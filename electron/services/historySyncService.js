const { getDb } = require('../db/database');
const timeService = require('./timeService');
const dashboardService = require('./dashboardService');

// Igual liveStatusSyncService/userStatusSyncService: best-effort,
// intervalo bem mais espaçado que o status ao vivo (25s) -- histórico
// não precisa ser "quase tempo real" pra ser útil numa consulta remota,
// e as consultas daqui (JOIN com sale_items/products, agrupamento por
// dia/operador) são mais pesadas que o resumo do dia sozinho.
const INTERVALO_PUBLICACAO_MS = 10 * 60 * 1000;

// 'hoje' entrou junto com o painel da loja no PDV móvel (mais vendidos /
// por operador / formas de pagamento / vendas por hora DO DIA) -- o total
// do dia "ao vivo" continua vindo de status_ao_vivo (25 s).
const PERIODOS = { hoje: 1, ultimos7: 7, ultimos30: 30 };

/**
 * Resumo de um período (inclui hoje -- mesma convenção de "últimos N
 * dias" que o Dashboard do desktop já usa) pra consulta remota: total
 * vendido/faturado, devoluções, vendas por dia (pro celular montar uma
 * lista/gráfico simples), produtos mais vendidos e vendas por operador.
 *
 * DELIBERADAMENTE fora daqui: lucroBrutoEstimado/margemPorProduto (custo
 * e margem) que dashboardService.getSummary também calcula -- essa
 * função existe fazia parte do Dashboard local (visível a
 * gerente/admin/suporte no desktop), mas custo/margem é um dado mais
 * sensível que faturamento bruto, e não faz parte do pedido de
 * "consultar informações do passado" -- expor isso por uma sessão
 * anônima do celular é um risco a mais que não precisa ser aceito aqui.
 * Se um dia isso for pedido explicitamente, é só incluir.
 */
function getResumoPeriodo({ locationId, dias }) {
  const dataFim = timeService.hojeLocalISO();
  const dataInicio = timeService.diasAPartirDeHojeLocalISO(-(dias - 1));

  const resumo = dashboardService.getSummary({ locationId, dataInicio, dataFim });
  const porOperador = dashboardService.getSalesByOperator({ locationId, dataInicio, dataFim });
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  const db = getDb();
  // Recebido por forma de pagamento (todas as vendas da loja, inclusive as
  // que vieram de celular -- é o faturamento da loja, não a gaveta).
  const porMetodo = db.prepare(
    `SELECT p.metodo, COALESCE(SUM(p.valor), 0) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY p.metodo ORDER BY total DESC`,
  ).all(locationId, inicioUtc, fimUtcExclusivo).map((r) => ({ metodo: r.metodo, total: r.total }));
  // Hora LOCAL (Brasília) de cada venda -- mesma convenção de -3 h do resto do app.
  const vendasPorHora = dias === 1 ? db.prepare(
    `SELECT CAST(strftime('%H', finalizada_em, '-3 hours') AS INTEGER) AS hora, COUNT(*) AS vendas,
       COALESCE(SUM(total - desconto - desconto_gerente), 0) AS total
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?
     GROUP BY hora ORDER BY hora`,
  ).all(locationId, inicioUtc, fimUtcExclusivo) : [];

  return {
    dataInicio, dataFim,
    totalVendas: resumo.totalVendas,
    totalFaturado: resumo.totalFaturado,
    ticketMedio: resumo.totalVendas > 0 ? resumo.totalFaturado / resumo.totalVendas : 0,
    devolucoes: resumo.devolucoes,
    vendasPorDia: resumo.vendasPorDia, // [{dia, total}]
    topProdutos: resumo.topProdutos.map((p) => ({ nome: p.nome, unidade: p.unidade || 'un', quantidade: p.quantidade, valorTotal: p.valorTotal })),
    porOperador: porOperador.map((o) => ({ operador: o.operador, totalVendas: o.total_vendas, totalVendido: o.total_vendido })),
    porMetodo,
    vendasPorHora,
  };
}

/**
 * Publica os dois períodos pré-calculados num único documento -- assim
 * o celular troca entre "últimos 7 dias"/"últimos 30 dias" só olhando o
 * campo já carregado (sem nova consulta ao Firestore a cada toque no
 * seletor). Documento pequeno (poucas dezenas de linhas por período),
 * bem longe do limite de 1 MiB do Firestore.
 */
async function publicarHistorico() {
  try {
    const db = getDb();
    // Só "Consulta remota" e PDV móvel com o painel da loja liberado leem
    // este documento -- sem nenhum dos dois, não roda as consultas de
    // painel (as mais pesadas deste ciclo) a cada 10 min à toa.
    const temConsulta = !!db.prepare(`SELECT 1 FROM paired_devices WHERE tipo = 'consulta' AND ativo = 1 LIMIT 1`).get();
    if (!temConsulta && require('./pdvMobileConfigService').dispositivosComMetricas().length === 0) return;
    const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
    if (!location) return;
    const locationId = location.id;

    const payload = {};
    for (const [chave, dias] of Object.entries(PERIODOS)) {
      payload[chave] = getResumoPeriodo({ locationId, dias });
    }

    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    await setDoc(doc(firestore, 'installations', installId, 'historico_vendas', 'atual'), {
      ...payload,
      atualizadoEm: serverTimestamp(),
    });
  } catch (err) {
    // Rede fora, Firestore indisponível, ou nenhum dispositivo pareado
    // ainda -- best-effort, sem alarde (mesmo critério de
    // liveStatusSyncService.publicarStatusAoVivo).
  }
}

let intervalo = null;

function iniciarPublicacaoContinua() {
  if (intervalo) clearInterval(intervalo);
  publicarHistorico();
  intervalo = setInterval(publicarHistorico, INTERVALO_PUBLICACAO_MS);
}

module.exports = { publicarHistorico, iniciarPublicacaoContinua, getResumoPeriodo, PERIODOS };
