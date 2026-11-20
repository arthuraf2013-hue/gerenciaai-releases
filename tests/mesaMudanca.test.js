const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem Firebase neste teste'); };

const saleService = require('../electron/services/saleService');
const tableService = require('../electron/services/tableService');
const mesaLocal = require('../electron/services/mesaLocalService');
const mudanca = require('../electron/services/mesaMudancaService');
const cozinha = require('../electron/services/cozinhaService');

// Mudança de mesa: a mesa inteira ou só algumas pessoas, pelo caixa ou a
// pedido do cliente pelo QR (o caixa aprova).

const DEV = 'pc';
const CEL_ANA = 'celularAnaAAAAAAAAAAAA';
const CEL_BIA = 'celularBiaBBBBBBBBBBBB';
const TOKENS = { 5: 'TokenMesaCinco0000000005', 9: 'TokenMesaNove00000000009', 7: 'TokenMesaSete00000000007' };

function loja() {
  const ctx = freshTestDb();
  ctx.db.prepare("UPDATE business_profile SET perfil_ativo = 'restaurante'").run();
  const peixe = createProduct(ctx.db, { nome: 'Peixe frito', preco: 60, categoria: 'Pratos' });
  const coco = createProduct(ctx.db, { nome: 'Água de coco', preco: 9, categoria: 'Bebidas' });
  for (const p of [peixe, coco]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.operadorId });
  const mesas = {};
  for (const n of [5, 9, 7]) {
    tableService.createTable({ locationId: ctx.locationId, numero: String(n) });
    mesas[n] = ctx.db.prepare('SELECT id FROM restaurant_tables WHERE numero = ?').get(String(n)).id;
    ctx.db.prepare('UPDATE restaurant_tables SET qr_token = ? WHERE id = ?').run(TOKENS[n], mesas[n]);
  }
  const mesa = (n) => ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesas[n]);
  const item = (saleId, productId, pessoaNumero, quantidade = 1) => {
    const r = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade, operadorId: ctx.operadorId, deviceId: DEV, pessoaNumero });
    assert.equal(r.ok, true, r.error);
    return r.itemId;
  };
  const totalDe = (saleId) => ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId).total;
  const pessoas = (saleId) => ctx.db.prepare('SELECT numero, nome, aparelho FROM sale_people WHERE sale_id = ? ORDER BY numero').all(saleId).map((p) => [p.numero, p.nome]);
  return { ...ctx, peixe, coco, mesas, mesa, item, totalDe, pessoas };
}

/** Mesa 5 aberta: Ana (pessoa 1, peixe), Bia (pessoa 2, coco), 1 coco sem pessoa. */
function mesaCinco(ctx, { comCelulares = false } = {}) {
  const { saleId } = tableService.openTable({ tableId: ctx.mesas[5], locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 2 });
  if (comCelulares) {
    mesaLocal.entrarNaMesa({ token: TOKENS[5], aparelho: CEL_ANA, nome: 'Ana' });
    mesaLocal.entrarNaMesa({ token: TOKENS[5], aparelho: CEL_BIA, nome: 'Bia' });
  } else {
    tableService.renomearPessoa({ tableId: ctx.mesas[5], numero: 1, nome: 'Ana' });
    tableService.renomearPessoa({ tableId: ctx.mesas[5], numero: 2, nome: 'Bia' });
  }
  ctx.item(saleId, ctx.peixe, 1);
  ctx.item(saleId, ctx.coco, 2);
  ctx.item(saleId, ctx.coco, null);
  return saleId;
}

test('só a Ana vai para a mesa livre: abre a 9 com ela e os itens dela; o resto fica na 5', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  const r = mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [1], operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inteira, false);
  const s9 = ctx.mesa(9).sale_id;
  assert.ok(s9 && s9 !== s5);
  assert.deepEqual(ctx.pessoas(s9), [[1, 'Ana']]);
  assert.deepEqual(ctx.pessoas(s5), [[2, 'Bia']]);
  assert.equal(ctx.totalDe(s9), 60);
  assert.equal(ctx.totalDe(s5), 18);
  assert.equal(ctx.mesa(5).status, 'ocupada');
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'mesa_mudou' AND motivo LIKE 'Mesa 5 -> Mesa 9: Ana%'").get());
});

test('pessoas para mesa ocupada: entram depois das de lá, sem misturar números', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  const { saleId: s7 } = tableService.openTable({ tableId: ctx.mesas[7], locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 1 });
  tableService.renomearPessoa({ tableId: ctx.mesas[7], numero: 1, nome: 'Rafa' });
  ctx.item(s7, ctx.coco, 1, 2);
  const r = mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[7], pessoas: [1, 2], operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.juntou, true);
  assert.deepEqual(ctx.pessoas(s7), [[1, 'Rafa'], [2, 'Ana'], [3, 'Bia']]);
  assert.equal(ctx.totalDe(s7), 18 + 60 + 9);
  const daAna = ctx.db.prepare('SELECT pessoa_numero FROM sale_items WHERE sale_id = ? AND product_id = ?').get(s7, ctx.peixe);
  assert.equal(daAna.pessoa_numero, 2);
  // Sobrou o coco sem pessoa: a 5 continua aberta com ele.
  assert.equal(ctx.mesa(5).sale_id, s5);
  assert.equal(ctx.totalDe(s5), 9);
});

test('mesa inteira para mesa ocupada: junta as contas, a 5 fica para limpar e aponta para a 7', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  const { saleId: s7 } = tableService.openTable({ tableId: ctx.mesas[7], locationId: ctx.locationId, operadorId: ctx.operadorId });
  ctx.item(s7, ctx.coco, null);
  const r = mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[7], pessoas: 'todas', operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inteira, true);
  assert.equal(ctx.totalDe(s7), 9 + 60 + 9 + 9);
  assert.equal(ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(s5).status, 'cancelada');
  assert.deepEqual([ctx.mesa(5).status, ctx.mesa(5).transferida_para_id], ['aguardando_limpeza', ctx.mesas[7]]);
  // O estoque não se perde: as vendas continuam baixadas (só mudaram de comanda).
  assert.equal(require('../electron/services/stockService').getCurrentStock(ctx.coco, ctx.locationId), 50 - 3);
});

test('mesa inteira para mesa livre: a transferência de sempre (a comanda vai junto)', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  const r = mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: 'todas' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inteira, true);
  assert.equal(ctx.mesa(9).sale_id, s5);
});

test('todas as pessoas, uma a uma, esvaziam a mesa: ela fecha sozinha', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  ctx.db.prepare('UPDATE sale_items SET cancelado = 1 WHERE sale_id = ? AND pessoa_numero IS NULL').run(s5);
  assert.equal(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [1] }).ok, true);
  const r = mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [2] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inteira, true);
  assert.equal(ctx.mesa(5).status, 'aguardando_limpeza');
  assert.deepEqual(ctx.pessoas(ctx.mesa(9).sale_id), [[1, 'Ana'], [2, 'Bia']]);
});

test('recusa com motivo: pagamento, mesa sendo paga, reservada, mesma mesa, pessoa que não existe', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  assert.match(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[5] }).error, /outra mesa/);
  assert.match(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [8] }).error, /não tem nome nem item/);
  assert.match(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [] }).error, /Escolha quem/);
  tableService.markReserved(ctx.mesas[9], '2026-12-01T20:00');
  assert.match(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [1] }).error, /reservada/);
  ctx.db.prepare("UPDATE restaurant_tables SET fechando_caixa_id = 'cx2', fechando_caixa_nome = 'Caixa 2' WHERE id = ?").run(ctx.mesas[5]);
  assert.match(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[7], pessoas: [1] }).error, /sendo paga no Caixa 2/);
  ctx.db.prepare('UPDATE restaurant_tables SET fechando_caixa_id = NULL WHERE id = ?').run(ctx.mesas[5]);
  ctx.db.prepare("INSERT INTO payments (id, sale_id, metodo, valor) VALUES ('pg1', ?, 'dinheiro', 10)").run(s5);
  assert.match(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[7], pessoas: [1] }).error, /pagamento/);
  assert.equal(ctx.totalDe(s5), 78, 'nada mudou');
});

test('cozinha: o que ela já recebeu sai numa comanda "MUDOU DE MESA"', async () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx);
  ctx.db.prepare('UPDATE sale_items SET enviado_cozinha = 1 WHERE sale_id = ? AND product_id = ?').run(s5, ctx.peixe);
  const enviadas = [];
  const originais = { getConfig: cozinha.getConfig, enviarParaImpressora: cozinha.enviarParaImpressora };
  cozinha.getConfig = () => ({ ...originais.getConfig(), ativa: true });
  cozinha.enviarParaImpressora = async (comanda) => { enviadas.push(comanda); };
  try {
    assert.equal(mudanca.moverConta({ fromTableId: ctx.mesas[5], toTableId: ctx.mesas[9], pessoas: [1, 2] }).ok, true);
    await new Promise((ok) => setImmediate(ok));
  } finally { Object.assign(cozinha, originais); }
  assert.equal(enviadas.length, 1);
  assert.equal(enviadas[0].titulo, 'MUDOU DE MESA');
  assert.equal(enviadas[0].subtitulo, 'Mesa 5 -> Mesa 9');
  assert.deepEqual(enviadas[0].itens.map((i) => [i.nome, i.pessoa]), [['Peixe frito', 'Ana']], 'só o que a cozinha já tinha recebido');
});

// ------------------------------------------------------------ pedido pelo celular

test('celular: Ana lê o QR da 9, pede para levar a conta dela, o caixa aprova', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx, { comCelulares: true });
  const e = mesaLocal.estadoDaMesa(TOKENS[9], CEL_ANA);
  assert.equal(e.outraMesa, 'Mesa 5');
  assert.equal(e.mesa, 'Mesa 9');
  assert.equal(e.mudanca, null);

  const p = mudanca.pedirMudanca({ paraMesa: ctx.mesa(9), aparelho: CEL_ANA, tipo: 'minha' });
  assert.equal(p.ok, true, p.error);
  assert.equal(mesaLocal.estadoDaMesa(TOKENS[9], CEL_ANA).mudanca.status, 'pendente');
  const ind = new Map(tableService.listTables(ctx.locationId).map((m) => [m.numero, m.indicadores]));
  assert.deepEqual(ind.get('5').mudancas.map((m) => [m.nome, m.tipo, m.para]), [['Ana', 'minha', 'Mesa 9']]);
  assert.deepEqual(ind.get('9').chegando.map((m) => [m.nome, m.de]), [['Ana', 'Mesa 5']]);

  const a = mudanca.aprovarMudanca({ id: p.id, operadorId: ctx.operadorId });
  assert.equal(a.ok, true, a.error);
  const s9 = ctx.mesa(9).sale_id;
  assert.deepEqual(ctx.pessoas(s9), [[1, 'Ana']]);
  assert.equal(ctx.totalDe(s9), 60);
  assert.deepEqual(ctx.pessoas(s5), [[2, 'Bia']]);
  const depois = mesaLocal.estadoDaMesa(TOKENS[9], CEL_ANA);
  assert.equal(depois.eu.nome, 'Ana');
  assert.deepEqual(depois.meusItens.map((i) => i.nome), ['Peixe frito']);
  assert.equal(depois.mudanca.status, 'aprovada');
  assert.equal(mesaLocal.estadoDaMesa(TOKENS[5], CEL_BIA).eu.nome, 'Bia', 'a Bia continua na 5');
  assert.equal(mudanca.aprovarMudanca({ id: p.id }).ok, false, 'aprovar de novo não faz nada');
});

test('celular: "mudamos todos" leva a conta inteira; quem ficou com o QR antigo continua na conta', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx, { comCelulares: true });
  const p = mudanca.pedirMudanca({ paraMesa: ctx.mesa(9), aparelho: CEL_ANA, tipo: 'todos' });
  assert.equal(mudanca.aprovarMudanca({ id: p.id }).ok, true);
  assert.equal(ctx.mesa(9).sale_id, s5);
  assert.equal(ctx.mesa(5).status, 'aguardando_limpeza');
  const daBia = mesaLocal.estadoDaMesa(TOKENS[5], CEL_BIA);
  assert.equal(daBia.mesa, 'Mesa 9');
  assert.equal(daBia.eu.nome, 'Bia');
});

test('celular: "só entregar aqui" -- o pedido vai para a conta da 5 avisando "entregar na 9"', () => {
  const ctx = loja();
  const s5 = mesaCinco(ctx, { comCelulares: true });
  assert.equal(mudanca.pedirMudanca({ paraMesa: ctx.mesa(9), aparelho: CEL_ANA, tipo: 'entregar' }).ok, true);
  const e = mesaLocal.estadoDaMesa(TOKENS[9], CEL_ANA);
  assert.equal(e.entregarAqui, true);
  assert.equal(e.contaEm, 'Mesa 5');
  assert.equal(e.eu.nome, 'Ana');
  const r = mesaLocal.criarPedido({ token: TOKENS[9], pedidoId: 'pedidoEntregaNove01', nome: 'x', aparelho: CEL_ANA, itens: [{ produtoId: ctx.coco, quantidade: 1 }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.aceitoSozinho, true, 'a 5 está aberta: entra direto');
  const novo = ctx.db.prepare('SELECT observacao, pessoa_numero FROM sale_items WHERE sale_id = ? ORDER BY rowid DESC LIMIT 1').get(s5);
  assert.match(novo.observacao, /^ENTREGAR NO MESA 9/);
  assert.equal(novo.pessoa_numero, 1, 'na conta da Ana');
  assert.equal(ctx.mesa(9).status, 'livre', 'a 9 não abre');
  // Parar de receber aqui: volta a perguntar.
  mudanca.pedirMudanca({ paraMesa: ctx.mesa(9), aparelho: CEL_ANA, tipo: 'cancelar' });
  assert.equal(mesaLocal.estadoDaMesa(TOKENS[9], CEL_ANA).outraMesa, 'Mesa 5');
});

test('celular: o caixa recusa; e quem não está em outra mesa não pede mudança', () => {
  const ctx = loja();
  mesaCinco(ctx, { comCelulares: true });
  const p = mudanca.pedirMudanca({ paraMesa: ctx.mesa(9), aparelho: CEL_ANA, tipo: 'minha' });
  assert.equal(mudanca.recusarMudanca({ id: p.id }).ok, true);
  const e = mesaLocal.estadoDaMesa(TOKENS[9], CEL_ANA);
  assert.equal(e.mudanca.status, 'recusada');
  assert.equal(e.outraMesa, 'Mesa 5');
  assert.match(mudanca.pedirMudanca({ paraMesa: ctx.mesa(9), aparelho: 'celularNovoXXXXXXXXXXX', tipo: 'minha' }).error, /não está em outra mesa/);
});

test('pela rede: /api/mudar', async (t) => {
  const ctx = loja();
  mesaCinco(ctx, { comCelulares: true });
  const r = await mesaLocal.iniciar(0);
  t.after(() => mesaLocal.parar());
  const http = require('http');
  const post = (corpo) => new Promise((ok, erro) => {
    const dados = JSON.stringify(corpo);
    const req = http.request({ host: '127.0.0.1', port: r.porta, path: '/api/mudar', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(Buffer.concat(partes).toString()) }));
    });
    req.on('error', erro); req.write(dados); req.end();
  });
  const ok = await post({ m: TOKENS[9], aparelho: CEL_ANA, tipo: 'minha' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mudanca.status, 'pendente');
  assert.equal((await post({ m: 'XXXXXXXXXXXXXXXXXXXXXXXX', aparelho: CEL_ANA, tipo: 'minha' })).status, 404);
  assert.equal((await post({ m: TOKENS[9], aparelho: 'x', tipo: 'minha' })).status, 400);
});
