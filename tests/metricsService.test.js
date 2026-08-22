const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const metricsService = require('../electron/services/metricsService');

function inserirVendaFinalizada(db, { locationId, operadorId }, finalizadaEmUtc) {
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, finalizada_em) VALUES (?, ?, ?, 'finalizada', 10, ?)`
  ).run(randomUUID(), locationId, operadorId, finalizadaEmUtc);
}

/**
 * vendasUltimos30Dias foi reescrito pra um filtro sargable (comparação
 * direta de timestamp UTC em vez de embrulhar a coluna finalizada_em numa
 * função). Confere que a contagem de "últimos 30 dias" continua correta:
 * uma venda de 10 dias atrás entra, uma de 40 dias atrás não.
 */
test('getMetricasAgregadas conta corretamente vendas finalizadas nos últimos 30 dias', () => {
  const { db, locationId, operadorId } = freshTestDb();

  const agora = Date.now();
  const dez_dias_atras = new Date(agora - 10 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const quarenta_dias_atras = new Date(agora - 40 * 86400000).toISOString().slice(0, 19).replace('T', ' ');

  inserirVendaFinalizada(db, { locationId, operadorId }, dez_dias_atras);
  inserirVendaFinalizada(db, { locationId, operadorId }, quarenta_dias_atras);

  const metricas = metricsService.getMetricasAgregadas();
  assert.equal(metricas.totalVendasHistorico, 2);
  assert.equal(metricas.vendasUltimos30Dias, 1);
});
