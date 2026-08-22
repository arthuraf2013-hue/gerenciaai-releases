const { getDb } = require('../db/database');

/**
 * Só contagens agregadas — NUNCA o conteúdo de uma venda específica
 * (produto, valor, cliente). É reportado junto com o "sinal de vida"
 * de sempre (ultimoContato/versaoApp), pro painel de licenciamento
 * mostrar uma visão geral do negócio sem expor nada sensível de
 * nenhum cliente individual.
 */
function getMetricasAgregadas() {
  const db = getDb();

  const totalVendasHistorico = db.prepare(
    `SELECT COUNT(*) as c FROM sales WHERE status = 'finalizada'`
  ).get().c;

  // Sargable -- ver o mesmo comentário em timeService.js/dashboardService.js.
  // Equivalente exato de `date(finalizada_em,'-3h') >= date('now','-30 days')`:
  // em vez de embrulhar a COLUNA numa função (o que impede o uso de índice),
  // desloca o LIMITE (uma constante, calculada uma vez) +3h pro fuso UTC em
  // que finalizada_em é gravado, e compara a coluna crua com ele.
  const vendasUltimos30Dias = db.prepare(
    `SELECT COUNT(*) as c FROM sales WHERE status = 'finalizada' AND finalizada_em >= (date('now', '-30 days') || ' 03:00:00')`
  ).get().c;

  const perfilAtivo = db.prepare(`SELECT perfil_ativo FROM business_profile WHERE id = ?`).get('default');

  // Quantos produtos estão com conflito de código de barras pendente
  // de resolver — dá pra você ver no painel sem precisar entrar em
  // cada máquina uma por uma pra descobrir.
  const conflitosCodigoBarrasPendentes = db.prepare(
    `SELECT COUNT(*) as c FROM products WHERE conflito_codigo_barras_pendente IS NOT NULL`
  ).get().c;

  return {
    totalVendasHistorico,
    vendasUltimos30Dias,
    perfilAtivo: perfilAtivo?.perfil_ativo || null,
    conflitosCodigoBarrasPendentes,
  };
}

module.exports = { getMetricasAgregadas };
