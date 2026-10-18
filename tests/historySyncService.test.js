const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const historySyncService = require('../electron/services/historySyncService');

// Só getResumoPeriodo é testável localmente sem rede -- publicarHistorico e
// iniciarPublicacaoContinua dependem de Firestore de verdade (mesmo critério
// de tests/liveStatusSyncService.test.js / tests/userStatusSyncService.test.js).

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

test('getResumoPeriodo cobre "dias" dias incluindo hoje (últimos 7 = hoje + 6 anteriores)', () => {
  const { locationId } = freshTestDb();
  const resumo = historySyncService.getResumoPeriodo({ locationId, dias: 7 });

  const hoje = new Date(resumo.dataFim + 'T00:00:00Z');
  const inicio = new Date(resumo.dataInicio + 'T00:00:00Z');
  const diffDias = Math.round((hoje - inicio) / 86400000);
  assert.equal(diffDias, 6, 'dataInicio deveria ser 6 dias antes de dataFim (7 dias inclusive)');
});

test('getResumoPeriodo calcula ticketMedio corretamente e não divide por zero sem vendas', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 10 });

  const semVendas = historySyncService.getResumoPeriodo({ locationId, dias: 7 });
  assert.equal(semVendas.totalVendas, 0);
  assert.equal(semVendas.ticketMedio, 0, 'sem vendas, ticketMedio não pode ser NaN nem dividir por zero');

  const hoje = historySyncService.getResumoPeriodo({ locationId, dias: 7 }).dataFim;
  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: `${hoje} 15:00:00`, total: 20, produtoId });
  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: `${hoje} 16:00:00`, total: 30, produtoId });

  const comVendas = historySyncService.getResumoPeriodo({ locationId, dias: 7 });
  assert.equal(comVendas.totalVendas, 2);
  assert.equal(comVendas.totalFaturado, 50);
  assert.equal(comVendas.ticketMedio, 25);
});

test('getResumoPeriodo NUNCA inclui lucroBrutoEstimado/margemPorProduto (custo/margem é sensível demais pra sessão anônima do celular)', () => {
  const { locationId } = freshTestDb();
  const resumo = historySyncService.getResumoPeriodo({ locationId, dias: 30 });
  assert.deepEqual(
    Object.keys(resumo).sort(),
    ['dataFim', 'dataInicio', 'devolucoes', 'porMetodo', 'porOperador', 'ticketMedio', 'topProdutos', 'totalFaturado', 'totalVendas', 'vendasPorDia', 'vendasPorHora'].sort()
  );
});

test('getResumoPeriodo.porOperador só traz operador/totalVendas/totalVendido (sem id de usuário nem outro dado)', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 10 });
  const hoje = historySyncService.getResumoPeriodo({ locationId, dias: 7 }).dataFim;
  inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: `${hoje} 12:00:00`, total: 10, produtoId });

  const resumo = historySyncService.getResumoPeriodo({ locationId, dias: 7 });
  assert.equal(resumo.porOperador.length, 1);
  assert.deepEqual(Object.keys(resumo.porOperador[0]).sort(), ['operador', 'totalVendas', 'totalVendido']);
  assert.equal(resumo.porOperador[0].operador, 'Operador Teste');
});

test('PERIODOS define hoje, ultimos7 e ultimos30, e publicarHistorico usa os três pra montar o payload', () => {
  assert.deepEqual(historySyncService.PERIODOS, { hoje: 1, ultimos7: 7, ultimos30: 30 });
});

test('getResumoPeriodo: formas de pagamento no período e vendas por hora LOCAL só no período de hoje', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 10 });
  const hoje = historySyncService.getResumoPeriodo({ locationId, dias: 1 }).dataFim;
  const s1 = inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: `${hoje} 15:10:00`, total: 20, produtoId });
  const s2 = inserirVendaFinalizada(db, { locationId, operadorId, finalizadaEmUtc: `${hoje} 15:40:00`, total: 30, produtoId });
  db.prepare(`INSERT INTO payments (id, sale_id, metodo, valor) VALUES (?, ?, 'pix', 20)`).run(randomUUID(), s1);
  db.prepare(`INSERT INTO payments (id, sale_id, metodo, valor) VALUES (?, ?, 'dinheiro', 10)`).run(randomUUID(), s2);
  db.prepare(`INSERT INTO payments (id, sale_id, metodo, valor) VALUES (?, ?, 'pix', 20)`).run(randomUUID(), s2);

  const r = historySyncService.getResumoPeriodo({ locationId, dias: 1 });
  assert.deepEqual(r.porMetodo, [{ metodo: 'pix', total: 40 }, { metodo: 'dinheiro', total: 10 }]);
  // 15h UTC = 12h em Brasília.
  assert.deepEqual(r.vendasPorHora, [{ hora: 12, vendas: 2, total: 50 }]);
  assert.deepEqual(historySyncService.getResumoPeriodo({ locationId, dias: 7 }).vendasPorHora, []);
});
