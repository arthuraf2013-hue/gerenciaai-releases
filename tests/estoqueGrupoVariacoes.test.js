const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const stockService = require('../electron/services/stockService');
const returnService = require('../electron/services/returnService');
const stockSyncService = require('../electron/services/stockSyncService');

// Firestore falso com o MESMO comportamento do backend de verdade:
// contador por produto + livro de movimentos (id aplicado uma vez só) +
// débito atômico na finalização.
function grupoFalso() {
  const contador = new Map();
  const movimentos = new Set();
  let foraDoAr = false;
  return {
    contador, movimentos,
    derrubar(v = true) { foraDoAr = v; },
    async aplicarMovimento({ productId, movimentoId, delta }) {
      if (foraDoAr) throw new Error('sem internet');
      if (movimentos.has(movimentoId)) return;
      movimentos.add(movimentoId);
      contador.set(productId, (contador.get(productId) || 0) + delta);
    },
    async verificarEDebitar({ porProduto }) {
      if (foraDoAr) return { ok: false, motivo: 'rede', error: 'sem internet' };
      for (const [id, p] of porProduto) if ((contador.get(id) || 0) < p.quantidade) return { ok: false, motivo: 'estoque_insuficiente', error: 'falta' };
      for (const [id, p] of porProduto) contador.set(id, contador.get(id) - p.quantidade);
      return { ok: true, debitado: true };
    },
  };
}

function entrarNoGrupo(db, { servidor }) {
  db.prepare(`UPDATE sync_state SET grupo_sincronizacao_id = 'grupo-1', servidor_do_grupo = ? WHERE id = 'default'`).run(servidor ? 1 : 0);
}

function venderUm(ctx, productId, preco = 10) {
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: preco, detalhes: {} });
  return saleId;
}

test('defeito corrigido: entrada no servidor SOMA ao contador em vez de regravar o total local', async () => {
  const ctx = freshTestDb();
  const g = grupoFalso();
  stockSyncService._definirBackendParaTeste(g);
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  entrarNoGrupo(ctx.db, { servidor: true });
  g.contador.set(productId, 10); // retrato inicial do servidor

  // Outra máquina do grupo vendeu 3 (só o contador sabe disso).
  await g.verificarEDebitar({ porProduto: new Map([[productId, { quantidade: 3 }]]) });
  assert.equal(g.contador.get(productId), 7);

  // Servidor recebe 5 unidades. Antes: contador = total local (15). Real: 12.
  stockService.adjustStock({ productId, locationId: ctx.locationId, quantidade: 5, tipo: 'entrada', operadorId: ctx.adminId, deviceId: 'd' });
  await stockSyncService.enviarVariacoesPendentes();
  assert.equal(g.contador.get(productId), 12);
  assert.equal(stockSyncService.contarVariacoesPendentes(), 0);
});

test('sem internet a variação fica na fila, na ordem, e entra uma vez só quando volta', async () => {
  const ctx = freshTestDb();
  const g = grupoFalso();
  stockSyncService._definirBackendParaTeste(g);
  const productId = createProduct(ctx.db, { preco: 10 });
  entrarNoGrupo(ctx.db, { servidor: true });
  g.contador.set(productId, 0);
  g.derrubar(true);
  stockService.adjustStock({ productId, locationId: ctx.locationId, quantidade: 4, tipo: 'entrada', operadorId: ctx.adminId, deviceId: 'd' });
  stockService.adjustStock({ productId, locationId: ctx.locationId, quantidade: -1, tipo: 'perda', operadorId: ctx.adminId, deviceId: 'd' });
  await stockSyncService.enviarVariacoesPendentes();
  assert.equal(stockSyncService.contarVariacoesPendentes(), 2);
  const erro = ctx.db.prepare('SELECT tentativas, ultimo_erro FROM estoque_grupo_pendente ORDER BY criado_em, rowid LIMIT 1').get();
  assert.equal(erro.tentativas, 1);
  assert.match(erro.ultimo_erro, /internet/);
  g.derrubar(false);
  await stockSyncService.enviarVariacoesPendentes();
  await stockSyncService.enviarVariacoesPendentes(); // repetir não soma de novo
  assert.equal(g.contador.get(productId), 3);
});

test('máquina que não é servidor não mexe no contador ao ajustar estoque local', async () => {
  const ctx = freshTestDb();
  stockSyncService._definirBackendParaTeste(grupoFalso());
  const productId = createProduct(ctx.db, { preco: 10 });
  entrarNoGrupo(ctx.db, { servidor: false });
  stockService.adjustStock({ productId, locationId: ctx.locationId, quantidade: 5, tipo: 'entrada', operadorId: ctx.adminId, deviceId: 'd' });
  assert.equal(stockSyncService.contarVariacoesPendentes(), 0);
});

test('venda finalizada no grupo marca o débito; devolução dela devolve ao contador mesmo fora do servidor', async () => {
  const ctx = freshTestDb();
  const g = grupoFalso();
  stockSyncService._definirBackendParaTeste(g);
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  entrarNoGrupo(ctx.db, { servidor: false });
  g.contador.set(productId, 5);

  const saleId = venderUm(ctx, productId);
  const r = await saleService.finalizeSaleComVerificacaoDeGrupo(saleId);
  assert.equal(r.ok, true);
  assert.equal(g.contador.get(productId), 4);
  assert.equal(ctx.db.prepare('SELECT estoque_grupo_debitado AS d FROM sales WHERE id = ?').get(saleId).d, 1);

  const saleItemId = ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(saleId).id;
  const dev = returnService.createReturn({
    saleId, locationId: ctx.locationId, itens: [{ saleItemId, quantidade: 1 }], motivo: 'defeito',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(dev.ok, true, dev.error);
  await stockSyncService.enviarVariacoesPendentes();
  assert.equal(g.contador.get(productId), 5);
});

test('venda de antes do grupo devolvida numa máquina que não é servidor não mexe no contador', async () => {
  const ctx = freshTestDb();
  const g = grupoFalso();
  stockSyncService._definirBackendParaTeste(g);
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  const saleId = venderUm(ctx, productId);
  assert.equal(saleService.finalizeSale(saleId).ok, true); // sem grupo ainda
  entrarNoGrupo(ctx.db, { servidor: false });
  const saleItemId = ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(saleId).id;
  const dev = returnService.createReturn({
    saleId, locationId: ctx.locationId, itens: [{ saleItemId, quantidade: 1 }], motivo: 'x',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(dev.ok, true, dev.error);
  assert.equal(stockSyncService.contarVariacoesPendentes(), 0);
});

test('débito feito mas finalização recusada (pagamento faltando): o débito volta pro contador', async () => {
  const ctx = freshTestDb();
  const g = grupoFalso();
  stockSyncService._definirBackendParaTeste(g);
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  entrarNoGrupo(ctx.db, { servidor: false });
  g.contador.set(productId, 5);
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: 'd' });
  // sem pagamento
  const r = await saleService.finalizeSaleComVerificacaoDeGrupo(saleId);
  assert.equal(r.ok, false);
  await stockSyncService.enviarVariacoesPendentes();
  assert.equal(g.contador.get(productId), 5);
  assert.equal(ctx.db.prepare('SELECT estoque_grupo_debitado AS d FROM sales WHERE id = ?').get(saleId).d, 0);
});

test('cancelar item de venda ABERTA não mexe no contador (ele só é debitado na finalização)', async () => {
  const ctx = freshTestDb();
  stockSyncService._definirBackendParaTeste(grupoFalso());
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  entrarNoGrupo(ctx.db, { servidor: true });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  const saleItemId = ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(saleId).id;
  const r = saleService.cancelSaleItem({ saleId, saleItemId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(stockSyncService.contarVariacoesPendentes(), 0);
});
