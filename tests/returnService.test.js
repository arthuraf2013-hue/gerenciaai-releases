const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const returnService = require('../electron/services/returnService');
const stockService = require('../electron/services/stockService');

function vendaFinalizadaComItem(ctx, { quantidadeVenda = 2, preco = 10 } = {}) {
  const productId = createProduct(ctx.db, { preco });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const addResult = saleService.addItem({
    saleId, productId, locationId: ctx.locationId, quantidade: quantidadeVenda,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: preco * quantidadeVenda, detalhes: {} });
  saleService.finalizeSale(saleId);
  return { ...ctx, productId, saleId, saleItemId: addResult.itemId };
}

test('devolução recusa quantidade maior do que foi vendido', () => {
  const ctx = vendaFinalizadaComItem(freshTestDb(), { quantidadeVenda: 2 });
  const result = returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 5 }], // vendeu só 2
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(result.ok, false);
});

test('devolução recusa quantidade zero ou negativa', () => {
  const ctx = vendaFinalizadaComItem(freshTestDb(), { quantidadeVenda: 2 });
  const zero = returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 0 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(zero.ok, false);
});

test('devolução parcial acumulada não pode passar do total vendido', () => {
  const ctx = vendaFinalizadaComItem(freshTestDb(), { quantidadeVenda: 2 });

  const primeira = returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(primeira.ok, true);

  // já devolveu 1 de 2 — tentar devolver mais 2 (só resta 1) deve falhar
  const segunda = returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 2 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(segunda.ok, false);

  // devolver exatamente o que resta (1) deve funcionar
  const terceira = returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(terceira.ok, true);
});

test('devolução autorizada devolve o estoque corretamente', () => {
  const ctx = vendaFinalizadaComItem(freshTestDb(), { quantidadeVenda: 2 });
  const antes = stockService.getCurrentStock(ctx.productId, ctx.locationId); // 10 - 2 = 8

  returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });

  const depois = stockService.getCurrentStock(ctx.productId, ctx.locationId);
  assert.equal(depois, antes + 1);
});
