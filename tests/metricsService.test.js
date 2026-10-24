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

// ---------------------------------------------------------------------
// Central "Crescimento": sinais de uso e relatório mensal
// ---------------------------------------------------------------------
{
  const { freshTestDb: novoBanco } = require('./helpers/testDb');
  const metrics = require('../electron/services/metricsService');
  const { randomUUID: uuid } = require('crypto');

  const venda = (ctx, finalizadaEm, { total = 10, desconto = 0, cliente = null, status = 'finalizada' } = {}) => ctx.db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, desconto, finalizada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), ctx.locationId, ctx.adminId, cliente, status, total, desconto, finalizadaEm);

  test('relatório do mês: fronteiras no fuso de Brasília, só vendas finalizadas, líquido de desconto', () => {
    const ctx = novoBanco();
    ctx.db.prepare(`INSERT INTO customers (id, nome) VALUES ('c1', 'Ana')`).run();
    venda(ctx, '2026-09-01 02:59:00', { total: 99 }); // 31/08 23:59 em Brasília: fora de setembro
    venda(ctx, '2026-09-01 03:00:00', { total: 100, desconto: 10, cliente: 'c1' });
    venda(ctx, '2026-10-01 02:59:59', { total: 50 }); // 30/09 23:59:59 em Brasília: dentro
    venda(ctx, '2026-10-01 03:00:00', { total: 77 }); // já é outubro
    venda(ctx, '2026-09-15 15:00:00', { total: 500, status: 'cancelada' });
    ctx.db.prepare(`INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, criado_em) VALUES ('m1', 'c1', 'pagamento', 25, '2026-09-10 12:00:00')`).run();

    const r = metrics.relatorioDoMes('2026-09');
    assert.equal(r.vendas, 2);
    assert.equal(r.faturamento, 140);
    assert.equal(r.ticketMedio, 70);
    assert.equal(r.vendasComCliente, 1);
    assert.equal(r.clientesAtendidos, 1);
    assert.equal(r.fiadoRecebido, 25);
  });

  test('relatório do mês: campanha conta quem voltou em até 15 dias e quanto comprou', () => {
    const ctx = novoBanco();
    ctx.db.prepare(`INSERT INTO customers (id, nome) VALUES ('c1', 'Ana'), ('c2', 'Bia')`).run();
    ctx.db.prepare(`INSERT INTO campanha_envios (id, customer_id, tipo, enviado_em) VALUES ('e1', 'c1', 'reconquista', '2026-09-05 12:00:00'), ('e2', 'c2', 'reconquista', '2026-09-05 12:00:00')`).run();
    venda(ctx, '2026-09-10 12:00:00', { total: 80, cliente: 'c1' });
    venda(ctx, '2026-09-30 12:00:00', { total: 60, cliente: 'c2' }); // depois de 15 dias: não conta
    const r = metrics.relatorioDoMes('2026-09');
    assert.equal(r.campanhasEnviadas, 2);
    assert.equal(r.campanhasVoltaram, 1);
    assert.equal(r.campanhasReceita, 80);
  });

  test('mês anterior vira o ano em janeiro', () => {
    const timeService = require('../electron/services/timeService');
    const original = timeService.hojeLocalISO;
    try {
      timeService.hojeLocalISO = () => '2027-01-03';
      assert.equal(metrics.mesAnterior(), '2026-12');
    } finally {
      timeService.hojeLocalISO = original;
    }
  });

  test('sinais de uso: produtos, vendas de 7 e 30 dias, 30 dias anteriores e dias com venda', () => {
    const ctx = novoBanco();
    const timeService = require('../electron/services/timeService');
    const atras = (dias, horas = 0) => timeService.utcSqlAtras({ dias, horas });
    venda(ctx, atras(1), { total: 30 });
    venda(ctx, atras(1, 1), { total: 20 });
    venda(ctx, atras(10), { total: 50 });
    venda(ctx, atras(45), { total: 70 });
    ctx.db.prepare(`INSERT INTO products (id, nome, preco) VALUES ('p1', 'A', 1), ('p2', 'B', 1)`).run();
    const u = metrics.metricasDeUso();
    assert.equal(u.produtosCadastrados, 2);
    assert.equal(u.vendas7Dias, 2);
    assert.equal(u.faturamento30Dias, 100);
    assert.equal(u.ticketMedio30Dias, 33.33);
    assert.equal(u.vendasAnteriores30Dias, 1);
    assert.equal(u.faturamentoAnterior30Dias, 70);
    assert.ok(u.diasComVenda30 >= 2 && u.diasComVenda30 <= 3);
    assert.ok(u.primeiraVendaEm);
  });
}
