import { auth, db, firestoreFns as F } from '../../firebase-config.js';

/**
 * Conversa do painel de mesas com o computador da loja, pelo Firestore
 * (lado de lá: electron/services/mesaCelularService.js).
 *
 *   mesas_ao_vivo/atual        lista de mesas + o que montar na tela
 *   comandas_mesa/{mesaId}     comanda de uma mesa ocupada
 *   comandos_mesa/{id}         o que este celular pede (lançar, mover...)
 *
 * "Lançar" pode ser feito sem internet: o SDK do Firestore guarda a escrita
 * no aparelho e envia quando a conexão volta. Para a pessoa ver o que está
 * na fila mesmo fechando o app, este celular guarda os envios de lançar
 * (localStorage) até o computador responder.
 */

export const VERSAO_APP = 'mesas-1';
const caminho = (installId, ...resto) => ['installations', installId, ...resto];

function traduzirErro(err) {
  if (err?.code === 'permission-denied') {
    return new Error('Sem permissão nesta loja. O celular pode ter sido desconectado ou o módulo foi desligado. Fale com o gerente.');
  }
  if (err?.code === 'unavailable') return new Error('Sem conexão com a internet agora.');
  return err instanceof Error ? err : new Error(String(err?.message || err || 'Erro inesperado.'));
}

// ------------------------------------------------------------------ leituras

/** Mesas da loja. `aoMudar({ dados, existe, doServidor, ultimaNovidadeMs, erro })`. */
export function observarMesas(installId, aoMudar) {
  let ultimoVivo = 0;
  let ultimaNovidadeMs = 0;
  return F.onSnapshot(
    F.doc(db, ...caminho(installId, 'mesas_ao_vivo', 'atual')),
    { includeMetadataChanges: true },
    (snap) => {
      const dados = snap.exists() ? snap.data() : null;
      const doServidor = !snap.metadata.fromCache;
      if (doServidor && dados && dados.vivoEmMs !== ultimoVivo) {
        if (ultimoVivo) ultimaNovidadeMs = Date.now();
        ultimoVivo = dados.vivoEmMs;
      }
      aoMudar({ dados, existe: snap.exists(), doServidor, ultimaNovidadeMs });
    },
    (erro) => aoMudar({ dados: null, existe: false, doServidor: false, ultimaNovidadeMs, erro: traduzirErro(erro) })
  );
}

/** Comanda de uma mesa (principal). `aoMudar({ comanda, existe, erro })`. */
export function observarComanda(installId, mesaId, aoMudar) {
  return F.onSnapshot(
    F.doc(db, ...caminho(installId, 'comandas_mesa', mesaId)),
    (snap) => aoMudar({ comanda: snap.exists() ? snap.data() : null, existe: snap.exists() }),
    (erro) => aoMudar({ comanda: null, existe: false, erro: traduzirErro(erro) })
  );
}

/** Catálogo publicado para o celular (o mesmo do app do garçom). */
export function observarCatalogo(installId, aoMudar) {
  return F.onSnapshot(
    F.doc(db, ...caminho(installId, 'status_ao_vivo', 'atual')),
    (snap) => {
      const d = snap.exists() ? snap.data() : null;
      aoMudar({ produtos: Array.isArray(d?.catalogoProdutos) ? d.catalogoProdutos : [], perfil: d?.perfilAtivo || null });
    },
    (erro) => aoMudar({ produtos: [], erro: traduzirErro(erro) })
  );
}

// ------------------------------------------------------------------ comandos

function novoComando(installId, tipo, campos) {
  const ref = F.doc(F.collection(db, ...caminho(installId, 'comandos_mesa')));
  const dados = {
    dispositivoUid: auth.currentUser.uid,
    status: 'novo',
    tipo,
    criadoEm: F.serverTimestamp(),
    criadoEmCelularMs: Date.now(),
    appVersao: VERSAO_APP,
    ...campos,
  };
  return { ref, escrita: F.setDoc(ref, dados) };
}

/**
 * Comando que precisa de resposta na hora (tudo menos lançar). Resolve com o
 * resultado do computador; rejeita com Error (err.extra = conta atual, quando
 * o computador mandar). Sem resposta em `timeoutMs`: rejeita com
 * err.semResposta -- o pedido pode ainda ser feito quando chegar.
 */
export function executar(installId, tipo, campos = {}, { timeoutMs = 20000 } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.reject(new Error('Sem internet agora. Isso precisa do computador da loja respondendo.'));
  }
  return new Promise((resolve, reject) => {
    let terminado = false;
    let parar = () => {};
    const terminar = (fn, valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      parar();
      fn(valor);
    };
    const timer = setTimeout(() => {
      const err = new Error('O computador da loja não respondeu a tempo. Confira na mesa se foi feito antes de repetir.');
      err.semResposta = true;
      terminar(reject, err);
    }, timeoutMs);

    const { ref, escrita } = novoComando(installId, tipo, campos);
    parar = F.onSnapshot(ref, (snap) => {
      const d = snap.data();
      if (d?.status === 'feito') terminar(resolve, d.resultado || {});
      else if (d?.status === 'erro') {
        const err = new Error(d.erro || 'O computador recusou.');
        err.extra = d.resultado || null;
        terminar(reject, err);
      }
    }, (err) => terminar(reject, traduzirErro(err)));
    escrita.catch((err) => terminar(reject, traduzirErro(err)));
  });
}

// ------------------------------------------------------------------ lançar (fila)

const chaveFila = (installId) => `gerenciaai_mesas_envios_${installId}`;
const VALIDADE_FILA_MS = 24 * 60 * 60 * 1000;

function lerFila(installId) {
  try {
    const lista = JSON.parse(localStorage.getItem(chaveFila(installId)) || '[]');
    return Array.isArray(lista) ? lista.filter((e) => Date.now() - (e.criadoMs || 0) < VALIDADE_FILA_MS) : [];
  } catch {
    return [];
  }
}

function gravarFila(installId, lista) {
  try { localStorage.setItem(chaveFila(installId), JSON.stringify(lista)); } catch { /* sem armazenamento: só não sobrevive a fechar o app */ }
}

/**
 * Fila de lançamentos deste celular: cada envio com `situacao`
 *   'na_fila'   sem internet, guardado no aparelho
 *   'enviando'  saindo agora
 *   'enviado'   chegou no Firestore, esperando o computador
 *   'erro'      o computador recusou (fica até a pessoa dispensar)
 * Os 'feito' saem da fila (os itens já estão na comanda).
 */
export function criarFilaDeLancamentos(installId, aoMudar) {
  let envios = lerFila(installId).map((e) => ({ ...e, situacao: e.situacao === 'erro' ? 'erro' : 'na_fila' }));
  const escutas = new Map();
  const avisar = () => {
    gravarFila(installId, envios.map(({ situacao, ...resto }) => ({ ...resto, situacao: situacao === 'erro' ? 'erro' : 'na_fila' })));
    aoMudar([...envios]);
  };
  const atualizar = (id, campos) => {
    envios = envios.map((e) => (e.id === id ? { ...e, ...campos } : e));
    avisar();
  };
  const remover = (id) => {
    escutas.get(id)?.();
    escutas.delete(id);
    envios = envios.filter((e) => e.id !== id);
    avisar();
  };
  const escutar = (envio) => {
    if (escutas.has(envio.id) || envio.situacao === 'erro') return;
    const ref = F.doc(db, ...caminho(installId, 'comandos_mesa', envio.id));
    const parar = F.onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
      const d = snap.data();
      if (!d) return;
      if (d.status === 'feito') {
        const nao = d.resultado?.naoLancados || [];
        if (nao.length) atualizar(envio.id, { situacao: 'erro', erro: `Não entrou: ${nao.map((n) => `${n.nome} (${n.motivo})`).join('; ')}`, parcial: true });
        else remover(envio.id);
        if (nao.length) { escutas.get(envio.id)?.(); escutas.delete(envio.id); }
        return;
      }
      if (d.status === 'erro') {
        atualizar(envio.id, { situacao: 'erro', erro: d.erro || 'O computador recusou.' });
        escutas.get(envio.id)?.();
        escutas.delete(envio.id);
        return;
      }
      const pendente = snap.metadata.hasPendingWrites;
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      atualizar(envio.id, { situacao: pendente ? (online ? 'enviando' : 'na_fila') : 'enviado' });
    }, () => {});
    escutas.set(envio.id, parar);
  };
  envios.forEach(escutar);
  aoMudar([...envios]);

  return {
    /** Lança itens (pode estar sem internet). `itensTela` leva nome/preço só para mostrar. */
    lancar({ mesaId, itens, itensTela, pessoas }) {
      const campos = { mesaId, itens };
      if (pessoas) campos.pessoas = pessoas;
      const { ref, escrita } = novoComando(installId, 'lancar', campos);
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      const envio = { id: ref.id, mesaId, itens: itensTela, criadoMs: Date.now(), situacao: online ? 'enviando' : 'na_fila' };
      envios = [...envios, envio];
      avisar();
      escutar(envio);
      escrita.catch((err) => atualizar(envio.id, { situacao: 'erro', erro: traduzirErro(err).message }));
      return envio.id;
    },
    dispensar: remover,
    parar() {
      escutas.forEach((p) => p());
      escutas.clear();
    },
  };
}

// ------------------------------------------------------------------ PIN

/** PIN do gerente cifrado com a chave pública do computador (RSA-OAEP,
 * SHA-256). Só o computador da loja abre; no Firestore nunca fica em claro. */
export async function cifrarPin(chavePublicaB64, pin) {
  if (!globalThis.crypto?.subtle) throw new Error('Este navegador não consegue proteger o PIN. Use o app instalado (https).');
  const der = Uint8Array.from(atob(chavePublicaB64), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, chave, new TextEncoder().encode(String(pin))));
  let s = '';
  for (let i = 0; i < cifrado.length; i++) s += String.fromCharCode(cifrado[i]);
  return btoa(s);
}
