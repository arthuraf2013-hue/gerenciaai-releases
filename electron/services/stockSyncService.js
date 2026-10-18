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
    // Variações ainda na fila já estão dentro do total local -- depois do
    // retrato absoluto elas não podem ser somadas de novo.
    const filaAntes = db.prepare('SELECT id FROM estoque_grupo_pendente WHERE grupo_id = ?').all(grupoId).map((r) => r.id);
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
    const apagar = db.prepare('DELETE FROM estoque_grupo_pendente WHERE id = ?');
    for (const id of filaAntes) apagar.run(id);
  } catch (err) {
    console.error('[stockSyncService] falha ao mandar o estoque inicial:', err.message);
  }
}

// ------------------------------------------------------------------
// Variações do estoque compartilhado (fila persistente + idempotente)
// ------------------------------------------------------------------
// Antes existia pushEstoqueProduto(): o SERVIDOR gravava no contador do
// grupo o total absoluto do estoque LOCAL dele (setDoc). Esse total não
// inclui o que as outras máquinas venderam (o débito delas só existe no
// contador), nem as vendas ainda abertas no próprio servidor (o estoque
// local é debitado ao adicionar o item; o do grupo só ao finalizar). Cada
// entrada, devolução ou cancelamento no servidor apagava esses débitos e
// "ressuscitava" unidades -- venda acima do estoque sem ninguém perceber.
// Agora só VARIAÇÕES vão pro contador, cada uma uma vez só.

const { randomUUID } = require('crypto');

/** Backend remoto trocável nos testes (sem Firestore de verdade). */
let backend = {
  async aplicarMovimento({ grupoId, productId, movimentoId, delta, motivo }) {
    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, runTransaction, serverTimestamp } = require('firebase/firestore');
    const contadorRef = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', productId);
    const movRef = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', productId, 'movimentos', movimentoId);
    await runTransaction(firestore, async (tx) => {
      const [mov, contador] = await Promise.all([tx.get(movRef), tx.get(contadorRef)]);
      if (mov.exists()) return; // já aplicado numa tentativa anterior (resposta perdida)
      const atual = contador.exists() ? (contador.data().quantidade || 0) : 0;
      tx.set(movRef, { delta, motivo: motivo || null, criadoEm: serverTimestamp() });
      tx.set(contadorRef, { quantidade: atual + delta, atualizadoEm: serverTimestamp() }, { merge: true });
    });
  },
};
function _definirBackendParaTeste(b) { backend = b; }

function enfileirarVariacao(productId, delta, motivo) {
  const grupoId = syncStateService.getGrupoSincronizacaoId();
  const qtd = Number(delta);
  if (!grupoId || !productId || !qtd) return null;
  const { getDb } = require('../db/database');
  const id = randomUUID();
  getDb().prepare(
    'INSERT INTO estoque_grupo_pendente (id, grupo_id, product_id, delta, motivo) VALUES (?, ?, ?, ?, ?)'
  ).run(id, grupoId, productId, qtd, motivo || null);
  // Tenta mandar logo (fora da transação de quem chamou); se falhar, o
  // ciclo de 10 s do main.js tenta de novo.
  setImmediate(() => enviarVariacoesPendentes().catch(() => {}));
  return id;
}

/**
 * Movimento de estoque do SERVIDOR que não é venda: entrada/abastecimento,
 * ajuste, perda, importação. Só o servidor -- o estoque físico do grupo é
 * o dele; as outras máquinas só debitam o contador ao vender.
 * Pode ser chamada de dentro da transação SQLite de quem chama (só grava
 * na fila local).
 */
function registrarMovimentoDoServidor(productId, delta, motivo) {
  if (!syncStateService.ehServidorDoGrupo()) return null;
  return enfileirarVariacao(productId, delta, motivo || 'movimento no servidor');
}

/**
 * Devolução de item de uma venda finalizada. Se a finalização debitou o
 * contador do grupo (sales.estoque_grupo_debitado), devolve -- em
 * qualquer máquina. Venda de antes do grupo: só o servidor devolve (era
 * estoque dele).
 */
function registrarDevolucaoDeVenda(saleId, productId, quantidade) {
  const { getDb } = require('../db/database');
  const venda = getDb().prepare('SELECT estoque_grupo_debitado FROM sales WHERE id = ?').get(saleId);
  if (venda?.estoque_grupo_debitado === 1 || syncStateService.ehServidorDoGrupo()) {
    return enfileirarVariacao(productId, Math.abs(Number(quantidade)), 'devolução');
  }
  return null;
}

/** Desfaz no contador o débito de uma finalização que não chegou a gravar. */
function estornarDebitoDaVenda(itens, motivo) {
  for (const item of itens) enfileirarVariacao(item.productId, Math.abs(Number(item.quantidade)), motivo || 'estorno de débito');
}

let enviando = null;
/** Manda a fila local pro Firestore, em ordem. Nunca lança. */
async function enviarVariacoesPendentes() {
  if (enviando) return enviando;
  enviando = (async () => {
    const { getDb } = require('../db/database');
    const db = getDb();
    const pendentes = db.prepare('SELECT * FROM estoque_grupo_pendente ORDER BY criado_em, rowid LIMIT 200').all();
    let enviados = 0;
    for (const p of pendentes) {
      try {
        await backend.aplicarMovimento({ grupoId: p.grupo_id, productId: p.product_id, movimentoId: p.id, delta: p.delta, motivo: p.motivo });
        db.prepare('DELETE FROM estoque_grupo_pendente WHERE id = ?').run(p.id);
        enviados += 1;
      } catch (err) {
        db.prepare('UPDATE estoque_grupo_pendente SET tentativas = tentativas + 1, ultimo_erro = ? WHERE id = ?')
          .run(String(err?.message || err).slice(0, 300), p.id);
        break; // sem rede: para e tenta tudo de novo no próximo ciclo, mantendo a ordem
      }
    }
    return { enviados, restantes: pendentes.length - enviados };
  })().catch((err) => {
    console.error('[stockSyncService] falha ao enviar variações do estoque do grupo:', err.message);
    return { enviados: 0, erro: err.message };
  }).finally(() => { enviando = null; });
  return enviando;
}

function contarVariacoesPendentes() {
  const { getDb } = require('../db/database');
  return getDb().prepare('SELECT COUNT(*) AS c FROM estoque_grupo_pendente').get().c;
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
  if (backend.verificarEDebitar) return backend.verificarEDebitar({ grupoId, porProduto });

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

    // Conseguiu completar a transação -- o Firestore respondeu, então a
    // conexão está OK (mesmo quando a resposta é "sem estoque").
    require('./connectivityService').marcarOnline();
    return { ok: true, debitado: true };
  } catch (err) {
    if (String(err.message || '').startsWith('ESTOQUE_INSUFICIENTE:')) {
      // Isso só acontece depois de ler o Firestore com sucesso -- não é
      // falha de rede, é uma resposta de verdade dizendo "não tem". Marca
      // online (chegamos a falar com o servidor) e devolve um motivo
      // diferente de erro de rede, pra quem chama saber que tentar de
      // novo sozinho não resolve (só retirar/ajustar o item resolve).
      require('./connectivityService').marcarOnline();
      return {
        ok: false,
        motivo: 'estoque_insuficiente',
        error: 'Estoque insuficiente no grupo: ' + err.message.replace('ESTOQUE_INSUFICIENTE: ', ''),
      };
    }
    console.error('[stockSyncService] falha na checagem de estoque remoto:', err.message);
    require('./connectivityService').marcarOffline();
    // Rede fora, Firestore indisponível etc. — decisão deliberada: NÃO
    // deixa passar sem checar (o pedido explícito foi "garantir essa
    // consulta"), bloqueia a finalização com um erro claro em vez de
    // arriscar vender em dobro silenciosamente. `motivo: 'rede'` é o que
    // deixa saleService.finalizeSaleComVerificacaoDeGrupo saber que vale
    // a pena tentar de novo sozinho mais tarde (ver
    // tentarFinalizarVendasPendentesDeEstoque), diferente do caso de
    // estoque insuficiente de verdade acima.
    return {
      ok: false,
      motivo: 'rede',
      error: 'Não foi possível confirmar o estoque com o servidor do grupo agora. Tente novamente em instantes.',
    };
  }
}

module.exports = {
  pushEstoqueInicial, verificarEDebitarEstoqueRemoto,
  registrarMovimentoDoServidor, registrarDevolucaoDeVenda, estornarDebitoDaVenda,
  enviarVariacoesPendentes, contarVariacoesPendentes, _definirBackendParaTeste,
};
