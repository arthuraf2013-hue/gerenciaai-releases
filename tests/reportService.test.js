const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const customerService = require('../electron/services/customerService');
const reportService = require('../electron/services/reportService');

/**
 * getCustomerPurchaseReport tinha um bug pré-existente (`getDb` nunca
 * era importado no topo do arquivo) que quebrava a função com
 * "getDb is not defined" toda vez que alguém pedia esse relatório --
 * corrigido de passagem enquanto a query de data era otimizada pra
 * ficar sargable. Este teste garante que a função roda de verdade (não
 * só sintaticamente) e que o filtro de data continua correto nas
 * fronteiras do dia local (UTC-3).
 */
test('getCustomerPurchaseReport roda sem erro e soma só as compras dentro do intervalo local pedido', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Relatório' });
  const produtoId = createProduct(db, { preco: 10, categoria: 'Bebidas' });

  const inserirVenda = (finalizadaEmUtc, total) => {
    const saleId = randomUUID();
    db.prepare(
      `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em) VALUES (?, ?, ?, ?, 'finalizada', ?, ?)`
    ).run(saleId, locationId, operadorId, customerId, total, finalizadaEmUtc);
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, 1, ?)`
    ).run(randomUUID(), saleId, produtoId, total);
  };

  inserirVenda('2026-07-31 02:59:59', 999); // fora (30/07 local)
  inserirVenda('2026-08-15 12:00:00', 30); // dentro
  inserirVenda('2026-09-01 03:00:00', 999); // fora (01/09 local)

  const relatorio = reportService.getCustomerPurchaseReport({ customerId, dataInicio: '2026-08-01', dataFim: '2026-08-31' });
  assert.equal(relatorio.ok, true);
  assert.equal(relatorio.totalPedidos, 1);
  assert.equal(relatorio.totalGasto, 30);
});

test('getCustomerPurchaseReport devolve erro claro pra cliente inexistente (não quebra)', () => {
  freshTestDb();
  const relatorio = reportService.getCustomerPurchaseReport({ customerId: 'cliente-que-nao-existe', dataInicio: '2026-08-01', dataFim: '2026-08-31' });
  assert.equal(relatorio.ok, false);
});
