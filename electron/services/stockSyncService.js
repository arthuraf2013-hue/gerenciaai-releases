const syncStateService = require('./syncStateService');

// Id do produto no grupo: o contador é do produto do GRUPO. Um produto
// daqui casado com o de outro caixa (pelo código de barras) pode ter id
// local diferente -- ver grupoReplicaService.paraGrupo.
function idNoGrupo(productId) {
  try { return require('./grupoReplicaService').paraGrupo(productId); } catch { return productId; }
}

// Estoque físico local por produto (soma do livro de movimentos), já com
// o id do produto no grupo.
function totaisLocais() {
  const { getDb } = require('../db/database');
  return getDb().prepare(
    `SELECT product_id, COALESCE(SUM(quantidade), 0) as total FROM stock_movements GROUP BY product_id`
  ).all().map((l) => ({ product_id: idNoGrupo(l.product_id), local_id: l.product_id, total: l.total }));
}

/**
 * Máquina que ACABOU de virar servidor do grupo. Só cria o contador dos
 * produtos que o grupo ainda não conhece -- os que já existem ficam como
 * estão. Antes ela regravava o total de TODOS com o estoque local dela,
 * que não sabe das vendas dos outros caixas (nem, se ela era reserva, das
 * entradas feitas no servidor anterior): trocar de servidor -- e depois
 * voltar -- deixava o estoque do grupo errado. Agora dá para passar o
 * servidor para outra máquina e devolver sem mexer em nada.
 *
 * O produto novo entra somando (increment), não regravando: se outro
 * caixa vendeu dele no meio tempo, o débito continua lá.
 * Para refazer a contagem inteira (depois de um inventário):
 * recontarEstoqueDoGrupo().
 */
async function pushEstoqueInicial() {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId || !syncStateService.ehServidorDoGrupo()) return { ok: false, error: 'Este computador não é o servidor do grupo.' };
    const existentes = await contadoresExistentes(grupoId);
    const linhas = produtosComEstoqueNoGrupo(grupoId);
    const novos = linhas.filter((l) => !existentes.has(l.product_id));
    const { getDb } = require('../db/database');
    const db = getDb();
    // Variações ainda na fila dos produtos que vão entrar agora já estão
    // dentro do total local -- não podem ser somadas de novo depois.
    const idsNovos = new Set(novos.map((l) => l.local_id));
    const filaAntes = db.prepare('SELECT id, product_id FROM estoque_grupo_pendente WHERE grupo_id = ?').all(grupoId)
      .filter((r) => idsNovos.has(r.product_id)).map((r) => r.id);
    if (novos.length > 0) await backend.gravarContadores(grupoId, novos, { somar: true });
    for (const l of novos) existentes.add(l.product_id);
    const apagar = db.prepare('DELETE FROM estoque_grupo_pendente WHERE id = ?');
    for (const id of filaAntes) apagar.run(id);
    return { ok: true, criados: novos.length, mantidos: linhas.length - novos.length };
  } catch (err) {
    console.error('[stockSyncService] falha ao mandar o estoque inicial:', err.message);
    return { ok: false, error: 'Não foi possível falar com o grupo agora. Confira a internet e tente de novo.' };
  }
}

/**
 * Produtos deste computador (servidor) que controlam estoque e já estão no
 * grupo, com o estoque local (0 se nunca teve movimento). Serviço e prato
 * feito na hora (tipo 'servico') não têm estoque próprio -- ficam de fora.
 */
function produtosComEstoqueNoGrupo(grupoId) {
  const { getDb } = require('../db/database');
  const db = getDb();
  const totais = new Map(db.prepare('SELECT product_id, COALESCE(SUM(quantidade), 0) AS total FROM stock_movements GROUP BY product_id').all()
    .map((l) => [l.product_id, l.total]));
  // Id no grupo = o do documento do produto (grupo_replica); sem vínculo
  // ainda, o próprio id (igual a idNoGrupo).
  return db.prepare(
    `SELECT p.id, r.doc_id FROM products p
     LEFT JOIN grupo_replica r ON r.entidade = 'produtos' AND r.grupo_id = ? AND r.local_id = p.id
     WHERE p.ativo = 1 AND p.tipo != 'servico'`
  ).all(grupoId).map((p) => ({ product_id: p.doc_id || p.id, local_id: p.id, total: totais.get(p.id) || 0 }));
}

// Quais produtos o grupo já tem contador: lido da nuvem no máximo a cada 6 h
// (cada leitura custa um documento por produto); no meio, vale o que este
// computador já sabe e o que ele mesmo criou.
const RELER_CONTADORES_MS = 6 * 60 * 60 * 1000;
let cacheContadores = { grupoId: null, conjunto: null, lidoEm: 0 };
async function contadoresExistentes(grupoId) {
  if (cacheContadores.grupoId !== grupoId || !cacheContadores.conjunto || Date.now() - cacheContadores.lidoEm > RELER_CONTADORES_MS) {
    cacheContadores = { grupoId, conjunto: await backend.lerContadoresExistentes(grupoId), lidoEm: Date.now() };
  }
  return cacheContadores.conjunto;
}

/**
 * Rede de segurança do estoque do grupo (só no servidor, ao abrir e a cada
 * 30 min): todo produto com estoque que está no grupo precisa de contador.
 * Antes ele só era criado quando a máquina VIRAVA servidor -- se a internet
 * (ou a cota) falhasse naquela hora, ou o produto fosse cadastrado depois, o
 * contador nunca existia e a venda nos outros caixas travava em "tem 0".
 */
async function garantirContadoresDoGrupo() {
  if (!syncStateService.getGrupoSincronizacaoId() || !syncStateService.ehServidorDoGrupo()) return { ok: true, servidor: false };
  return pushEstoqueInicial();
}

/**
 * Recontagem de propósito (botão em Configurações, só admin, só no
 * servidor): o estoque do grupo passa a ser EXATAMENTE o estoque deste
 * computador. Apaga o que os outros caixas venderam desde a última
 * contagem -- por isso só depois de um inventário/contagem física aqui.
 */
async function recontarEstoqueDoGrupo() {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return { ok: false, error: 'Este computador não está em nenhum grupo de sincronização.' };
    if (!syncStateService.ehServidorDoGrupo()) return { ok: false, error: 'Só o servidor do grupo pode recontar o estoque.' };
    const { getDb } = require('../db/database');
    const db = getDb();
    const filaAntes = db.prepare('SELECT id FROM estoque_grupo_pendente WHERE grupo_id = ?').all(grupoId).map((r) => r.id);
    const linhas = totaisLocais();
    if (linhas.length > 0) await backend.gravarContadores(grupoId, linhas, { somar: false });
    const apagar = db.prepare('DELETE FROM estoque_grupo_pendente WHERE id = ?');
    for (const id of filaAntes) apagar.run(id);
    return { ok: true, produtos: linhas.length };
  } catch (err) {
    console.error('[stockSyncService] falha ao recontar o estoque do grupo:', err.message);
    return { ok: false, error: 'Não foi possível falar com o grupo agora. Confira a internet e tente de novo.' };
  }
}

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
    const lan = require('./grupoTransporteService').backend('estoque');
    if (lan) return lan.aplicarMovimento({ grupoId, productId, movimentoId, delta, motivo });
    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, runTransaction, serverTimestamp } = require('firebase/firestore');
    const contadorRef = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', productId);
    const movRef = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', productId, 'movimentos', movimentoId);
    await runTransaction(firestore, async (tx) => {
      const [mov, contador] = await Promise.all([tx.get(movRef), tx.get(contadorRef)]);
      if (mov.exists()) return; // já aplicado numa tentativa anterior (resposta perdida)
      // Produto que o grupo ainda não controla (sem contador): a variação não
      // cria um contador "de mentira" (ex.: +1 de uma devolução viraria o
      // estoque inteiro do grupo). Quem cria é o servidor, com o estoque
      // dele (garantirContadoresDoGrupo), e esse total já inclui isto.
      tx.set(movRef, { delta, motivo: motivo || null, criadoEm: serverTimestamp(), semContador: !contador.exists() });
      if (!contador.exists()) return;
      const atual = contador.data().quantidade || 0;
      tx.set(contadorRef, { quantidade: atual + delta, atualizadoEm: serverTimestamp() }, { merge: true });
    });
  },
  async lerContadoresExistentes(grupoId) {
    const lan = require('./grupoTransporteService').backend('estoque');
    if (lan?.lerContadoresExistentes) return lan.lerContadoresExistentes(grupoId);
    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { collection, getDocs } = require('firebase/firestore');
    const snap = await getDocs(collection(firestore, 'grupos_sincronizacao', grupoId, 'estoque'));
    return new Set(snap.docs.map((d) => d.id));
  },
  // Lotes de 400: o Firestore recusa mais de 500 escritas por lote (o
  // código antigo mandava o catálogo inteiro num lote só).
  async gravarContadores(grupoId, linhas, { somar }) {
    const lan = require('./grupoTransporteService').backend('estoque');
    if (lan?.gravarContadores) return lan.gravarContadores(grupoId, linhas, { somar });
    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, writeBatch, serverTimestamp, increment } = require('firebase/firestore');
    for (let i = 0; i < linhas.length; i += 400) {
      const batch = writeBatch(firestore);
      for (const linha of linhas.slice(i, i + 400)) {
        const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', linha.product_id);
        batch.set(ref, { quantidade: somar ? increment(linha.total) : linha.total, atualizadoEm: serverTimestamp() }, { merge: true });
      }
      await batch.commit();
    }
  },
};
function _definirBackendParaTeste(b) { backend = { ...backend, ...b }; cacheContadores = { grupoId: null, conjunto: null, lidoEm: 0 }; }

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
  if (getDb().prepare('SELECT tipo FROM products WHERE id = ?').get(productId)?.tipo === 'servico') return null; // sem estoque próprio
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
  // Sem cota de escrita hoje: as variações ficam na fila (estoque_grupo_pendente).
  if (!require('./grupoTransporteService').backend('estoque') && !require('./nuvemDisjuntorService').podeEscrever()) return { enviados: 0, semCota: true };
  enviando = (async () => {
    const { getDb } = require('../db/database');
    const db = getDb();
    const pendentes = db.prepare('SELECT * FROM estoque_grupo_pendente ORDER BY criado_em, rowid LIMIT 200').all();
    let enviados = 0;
    for (const p of pendentes) {
      try {
        require('./nuvemDisjuntorService').contar('estoqueGrupo', 2);
        await backend.aplicarMovimento({ grupoId: p.grupo_id, productId: idNoGrupo(p.product_id), movimentoId: p.id, delta: p.delta, motivo: p.motivo });
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
async function verificarEDebitarEstoqueRemoto(itens, { operacaoId = null } = {}) {
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

  // Rede local: o servidor confere e debita (transação no banco dele). Se ele
  // não responder, segue pela nuvem -- o espelho do servidor soma esse débito
  // quando ele voltar (lanArmazemService.contadorDaNuvem).
  const lan = require('./grupoTransporteService').backend('estoque');
  if (lan) {
    try {
      const lista = [...porProduto].map(([productId, p]) => ({ productId: idNoGrupo(productId), quantidade: p.quantidade, nome: p.nome || null }));
      const r = await lan.verificarEDebitar({ grupoId, itens: lista, operacaoId });
      if (r?.ok) return { ok: true, debitado: true };
      if (r?.motivo === 'estoque_insuficiente') {
        return { ok: false, motivo: 'estoque_insuficiente', error: 'Estoque insuficiente no grupo: ' + (r.faltando || []).join('; ') };
      }
    } catch (err) {
      if (!err?.rede) {
        console.error('[stockSyncService] servidor da rede local recusou a checagem de estoque:', err?.message || err);
        return { ok: false, motivo: 'rede', error: 'O servidor do grupo não conseguiu conferir o estoque agora. Tente novamente em instantes.' };
      }
    }
  }

  try {
    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, runTransaction } = require('firebase/firestore');

    await runTransaction(firestore, async (tx) => {
      const refs = [...porProduto.keys()].map((productId) => ({
        productId,
        ref: doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', idNoGrupo(productId)),
      }));

      // TODAS as leituras primeiro (exigência do Firestore em
      // transações — não dá pra intercalar leitura e escrita).
      const snapshots = await Promise.all(refs.map(({ ref }) => tx.get(ref)));

      const faltando = [];
      snapshots.forEach((snap, i) => {
        const { productId } = refs[i];
        const pedido = porProduto.get(productId);
        // Sem contador no grupo (produto novo que o servidor ainda não
        // cadastrou no estoque do grupo): não trava a venda -- vale o
        // estoque deste caixa, já conferido ao lançar o item.
        if (!snap.exists()) return;
        const disponivel = snap.data().quantidade || 0;
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
        if (!snap.exists()) return;
        const { productId, ref } = refs[i];
        const pedido = porProduto.get(productId);
        const disponivel = snap.data().quantidade || 0;
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

/**
 * Saldos que o SERVIDOR do grupo tem para vender agora (rede local, modo hub):
 * o contador do grupo (lanArmazemService, a autoridade) menos o que já está
 * lançado em vendas ABERTAS aqui no servidor (mesas e balcão: o contador só é
 * debitado ao finalizar). Map id do produto no grupo -> saldo. Produto sem
 * contador não aparece (o grupo ainda não controla o estoque dele).
 * `ids` (opcional): só esses produtos.
 */
function saldosNoServidor(grupoId, ids = null) {
  const { getDb } = require('../db/database');
  const contadores = require('./lanArmazemService').lerContadores(grupoId);
  const reservado = new Map(getDb().prepare(
    `SELECT COALESCE(r.doc_id, si.product_id) AS doc, SUM(si.quantidade) AS q
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     LEFT JOIN grupo_replica r ON r.entidade = 'produtos' AND r.grupo_id = ? AND r.local_id = si.product_id
     WHERE s.status = 'aberta' AND si.cancelado = 0 AND p.tipo != 'servico'
     GROUP BY doc`
  ).all(grupoId).map((l) => [l.doc, l.q]));
  const filtro = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  const saldos = new Map();
  for (const [doc, quantidade] of contadores) {
    if (filtro && !filtro.has(doc)) continue;
    saldos.set(doc, arredondarSaldo(quantidade - (reservado.get(doc) || 0)));
  }
  return saldos;
}

function arredondarSaldo(n) { return Math.round(Number(n) * 1000) / 1000; }

/**
 * Saldo do grupo de um produto daqui, quando ESTE computador é o servidor com
 * a rede local ligada (o estoque do grupo é este). null = fora de grupo, não é
 * o servidor, ou o grupo não controla esse produto (sem contador): quem chama
 * usa o estoque local, como sempre.
 */
function saldoDoGrupoNoServidor(productId) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId || !syncStateService.ehServidorDoGrupo()) return null;
    if (require('./grupoTransporteService').modoAtual() !== 'hub') return null;
    const doc = idNoGrupo(productId);
    const saldos = saldosNoServidor(grupoId, [doc]);
    return saldos.has(doc) ? saldos.get(doc) : null;
  } catch { return null; }
}

function _zerarCacheParaTeste() { cacheContadores = { grupoId: null, conjunto: null, lidoEm: 0 }; }

module.exports = {
  saldoDoGrupoNoServidor, saldosNoServidor,
  garantirContadoresDoGrupo, produtosComEstoqueNoGrupo, enfileirarVariacao, _zerarCacheParaTeste,
  recontarEstoqueDoGrupo,
  pushEstoqueInicial, verificarEDebitarEstoqueRemoto,
  registrarMovimentoDoServidor, registrarDevolucaoDeVenda, estornarDebitoDaVenda,
  enviarVariacoesPendentes, contarVariacoesPendentes, _definirBackendParaTeste,
};
