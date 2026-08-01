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

  const vendasUltimos30Dias = db.prepare(
    `SELECT COUNT(*) as c FROM sales WHERE status = 'finalizada' AND date(finalizada_em) >= date('now', '-30 days')`
  ).get().c;

  const perfilAtivo = db.prepare(`SELECT perfil_ativo FROM business_profile WHERE id = ?`).get('default');

  return {
    totalVendasHistorico,
    vendasUltimos30Dias,
    perfilAtivo: perfilAtivo?.perfil_ativo || null,
  };
}

module.exports = { getMetricasAgregadas };
