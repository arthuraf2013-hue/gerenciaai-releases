const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const purchaseOrderService = require('../electron/services/purchaseOrderService');
const supplierService = require('../electron/services/supplierService');

function base() {
  const ctx = freshTestDb();
  const fornecedor = supplierService.upsert({ nome: 'Atacado Bom Preço', telefone: '(81) 99999-0000' });
  const arroz = createProduct(ctx.db, { nome: 'Arroz 5kg', custo: 20 });
  const feijao = createProduct(ctx.db, { nome: 'Feijão 1kg', custo: 7 });
  return { ...ctx, fornecedorId: fornecedor.id, arroz, feijao };
}

test('salvar cria com número sequencial e total; edição só em rascunho', () => {
  const { db, locationId, gerenteId, fornecedorId, arroz, feijao } = base();
  const a = purchaseOrderService.salvar({ fornecedorId, itens: [{ productId: arroz, quantidade: 10, custoUnitario: 21 }], locationId, operadorId: gerenteId });
  const b = purchaseOrderService.salvar({ fornecedorId, itens: [{ productId: feijao, quantidade: 3, custoUnitario: 7.5 }], locationId, operadorId: gerenteId });
  assert.equal(purchaseOrderService.obter(a.id).numero, 1);
  assert.equal(purchaseOrderService.obter(b.id).numero, 2);
  assert.equal(purchaseOrderService.obter(a.id).total, 210);

  const editado = purchaseOrderService.salvar({ id: a.id, fornecedorId, previsaoEntrega: '2026-11-10', itens: [{ productId: arroz, quantidade: 12, custoUnitario: 21 }, { productId: feijao, quantidade: 1, custoUnitario: 7 }], locationId, operadorId: gerenteId });
  assert.equal(editado.ok, true);
  const p = purchaseOrderService.obter(a.id);
  assert.equal(p.itens.length, 2);
  assert.equal(p.total, 259);
  assert.equal(p.previsao_entrega, '2026-11-10');

  purchaseOrderService.marcarEnviado({ id: a.id });
  const r = purchaseOrderService.salvar({ id: a.id, fornecedorId, itens: [{ productId: arroz, quantidade: 1 }], locationId, operadorId: gerenteId });
  assert.equal(r.ok, false);
  assert.match(r.error, /rascunho/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchase_order_items WHERE order_id = ?').get(a.id).c, 2, 'falha não apaga os itens');
});

test('salvar valida fornecedor, itens vazios, duplicados, serviço e quantidade', () => {
  const { db, locationId, gerenteId, fornecedorId, arroz } = base();
  const servico = createProduct(db, { nome: 'Frete', tipo: 'servico' });
  const s = (extra) => purchaseOrderService.salvar({ fornecedorId, locationId, operadorId: gerenteId, ...extra });
  assert.match(s({ fornecedorId: null, itens: [{ productId: arroz, quantidade: 1 }] }).error, /fornecedor/);
  assert.match(s({ itens: [] }).error, /pelo menos um/);
  assert.match(s({ itens: [{ productId: arroz, quantidade: 1 }, { productId: arroz, quantidade: 2 }] }).error, /duas vezes/);
  assert.match(s({ itens: [{ productId: servico, quantidade: 1 }] }).error, /serviço/);
  assert.match(s({ itens: [{ productId: arroz, quantidade: 0 }] }).error, /quantidade/);
});

test('receberSemNota: estoque com o custo do pedido (médio), parcial e depois recebido', () => {
  const { db, locationId, gerenteId, fornecedorId, arroz } = base();
  addStock(db, { productId: arroz, locationId, quantidade: 10, operadorId: gerenteId });
  const { id } = purchaseOrderService.salvar({ fornecedorId, itens: [{ productId: arroz, quantidade: 10, custoUnitario: 30 }], locationId, operadorId: gerenteId });
  purchaseOrderService.marcarEnviado({ id });
  const item = purchaseOrderService.obter(id).itens[0];

  let r = purchaseOrderService.receberSemNota({ orderId: id, itens: [{ itemId: item.id, quantidade: 4, lote: 'A1', validade: '2027-01-31' }], locationId, operadorId: gerenteId, deviceId: 'd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'parcial');
  assert.equal(db.prepare('SELECT custo FROM products WHERE id = ?').get(arroz).custo, 22.8571); // (10×20 + 4×30) / 14

  r = purchaseOrderService.receberSemNota({ orderId: id, itens: [{ itemId: item.id, quantidade: 6 }], locationId, operadorId: gerenteId, deviceId: 'd' });
  assert.equal(r.status, 'recebido');
  assert.equal(db.prepare('SELECT SUM(quantidade) q FROM stock_movements WHERE product_id = ?').get(arroz).q, 20);
  assert.match(purchaseOrderService.receberSemNota({ orderId: id, itens: [{ itemId: item.id, quantidade: 1 }], locationId, operadorId: gerenteId, deviceId: 'd' }).error, /recebido/);
});

test('receberSemNota é tudo ou nada', () => {
  const { db, locationId, gerenteId, fornecedorId, arroz, feijao } = base();
  const { id } = purchaseOrderService.salvar({ fornecedorId, itens: [{ productId: arroz, quantidade: 2, custoUnitario: 20 }, { productId: feijao, quantidade: 2, custoUnitario: 7 }], locationId, operadorId: gerenteId });
  const [i1] = purchaseOrderService.obter(id).itens;
  const r = purchaseOrderService.receberSemNota({ orderId: id, itens: [{ itemId: i1.id, quantidade: 2 }, { itemId: 'nao-e-deste-pedido', quantidade: 1 }], locationId, operadorId: gerenteId, deviceId: 'd' });
  assert.equal(r.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_movements').get().c, 0);
  assert.equal(purchaseOrderService.obter(id).itens.every((i) => i.quantidade_recebida === 0), true);
});

test('cancelar: não cancela recebido; registra na Auditoria', () => {
  const { db, locationId, gerenteId, fornecedorId, arroz } = base();
  const { id } = purchaseOrderService.salvar({ fornecedorId, itens: [{ productId: arroz, quantidade: 1, custoUnitario: 1 }], locationId, operadorId: gerenteId });
  assert.equal(purchaseOrderService.cancelar({ id, operadorId: gerenteId }).ok, true);
  assert.equal(purchaseOrderService.obter(id).status, 'cancelado');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE tipo_evento = 'pedido_compra_cancelado'`).get());
  assert.equal(purchaseOrderService.cancelar({ id, operadorId: gerenteId }).ok, false);
});

test('criarDaSugestao agrupa por fornecedor e conta quem não tem fornecedor', () => {
  const { db, locationId, gerenteId, fornecedorId, arroz, feijao } = base();
  const semFornecedor = createProduct(db, { nome: 'Sem fornecedor', estoqueMinimo: 5 });
  db.prepare('UPDATE products SET fornecedor_id = ?, estoque_minimo = 5 WHERE id IN (?, ?)').run(fornecedorId, arroz, feijao);
  const r = purchaseOrderService.criarDaSugestao({ locationId, operadorId: gerenteId });
  assert.equal(r.ok, true);
  assert.equal(r.criados.length, 1);
  assert.equal(r.semFornecedor, 1);
  const p = purchaseOrderService.obter(r.criados[0]);
  assert.equal(p.fornecedor_id, fornecedorId);
  assert.deepEqual(p.itens.map((i) => [i.produto_nome, i.quantidade, i.custo_unitario]).sort(), [['Arroz 5kg', 5, 20], ['Feijão 1kg', 5, 7]]);
  assert.ok(semFornecedor);
});

test('texto e link de WhatsApp: sem custo no texto, DDI 55 só quando falta', () => {
  const { locationId, gerenteId, fornecedorId, arroz } = base();
  const { id } = purchaseOrderService.salvar({ fornecedorId, previsaoEntrega: '2026-11-03', itens: [{ productId: arroz, quantidade: 3, custoUnitario: 99.9 }], locationId, operadorId: gerenteId });
  const { texto } = purchaseOrderService.textoParaFornecedor(id);
  assert.match(texto, /Pedido de compra nº 1/);
  assert.match(texto, /3 un — Arroz 5kg/);
  assert.match(texto, /03\/11\/2026/);
  assert.doesNotMatch(texto, /99/);
  const { url } = purchaseOrderService.linkWhatsapp(id);
  assert.match(url, /^https:\/\/wa\.me\/5581999990000\?text=/);
});
