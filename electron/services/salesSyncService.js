const pdvRegistryService = require('./pdvRegistryService');
const syncStateService = require('./syncStateService');

/**
 * `finalizada_em` é gravado em UTC (NOW_SYNCED()) — cortar a string
 * direto pega o dia em UTC, não o dia local. Pra vendas tarde da noite
 * (horário de Brasília, UTC-3), isso empurra a venda pro dia SEGUINTE
 * em UTC — uma venda às 21:45 vira "00:45 do dia seguinte" em UTC, e
 * cortar ingenuamente a data dava o dia errado no histórico do grupo.
 * Sempre usa isso pra calcular diaISO, nunca `.slice(0, 10)` direto.
 */
function calcularDiaISO(finalizadaEmUTC) {
  if (!finalizadaEmUTC) return '';
  const data = new Date(finalizadaEmUTC.includes('Z') ? finalizadaEmUTC : finalizadaEmUTC + 'Z');
  if (isNaN(data.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(data);
}

/**
 * Envia um RESUMO da venda pro Firestore central do Arthur (não os
 * itens individuais, não dado de cliente) — só o suficiente pra um
 * relatório consolidado entre PDVs do mesmo grupo. Puramente aditivo:
 * nunca sincroniza estoque nem impede uma venda de acontecer se a
 * rede cair ou o grupo ainda não tiver sido configurado pelo painel.
 *
 * Diferente da primeira versão desse serviço, não precisa mais de
 * nenhuma configuração de Firebase por parte do cliente — usa a MESMA
 * conexão já usada pra licenciamento, e o grupo é atribuído
 * centralmente pelo Arthur em Central GerenciaAI → Sincronização.
 */
async function pushSale({ saleId, total, totalItens, itens, metodosPagamento, finalizadaEm, operadorNome, locationNome }) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return; // essa instalação ainda não foi colocada em nenhum grupo — sem sincronização, silencioso

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const { doc, setDoc } = require('firebase/firestore');

    const diaISO = calcularDiaISO(finalizadaEm);
    const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'vendas', saleId);
    await setDoc(ref, {
      installId, total, totalItens, itens: itens || [], metodosPagamento: metodosPagamento || [],
      operadorNome, locationNome, finalizadaEm, diaISO,
    });
  } catch (err) {
    // Best-effort de propósito — a venda já está gravada localmente, isso
    // é só um espelho pro relatório consolidado. Nunca deixa o erro subir.
    console.error('[salesSyncService] falha ao sincronizar venda (não afeta a venda local):', err.message);
  }
}

/**
 * Manda TODAS as vendas finalizadas locais pro grupo de uma vez —
 * chamado quando essa instalação entra num grupo pela primeira vez,
 * pra levar o histórico que já existia antes de configurar a
 * sincronização (sem isso, só vendas finalizadas DEPOIS de entrar no
 * grupo apareceriam no histórico compartilhado).
 */
/**
 * @param {{ diasRecentes?: number }} opts diasRecentes limita a busca
 * a vendas dos últimos N dias — sem isso, cada chamada reprocessava o
 * histórico INTEIRO desde sempre, ficando mais lento conforme o
 * histórico crescia. Passe `null`/omita pra pegar tudo (usado só uma
 * vez, ao entrar num grupo pela primeira vez — ali sim precisa do
 * histórico completo). As chamadas recorrentes (ciclo automático,
 * botão "Atualizar", abertura do app) usam um período recente — o
 * objetivo delas é só corrigir alguma sincronização que falhou
 * silenciosamente há pouco tempo, não reprocessar anos de vendas.
 */
async function pushTodoOHistorico({ diasRecentes } = {}) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return;

    const { getDb } = require('../db/database');
    const db = getDb();
    const vendas = diasRecentes
      ? db.prepare(
          `SELECT s.id, s.total, s.desconto, s.desconto_gerente, s.finalizada_em, u.nome as operador_nome, l.nome as location_nome
           FROM sales s JOIN users u ON u.id = s.operador_id JOIN locations l ON l.id = s.location_id
           WHERE s.status = 'finalizada' AND date(s.finalizada_em, '-3 hours') >= date('now', ?)`
        ).all(`-${diasRecentes} days`)
      : db.prepare(
          `SELECT s.id, s.total, s.desconto, s.desconto_gerente, s.finalizada_em, u.nome as operador_nome, l.nome as location_nome
           FROM sales s JOIN users u ON u.id = s.operador_id JOIN locations l ON l.id = s.location_id
           WHERE s.status = 'finalizada'`
        ).all();
    if (vendas.length === 0) return;

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const { doc, writeBatch } = require('firebase/firestore');

    // Em lotes de 400 (limite de 500 operações por batch do Firestore,
    // com folga) — um histórico grande não pode estourar isso.
    for (let i = 0; i < vendas.length; i += 400) {
      const lote = vendas.slice(i, i + 400);
      const batch = writeBatch(firestore);
      for (const v of lote) {
        const itensDetalhados = db.prepare(
          `SELECT p.nome, si.quantidade, si.preco_unitario FROM sale_items si
           JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? AND si.cancelado = 0`
        ).all(v.id);
        const metodosPagamento = db.prepare('SELECT DISTINCT metodo FROM payments WHERE sale_id = ?').all(v.id).map((p) => p.metodo);
        const diaISO = calcularDiaISO(v.finalizada_em);
        const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'vendas', v.id);
        batch.set(ref, {
          installId,
          total: v.total - v.desconto - v.desconto_gerente,
          totalItens: itensDetalhados.length,
          itens: itensDetalhados.map((it) => ({ nome: it.nome, quantidade: it.quantidade, precoUnitario: it.preco_unitario })),
          metodosPagamento,
          operadorNome: v.operador_nome,
          locationNome: v.location_nome,
          finalizadaEm: v.finalizada_em,
          diaISO,
        });
      }
      await batch.commit();
    }
  } catch (err) {
    console.error('[salesSyncService] falha ao mandar o histórico inteiro pro grupo:', err.message);
  }
}

/**
 * Histórico COMPLETO do grupo (todas as vendas de todos os PDVs, com
 * itens e forma de pagamento) — diferente de getConsolidated, que só
 * soma totais. Usado na tela de Histórico pra mostrar cada venda com
 * o nome do PDV que vendeu.
 */
async function getGroupHistory({ dataInicio, dataFim }) {
  const grupoId = syncStateService.getGrupoSincronizacaoId();
  if (!grupoId) {
    return { ok: false, error: 'Esta instalação ainda não foi colocada em nenhum grupo de sincronização.' };
  }

  const licenseService = require('./licenseService');
  const firestore = licenseService.getLicenseFirestore();
  const { collection, query, where, getDocs } = require('firebase/firestore');

  const vendasRef = collection(firestore, 'grupos_sincronizacao', grupoId, 'vendas');
  const q = query(vendasRef, where('diaISO', '>=', dataInicio), where('diaISO', '<=', dataFim));

  let snapshot;
  try {
    snapshot = await getDocs(q);
  } catch (err) {
    return { ok: false, error: `Falha ao consultar o servidor: ${err.message}` };
  }

  const vendas = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.finalizadaEm || '').localeCompare(a.finalizadaEm || ''));

  return { ok: true, vendas };
}

/**
 * Consolidado de vendas de todas as instalações do MESMO grupo de
 * sincronização, num período — vem do Firestore central, não do banco
 * local (que só tem as vendas desta instalação).
 */
async function getConsolidated({ dataInicio, dataFim }) {
  const grupoId = syncStateService.getGrupoSincronizacaoId();
  if (!grupoId) {
    return { ok: false, error: 'Esta instalação ainda não foi colocada em nenhum grupo de sincronização. Fale com o suporte.' };
  }

  const licenseService = require('./licenseService');
  const firestore = licenseService.getLicenseFirestore();
  const { collection, query, where, getDocs } = require('firebase/firestore');

  const vendasRef = collection(firestore, 'grupos_sincronizacao', grupoId, 'vendas');
  const q = query(vendasRef, where('diaISO', '>=', dataInicio), where('diaISO', '<=', dataFim));

  let snapshot;
  try {
    snapshot = await getDocs(q);
  } catch (err) {
    return { ok: false, error: `Falha ao consultar o servidor: ${err.message}` };
  }

  const vendas = snapshot.docs.map((d) => d.data());
  const porInstalacao = {};
  let totalGeral = 0;
  for (const v of vendas) {
    totalGeral += v.total || 0;
    const chave = v.locationNome || v.installId;
    if (!porInstalacao[chave]) porInstalacao[chave] = { nome: chave, totalVendas: 0, totalFaturado: 0 };
    porInstalacao[chave].totalVendas += 1;
    porInstalacao[chave].totalFaturado += v.total || 0;
  }

  return {
    ok: true,
    totalVendas: vendas.length,
    totalFaturado: totalGeral,
    porInstalacao: Object.values(porInstalacao).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  };
}

module.exports = { pushSale, pushTodoOHistorico, getConsolidated, getGroupHistory };
