const syncStateService = require('./syncStateService');

/**
 * A máquina servidor manda TODO o estoque atual (por local dela) pro
 * Firestore de uma vez — chamado quando ela é designada servidor pela
 * primeira vez, ou sob demanda pra reconciliar.
 */
async function pushEstoqueInicial() {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId || !syncStateService.ehServidorDoGrupo()) return;

    const { getDb } = require('../db/database');
    const db = getDb();
    const linhas = db.prepare(
      `SELECT product_id, COALESCE(SUM(quantidade), 0) as total FROM stock_movements GROUP BY product_id`
    ).all();

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, writeBatch, serverTimestamp } = require('firebase/firestore');
    const batch = writeBatch(firestore);
    for (const linha of linhas) {
      const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', linha.product_id);
      batch.set(ref, { quantidade: linha.total, atualizadoEm: serverTimestamp() });
    }
    if (linhas.length > 0) await batch.commit();
  } catch (err) {
    console.error('[stockSyncService] falha ao mandar o estoque inicial:', err.message);
  }
}

/** A servidor manda a contagem atualizada de UM produto — chamado
 * sempre que o estoque dela muda localmente (abastecimento, ajuste,
 * ou uma venda finalizada nela mesma). Só a servidor faz isso — as
 * outras máquinas não têm estoque físico "de verdade" pra reportar,
 * só consultam/debitam o contador dela. */
async function pushEstoqueProduto(productId) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId || !syncStateService.ehServidorDoGrupo()) return;

    const { getDb } = require('../db/database');
    const db = getDb();
    const linha = db.prepare(
      `SELECT COALESCE(SUM(quantidade), 0) as total FROM stock_movements WHERE product_id = ?`
    ).get(productId);

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', productId);
    await setDoc(ref, { quantidade: linha.total, atualizadoEm: serverTimestamp() });
  } catch (err) {
    console.error('[stockSyncService] falha ao atualizar estoque de um produto:', err.message);
  }
}

/**
 * O coração do pedido: antes de finalizar uma venda, confere e já
 * debita o estoque compartilhado NUMA TRANSAÇÃO ATÔMICA do Firestore
 * — se duas máquinas tentarem vender a última unidade ao mesmo tempo,
 * o Firestore garante que só uma consegue, a outra recebe erro de
 * estoque insuficiente na hora, antes de finalizar.
 *
 * @param {{ productId: string, quantidade: number, nome: string }[]} itens
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
async function verificarEDebitarEstoqueRemoto(itens) {
  const grupoId = syncStateService.getGrupoSincronizacaoId();
  if (!grupoId) return { ok: true }; // sem grupo, sem checagem remota — comportamento de sempre

  // Produtos repetidos na mesma venda somam a quantidade antes de checar.
  const porProduto = new Map();
  for (const item of itens) {
    if (!item.productId) continue;
    const atual = porProduto.get(item.productId) || { quantidade: 0, nome: item.nome };
    atual.quantidade += item.quantidade;
    porProduto.set(item.productId, atual);
  }
  if (porProduto.size === 0) return { ok: true };

  try {
    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, runTransaction } = require('firebase/firestore');

    await runTransaction(firestore, async (tx) => {
      const refs = [...porProduto.keys()].map((productId) => ({
        productId,
        ref: doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', productId),
      }));

      // TODAS as leituras primeiro (exigência do Firestore em
      // transações — não dá pra intercalar leitura e escrita).
      const snapshots = await Promise.all(refs.map(({ ref }) => tx.get(ref)));

      const faltando = [];
      snapshots.forEach((snap, i) => {
        const { productId } = refs[i];
        const pedido = porProduto.get(productId);
        const disponivel = snap.exists() ? (snap.data().quantidade || 0) : 0;
        if (disponivel < pedido.quantidade) {
          faltando.push(`${pedido.nome || productId} (pede ${pedido.quantidade}, tem ${disponivel})`);
        }
      });

      if (faltando.length > 0) {
        throw new Error('ESTOQUE_INSUFICIENTE: ' + faltando.join('; '));
      }

      // Só debita depois de confirmar que TODOS os itens têm estoque —
      // uma venda não fica "meio finalizada" com um item debitado e
      // outro não.
      snapshots.forEach((snap, i) => {
        const { productId, ref } = refs[i];
        const pedido = porProduto.get(productId);
        const disponivel = snap.exists() ? (snap.data().quantidade || 0) : 0;
        tx.update(ref, { quantidade: disponivel - pedido.quantidade });
      });
    });

    return { ok: true };
  } catch (err) {
    if (String(err.message || '').startsWith('ESTOQUE_INSUFICIENTE:')) {
      return { ok: false, error: 'Estoque insuficiente no grupo: ' + err.message.replace('ESTOQUE_INSUFICIENTE: ', '') };
    }
    console.error('[stockSyncService] falha na checagem de estoque remoto:', err.message);
    // Rede fora, Firestore indisponível etc. — decisão deliberada: NÃO
    // deixa passar sem checar (o pedido explícito foi "garantir essa
    // consulta"), bloqueia a finalização com um erro claro em vez de
    // arriscar vender em dobro silenciosamente.
    return { ok: false, error: 'Não foi possível confirmar o estoque com o servidor do grupo agora. Tente novamente em instantes.' };
  }
}

module.exports = { pushEstoqueInicial, pushEstoqueProduto, verificarEDebitarEstoqueRemoto };
