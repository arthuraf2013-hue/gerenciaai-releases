const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const dashboardService = require('../electron/services/dashboardService');

/**
 * dashboardService foi reescrito pra usar filtros sargable
 * (col >= inicioUtc AND col < fimUtcExclusivo) em vez de
 * `date(col, '-3 hours') BETWEEN date(?) AND date(?)`. Estes testes
 * travam o comportamento exatamente nas fronteiras do dia local
 * (UTC-3), que é onde um erro de limite passaria despercebido.
 */
function inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc, total = 10, produtoId, precoUnitario = 10 }) {
  const saleId = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, finalizada_em) VALUES (?, ?, ?, 'finalizada', ?, ?)`
  ).run(saleId, locationId, operadorId, total, finalizadaEmUtc);
  db.prepare(
    `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, 1, ?)`
  ).run(randomUUID(), saleId, produtoId, precoUnitario);
  return saleId;
}

test('getSummary inclui vendas no primeiro e no último instante do dia local pedido, exclui os vizinhos', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 10 });

  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: '2026-07-31 02:59:59', produtoId }); // fora (30/07 local)
  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: '2026-07-31 03:00:00', produtoId }); // dentro (31/07 00:00 local)
  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: '2026-09-01 02:59:59', produtoId }); // dentro (31/08 23:59:59 local)
  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: '2026-09-01 03:00:00', produtoId }); // fora (01/09 local)

  const resumo = dashboardService.getSummary({ locationId, dataInicio: '2026-07-31', dataFim: '2026-08-31' });
  assert.equal(resumo.totalVendas, 2);
  assert.equal(resumo.totalFaturado, 20);
});

test('getSummary não conta venda de outro local nem venda ainda aberta', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 10 });
  const outroLocationId = randomUUID();
  db.prepare(`INSERT INTO locations (id, nome, tipo) VALUES (?, 'Outra loja', 'loja')`).run(outroLocationId);

  inserirVendaFinalizada(db, { locationId: outroLocationId, operadorId, finalizadaEmUtc: '2026-08-15 12:00:00', produtoId });
  const abertaId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES (?, ?, ?, 'aberta', 10)`).run(abertaId, locationId, operadorId);

  const resumo = dashboardService.getSummary({ locationId, dataInicio: '2026-08-01', dataFim: '2026-08-31' });
  assert.equal(resumo.totalVendas, 0);
  assert.equal(resumo.totalFaturado, 0);
});

test('getResultadoSimples soma despesas só dentro do intervalo local pedido', () => {
  const { db, locationId } = freshTestDb();
  db.prepare(
    `INSERT INTO expenses (id, categoria, descricao, valor, location_id, operador_id, criado_em) VALUES (?, 'outro', 'x', 50, ?, (SELECT id FROM users LIMIT 1), ?)`
  ).run(randomUUID(), locationId, '2026-08-15 12:00:00'); // dentro
  db.prepare(
    `INSERT INTO expenses (id, categoria, descricao, valor, location_id, operador_id, criado_em) VALUES (?, 'outro', 'y', 999, ?, (SELECT id FROM users LIMIT 1), ?)`
  ).run(randomUUID(), locationId, '2026-09-01 03:00:00'); // fora (01/09 local)

  const resultado = dashboardService.getResultadoSimples({ locationId, dataInicio: '2026-08-01', dataFim: '2026-08-31' });
  assert.equal(resultado.despesas, 50);
});
