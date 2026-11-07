const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');

// "Venda travada, não permite limpar a mesa": a conta foi paga, mas a mesa
// continuou ocupada apontando para a venda já finalizada (saiu da tela por
// "Voltar ao pedido" em vez de "Concluir"). Pagar de novo dava "Esta venda
// não está mais aberta" e a mesa não limpava.

function mesaPaga() {
  const ctx = freshTestDb();
  const mesas = {};
  for (const n of ['1', '2']) mesas[n] = tableService.createTable({ locationId: ctx.locationId, numero: n }).id;
  const prato = createProduct(ctx.db, { nome: 'Salada Caesar', preco: 27.9 });
  addStock(ctx.db, { productId: prato, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.adminId });
  const saleId = tableService.openTable({ tableId: mesas['1'], locationId: ctx.locationId, operadorId: ctx.operadorId }).saleId;
  assert.equal(saleService.addItem({ saleId, productId: prato, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 't' }).ok, true);
  assert.equal(tableService.juntarMesas({ tableId: mesas['1'], mesaIds: [mesas['2']], currentOperatorId: ctx.adminId }).ok, true);
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 27.9 });
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  const mesa = (n) => ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesas[n]);
  return { ...ctx, mesas, saleId, mesa };
}

test('mesa presa em conta já paga se solta sozinha ao listar (e as unidas junto)', () => {
  const { mesa, saleId, locationId } = mesaPaga();
  assert.equal(mesa('1').status, 'ocupada', 'cenário: ficou presa');
  assert.equal(saleService.getPaymentState(saleId).status, 'finalizada');
  const lista = tableService.listTables(locationId);
  assert.equal(lista.find((m) => m.numero === '1').status, 'aguardando_limpeza');
  assert.equal(mesa('2').status, 'aguardando_limpeza');
  assert.equal(mesa('2').unida_a_mesa_id, null);
  assert.equal(tableService.markCleaned(mesa('1').id).ok, true);
});

test('pagar a comanda libera a mesa na hora; reabrir não volta para a venda paga', () => {
  const { mesa, mesas, saleId, locationId, operadorId } = mesaPaga();
  assert.deepEqual(tableService.liberarMesaDaVenda(saleId), { ok: true, liberou: true });
  assert.equal(mesa('1').status, 'aguardando_limpeza');
  assert.equal(tableService.liberarMesaDaVenda(saleId).liberou, false, 'idempotente');
  const r = tableService.openTable({ tableId: mesas['1'], locationId, operadorId });
  assert.equal(r.ok, false);
  assert.match(r.error, /aguardando limpeza/);
});

test('desocupar mesa com conta já paga só solta a mesa: nunca cancela a venda paga', () => {
  const { db, mesa, mesas, saleId, locationId, adminId } = mesaPaga();
  const r = tableService.desocuparMesa({ tableId: mesas['1'], locationId, currentOperatorId: adminId, motivo: 'travou' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.statusFinal, 'aguardando_limpeza');
  assert.equal(db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId).status, 'finalizada');
  assert.equal(mesa('1').sale_id, null);
});

test('mesa com comanda aberta continua ocupada (o conserto não mexe em conta em andamento)', () => {
  const ctx = freshTestDb();
  const id = tableService.createTable({ locationId: ctx.locationId, numero: '9' }).id;
  tableService.openTable({ tableId: id, locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.equal(tableService.repararMesasComVendaFechada(ctx.db), 0);
  assert.equal(tableService.listTables(ctx.locationId)[0].status, 'ocupada');
});
