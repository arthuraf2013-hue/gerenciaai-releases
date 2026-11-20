const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem Firebase neste teste'); };

const saleService = require('../electron/services/saleService');
const tableService = require('../electron/services/tableService');
const politica = require('../electron/services/estoquePoliticaService');
const syncState = require('../electron/services/syncStateService');
const stockService = require('../electron/services/stockService');

const DEV = 'device-teste';

function trocar(obj, nome, valor, fn) {
  const original = obj[nome];
  obj[nome] = valor;
  try { return fn(); } finally { obj[nome] = original; }
}

function perfil(db, p) { db.prepare("UPDATE business_profile SET perfil_ativo = ?, config_json = '{}' WHERE id = 'default'").run(p); }

function loja(p = 'restaurante') {
  const ctx = freshTestDb();
  perfil(ctx.db, p);
  const cerveja = createProduct(ctx.db, { nome: 'Cerveja', preco: 10 });
  const mesas = {};
  for (const n of ['1', '2', '3']) {
    tableService.createTable({ locationId: ctx.locationId, numero: n });
    mesas[n] = ctx.db.prepare('SELECT id FROM restaurant_tables WHERE numero = ?').get(n).id;
  }
  const mesa = (n) => ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesas[n]);
  return { ...ctx, cerveja, mesas, mesa };
}
const estoque = (ctx, p) => stockService.getCurrentStock(p, ctx.locationId);

// ------------------------------------------------------------ venda sem estoque

test('restaurante: sem estoque o item entra, avisa onde falta, fica negativo e marcado', () => {
  const ctx = loja('restaurante');
  assert.equal(politica.getPolitica().venderSemEstoque, true, 'padrão do restaurante: não trava');
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const r = saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: DEV });
  assert.equal(r.ok, true, r.error);
  assert.match(r.avisoEstoque, /^Estoque insuficiente neste computador\. Disponível: 0 un\./);
  assert.equal(estoque(ctx, ctx.cerveja), -2);
  const item = ctx.db.prepare('SELECT vendido_sem_estoque, aviso_estoque FROM sale_items WHERE id = ?').get(r.itemId);
  assert.equal(item.vendido_sem_estoque, 1);
  assert.match(item.aviso_estoque, /neste computador/);

  const mais = saleService.ajustarQuantidadeItem({ saleId, saleItemId: r.itemId, delta: 1, locationId: ctx.locationId, operadorId: ctx.operadorId, deviceId: DEV });
  assert.equal(mais.ok, true, mais.error);
  assert.match(mais.avisoEstoque, /Disponível: -2/);

  const rel = politica.vendidosSemEstoque({ dias: 30 });
  assert.equal(rel.length, 1);
  assert.equal(rel[0].nome, 'Cerveja');
  assert.equal(rel[0].quantidade, 3);
  assert.equal(rel[0].estoqueAtual, -3);
});

test('com estoque: nada de aviso nem marca', () => {
  const ctx = loja('restaurante');
  addStock(ctx.db, { productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.operadorId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const r = saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: DEV });
  assert.equal(r.ok, true);
  assert.equal(r.avisoEstoque, undefined);
  assert.equal(politica.vendidosSemEstoque().length, 0);
});

test('farmácia (padrão): trava, com a explicação; o gerente pode ligar e o operador não', () => {
  const ctx = loja('farmacia');
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const add = () => saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: DEV });
  const r = add();
  assert.equal(r.ok, false);
  assert.equal(r.semEstoque, true);
  assert.match(r.error, /^Estoque insuficiente neste computador/);

  assert.equal(politica.setPolitica({ venderSemEstoque: true, requestingUserId: ctx.operadorId }).ok, false);
  const s = politica.setPolitica({ venderSemEstoque: true, requestingUserId: ctx.gerenteId });
  assert.equal(s.ok, true);
  assert.equal(s.escolhido, true);
  assert.equal(add().ok, true);
  // A escolha fica gravada junto das outras do perfil (config_json não perde nada).
  assert.equal(JSON.parse(ctx.db.prepare("SELECT config_json FROM business_profile WHERE id = 'default'").get().config_json).venderSemEstoque, true);
  assert.equal(politica.setPolitica({ venderSemEstoque: false, requestingUserId: ctx.adminId }).venderSemEstoque, false);
  assert.equal(add().ok, false);
});

test('servidor do grupo: a mensagem diz quanto está preso em comandas abertas', () => {
  const ctx = loja('farmacia');
  const stockSync = require('../electron/services/stockSyncService');
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  addStock(ctx.db, { productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  trocar(stockSync, 'detalheDoGrupoNoServidor', () => ({ contador: 4, reservado: 4, saldo: 0 }), () => {
    const r = saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: DEV });
    assert.equal(r.ok, false);
    assert.match(r.error, /^Estoque insuficiente no grupo\. Disponível: 0 un\. 4 un estão em comandas abertas\. Neste computador constam 10 un\./);
  });
});

// ------------------------------------------------------------ comandas esquecidas

test('comanda esquecida: aparece depois de 12 h, cancela com o PIN de quem é gestão, a mesa fica livre e o estoque volta', () => {
  const ctx = loja('restaurante');
  addStock(ctx.db, { productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.operadorId });
  const { saleId } = tableService.openTable({ tableId: ctx.mesas['1'], locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: DEV });
  // Balcão vazio aberto (normal) não conta.
  saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.gerenteId });
  assert.equal(politica.comandasEsquecidas().length, 0, 'aberta agora: ainda não é esquecida');
  ctx.db.prepare("UPDATE sales SET criado_em = datetime('now', '-20 hours')").run();

  const lista = politica.comandasEsquecidas();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].mesa, 'Mesa 1');
  assert.equal(lista[0].itens, 1);
  assert.equal(lista[0].total, 20);

  assert.match(politica.cancelarComandaEsquecida({ saleId, requestingUserId: ctx.operadorId, pin: '5678' }).error, /gerente/);
  assert.match(politica.cancelarComandaEsquecida({ saleId, requestingUserId: ctx.gerenteId, pin: '0000' }).error, /PIN/);
  const ok = politica.cancelarComandaEsquecida({ saleId, requestingUserId: ctx.gerenteId, pin: '1234', deviceId: DEV });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ctx.mesa('1').status, 'livre');
  assert.equal(estoque(ctx, ctx.cerveja), 5);
  assert.equal(politica.comandasEsquecidas().length, 0);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'comanda_esquecida_cancelada'").get());
});

test('comanda esquecida com pagamento não é cancelada por aqui', () => {
  const ctx = loja('restaurante');
  const { saleId } = tableService.openTable({ tableId: ctx.mesas['1'], locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: DEV });
  ctx.db.prepare("INSERT INTO payments (id, sale_id, metodo, valor) VALUES ('pg1', ?, 'dinheiro', 5)").run(saleId);
  assert.match(politica.cancelarComandaEsquecida({ saleId, requestingUserId: ctx.gerenteId, pin: '1234' }).error, /pagamento/);
  assert.equal(ctx.mesa('1').status, 'ocupada');
});

// ------------------------------------------------------------ unificar estoque

test('unificar: leva ao servidor só as entradas/ajustes deste caixa, uma vez só, e zera aqui', () => {
  const ctx = loja('restaurante');
  addStock(ctx.db, { productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 12, operadorId: ctx.operadorId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 3, operadorId: ctx.operadorId, deviceId: DEV });
  assert.equal(estoque(ctx, ctx.cerveja), 9);

  assert.equal(politica.previaUnificacao().pode, false, 'fora de grupo não faz sentido');
  const stockSync = require('../electron/services/stockSyncService');
  const comoCaixa = (fn) => trocar(syncState, 'getGrupoSincronizacaoId', () => 'grupo-x',
    () => trocar(syncState, 'ehServidorDoGrupo', () => false,
      () => trocar(stockSync, 'enviarVariacoesPendentes', async () => {}, fn)));

  comoCaixa(() => {
    const previa = politica.previaUnificacao();
    assert.equal(previa.pode, true);
    assert.deepEqual(previa.produtos.map((p) => [p.nome, p.quantidade]), [['Cerveja', 12]], 'a venda não entra: ela já baixa no servidor');
    assert.equal(politica.unificarNoServidor({ requestingUserId: ctx.operadorId }).ok, false);
    const r = politica.unificarNoServidor({ requestingUserId: ctx.gerenteId, deviceId: DEV });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.enviados.map((e) => e.quantidade), [12]);
    const fila = ctx.db.prepare('SELECT product_id, delta FROM estoque_grupo_pendente').all();
    assert.deepEqual(fila, [{ product_id: ctx.cerveja, delta: 12 }]);
    assert.equal(estoque(ctx, ctx.cerveja), -3, 'aqui só sobra a venda (o estoque agora é o do servidor)');
    assert.equal(politica.previaUnificacao().produtos.length, 0, 'não leva de novo');
    assert.equal(politica.unificarNoServidor({ requestingUserId: ctx.gerenteId }).enviados.length, 0);
  });
  trocar(syncState, 'getGrupoSincronizacaoId', () => 'grupo-x', () => trocar(syncState, 'ehServidorDoGrupo', () => true, () => {
    assert.equal(politica.previaUnificacao().pode, false, 'o servidor já é o estoque do grupo');
  }));
});

// ------------------------------------------------------------ transferência de mesa

function mesaAberta(ctx, n = '1') {
  addStock(ctx.db, { productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.operadorId });
  const { saleId } = tableService.openTable({ tableId: ctx.mesas[n], locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 3 });
  saleService.addItem({ saleId, productId: ctx.cerveja, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: DEV, pessoaNumero: 2 });
  return saleId;
}

test('transferir: a comanda (itens, pessoas) vai inteira, a origem fica para limpar e aponta para o destino', () => {
  const ctx = loja();
  const saleId = mesaAberta(ctx);
  const r = tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['2'], operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.saleId, saleId);
  assert.deepEqual([ctx.mesa('2').status, ctx.mesa('2').sale_id, ctx.mesa('2').pessoas], ['ocupada', saleId, 3]);
  assert.deepEqual([ctx.mesa('1').status, ctx.mesa('1').sale_id, ctx.mesa('1').transferida_para_id], ['aguardando_limpeza', null, ctx.mesas['2']]);
  assert.equal(tableService.getTableCart(saleId).items.length, 1);
  assert.match(tableService.openTable({ tableId: ctx.mesas['1'], locationId: ctx.locationId, operadorId: ctx.operadorId }).error, /transferida para Mesa 2/);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'mesa_transferida' AND motivo LIKE 'Mesa 1 -> Mesa 2%'").get());

  // Limpou: some o apontamento; abre normal.
  assert.equal(tableService.markCleaned(ctx.mesas['1']).ok, true);
  assert.equal(ctx.mesa('1').transferida_para_id, null);
  assert.equal(tableService.openTable({ tableId: ctx.mesas['1'], locationId: ctx.locationId, operadorId: ctx.operadorId }).ok, true);
});

test('transferir: recusa com motivo claro (destino ocupado/reservado, mesma mesa, comanda fechada, sendo paga)', () => {
  const ctx = loja();
  mesaAberta(ctx, '1');
  mesaAberta(ctx, '2');
  assert.match(tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['2'] }).error, /Mesa 2 está ocupada/);
  assert.match(tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['1'] }).error, /outra mesa/);
  tableService.markReserved(ctx.mesas['3'], '2026-12-01T20:00');
  assert.match(tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['3'] }).error, /reservada/);
  tableService.cancelReservation(ctx.mesas['3']);
  ctx.db.prepare("UPDATE restaurant_tables SET fechando_caixa_id = 'cx2', fechando_caixa_nome = 'Caixa 2' WHERE id = ?").run(ctx.mesas['1']);
  assert.match(tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['3'] }).error, /sendo paga no Caixa 2/);
  assert.equal(ctx.mesa('1').status, 'ocupada', 'nada mudou');
  assert.equal(ctx.mesa('3').status, 'livre');
});

test('transferir: pedido do QR esperando vai junto; e o que chega depois pelo QR da mesa antiga entra na nova', () => {
  const ctx = loja();
  const mesaLocal = require('../electron/services/mesaLocalService');
  const botOrder = require('../electron/services/botOrderService');
  ctx.db.prepare("UPDATE restaurant_tables SET qr_token = 'AbCdEfGhIjKlMnOpQrStUv12' WHERE id = ?").run(ctx.mesas['1']);
  const saleId = mesaAberta(ctx);
  // Desliga o aceite sozinho para o pedido ficar esperando.
  ctx.db.prepare('UPDATE vitrine_config SET aceitar_mesa_aberta = 0').run();
  ctx.db.prepare("INSERT OR IGNORE INTO vitrine_config (id, aceitar_mesa_aberta) VALUES ('default', 0)").run();
  const esperando = mesaLocal.criarPedido({ token: 'AbCdEfGhIjKlMnOpQrStUv12', pedidoId: 'pedidoEsperando0001', nome: 'Ana', itens: [{ produtoId: ctx.cerveja, quantidade: 1 }] });
  assert.equal(esperando.ok, true, esperando.error);

  const t = tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['3'] });
  assert.equal(t.ok, true, t.error);
  assert.equal(t.pedidosMovidos, 1);
  assert.equal(ctx.db.prepare('SELECT mesa_numero FROM bot_orders WHERE id = ?').get(esperando.id).mesa_numero, '3');
  const a = botOrder.lancarPedidoNaMesa({ orderId: esperando.id, operadorId: ctx.operadorId, deviceId: 'pc' });
  assert.equal(a.ok, true, a.error);
  assert.equal(a.saleId, saleId);

  // Cliente com a página da mesa 1 ainda aberta pede de novo.
  const depois = mesaLocal.criarPedido({ token: 'AbCdEfGhIjKlMnOpQrStUv12', pedidoId: 'pedidoDepois0000001', nome: 'Ana', itens: [{ produtoId: ctx.cerveja, quantidade: 1 }] });
  assert.equal(depois.ok, true, depois.error);
  const b = botOrder.lancarPedidoNaMesa({ orderId: depois.id, operadorId: ctx.operadorId, deviceId: 'pc' });
  assert.equal(b.ok, true, b.error);
  assert.equal(b.saleId, saleId, 'entrou na comanda que foi para a Mesa 3');
  assert.equal(ctx.mesa('1').status, 'aguardando_limpeza', 'a mesa antiga não reabre sozinha');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM sales WHERE status = ?').get('aberta').n, 1, 'nenhuma comanda nova');
});

test('transferir duas vezes: a primeira mesa aponta para a última', () => {
  const ctx = loja();
  const saleId = mesaAberta(ctx);
  assert.equal(tableService.transferTable({ fromTableId: ctx.mesas['1'], toTableId: ctx.mesas['2'] }).ok, true);
  assert.equal(tableService.transferTable({ fromTableId: ctx.mesas['2'], toTableId: ctx.mesas['3'] }).ok, true);
  assert.equal(tableService.destinoDaTransferencia(ctx.db, ctx.mesa('1')).id, ctx.mesas['3']);
  assert.equal(ctx.mesa('3').sale_id, saleId);
  // Pagou e fechou: ninguém aponta mais para lá.
  tableService.releaseTable(ctx.mesas['3']);
  assert.equal(tableService.destinoDaTransferencia(ctx.db, ctx.mesa('1')), null);
});
