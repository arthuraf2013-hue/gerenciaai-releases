/**
 * Espelho entre a cópia do grupo no servidor (lanArmazemService) e a nuvem
 * (Firestore). Só roda no servidor do grupo com a rede local ligada.
 *
 * - Nuvem -> cópia: escuta as coleções do grupo; documento mais novo entra
 *   (caixa fora da rede local, ou o que já estava lá).
 * - Cópia -> nuvem: um único computador sobe tudo, em lotes, só quando há
 *   cota (nuvemDisjuntorService). Sem internet ou sem cota, a loja continua
 *   igual pela rede local e a nuvem acerta depois.
 * - Estoque: a cópia manda enquanto o servidor está no ar. A subida lê o
 *   contador da nuvem numa transação e soma o que outro caixa debitou direto
 *   lá desde a última subida (lanArmazemService.contaDaSubida).
 */

const armazem = require('./lanArmazemService');
const disjuntor = require('./nuvemDisjuntorService');

const DIAS_DE_VENDAS = 60;
// Nuvem que não responde (sem internet, Firebase fora, sem cota): a rede
// local começa assim mesmo, só com a cópia daqui (o servidor manda o que
// tem e os caixas o deles); quando a nuvem voltar, as versões acertam.
// Antes a loja ficava presa no Firebase até ele responder uma vez.
const PRONTO_SEM_NUVEM_MS = 2 * 60 * 1000;
const INTERVALO_MS = 5000;
const LOTE = 400;
// Fotos (coleção `fotos` da cópia) NÃO sobem para a nuvem: ficam só na
// rede local (ver grupoFotoService). Nada aqui lê nem grava foto no Firestore.

// ------------------------------------------------------------ Firestore (trocável nos testes)

let nuvem = {
  escutarColecao(grupoId, colecao, aoMudar, aoErrar) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, onSnapshot } = require('firebase/firestore');
    return onSnapshot(collection(firestore, 'grupos_sincronizacao', grupoId, colecao), (snap) => {
      const mudou = new Map();
      for (const ch of snap.docChanges()) if (ch.type !== 'removed') mudou.set(ch.doc.id, ch.doc.data());
      aoMudar(mudou);
    }, aoErrar);
  },
  escutarVendas(grupoId, desdeDia, aoMudar, aoErrar) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, onSnapshot, query, where } = require('firebase/firestore');
    return onSnapshot(query(collection(firestore, 'grupos_sincronizacao', grupoId, 'vendas'), where('diaISO', '>=', desdeDia)), (snap) => {
      const mudou = new Map();
      for (const ch of snap.docChanges()) if (ch.type !== 'removed') mudou.set(ch.doc.id, ch.doc.data());
      aoMudar(mudou);
    }, aoErrar);
  },
  escutarEstoque(grupoId, aoMudar, aoErrar) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, onSnapshot } = require('firebase/firestore');
    return onSnapshot(collection(firestore, 'grupos_sincronizacao', grupoId, 'estoque'), (snap) => {
      const mudou = new Map();
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue;
        const q = Number(ch.doc.data().quantidade);
        if (Number.isFinite(q)) mudou.set(ch.doc.id, q);
      }
      aoMudar(mudou);
    }, aoErrar);
  },
  async gravarLote(grupoId, itens) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { doc, writeBatch, serverTimestamp } = require('firebase/firestore');
    const lote = writeBatch(firestore);
    for (const i of itens) lote.set(doc(firestore, 'grupos_sincronizacao', grupoId, i.colecao, i.docId), { ...i.dados, atualizadoEm: serverTimestamp() });
    await disjuntor.comPrazo(lote.commit(), 60000, 'espelho da rede local');
  },
  /** calcular(valorNaNuvem|null) -> valor a gravar. Devolve { gravado, nuvem }. */
  async subirContador(grupoId, produtoId, calcular) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { doc, runTransaction, serverTimestamp } = require('firebase/firestore');
    const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'estoque', produtoId);
    return disjuntor.comPrazo(runTransaction(firestore, async (tx) => {
      const snap = await tx.get(ref);
      const atual = snap.exists() && Number.isFinite(Number(snap.data().quantidade)) ? Number(snap.data().quantidade) : null;
      const gravado = calcular(atual);
      tx.set(ref, { quantidade: gravado, atualizadoEm: serverTimestamp() }, { merge: true });
      return { gravado, nuvem: atual };
    }), 60000, 'estoque da rede local');
  },
};
function _definirNuvemParaTeste(n) { nuvem = { ...nuvem, ...n }; }

// ------------------------------------------------------------ estado

let grupoAtivo = null;
let paradas = [];
let relogio = null;
let prontoSemNuvem = null;
let subindo = false;
const contadorSubindo = new Map(); // produto -> último valor visto na nuvem durante a subida (ou undefined)
const ouvintesPronto = new Set();

function chavePronto(grupoId) { return `espelho_pronto:${grupoId}`; }
function pronto(grupoId) { return !!grupoId && armazem.lerMeta(chavePronto(grupoId)) === '1'; }
function aoFicarPronto(fn) { ouvintesPronto.add(fn); return () => ouvintesPronto.delete(fn); }

function diaHaDias(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

function iniciar(grupoId) {
  if (grupoAtivo === grupoId && paradas.length) return;
  parar();
  grupoAtivo = grupoId;
  const faltam = new Set(['produtos', 'clientes', 'fiado', 'usuarios', 'estoque']);
  const ficarPronto = () => {
    if (!pronto(grupoId)) armazem.gravarMeta(chavePronto(grupoId), '1');
    for (const fn of ouvintesPronto) { try { fn(grupoId); } catch { /* quem escuta se vira */ } }
  };
  const chegou = (nome) => {
    if (!faltam.delete(nome) || faltam.size) return;
    ficarPronto();
  };
  if (!pronto(grupoId)) {
    prontoSemNuvem = setTimeout(() => {
      prontoSemNuvem = null;
      if (grupoAtivo !== grupoId || pronto(grupoId)) return;
      console.warn('[lanEspelho] a nuvem não respondeu: a rede local começa com a cópia deste computador (acerta com a nuvem quando ela voltar).');
      ficarPronto();
    }, PRONTO_SEM_NUVEM_MS);
    prontoSemNuvem.unref?.();
  }
  const erro = (nome) => (err) => console.error(`[lanEspelho] escuta de ${nome} na nuvem falhou:`, err?.message || err);

  for (const colecao of ['produtos', 'clientes', 'fiado', 'usuarios']) {
    try {
      paradas.push(nuvem.escutarColecao(grupoId, colecao, (mudou) => {
        if (grupoAtivo !== grupoId) return;
        try { armazem.aplicarDaNuvem(grupoId, colecao, mudou); } catch (err) { console.error('[lanEspelho]', err?.message || err); }
        chegou(colecao);
      }, erro(colecao)));
    } catch (err) { console.error('[lanEspelho]', err?.message || err); }
  }
  try {
    paradas.push(nuvem.escutarVendas(grupoId, diaHaDias(DIAS_DE_VENDAS), (mudou) => {
      if (grupoAtivo !== grupoId) return;
      try { armazem.aplicarDaNuvem(grupoId, 'vendas', mudou); } catch (err) { console.error('[lanEspelho]', err?.message || err); }
    }, erro('vendas')));
  } catch (err) { console.error('[lanEspelho]', err?.message || err); }
  try {
    paradas.push(nuvem.escutarEstoque(grupoId, (mudou) => {
      if (grupoAtivo !== grupoId) return;
      for (const [produtoId, valor] of mudou) {
        if (contadorSubindo.has(produtoId)) { contadorSubindo.set(produtoId, valor); continue; }
        try { armazem.contadorDaNuvem(grupoId, produtoId, valor); } catch (err) { console.error('[lanEspelho]', err?.message || err); }
      }
      chegou('estoque');
    }, erro('estoque')));
  } catch (err) { console.error('[lanEspelho]', err?.message || err); }

  relogio = setInterval(() => { subirPendentes().catch(() => {}); }, INTERVALO_MS);
  relogio.unref?.();
}

function parar() {
  for (const p of paradas) { try { p(); } catch { /* já parado */ } }
  paradas = [];
  if (relogio) clearInterval(relogio);
  relogio = null;
  if (prontoSemNuvem) clearTimeout(prontoSemNuvem);
  prontoSemNuvem = null;
  grupoAtivo = null;
}

/** Sobe o que mudou na cópia. Um ciclo por vez. Devolve quantos subiram. */
async function subirPendentes() {
  if (subindo || !grupoAtivo) return 0;
  subindo = true;
  let total = 0;
  try {
    // Documentos, em lotes.
    for (let volta = 0; volta < 10; volta++) {
      const pend = armazem.pendentesParaNuvem(LOTE).filter((p) => p.grupoId === grupoAtivo);
      if (!pend.length) break;
      if (!disjuntor.podeEscrever('espelhoRedeLocal', pend.length)) return total;
      await nuvem.gravarLote(grupoAtivo, pend);
      armazem.marcarNaNuvem(pend);
      total += pend.length;
      if (pend.length < LOTE) break;
    }
    // Contadores de estoque, um por transação.
    for (const linha of armazem.contadoresPendentes(100)) {
      if (linha.grupo_id !== grupoAtivo) continue;
      if (!disjuntor.podeEscrever('estoqueRedeLocal', 1)) return total;
      contadorSubindo.set(linha.produto_id, undefined);
      try {
        let conta = null;
        const r = await nuvem.subirContador(grupoAtivo, linha.produto_id, (valorNuvem) => {
          conta = armazem.contaDaSubida({ local: linha.quantidade, espelhado: linha.espelhado, nuvem: valorNuvem, absoluto: !!linha.absoluto });
          return conta.gravar;
        });
        armazem.contadorSubiu(linha, { gravado: r.gravado, somarAqui: conta.somarAqui });
        total += 1;
      } finally {
        const vistoNoMeio = contadorSubindo.get(linha.produto_id);
        contadorSubindo.delete(linha.produto_id);
        // A nuvem mudou de novo enquanto subia (outro caixa vendeu na nuvem):
        // agora que o "espelhado" está certo, a diferença conta.
        if (vistoNoMeio !== undefined) armazem.contadorDaNuvem(grupoAtivo, linha.produto_id, vistoNoMeio);
      }
    }
  } catch (err) {
    console.error('[lanEspelho] subida para a nuvem falhou (tenta de novo):', err?.message || err);
  } finally {
    subindo = false;
  }
  return total;
}

function status() {
  return { ativo: !!grupoAtivo, pronto: pronto(grupoAtivo), faltaSubir: (() => { try { return armazem.contarPendentesParaNuvem(); } catch { return null; } })() };
}

module.exports = { iniciar, parar, subirPendentes, pronto, aoFicarPronto, status, _definirNuvemParaTeste };
