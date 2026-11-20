const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const stockSyncService = require('../electron/services/stockSyncService');

// Mesa do servidor lançada por um caixa: o estoque que vale é o do grupo,
// não só o do servidor (que pode estar zerado enquanto o grupo tem).
function cenario() {
  const { db, locationId, operadorId } = freshTestDb();
  const produto = createProduct(db, { nome: 'Brahma Latão', preco: 8 });
  const venda = saleService.openSale({ locationId, operadorId });
  return { db, locationId, operadorId, produto, saleId: venda.id };
}

function comSaldoDoGrupo(saldo, fn) {
  const original = stockSyncService.saldoDoGrupoNoServidor;
  stockSyncService.saldoDoGrupoNoServidor = () => saldo;
  try { return fn(); } finally { stockSyncService.saldoDoGrupoNoServidor = original; }
}

test('servidor zerado, grupo com estoque: o caixa consegue lançar', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  comSaldoDoGrupo(5, () => {
    const r = saleService.addItem({ saleId, productId: produto, locationId, quantidade: 2, operadorId, deviceId: 'device-teste', conferirGrupo: true });
    assert.equal(r.ok, true);
  });
});

test('servidor zerado e grupo sem o suficiente: bloqueia e fala do grupo', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  comSaldoDoGrupo(1, () => {
    const r = saleService.addItem({ saleId, productId: produto, locationId, quantidade: 2, operadorId, deviceId: 'device-teste', conferirGrupo: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /no grupo\. Disponível: 1/);
  });
});

test('sem contador no grupo (ou fora de grupo): continua valendo o estoque do servidor', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  comSaldoDoGrupo(null, () => {
    const r = saleService.addItem({ saleId, productId: produto, locationId, quantidade: 1, operadorId, deviceId: 'device-teste', conferirGrupo: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /Estoque insuficiente\. Disponível: 0/);
  });
});

test('venda comum (sem conferirGrupo) não muda: só olha o estoque local', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  comSaldoDoGrupo(99, () => {
    assert.equal(saleService.addItem({ saleId, productId: produto, locationId, quantidade: 1, operadorId }).ok, false);
  });
});

test('+ do carrinho pelo caixa também confere o grupo', () => {
  const { db, locationId, operadorId, produto, saleId } = cenario();
  addStock(db, { productId: produto, locationId, quantidade: 1, operadorId });
  assert.equal(saleService.addItem({ saleId, productId: produto, locationId, quantidade: 1, operadorId, deviceId: 'device-teste' }).ok, true);
  const item = db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(saleId);
  comSaldoDoGrupo(3, () => {
    assert.equal(saleService.ajustarQuantidadeItem({ saleId, saleItemId: item.id, delta: 1, locationId, operadorId, deviceId: 'device-teste', conferirGrupo: true }).ok, true);
  });
  comSaldoDoGrupo(0, () => {
    assert.equal(saleService.ajustarQuantidadeItem({ saleId, saleItemId: item.id, delta: 1, locationId, operadorId, deviceId: 'device-teste', conferirGrupo: true }).ok, false);
  });
});
