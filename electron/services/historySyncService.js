const { getDb } = require('../db/database');
const timeService = require('./timeService');
const dashboardService = require('./dashboardService');

// Igual liveStatusSyncService/userStatusSyncService: best-effort,
// intervalo bem mais espaçado que o status ao vivo (25s) -- histórico
// não precisa ser "quase tempo real" pra ser útil numa consulta remota,
// e as consultas daqui (JOIN com sale_items/products, agrupamento por
// dia/operador) são mais pesadas que o resumo do dia sozinho.
const INTERVALO_PUBLICACAO_MS = 10 * 60 * 1000;

const PERIODOS = { ultimos7: 7, ultimos30: 30 };

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

  return {
    dataInicio, dataFim,
    totalVendas: resumo.totalVendas,
    totalFaturado: resumo.totalFaturado,
    ticketMedio: resumo.totalVendas > 0 ? resumo.totalFaturado / resumo.totalVendas : 0,
    devolucoes: resumo.devolucoes,
    vendasPorDia: resumo.vendasPorDia, // [{dia, total}]
    topProdutos: resumo.topProdutos.map((p) => ({ nome: p.nome, quantidade: p.quantidade, valorTotal: p.valorTotal })),
    porOperador: porOperador.map((o) => ({ operador: o.operador, totalVendas: o.total_vendas, totalVendido: o.total_vendido })),
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
