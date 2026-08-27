const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const returnService = require('../electron/services/returnService');
const stockService = require('../electron/services/stockService');

function vendaFinalizadaComItem(ctx, { quantidadeVenda = 2, preco = 10, tipo = 'produto' } = {}) {
  const productId = createProduct(ctx.db, { preco, tipo });
  if (tipo !== 'servico') addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
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

/**
 * listReturns foi reescrito para um filtro sargable (comparação direta de
 * timestamp UTC em vez de `date(criado_em, '-3 hours') BETWEEN ...`). Este
 * teste confere que as fronteiras do dia local (UTC-3, sem horário de
 * verão) continuam corretas: pedindo o período local 31/07 a 31/08, só as
 * devoluções cujo instante UTC cai dentro desse intervalo local devem
 * aparecer.
 */
test('listReturns respeita as fronteiras do dia local (UTC-3) no filtro de data', () => {
  const ctx = vendaFinalizadaComItem(freshTestDb(), { quantidadeVenda: 4 });

  const inserirReturn = (criadoEmUtc) => {
    ctx.db.prepare(
      `INSERT INTO returns (id, sale_id, location_id, operador_id, autorizado_por_id, motivo, valor_devolvido, criado_em)
       VALUES (?, ?, ?, ?, ?, 'teste', 0, ?)`
    ).run(randomUUID(), ctx.saleId, ctx.locationId, ctx.operadorId, ctx.gerenteId, criadoEmUtc);
  };

  inserirReturn('2026-07-31 02:59:59'); // 30/07 local — fora
  inserirReturn('2026-07-31 03:00:00'); // 31/07 00:00 local — dentro (início)
  inserirReturn('2026-09-01 02:59:59'); // 31/08 23:59:59 local — dentro (fim)
  inserirReturn('2026-09-01 03:00:00'); // 01/09 local — fora

  const resultado = returnService.listReturns({ locationId: ctx.locationId, dataInicio: '2026-07-31', dataFim: '2026-08-31' });
  assert.equal(resultado.length, 2);
  assert.ok(resultado.every((r) => r.criado_em === '2026-07-31 03:00:00' || r.criado_em === '2026-09-01 02:59:59'));
});

test('devolução de item de serviço não inventa uma entrada de estoque (nunca teve saída)', () => {
  const ctx = vendaFinalizadaComItem(freshTestDb(), { quantidadeVenda: 1, preco: 80, tipo: 'servico' });

  const result = returnService.createReturn({
    saleId: ctx.saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: ctx.saleItemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });

  assert.equal(result.ok, true);
  assert.equal(result.valorDevolvido, 80);
  const movimentos = ctx.db.prepare('SELECT COUNT(*) as c FROM stock_movements WHERE product_id = ?').get(ctx.productId).c;
  assert.equal(movimentos, 0, 'devolver serviço não deveria criar stock_movements de entrada');
});
