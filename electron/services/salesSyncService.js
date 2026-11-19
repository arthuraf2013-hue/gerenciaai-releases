const pdvRegistryService = require('./pdvRegistryService');
const syncStateService = require('./syncStateService');
const timeService = require('./timeService');

/**
 * `finalizada_em` é gravado em UTC (NOW_SYNCED()) — cortar a string
 * direto pega o dia em UTC, não o dia local. Pra vendas tarde da noite
 * (horário de Brasília, UTC-3), isso empurra a venda pro dia SEGUINTE
 * em UTC — uma venda às 21:45 vira "00:45 do dia seguinte" em UTC, e
 * cortar ingenuamente a data dava o dia errado no histórico do grupo.
 * Sempre usa isso pra calcular diaISO, nunca `.slice(0, 10)` direto.
 */
// Criado uma vez só -- calcularDiaISO roda por venda, milhares de vezes
// numa repassada do histórico.
const FORMATO_DIA_SP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });

function calcularDiaISO(finalizadaEmUTC) {
  if (!finalizadaEmUTC) return '';
  const data = new Date(finalizadaEmUTC.includes('Z') ? finalizadaEmUTC : finalizadaEmUTC + 'Z');
  if (isNaN(data.getTime())) return '';
  return FORMATO_DIA_SP.format(data);
}

/** Marca vendas como já espelhadas neste grupo (tabela group_sync_sales,
 * ver schema.sql -- os triggers de lá apagam a marca se a venda, os
 * itens ou os pagamentos mudarem depois). */
function marcarEnviadas(saleIds, grupoId) {
  if (!saleIds.length) return;
  try {
    const { getDb } = require('../db/database');
    const db = getDb();
    const stmt = db.prepare(`INSERT OR REPLACE INTO group_sync_sales (sale_id, grupo_id, enviado_em) VALUES (?, ?, NOW_SYNCED())`);
    db.transaction(() => { for (const id of saleIds) stmt.run(id, grupoId); })();
  } catch (err) {
    // Sem a marca, a venda só vai de novo no próximo ciclo -- inofensivo.
    console.error('[salesSyncService] falha ao marcar vendas enviadas:', err.message);
  }
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
    const lan = require('./grupoTransporteService').backend('vendas');
    // Sem cota de escrita hoje: a venda fica sem a marca de enviada e o
    // ciclo de 15 min (pushPeriodico) manda quando a cota voltar.
    if (!lan && !require('./nuvemDisjuntorService').podeEscrever('vendaGrupo')) return;

    const licenseService = require('./licenseService');
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const diaISO = calcularDiaISO(finalizadaEm);
    const dados = {
      installId, total, totalItens, itens: itens || [], metodosPagamento: metodosPagamento || [],
      operadorNome, locationNome, finalizadaEm, diaISO,
      nomeComputador: licenseService.nomeDoComputador?.() || null,
      status: 'finalizada', valorDevolvido: 0, ocultaHistorico: false, versaoMs: Date.now(),
    };
    if (lan) {
      await lan.gravar(grupoId, [{ docId: saleId, dados }]);
    } else {
      const firestore = licenseService.getLicenseFirestore();
      const { doc, setDoc } = require('firebase/firestore');
      await setDoc(doc(firestore, 'grupos_sincronizacao', grupoId, 'vendas', saleId), dados);
    }
    marcarEnviadas([saleId], grupoId);
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
async function pushTodoOHistorico({ diasRecentes, apenasPendentes = false, ids = null } = {}) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return true;
    // apenasPendentes: só o que ainda não foi pra ESTE grupo (ou mudou
    // depois de ir) -- o ciclo automático usa isso; o botão "Atualizar"
    // do Histórico e a entrada num grupo novo continuam mandando tudo.
    const filtroPendentes = apenasPendentes
      ? ' AND NOT EXISTS (SELECT 1 FROM group_sync_sales g WHERE g.sale_id = s.id AND g.grupo_id = ?)'
      : '';
    const argsPendentes = apenasPendentes ? [grupoId] : [];
    // ids: só estas vendas (reenvio na hora depois de cancelar/devolver).
    const listaIds = Array.isArray(ids) ? ids.filter(Boolean).slice(0, 500) : null;
    if (listaIds && listaIds.length === 0) return true;
    const filtroIds = listaIds ? ` AND s.id IN (${listaIds.map(() => '?').join(',')})` : '';
    const argsIds = listaIds || [];

    const { getDb } = require('../db/database');
    const db = getDb();
    // Sargable: em vez de embrulhar a coluna em date(s.finalizada_em,
    // '-3 hours') e compará-la com date('now', ?) (o que forçava
    // escanear TODA a tabela sales, de todos os locais, em toda
    // passada do ciclo automático de 15 em 15 min), calcula o corte
    // como um limite UTC fixo e compara direto -- usa
    // idx_sales_location_status_finalizada (e, sem filtro de local
    // aqui, cai pelo menos no idx_sales_finalizada_em). A troca de
    // "corte baseado no UTC de agora" pra "corte baseado no dia local
    // de hoje" é inofensiva aqui -- é só uma janela de segurança pra
    // recuperar sync que falhou há pouco, não um relatório fiscal.
    const vendas = diasRecentes
      ? (() => {
          const dataCorte = timeService.diasAPartirDeHojeLocalISO(-diasRecentes);
          const { inicioUtc } = timeService.localDateRangeToUtcBounds(dataCorte, dataCorte);
          return db.prepare(
            `SELECT s.id, s.total, s.desconto, s.desconto_gerente, s.finalizada_em, s.status, s.cancelada_em, s.oculta_historico,
               (SELECT COALESCE(SUM(r.valor_devolvido), 0) FROM returns r WHERE r.sale_id = s.id) as valor_devolvido,
               u.nome as operador_nome, l.nome as location_nome
             FROM sales s JOIN users u ON u.id = s.operador_id JOIN locations l ON l.id = s.location_id
             WHERE s.status IN ('finalizada', 'cancelada') AND s.finalizada_em IS NOT NULL AND s.finalizada_em >= ?${filtroPendentes}${filtroIds}`
          ).all(inicioUtc, ...argsPendentes, ...argsIds);
        })()
      : db.prepare(
          `SELECT s.id, s.total, s.desconto, s.desconto_gerente, s.finalizada_em, s.status, s.cancelada_em, s.oculta_historico,
               (SELECT COALESCE(SUM(r.valor_devolvido), 0) FROM returns r WHERE r.sale_id = s.id) as valor_devolvido,
               u.nome as operador_nome, l.nome as location_nome
           FROM sales s JOIN users u ON u.id = s.operador_id JOIN locations l ON l.id = s.location_id
           WHERE s.status IN ('finalizada', 'cancelada') AND s.finalizada_em IS NOT NULL${filtroPendentes}${filtroIds}`
        ).all(...argsPendentes, ...argsIds);
    if (vendas.length === 0) return true;
    const lan = require('./grupoTransporteService').backend('vendas');
    // Sem cota de escrita: "não terminou" (o ciclo tenta de novo depois).
    if (!lan && !require('./nuvemDisjuntorService').podeEscrever('historicoGrupo', vendas.length)) return false;

    const licenseService = require('./licenseService');
    const firestore = lan ? null : licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const { doc, writeBatch } = require('firebase/firestore');
    const nomeComputador = licenseService.nomeDoComputador?.() || null;

    // Preparadas UMA VEZ fora do loop -- antes, cada uma era recompilada
    // a cada venda do lote (centenas/milhares de vezes por ciclo), sem
    // necessidade: better-sqlite3 já cacheia o plano da consulta em
    // .prepare(), só falta parametrizar com .all(v.id) por venda.
    const stmtItens = db.prepare(
      `SELECT p.nome, si.quantidade, si.preco_unitario FROM sale_items si
       JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? AND si.cancelado = 0`
    );
    const stmtMetodos = db.prepare('SELECT DISTINCT metodo FROM payments WHERE sale_id = ?');

    // Em lotes de 400 (limite de 500 operações por batch do Firestore,
    // com folga) — um histórico grande não pode estourar isso.
    for (let i = 0; i < vendas.length; i += 400) {
      const lote = vendas.slice(i, i + 400);
      const docs = [];
      for (const v of lote) {
        const itensDetalhados = stmtItens.all(v.id);
        const metodosPagamento = stmtMetodos.all(v.id).map((p) => p.metodo);
        const diaISO = calcularDiaISO(v.finalizada_em);
        docs.push({ docId: v.id, dados: {
          installId,
          total: v.total - v.desconto - v.desconto_gerente,
          totalItens: itensDetalhados.length,
          itens: itensDetalhados.map((it) => ({ nome: it.nome, quantidade: it.quantidade, precoUnitario: it.preco_unitario })),
          metodosPagamento,
          operadorNome: v.operador_nome,
          locationNome: v.location_nome,
          finalizadaEm: v.finalizada_em,
          diaISO,
          nomeComputador,
          // Cancelada/devolvida depois de ir para o grupo: o espelho é
          // atualizado (antes ficava como venda boa no histórico e no
          // consolidado dos outros caixas).
          status: v.status,
          canceladaEm: v.cancelada_em || null,
          valorDevolvido: Number(v.valor_devolvido) || 0,
          ocultaHistorico: v.oculta_historico === 1,
          versaoMs: Date.now(),
        } });
      }
      if (lan) {
        await lan.gravar(grupoId, docs);
      } else {
        const batch = writeBatch(firestore);
        for (const d of docs) batch.set(doc(firestore, 'grupos_sincronizacao', grupoId, 'vendas', d.docId), d.dados);
        await batch.commit();
      }
      marcarEnviadas(lote.map((v) => v.id), grupoId);
    }
    return true;
  } catch (err) {
    console.error('[salesSyncService] falha ao mandar o histórico inteiro pro grupo:', err.message);
    return false;
  }
}

/**
 * Ciclo automático (abertura do app + a cada 15 min, ver main.js): só as
 * vendas pendentes dos últimos 60 dias -- no dia a dia, quase sempre
 * nenhuma, porque cada venda já vai sozinha ao finalizar (pushSale).
 * Uma vez por dia (primeiro ciclo depois da virada do dia) repassa os 60
 * dias completos, como o ciclo antigo fazia sempre -- rede de segurança
 * pra qualquer marca que tenha ficado errada (ex: venda alterada no
 * exato instante em que estava sendo enviada).
 */
async function pushPeriodico() {
  const grupoId = syncStateService.getGrupoSincronizacaoId();
  if (!grupoId) return;
  const { getDb } = require('../db/database');
  const db = getDb();
  const hoje = timeService.hojeLocalISO();
  const chave = `grupo_repassada_completa:${grupoId}`;
  const ultima = db.prepare('SELECT valor FROM sync_marcadores WHERE chave = ?').get(chave)?.valor;
  if (ultima !== hoje) {
    // Só dá o dia como "repassado" se a repassada terminou de verdade
    // (sem internet, tenta de novo no próximo ciclo).
    if (await pushTodoOHistorico({ diasRecentes: 60 })) {
      db.prepare('INSERT OR REPLACE INTO sync_marcadores (chave, valor) VALUES (?, ?)').run(chave, hoje);
    }
    return;
  }
  await pushTodoOHistorico({ diasRecentes: 60, apenasPendentes: true });
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
  const daRede = await vendasPelaRedeLocal(grupoId, dataInicio, dataFim);
  if (daRede) {
    return { ok: true, vendas: daRede.sort((a, b) => (b.finalizadaEm || '').localeCompare(a.finalizadaEm || '')) };
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

  let todas = await vendasPelaRedeLocal(grupoId, dataInicio, dataFim);
  if (!todas) {
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
    todas = snapshot.docs.map((d) => d.data());
  }

  // Cancelada não entra; devolução desconta.
  const vendas = todas.filter((v) => v.status !== 'cancelada');
  const porInstalacao = {};
  let totalGeral = 0;
  for (const v of vendas) {
    const valor = Math.max(0, (v.total || 0) - (Number(v.valorDevolvido) || 0));
    totalGeral += valor;
    const chave = v.nomeComputador || v.locationNome || v.installId;
    if (!porInstalacao[chave]) porInstalacao[chave] = { nome: chave, totalVendas: 0, totalFaturado: 0 };
    porInstalacao[chave].totalVendas += 1;
    porInstalacao[chave].totalFaturado += valor;
  }

  return {
    ok: true,
    totalVendas: vendas.length,
    totalFaturado: totalGeral,
    porInstalacao: Object.values(porInstalacao).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  };
}

/** Vendas do grupo pela rede local (servidor da loja), ou null para ir à nuvem. */
async function vendasPelaRedeLocal(grupoId, de, ate) {
  const lan = require('./grupoTransporteService').backend('vendas');
  if (!lan) return null;
  try { return await lan.periodo(grupoId, de, ate); } catch (err) {
    console.error('[salesSyncService] histórico pela rede local falhou, indo à nuvem:', err?.message || err);
    return null;
  }
}

/** Atualiza na hora o espelho de vendas que mudaram (cancelamento,
 * devolução). Sem rede, o ciclo de 15 min manda depois (a marca já caiu
 * pelos triggers). */
function reenviarVendas(ids) {
  if (!syncStateService.getGrupoSincronizacaoId()) return Promise.resolve(true);
  return pushTodoOHistorico({ ids }).catch(() => false);
}

module.exports = { reenviarVendas, pushSale, pushTodoOHistorico, pushPeriodico, getConsolidated, getGroupHistory, calcularDiaISO };
