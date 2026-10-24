const { getDb } = require('../db/database');

/**
 * Só números agregados — NUNCA o conteúdo de uma venda específica
 * (produto, valor de uma venda, cliente). É reportado junto com o "sinal
 * de vida" de sempre (ultimoContato/versaoApp), pro painel de
 * licenciamento mostrar uma visão geral do negócio.
 *
 * Desde a Central "Crescimento": também vão TOTAIS de faturamento (30 dias
 * e do mês fechado) e o resumo mensal (`relatorioMensal`) -- usados no
 * funil do teste grátis, na nota de risco de cancelamento, no relatório
 * "quanto o GerenciaAI te rendeu" e na comparação anônima por segmento
 * (que só aparece com 5 lojas ou mais). Nenhum nome de cliente, produto ou
 * venda individual sai daqui.
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
    ...metricasDeUso(),
    relatorioMensal: relatorioDoMes(mesAnterior()),
  };
}

const arred2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** "AAAA-MM" do mês passado no fuso de Brasília. */
function mesAnterior() {
  const [ano, mes] = require('./timeService').hojeLocalISO().split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function limitesDoMes(anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return require('./timeService').localDateRangeToUtcBounds(`${anoMes}-01`, `${anoMes}-${String(ultimoDia).padStart(2, '0')}`);
}

/**
 * Sinais de uso para o funil do teste e a nota de risco: quantos produtos,
 * vendas e faturamento nos últimos 7/30 dias e nos 30 anteriores (queda
 * de uso), em quantos dias diferentes vendeu. Datas no fuso de Brasília.
 */
function metricasDeUso() {
  const db = getDb();
  const timeService = require('./timeService');
  const corte = (dias) => timeService.utcSqlAtras({ dias });
  const janela = db.prepare(
    `SELECT COUNT(*) AS vendas, COALESCE(SUM(total - desconto - desconto_gerente), 0) AS faturamento
     FROM sales WHERE status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  );
  const agora = timeService.nowSyncedUTCString();
  const ultimos30 = janela.get(corte(30), agora);
  const anteriores30 = janela.get(corte(60), corte(30));
  const ultimos7 = janela.get(corte(7), agora);
  const diasComVenda30 = db.prepare(
    `SELECT COUNT(DISTINCT date(finalizada_em, '-3 hours')) AS c FROM sales WHERE status = 'finalizada' AND finalizada_em >= ?`
  ).get(corte(30)).c;
  const produtosCadastrados = db.prepare(
    `SELECT COUNT(*) AS c FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') != 'servico'`
  ).get().c;
  const primeira = db.prepare(`SELECT MIN(finalizada_em) AS em FROM sales WHERE status = 'finalizada'`).get().em;
  return {
    produtosCadastrados,
    vendas7Dias: ultimos7.vendas,
    vendasAnteriores30Dias: anteriores30.vendas,
    faturamento30Dias: arred2(ultimos30.faturamento),
    faturamentoAnterior30Dias: arred2(anteriores30.faturamento),
    ticketMedio30Dias: ultimos30.vendas ? arred2(ultimos30.faturamento / ultimos30.vendas) : 0,
    diasComVenda30,
    primeiraVendaEm: primeira || null,
  };
}

/**
 * Resumo de um mês fechado para o relatório "quanto o GerenciaAI te
 * rendeu". Só o que o sistema mede de verdade: vendas, faturamento, ticket
 * médio, clientes identificados, retorno das campanhas automáticas (quem
 * voltou e quanto comprou em até 15 dias), fiado recebido, devoluções e
 * perdas registradas. Desconto por validade não entra: o item vendido em
 * promoção não fica marcado como tal, então "perda evitada" seria chute.
 */
function relatorioDoMes(anoMes) {
  const db = getDb();
  const { inicioUtc, fimUtcExclusivo } = limitesDoMes(anoMes);
  const umValor = (sql, ...params) => {
    try { return db.prepare(sql).get(...params); } catch { return null; }
  };
  const vendas = umValor(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total - desconto - desconto_gerente), 0) AS fat,
            COUNT(DISTINCT customer_id) AS clientes, SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END) AS comCliente
     FROM sales WHERE status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`, inicioUtc, fimUtcExclusivo,
  ) || { n: 0, fat: 0, clientes: 0, comCliente: 0 };
  const campanhas = umValor(
    `WITH primeiro AS (
       SELECT tipo, customer_id, MIN(enviado_em) AS enviado_em FROM campanha_envios
       WHERE enviado_em >= ? AND enviado_em < ? GROUP BY tipo, customer_id
     )
     SELECT COUNT(*) AS enviados,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = p.customer_id AND s.status = 'finalizada'
             AND s.finalizada_em > p.enviado_em AND s.finalizada_em <= datetime(p.enviado_em, '+15 days')) THEN 1 ELSE 0 END) AS voltaram,
       COALESCE(SUM((SELECT COALESCE(SUM(s.total - s.desconto - s.desconto_gerente), 0) FROM sales s WHERE s.customer_id = p.customer_id
             AND s.status = 'finalizada' AND s.finalizada_em > p.enviado_em AND s.finalizada_em <= datetime(p.enviado_em, '+15 days'))), 0) AS receita
     FROM primeiro p`, inicioUtc, fimUtcExclusivo,
  ) || { enviados: 0, voltaram: 0, receita: 0 };
  const fiado = umValor(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'pagamento' THEN valor ELSE 0 END), 0) AS recebido
     FROM customer_credit_movements WHERE criado_em >= ? AND criado_em < ?`, inicioUtc, fimUtcExclusivo,
  ) || { recebido: 0 };
  const devolucoes = umValor(
    `SELECT COUNT(*) AS n, COALESCE(SUM(valor_devolvido), 0) AS valor FROM returns WHERE criado_em >= ? AND criado_em < ?`, inicioUtc, fimUtcExclusivo,
  ) || { n: 0, valor: 0 };
  const perdas = umValor(`SELECT COUNT(*) AS n FROM waste_log WHERE criado_em >= ? AND criado_em < ?`, inicioUtc, fimUtcExclusivo) || { n: 0 };
  const celular = umValor(
    `SELECT COUNT(*) AS n FROM mobile_sales WHERE status = 'finalizada' AND criado_em >= ? AND criado_em < ?`, inicioUtc, fimUtcExclusivo,
  ) || { n: 0 };
  return {
    mes: anoMes,
    vendas: vendas.n,
    faturamento: arred2(vendas.fat),
    ticketMedio: vendas.n ? arred2(vendas.fat / vendas.n) : 0,
    vendasComCliente: vendas.comCliente || 0,
    clientesAtendidos: vendas.clientes || 0,
    campanhasEnviadas: campanhas.enviados || 0,
    campanhasVoltaram: campanhas.voltaram || 0,
    campanhasReceita: arred2(campanhas.receita),
    fiadoRecebido: arred2(fiado.recebido),
    devolucoes: devolucoes.n,
    devolucoesValor: arred2(devolucoes.valor),
    perdasRegistradas: perdas.n,
    vendasPeloCelular: celular.n,
  };
}

module.exports = { getMetricasAgregadas, metricasDeUso, relatorioDoMes, mesAnterior };
