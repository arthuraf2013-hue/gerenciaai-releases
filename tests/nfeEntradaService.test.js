const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const { montarNfeXml } = require('./helpers/nfeXml');
const { parseNFeXml } = require('../electron/services/nfeXmlParser');
const nfeEntradaService = require('../electron/services/nfeEntradaService');
const purchaseOrderService = require('../electron/services/purchaseOrderService');
const supplierService = require('../electron/services/supplierService');

const EAN_REFRI = '7891000100103';
const EAN_BISCOITO = '7891000200200';

function itemRefri(extra = {}) {
  return { codigo: 'REF2L', ean: '17891000100100', eanTrib: EAN_REFRI, descricao: 'REFRIGERANTE 2L CX C/6', uCom: 'CX', qCom: 2, vUnCom: 30, vProd: 60, uTrib: 'UN', qTrib: 12, ...extra };
}
function itemBiscoito(extra = {}) {
  return { codigo: 'BIS01', ean: EAN_BISCOITO, eanTrib: EAN_BISCOITO, descricao: 'BISCOITO 200G', uCom: 'UN', qCom: 10, vUnCom: 2.5, vProd: 25, ...extra };
}

function estoque(db, productId) {
  return db.prepare('SELECT COALESCE(SUM(quantidade), 0) q FROM stock_movements WHERE product_id = ?').get(productId).q;
}
function custo(db, productId) {
  return db.prepare('SELECT custo FROM products WHERE id = ?').get(productId).custo;
}
function comCodigo(db, nome, ean, custoInicial = 0) {
  const id = createProduct(db, { nome, custo: custoInicial });
  db.prepare('UPDATE products SET codigo_barras = ? WHERE id = ?').run(ean, id);
  return id;
}

// ---------- leitura do XML ----------

test('parse: valores do item, ST + FCP-ST e IPI somados, duplicatas, lote', () => {
  const { xml, chave } = montarNfeXml({
    itens: [itemRefri({ vFrete: 3, vDesc: 1, vIPI: 2, vICMSST: 4, vFCPST: 0.5, rastro: [{ nLote: 'L1', qLote: 2, dFab: '2026-09-01', dVal: '2027-02-01' }] })],
    duplicatas: [{ nDup: '001', dVenc: '2026-11-20', vDup: 34.25 }, { nDup: '002', dVenc: '2026-12-20', vDup: 34.25 }],
  });
  const r = parseNFeXml(xml);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nota.chave, chave);
  const [it] = r.nota.itens;
  assert.equal(it.ean, '17891000100100');
  assert.equal(it.quantidadeTributavel, 12);
  assert.equal(it.frete, 3);
  assert.equal(it.desconto, 1);
  assert.equal(it.ipi, 2);
  assert.equal(it.icmsSt, 4.5);
  assert.deepEqual(it.lotes, [{ lote: 'L1', quantidade: 2, fabricacao: '2026-09-01', validade: '2027-02-01' }]);
  assert.equal(r.nota.duplicatas.length, 2);
  assert.equal(r.nota.autorizada, true);
  assert.deepEqual(r.avisos, []);
});

test('parse: ST retida antes (CSOSN 500, vICMSSTRet) não entra no custo', () => {
  const { xml } = montarNfeXml({ itens: [itemBiscoito({ vICMSSTRet: 9 })] });
  const r = parseNFeXml(xml);
  assert.equal(r.nota.itens[0].icmsSt, 0);
});

test('parse: "SEM GTIN" vira código vazio', () => {
  const { xml } = montarNfeXml({ itens: [itemBiscoito({ ean: '', eanTrib: '' })] });
  const r = parseNFeXml(xml);
  assert.equal(r.nota.itens[0].ean, '');
  assert.equal(r.nota.itens[0].eanTributavel, '');
});

test('parse: recusa NFC-e, chave com dígito errado, XML quebrado e DOCTYPE', () => {
  assert.match(parseNFeXml(montarNfeXml({ modelo: '65', itens: [itemBiscoito()] }).xml).error, /NFC-e/);
  const { xml, chave } = montarNfeXml({ itens: [itemBiscoito()] });
  const errada = chave.slice(0, 43) + String((Number(chave[43]) + 1) % 10);
  assert.match(parseNFeXml(xml.replace(`NFe${chave}`, `NFe${errada}`)).error, /dígito verificador/);
  assert.match(parseNFeXml('<nfeProc><NFe><infNFe').error, /XML válido/);
  assert.match(parseNFeXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>').error, /DOCTYPE/);
  assert.match(parseNFeXml('<?xml version="1.0"?><resEvento/>').error, /infNFe/);
});

test('parse: XML sem protocolo e nota não autorizada geram aviso, não erro', () => {
  const semProt = parseNFeXml(montarNfeXml({ comProtocolo: false, itens: [itemBiscoito()] }).xml);
  assert.equal(semProt.ok, true);
  assert.match(semProt.avisos.join(' '), /protocolo/);
  const negada = parseNFeXml(montarNfeXml({ cStat: '302', itens: [itemBiscoito()] }).xml);
  assert.equal(negada.ok, true);
  assert.equal(negada.nota.autorizada, false);
  assert.match(negada.avisos.join(' '), /não autorizou/);
});

// ---------- importação (rascunho) ----------

test('importarXml grava rascunho sem mexer em estoque nem custo, e casa por EAN tributável com a conversão da caixa', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const refri = comCodigo(db, 'Refrigerante 2L', EAN_REFRI, 4);
  const biscoito = comCodigo(db, 'Biscoito 200g', EAN_BISCOITO, 2);
  const { xml } = montarNfeXml({ itens: [itemRefri(), itemBiscoito(), { codigo: 'X9', descricao: 'BRINDE DISPLAY', qCom: 1, vUnCom: 0.01, vProd: 0.01 }] });

  const r = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  assert.equal(r.ok, true, r.error);
  const e = nfeEntradaService.obter(r.id);
  assert.equal(e.status, 'rascunho');
  assert.equal(e.itens[0].product_id, refri);
  assert.equal(e.itens[0].fator, 6);
  assert.equal(e.itens[0].quantidade_entrada_prevista, 12);
  assert.equal(e.itens[0].custo_unitario_previsto, 5);
  assert.equal(e.itens[1].product_id, biscoito);
  assert.equal(e.itens[1].fator, 1);
  assert.equal(e.itens[2].product_id, null);
  assert.equal(e.pendencias, 1);
  assert.equal(estoque(db, refri), 0);
  assert.equal(custo(db, refri), 4);
});

test('importarXml recusa a mesma chave enquanto a anterior não for estornada', () => {
  const { db, locationId, operadorId } = freshTestDb();
  comCodigo(db, 'Biscoito', EAN_BISCOITO);
  const { xml } = montarNfeXml({ itens: [itemBiscoito()] });
  const a = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  assert.equal(a.ok, true);
  const b = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  assert.equal(b.ok, false);
  assert.equal(b.jaImportada, true);
  assert.equal(b.entradaId, a.id);
  assert.match(b.error, /em conferência/);
});

test('importarXml avisa quando a nota é para outro CNPJ', () => {
  const { db, locationId, operadorId } = freshTestDb();
  db.prepare(`INSERT INTO fiscal_config (id, cnpj) VALUES ('default', '99.888.777/0001-66') ON CONFLICT(id) DO UPDATE SET cnpj = excluded.cnpj`).run();
  const r = nfeEntradaService.importarXml({ xml: montarNfeXml({ itens: [itemBiscoito()] }).xml, locationId, operadorId });
  assert.equal(r.ok, true);
  assert.match(r.avisos.join(' '), /não é o CNPJ da loja/);
});

// ---------- confirmação ----------

function prepararNota(db, ctx, { duplicatas, itens } = {}) {
  const refri = comCodigo(db, 'Refrigerante 2L', EAN_REFRI, 4);
  addStock(db, { productId: refri, locationId: ctx.locationId, quantidade: 12, operadorId: ctx.operadorId });
  const { xml } = montarNfeXml({
    itens: itens || [itemRefri({ vFrete: 6, vDesc: 6 })], // custo total 60, 12 un => R$ 5
    duplicatas: duplicatas ?? [{ nDup: '001', dVenc: '2026-11-20', vDup: 30 }, { nDup: '002', dVenc: '2026-12-20', vDup: 30 }],
  });
  const r = nfeEntradaService.importarXml({ xml, locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  return { refri, entradaId: r.id };
}

test('confirmar: estoque, custo médio, lote, contas por duplicata, fornecedor criado e código memorizado', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const { refri, entradaId } = prepararNota(db, { locationId, operadorId: gerenteId });
  nfeEntradaService.atualizarItem({ entradaId, itemId: nfeEntradaService.obter(entradaId).itens[0].id, lote: 'L77', validade: '2027-05-01' });

  const r = nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.contas, 2);

  assert.equal(estoque(db, refri), 24);
  assert.equal(custo(db, refri), 4.5); // (12 × 4 + 12 × 5) / 24
  const lote = db.prepare('SELECT * FROM product_batches WHERE product_id = ?').get(refri);
  assert.equal(lote.lote, 'L77');
  assert.equal(lote.validade, '2027-05-01');
  assert.equal(lote.quantidade, 12);

  const contas = db.prepare('SELECT * FROM expenses WHERE nfe_entrada_id = ? ORDER BY data_vencimento').all(entradaId);
  assert.deepEqual(contas.map((c) => [c.valor, c.data_vencimento, c.data_pagamento]), [[30, '2026-11-20', null], [30, '2026-12-20', null]]);
  assert.match(contas[0].descricao, /NF-e 1234\/1 — Distribuidora Exemplo — parcela 1\/2/);

  const fornecedor = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(r.fornecedorId);
  assert.equal(fornecedor.cnpj_cpf, '11.222.333/0001-81');
  assert.equal(fornecedor.telefone, '8133334444');
  assert.equal(contas[0].fornecedor_id, fornecedor.id);

  const memo = db.prepare('SELECT * FROM supplier_products WHERE supplier_id = ?').get(fornecedor.id);
  assert.equal(memo.codigo_fornecedor, 'REF2L');
  assert.equal(memo.product_id, refri);
  assert.equal(memo.fator, 6);

  const e = nfeEntradaService.obter(entradaId);
  assert.equal(e.status, 'confirmada');
  assert.equal(e.itens[0].custo_unitario, 5);
  assert.equal(e.itens[0].quantidade_entrada, 12);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE tipo_evento = 'nfe_entrada_confirmada'`).get());

  // Não dá pra confirmar duas vezes nem editar depois.
  assert.equal(nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' }).ok, false);
  assert.equal(nfeEntradaService.atualizarItem({ entradaId, itemId: e.itens[0].id, fator: 2 }).ok, false);
});

test('próxima nota do mesmo fornecedor já vem casada pelo código memorizado (mesmo sem EAN)', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const { refri, entradaId } = prepararNota(db, { locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' }).ok, true);

  const { xml } = montarNfeXml({ numero: 1300, itens: [itemRefri({ ean: '', eanTrib: '' })] });
  const r = nfeEntradaService.importarXml({ xml, locationId, operadorId: gerenteId });
  const e = nfeEntradaService.obter(r.id);
  assert.ok(e.fornecedor_id);
  assert.equal(e.itens[0].product_id, refri);
  assert.equal(e.itens[0].fator, 6);
});

test('confirmar exige produto em todo item não ignorado e escolha de pagamento quando não há duplicata', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const { xml } = montarNfeXml({ itens: [itemBiscoito(), { codigo: 'BRD', descricao: 'BRINDE', qCom: 1, vUnCom: 0, vProd: 0 }] });
  const biscoito = comCodigo(db, 'Biscoito', EAN_BISCOITO, 2);
  const { id: entradaId } = nfeEntradaService.importarXml({ xml, locationId, operadorId: gerenteId });
  const brinde = nfeEntradaService.obter(entradaId).itens[1];

  let r = nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' });
  assert.match(r.error, /Falta escolher o produto de 1 item.*BRINDE/);

  nfeEntradaService.atualizarItem({ entradaId, itemId: brinde.id, ignorar: true });
  r = nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' });
  assert.match(r.error, /não tem duplicatas/);

  r = nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev', contaAPagar: { modo: 'vencimento', vencimento: '2026-11-05' } });
  assert.equal(r.ok, true, r.error);
  const contas = db.prepare('SELECT * FROM expenses WHERE nfe_entrada_id = ?').all(entradaId);
  assert.equal(contas.length, 1);
  assert.equal(contas[0].valor, 25);
  assert.equal(contas[0].data_vencimento, '2026-11-05');
  assert.equal(estoque(db, biscoito), 10);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_movements').get().c, 1, 'item ignorado não entra no estoque');
});

test('confirmar com compra à vista lança a conta já paga; "nenhuma" não lança nada', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  comCodigo(db, 'Biscoito', EAN_BISCOITO, 2);
  const a = nfeEntradaService.importarXml({ xml: montarNfeXml({ numero: 1, itens: [itemBiscoito()] }).xml, locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.confirmar({ entradaId: a.id, locationId, operadorId: gerenteId, deviceId: 'd', contaAPagar: { modo: 'paga' } }).ok, true);
  const paga = db.prepare('SELECT * FROM expenses WHERE nfe_entrada_id = ?').get(a.id);
  assert.ok(paga.data_pagamento);
  assert.equal(paga.data_vencimento, null);

  const b = nfeEntradaService.importarXml({ xml: montarNfeXml({ numero: 2, itens: [itemBiscoito()] }).xml, locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.confirmar({ entradaId: b.id, locationId, operadorId: gerenteId, deviceId: 'd', contaAPagar: { modo: 'nenhuma' } }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM expenses WHERE nfe_entrada_id = ?').get(b.id).c, 0);
});

test('confirmar recusa serviço e desconto maior que o item, sem deixar nada pela metade', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const biscoito = comCodigo(db, 'Biscoito', EAN_BISCOITO, 2);
  const servico = createProduct(db, { nome: 'Mão de obra', tipo: 'servico' });
  const { id } = nfeEntradaService.importarXml({
    xml: montarNfeXml({ itens: [itemBiscoito(), { codigo: 'Z', descricao: 'ITEM Z', qCom: 1, vUnCom: 5, vProd: 5, vDesc: 6 }] }).xml,
    locationId, operadorId: gerenteId,
  });
  const itemZ = nfeEntradaService.obter(id).itens[1];
  assert.match(nfeEntradaService.atualizarItem({ entradaId: id, itemId: itemZ.id, productId: servico }).error, /serviço/);
  const outro = createProduct(db, { nome: 'Outro' });
  nfeEntradaService.atualizarItem({ entradaId: id, itemId: itemZ.id, productId: outro });
  const r = nfeEntradaService.confirmar({ entradaId: id, locationId, operadorId: gerenteId, deviceId: 'd', contaAPagar: { modo: 'nenhuma' } });
  assert.match(r.error, /desconto/);
  assert.equal(estoque(db, biscoito), 0);
  assert.equal(nfeEntradaService.obter(id).status, 'rascunho');
});

test('atualizarItem valida conversão e data', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  comCodigo(db, 'Biscoito', EAN_BISCOITO);
  const { id } = nfeEntradaService.importarXml({ xml: montarNfeXml({ itens: [itemBiscoito()] }).xml, locationId, operadorId: gerenteId });
  const item = nfeEntradaService.obter(id).itens[0];
  assert.equal(nfeEntradaService.atualizarItem({ entradaId: id, itemId: item.id, fator: 0 }).ok, false);
  assert.equal(nfeEntradaService.atualizarItem({ entradaId: id, itemId: item.id, validade: '01/02/2027' }).ok, false);
  const r = nfeEntradaService.atualizarItem({ entradaId: id, itemId: item.id, fator: 12 });
  assert.equal(r.ok, true);
  assert.equal(r.item.quantidadeEntrada, 120);
  assert.equal(r.item.custoUnitario, 0.2083);
});

// ---------- estorno ----------

test('estornar devolve estoque e custo, apaga o lote, cancela contas abertas e libera a chave', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const { refri, entradaId } = prepararNota(db, { locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' }).ok, true);

  assert.match(nfeEntradaService.estornar({ entradaId, motivo: '', operadorId: gerenteId, deviceId: 'dev' }).error, /motivo/);
  const r = nfeEntradaService.estornar({ entradaId, motivo: 'Mercadoria devolvida', operadorId: gerenteId, deviceId: 'dev' });
  assert.equal(r.ok, true, r.error);
  assert.equal(estoque(db, refri), 12);
  assert.equal(custo(db, refri), 4);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM product_batches').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM expenses WHERE nfe_entrada_id = ?').get(entradaId).c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM stock_movements WHERE product_id = ?`).get(refri).c, 3, 'ledger: nada apagado, só compensado');
  assert.equal(nfeEntradaService.obter(entradaId).status, 'estornada');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE tipo_evento = 'nfe_entrada_estornada'`).get());

  // A mesma nota pode ser lançada de novo, certa desta vez.
  const xml = db.prepare('SELECT xml FROM nfe_entradas WHERE id = ?').get(entradaId).xml;
  assert.equal(nfeEntradaService.importarXml({ xml, locationId, operadorId: gerenteId }).ok, true);
});

test('estornar trava quando alguma conta da nota já foi paga', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const { refri, entradaId } = prepararNota(db, { locationId, operadorId: gerenteId });
  nfeEntradaService.confirmar({ entradaId, locationId, operadorId: gerenteId, deviceId: 'dev' });
  db.prepare(`UPDATE expenses SET data_pagamento = '2026-11-20 12:00:00' WHERE nfe_entrada_id = ? AND data_vencimento = '2026-11-20'`).run(entradaId);
  const r = nfeEntradaService.estornar({ entradaId, motivo: 'Devolução total', operadorId: gerenteId, deviceId: 'dev' });
  assert.match(r.error, /já paga/);
  assert.equal(estoque(db, refri), 24);
});

test('descartar apaga só rascunho', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  comCodigo(db, 'Biscoito', EAN_BISCOITO);
  const { id } = nfeEntradaService.importarXml({ xml: montarNfeXml({ itens: [itemBiscoito()] }).xml, locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.descartar({ entradaId: id }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM nfe_entrada_itens').get().c, 0);
  assert.equal(nfeEntradaService.obter(id), null);
});

// ---------- pedido de compra vinculado ----------

test('nota vinculada a pedido abate o recebido; estorno devolve o pedido pra enviado', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const fornecedor = supplierService.upsert({ nome: 'Distribuidora', cnpjCpf: '11.222.333/0001-81' });
  const refri = comCodigo(db, 'Refrigerante 2L', EAN_REFRI, 4);
  const pedido = purchaseOrderService.salvar({ fornecedorId: fornecedor.id, itens: [{ productId: refri, quantidade: 24, custoUnitario: 5 }], locationId, operadorId: gerenteId });
  purchaseOrderService.marcarEnviado({ id: pedido.id });

  const { id } = nfeEntradaService.importarXml({ xml: montarNfeXml({ itens: [itemRefri()], duplicatas: [{ nDup: '1', dVenc: '2026-11-30', vDup: 60 }] }).xml, locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.obter(id).fornecedor_id, fornecedor.id, 'casou o fornecedor pelo CNPJ formatado');
  assert.equal(nfeEntradaService.vincularPedido({ entradaId: id, purchaseOrderId: pedido.id }).ok, true);
  assert.equal(nfeEntradaService.confirmar({ entradaId: id, locationId, operadorId: gerenteId, deviceId: 'd' }).ok, true);

  let p = purchaseOrderService.obter(pedido.id);
  assert.equal(p.status, 'parcial');
  assert.equal(p.itens[0].quantidade_recebida, 12);

  assert.equal(nfeEntradaService.estornar({ entradaId: id, motivo: 'Nota errada', operadorId: gerenteId, deviceId: 'd' }).ok, true);
  p = purchaseOrderService.obter(pedido.id);
  assert.equal(p.status, 'enviado');
  assert.equal(p.itens[0].quantidade_recebida, 0);
});

test('vincularPedido recusa pedido de outro fornecedor ou já recebido', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const outro = supplierService.upsert({ nome: 'Outro', cnpjCpf: '00.000.000/0001-91' });
  const dono = supplierService.upsert({ nome: 'Dono', cnpjCpf: '11222333000181' });
  const prod = comCodigo(db, 'Biscoito', EAN_BISCOITO);
  const pedidoOutro = purchaseOrderService.salvar({ fornecedorId: outro.id, itens: [{ productId: prod, quantidade: 1, custoUnitario: 1 }], locationId, operadorId: gerenteId });
  const { id } = nfeEntradaService.importarXml({ xml: montarNfeXml({ itens: [itemBiscoito()] }).xml, locationId, operadorId: gerenteId });
  assert.equal(nfeEntradaService.obter(id).fornecedor_id, dono.id);
  assert.match(nfeEntradaService.vincularPedido({ entradaId: id, purchaseOrderId: pedidoOutro.id }).error, /outro fornecedor/);
});
