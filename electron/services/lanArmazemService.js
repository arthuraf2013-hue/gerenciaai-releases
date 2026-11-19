/**
 * Cópia do grupo no SERVIDOR (rede local). É o "Firestore da loja":
 * os caixas ligados ao servidor leem e gravam aqui pela rede
 * (lanHubService), o próprio servidor usa direto, e o espelho
 * (lanEspelhoService) acerta com a nuvem quando há internet e cota.
 *
 *   lan_docs        produtos, clientes, fiado, usuarios, vendas, fotos
 *                   (fotos = foto do produto, lida só por id -- lerAlguns --
 *                   e que NUNCA vai para a nuvem: nuvem_pendente sempre 0)
 *                   (seq crescente = feed de mudanças; nuvem_pendente = falta subir)
 *   lan_estoque     contador do estoque do grupo por produto (autoridade
 *                   enquanto o servidor está no ar; `espelhado` = último valor
 *                   que esta cópia gravou/viu na nuvem, para somar o que outros
 *                   caixas debitaram direto na nuvem)
 *   lan_movimentos  variações já aplicadas (cada uma uma vez só)
 *
 * Mesma regra do Firestore para quem grava: gravar substitui o documento
 * (quem resolve conflito é quem lê, pela versaoMs). Só a vinda da nuvem
 * compara versões (aplicarDaNuvem).
 */

const { EventEmitter } = require('events');
const { getDb } = require('../db/database');

const COLECOES = ['produtos', 'clientes', 'fiado', 'usuarios', 'vendas', 'fotos'];
// Pesadas demais para "ler tudo" ou para o feed: só por id (lerAlguns).
const SO_POR_ID = new Set(['fotos']);
const eventos = new EventEmitter();
eventos.setMaxListeners(200);

function colecaoValida(c) { return COLECOES.includes(c); }

function proximoSeq(db) {
  const atual = Number(db.prepare(`SELECT valor FROM lan_meta WHERE chave = 'seq'`).get()?.valor || 0);
  const novo = atual + 1;
  db.prepare(`INSERT INTO lan_meta (chave, valor) VALUES ('seq', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(novo));
  return novo;
}

/** Versão de um documento: versaoMs; senão a hora gravada pelo servidor; senão 1. */
function versaoDe(d) {
  if (Number.isFinite(d?.versaoMs) && d.versaoMs > 0) return Math.trunc(d.versaoMs);
  const t = d?.atualizadoEm;
  if (t && typeof t.toMillis === 'function') return t.toMillis();
  if (Number.isFinite(t?.seconds)) return t.seconds * 1000;
  return 1;
}

/** Tira o que não é JSON puro (Timestamp vira { seconds, nanoseconds }). */
function paraJson(d) {
  return JSON.parse(JSON.stringify(d, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.toMillis === 'function' && Number.isFinite(v.seconds)) {
      return { seconds: v.seconds, nanoseconds: v.nanoseconds || 0 };
    }
    return v;
  }));
}

function avisar(grupoId, colecao, docs, seqMax) {
  if (docs.size) setImmediate(() => eventos.emit('mudou', { grupoId, colecao, docs, seqMax }));
}

/** Gravação vinda de um caixa (ou do próprio servidor). Substitui, como o batch.set do Firestore. */
function gravar(grupoId, colecao, itens) {
  if (!colecaoValida(colecao)) throw new Error('coleção inválida');
  const db = getDb();
  const paraNuvem = SO_REDE_LOCAL.has(colecao) ? 0 : 1;
  const mudou = new Map();
  let seqMax = 0;
  db.transaction(() => {
    const up = db.prepare(
      `INSERT INTO lan_docs (grupo_id, colecao, doc_id, dados, versao, seq, nuvem_pendente, dia)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grupo_id, colecao, doc_id) DO UPDATE SET
         dados = excluded.dados, versao = excluded.versao, seq = excluded.seq, nuvem_pendente = excluded.nuvem_pendente, dia = excluded.dia`
    );
    for (const { docId, dados } of itens) {
      if (typeof docId !== 'string' || !docId || docId.length > 200 || docId.includes('/')) continue;
      const limpo = paraJson(dados || {});
      seqMax = proximoSeq(db);
      up.run(grupoId, colecao, docId, JSON.stringify(limpo), versaoDe(limpo), seqMax, paraNuvem, typeof limpo.diaISO === 'string' ? limpo.diaISO : null);
      mudou.set(docId, limpo);
    }
  })();
  avisar(grupoId, colecao, mudou, seqMax);
  return { ok: true, gravados: mudou.size };
}

/**
 * Documento que veio da nuvem (outro caixa fora da rede local, ou o que
 * estava lá antes). Só entra se for mais novo que o daqui -- inclusive o
 * "eco" do que esta cópia mesma subiu é ignorado.
 */
function aplicarDaNuvem(grupoId, colecao, docs) {
  if (!colecaoValida(colecao)) return 0;
  const db = getDb();
  const mudou = new Map();
  let seqMax = 0;
  db.transaction(() => {
    const atual = db.prepare('SELECT versao, nuvem_pendente FROM lan_docs WHERE grupo_id = ? AND colecao = ? AND doc_id = ?');
    const up = db.prepare(
      `INSERT INTO lan_docs (grupo_id, colecao, doc_id, dados, versao, seq, nuvem_pendente, dia)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(grupo_id, colecao, doc_id) DO UPDATE SET
         dados = excluded.dados, versao = excluded.versao, seq = excluded.seq, nuvem_pendente = 0, dia = excluded.dia`
    );
    for (const [docId, dados] of docs) {
      const limpo = paraJson(dados || {});
      const v = versaoDe(limpo);
      const aqui = atual.get(grupoId, colecao, docId);
      if (aqui && aqui.versao >= v) continue;
      seqMax = proximoSeq(db);
      up.run(grupoId, colecao, docId, JSON.stringify(limpo), v, seqMax, typeof limpo.diaISO === 'string' ? limpo.diaISO : null);
      mudou.set(docId, limpo);
    }
  })();
  avisar(grupoId, colecao, mudou, seqMax);
  return mudou.size;
}

function lerTodos(grupoId, colecao) {
  const linhas = getDb().prepare('SELECT doc_id, dados FROM lan_docs WHERE grupo_id = ? AND colecao = ?').all(grupoId, colecao);
  return new Map(linhas.map((l) => [l.doc_id, JSON.parse(l.dados)]));
}

/** Só os documentos pedidos (os que existem). */
function lerAlguns(grupoId, colecao, ids) {
  const lista = [...new Set((ids || []).filter((id) => typeof id === 'string' && id))].slice(0, 50);
  if (!lista.length) return new Map();
  const linhas = getDb().prepare(
    `SELECT doc_id, dados FROM lan_docs WHERE grupo_id = ? AND colecao = ? AND doc_id IN (${lista.map(() => '?').join(',')})`
  ).all(grupoId, colecao, ...lista);
  return new Map(linhas.map((l) => [l.doc_id, JSON.parse(l.dados)]));
}

function seqAtual() {
  return Number(getDb().prepare(`SELECT valor FROM lan_meta WHERE chave = 'seq'`).get()?.valor || 0);
}

/** Mudanças depois de `desde` (0 = tudo). Até `limite` por vez, em ordem. */
function mudancasDesde(grupoId, colecao, desde, limite = 2000) {
  const linhas = getDb().prepare(
    'SELECT doc_id, dados, seq FROM lan_docs WHERE grupo_id = ? AND colecao = ? AND seq > ? ORDER BY seq LIMIT ?'
  ).all(grupoId, colecao, Number(desde) || 0, limite);
  return {
    docs: linhas.map((l) => [l.doc_id, JSON.parse(l.dados)]),
    seq: linhas.length ? linhas[linhas.length - 1].seq : Math.max(Number(desde) || 0, 0),
    completo: linhas.length < limite,
  };
}

function vendasDoPeriodo(grupoId, de, ate) {
  return getDb().prepare(
    `SELECT doc_id, dados FROM lan_docs WHERE grupo_id = ? AND colecao = 'vendas' AND dia >= ? AND dia <= ?`
  ).all(grupoId, String(de), String(ate)).map((l) => ({ id: l.doc_id, ...JSON.parse(l.dados) }));
}

/**
 * Escuta em processo (o próprio servidor usando a cópia): primeiro tudo,
 * depois só o que muda -- como o onSnapshot do Firestore.
 */
function escutar(grupoId, colecao, aoMudar) {
  let ativo = true;
  // Fotografia agora (síncrona): o que já foi avisado antes dela não repete.
  const inicial = lerTodos(grupoId, colecao);
  let visto = seqAtual();
  const ouvinte = (ev) => {
    if (!ativo || ev.grupoId !== grupoId || ev.colecao !== colecao || ev.seqMax <= visto) return;
    visto = ev.seqMax;
    try { aoMudar(new Map(ev.docs)); } catch (err) { console.error('[lanArmazem]', err?.message || err); }
  };
  eventos.on('mudou', ouvinte);
  setImmediate(() => { if (ativo) { try { aoMudar(inicial); } catch (err) { console.error('[lanArmazem]', err?.message || err); } } });
  return () => { ativo = false; eventos.off('mudou', ouvinte); };
}

/** Espera alguma mudança na coleção (para o "feed" longo dos caixas). */
function esperarMudanca(grupoId, colecao, ms) {
  return new Promise((resolve) => {
    const ouvinte = (ev) => {
      if (ev.grupoId !== grupoId || ev.colecao !== colecao) return;
      clearTimeout(relogio); eventos.off('mudou', ouvinte); resolve(true);
    };
    const relogio = setTimeout(() => { eventos.off('mudou', ouvinte); resolve(false); }, ms);
    relogio.unref?.();
    eventos.on('mudou', ouvinte);
  });
}

// ---------------------------------------------------------------- nuvem

/** Coleções que ficam só na rede local (não sobem para o Firestore). */
const SO_REDE_LOCAL = new Set(['fotos']);

/** O que falta subir. Fotos nunca (só rede local; a marca de uma cópia da
 * v1.0.32, que ainda subia foto, é ignorada). */
function pendentesParaNuvem(limite = 400) {
  return getDb().prepare(
    `SELECT grupo_id, colecao, doc_id, dados, seq FROM lan_docs
     WHERE nuvem_pendente = 1 AND colecao <> 'fotos' ORDER BY seq LIMIT ?`
  ).all(limite).map((l) => ({ grupoId: l.grupo_id, colecao: l.colecao, docId: l.doc_id, dados: JSON.parse(l.dados), seq: l.seq }));
}

/** Só tira a marca se o documento não mudou de novo enquanto subia. */
function marcarNaNuvem(itens) {
  const db = getDb();
  const st = db.prepare('UPDATE lan_docs SET nuvem_pendente = 0 WHERE grupo_id = ? AND colecao = ? AND doc_id = ? AND seq = ?');
  db.transaction(() => { for (const i of itens) st.run(i.grupoId, i.colecao, i.docId, i.seq); })();
}

function contarPendentesParaNuvem() {
  const db = getDb();
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM lan_docs WHERE nuvem_pendente = 1 AND colecao <> 'fotos'`).get().n)
    + Number(db.prepare('SELECT COUNT(*) AS n FROM lan_estoque WHERE pendente = 1').get().n);
}

// ---------------------------------------------------------------- estoque

function lerContadores(grupoId) {
  return new Map(getDb().prepare('SELECT produto_id, quantidade FROM lan_estoque WHERE grupo_id = ?').all(grupoId)
    .map((l) => [l.produto_id, l.quantidade]));
}

function somarNoContador(db, grupoId, produtoId, delta) {
  db.prepare(
    `INSERT INTO lan_estoque (grupo_id, produto_id, quantidade, pendente, seq) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(grupo_id, produto_id) DO UPDATE SET quantidade = quantidade + excluded.quantidade, pendente = 1, seq = excluded.seq`
  ).run(grupoId, produtoId, delta, proximoSeq(db));
}

/**
 * Variação (entrada, ajuste, devolução...). Cada movimentoId vale uma vez.
 * Produto sem contador: registra e não cria contador (igual ao Firestore --
 * quem cria é o servidor, com o estoque dele).
 */
function aplicarMovimento(grupoId, { productId, movimentoId, delta }) {
  const db = getDb();
  const d = Number(delta);
  if (!productId || !movimentoId || !Number.isFinite(d)) throw new Error('movimento inválido');
  let aplicado = false;
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM lan_movimentos WHERE grupo_id = ? AND mov_id = ?').get(grupoId, movimentoId)) return;
    db.prepare('INSERT INTO lan_movimentos (grupo_id, mov_id, produto_id, delta) VALUES (?, ?, ?, ?)').run(grupoId, movimentoId, productId, d);
    if (!db.prepare('SELECT 1 FROM lan_estoque WHERE grupo_id = ? AND produto_id = ?').get(grupoId, productId)) return;
    somarNoContador(db, grupoId, productId, d);
    aplicado = true;
  })();
  return { ok: true, aplicado };
}

/**
 * Venda: confere TODOS os itens e debita de uma vez (better-sqlite3 é
 * síncrono: duas vendas da última unidade nunca passam juntas). Produto
 * sem contador não trava nem é debitado (o grupo ainda não controla).
 * `operacaoId` repetido (resposta perdida, caixa tentou de novo) não
 * debita duas vezes.
 */
function verificarEDebitar(grupoId, itens, operacaoId) {
  const db = getDb();
  let resultado = null;
  db.transaction(() => {
    if (operacaoId && db.prepare('SELECT 1 FROM lan_movimentos WHERE grupo_id = ? AND mov_id = ?').get(grupoId, `venda:${operacaoId}`)) {
      resultado = { ok: true, debitado: true, repetido: true };
      return;
    }
    const faltando = [];
    const ler = db.prepare('SELECT quantidade FROM lan_estoque WHERE grupo_id = ? AND produto_id = ?');
    const comContador = itens.filter((it) => ler.get(grupoId, it.productId));
    for (const it of comContador) {
      const disponivel = ler.get(grupoId, it.productId).quantidade || 0;
      if (disponivel < it.quantidade) faltando.push(`${it.nome || it.productId} (pede ${it.quantidade}, tem ${disponivel})`);
    }
    if (faltando.length) { resultado = { ok: false, motivo: 'estoque_insuficiente', faltando }; return; }
    for (const it of comContador) somarNoContador(db, grupoId, it.productId, -it.quantidade);
    if (operacaoId) db.prepare('INSERT INTO lan_movimentos (grupo_id, mov_id, produto_id, delta) VALUES (?, ?, NULL, 0)').run(grupoId, `venda:${operacaoId}`);
    resultado = { ok: true, debitado: true };
  })();
  return resultado;
}

/** Contadores iniciais (somar) ou recontagem (absoluto, vence a nuvem). */
function gravarContadores(grupoId, linhas, { somar }) {
  const db = getDb();
  db.transaction(() => {
    for (const l of linhas) {
      if (somar) { somarNoContador(db, grupoId, l.product_id, Number(l.total) || 0); continue; }
      db.prepare(
        `INSERT INTO lan_estoque (grupo_id, produto_id, quantidade, pendente, absoluto, seq) VALUES (?, ?, ?, 1, 1, ?)
         ON CONFLICT(grupo_id, produto_id) DO UPDATE SET quantidade = excluded.quantidade, pendente = 1, absoluto = 1, seq = excluded.seq`
      ).run(grupoId, l.product_id, Number(l.total) || 0, proximoSeq(db));
    }
  })();
}

/**
 * Valor da nuvem chegou (escuta do espelho). Primeira vez: é o valor
 * daqui. Depois: se a nuvem mudou sem ser por esta cópia (um caixa fora
 * da rede local vendeu direto na nuvem), soma a diferença aqui.
 * O espelho NÃO chama isto enquanto o próprio contador está subindo (o
 * eco da própria gravação não pode contar como venda de outro caixa).
 */
function contadorDaNuvem(grupoId, produtoId, valorNuvem) {
  const db = getDb();
  const v = Number(valorNuvem);
  if (!Number.isFinite(v)) return;
  db.transaction(() => {
    const aqui = db.prepare('SELECT quantidade, espelhado, absoluto FROM lan_estoque WHERE grupo_id = ? AND produto_id = ?').get(grupoId, produtoId);
    if (!aqui) {
      db.prepare('INSERT INTO lan_estoque (grupo_id, produto_id, quantidade, espelhado, pendente, seq) VALUES (?, ?, ?, ?, 0, ?)')
        .run(grupoId, produtoId, v, v, proximoSeq(db));
      return;
    }
    if (aqui.espelhado === null || aqui.espelhado === undefined) {
      // O daqui nasceu só de variações antes de ver a nuvem: a subida soma
      // as duas (lendo a nuvem dentro da transação).
      db.prepare('UPDATE lan_estoque SET pendente = 1 WHERE grupo_id = ? AND produto_id = ?').run(grupoId, produtoId);
      return;
    }
    if (aqui.absoluto) return; // recontagem esperando subir: vence a daqui
    const externo = v - aqui.espelhado;
    if (!externo) return;
    db.prepare('UPDATE lan_estoque SET quantidade = quantidade + ?, espelhado = ?, seq = ? WHERE grupo_id = ? AND produto_id = ?')
      .run(externo, v, proximoSeq(db), grupoId, produtoId);
  })();
}

/**
 * Conta da subida de um contador (pura, testada): dado o que tem aqui
 * (local), o que esta cópia gravou na nuvem da última vez (espelhado) e o
 * que está lá agora (nuvem), quanto gravar e quanto somar aqui.
 */
function contaDaSubida({ local, espelhado, nuvem, absoluto }) {
  if (absoluto) return { gravar: local, somarAqui: 0 };
  const externo = (nuvem === null || nuvem === undefined || espelhado === null || espelhado === undefined) ? 0 : nuvem - espelhado;
  // Contador que a nuvem já tinha e esta cópia nunca espelhou: a nuvem manda
  // (o daqui foi criado só com variações -- soma-se a elas).
  if ((espelhado === null || espelhado === undefined) && Number.isFinite(nuvem)) return { gravar: nuvem + local, somarAqui: nuvem };
  return { gravar: local + externo, somarAqui: externo };
}

function contadoresPendentes(limite = 100) {
  return getDb().prepare(
    'SELECT grupo_id, produto_id, quantidade, espelhado, absoluto, seq FROM lan_estoque WHERE pendente = 1 ORDER BY seq LIMIT ?'
  ).all(limite);
}

/** Depois de gravar `gravado` na nuvem a partir da linha lida (seq): acerta aqui. */
function contadorSubiu({ grupo_id: grupoId, produto_id: produtoId, seq }, { gravado, somarAqui }) {
  const db = getDb();
  db.transaction(() => {
    const agora = db.prepare('SELECT quantidade, seq FROM lan_estoque WHERE grupo_id = ? AND produto_id = ?').get(grupoId, produtoId);
    if (!agora) return;
    const mudouNoMeio = agora.seq !== seq;
    db.prepare(
      `UPDATE lan_estoque SET quantidade = quantidade + ?, espelhado = ?, absoluto = CASE WHEN ? THEN absoluto ELSE 0 END,
         pendente = ? WHERE grupo_id = ? AND produto_id = ?`
    ).run(somarAqui, gravado, mudouNoMeio ? 1 : 0, mudouNoMeio ? 1 : 0, grupoId, produtoId);
  })();
}

// ---------------------------------------------------------------- meta

function lerMeta(chave) { return getDb().prepare('SELECT valor FROM lan_meta WHERE chave = ?').get(chave)?.valor ?? null; }
function gravarMeta(chave, valor) {
  getDb().prepare('INSERT INTO lan_meta (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, valor == null ? null : String(valor));
}

/** Troca de grupo: a cópia do grupo antigo não serve para nada. */
function esquecerOutrosGrupos(grupoId) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM lan_docs WHERE grupo_id != ?').run(grupoId || '');
    db.prepare('DELETE FROM lan_estoque WHERE grupo_id != ?').run(grupoId || '');
    db.prepare('DELETE FROM lan_movimentos WHERE grupo_id != ?').run(grupoId || '');
  })();
}

module.exports = {
  COLECOES, SO_POR_ID, SO_REDE_LOCAL, colecaoValida, versaoDe, gravar, aplicarDaNuvem, lerTodos, lerAlguns, seqAtual, mudancasDesde, vendasDoPeriodo,
  escutar, esperarMudanca, pendentesParaNuvem, marcarNaNuvem, contarPendentesParaNuvem,
  lerContadores, aplicarMovimento, verificarEDebitar, gravarContadores, contadorDaNuvem, contaDaSubida,
  contadoresPendentes, contadorSubiu, lerMeta, gravarMeta, esquecerOutrosGrupos,
};
