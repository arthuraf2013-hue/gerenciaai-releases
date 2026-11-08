// CÓPIA de vertice/integrations/gerenciaai/verticeSync.js (repositório do Vértice).
// Não edite aqui: mude lá e copie de novo, para os dois lados não divergirem.
// Ponte com as senhas do GerenciaAI: ./ponteSenhas.js.

/**
 * Vértice × GerenciaAI — envia pedidos para as TVs do Vértice.
 *
 * Copie este arquivo para o GerenciaAI (ex.: src/integrations/vertice/verticeSync.js).
 * Roda no processo de interface (renderer), porque precisa do IndexedDB para manter a
 * identidade do caixa entre reinícios. Usa um app Firebase SEPARADO (nome "vertice"),
 * então não interfere no Firebase de licenciamento/sincronização do GerenciaAI.
 *
 * Fluxo:
 *  1. vx.startPairing() → mostra o código de 6 caracteres na tela de configurações.
 *  2. No painel Vértice: Empresa › Integrações › Conectar caixa → digita o código.
 *  3. A partir daí: vx.orderPreparing(venda), vx.orderReady(venda), vx.orderDelivered(venda).
 *
 * Funciona offline: o Firestore guarda os envios e manda quando a internet volta.
 *
 * Conexão que não se perde: a identidade do caixa é um login anônimo do Firebase guardado no
 * armazenamento da janela. Esse armazenamento pode sumir ou ser outro (rodando pelo código-fonte
 * a origem é http://localhost, no instalado é app://app). Por isso o app guarda uma cópia fora
 * da janela (onConexao) e, ao abrir, restaura com restaurarConexaoSalva() antes de criar o módulo.
 */
import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInAnonymously, onAuthStateChanged,
  onIdTokenChanged, signOut, connectAuthEmulator, getAuth,
} from 'firebase/auth';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, setDoc, updateDoc, deleteDoc, onSnapshot, getDoc, getDocFromServer, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';

const APP_NAME = 'vertice';
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIRING_TTL_MS = 30 * 60 * 1000;
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
/** Limite do catálogo enviado ao Price (cabe com folga no plano grátis do Firebase). */
const MAX_PRODUCTS = 5000;
/** Antes de desconectar porque o servidor disse "não existe", confere de novo depois disto. */
const CONFIRMA_REMOCAO_MS = 4000;

export const MSG_REMOVIDO = 'Este caixa foi desconectado no painel do Vértice (Empresa › Integrações). Gere um código novo para conectar de novo.';
export const MSG_LOGIN_PERDIDO = 'Este caixa perdeu o login salvo do Vértice e precisa ser conectado de novo. Gere um código novo.';

/** Chave em que o Firebase Auth guarda o login (formato do SDK: firebase:authUser:<apiKey>:<app>). */
export const chaveDoLogin = (firebaseConfig) => `firebase:authUser:${firebaseConfig?.apiKey}:${APP_NAME}`;

/**
 * A janela precisa receber a conexão salva fora dela? Sim quando há uma cópia salva e o
 * pareamento desta janela não é do mesmo login (armazenamento apagado ou outra origem).
 * Pura -- exportada para teste.
 */
export function precisaRestaurar(local, salva) {
  if (!salva?.uid || !salva.sessao) return false;
  try {
    const s = JSON.parse(salva.sessao);
    if (s?.uid !== salva.uid || !s?.stsTokenManager?.refreshToken) return false;
  } catch {
    return false;
  }
  return local?.uid !== salva.uid;
}

/**
 * Põe a conexão salva fora da janela de volta no armazenamento dela. Chamar ANTES de
 * createVerticeSync (o Firebase Auth lê o login ao iniciar). Apaga o login anônimo local que
 * houver (é dele a identidade errada) e grava o salvo onde o SDK procura.
 * @param {{ firebaseConfig: object, salva: { uid, sessao, dispositivo?, empresa? } }} opts
 */
export async function restaurarConexaoSalva({ firebaseConfig, salva }) {
  if (getApps().some((a) => a.name === APP_NAME)) return false; // já iniciado nesta janela
  await new Promise((resolve) => {
    try {
      const r = indexedDB.deleteDatabase('firebaseLocalStorageDb');
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
  localStorage.setItem(chaveDoLogin(firebaseConfig), salva.sessao);
  if (salva.dispositivo?.companyId) {
    localStorage.setItem('vertice:device', JSON.stringify({ ...salva.dispositivo, uid: salva.uid }));
    localStorage.setItem('vertice:companyName', salva.empresa || '');
  } else {
    localStorage.removeItem('vertice:device');
  }
  return true;
}

/**
 * @param {object} opts
 * @param {object} opts.firebaseConfig  config do projeto Firebase do Vértice (não o do GerenciaAI)
 * @param {string} [opts.terminal]      nome do caixa (ex.: "Caixa 1")
 * @param {string} [opts.appVersion]    versão do GerenciaAI
 * @param {boolean} [opts.sendFullName] false (padrão): envia só "Maria S." (LGPD: o mínimo necessário)
 * @param {boolean} [opts.emulator]     true para testar com os emuladores locais do Firebase
 */
/**
 * @param {(c: { uid: string|null, sessao: string|null, dispositivo: object|null, empresa: string, motivo: string }) => void} [opts.onConexao]
 *   chamado quando o login ou o pareamento muda: o app guarda uma cópia fora da janela.
 */
export function createVerticeSync({ firebaseConfig, terminal: terminalName = 'Caixa', appVersion = '', sendFullName = false, emulator = false, onConexao } = {}) {
  let terminal = String(terminalName || 'Caixa').slice(0, 40);
  const existing = getApps().find((a) => a.name === APP_NAME);
  const app = existing || initializeApp(firebaseConfig, APP_NAME);
  // Em hot reload o app já existe: reaproveita Auth e Firestore em vez de inicializar de novo.
  const auth = existing
    ? getAuth(app)
    : initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  const db = existing
    ? getFirestore(app)
    : initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  if (emulator && !existing) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  /**
   * @type {{status:'starting'|'unpaired'|'pairing'|'paired'|'error', code?:string, expiresAt?:number,
   *   companyName?:string, unitId?:string|null, error?:string, terminal?:string,
   *   pending?:number, lastSentAt?:number|null, lastError?:string|null}}
   * pending = pedidos aguardando confirmação do servidor (sem internet eles ficam na fila).
   */
  let state = { status: 'starting', terminal, pending: 0, lastSentAt: null, lastError: null };
  const subs = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    subs.forEach((f) => f(state));
  };

  let uid = null;
  let device = null; // { companyId, unitId }
  let offDevice = null;
  let offPairing = null;
  let pairingTimer = null;
  let hbTimer = null;
  let confirmaTimer = null;
  let offToken = null;
  const sentCreated = new Set();

  /** Avisa o app (cópia fora da janela). Nunca derruba nada. */
  function avisarConexao(motivo) {
    if (!onConexao) return;
    try {
      const u = auth.currentUser;
      onConexao({
        uid: u?.uid || null,
        sessao: u ? JSON.stringify(u.toJSON()) : null,
        dispositivo: device ? { companyId: device.companyId, unitId: device.unitId ?? null } : null,
        empresa: localStorage.getItem('vertice:companyName') || '',
        motivo,
      });
    } catch (e) {
      console.warn('[vertice] não guardei a conexão', e?.message || e);
    }
  }

  function salvarDispositivo() {
    localStorage.setItem('vertice:device', JSON.stringify({ ...device, uid }));
  }

  function desparear(error) {
    device = null;
    localStorage.removeItem('vertice:device');
    clearInterval(hbTimer);
    hbTimer = null;
    if (state.status !== 'pairing') set({ status: 'unpaired', companyName: '', error });
    avisarConexao(error ? 'desconectado' : 'sem-pareamento');
  }

  async function start() {
    // Abre já conectado se pareou antes: envia (ou enfileira) pedidos mesmo sem internet.
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('vertice:device') || 'null');
      if (saved && !device) {
        device = { companyId: saved.companyId, unitId: saved.unitId ?? null };
        set({ status: 'paired', companyName: localStorage.getItem('vertice:companyName') || '', unitId: device.unitId });
      }
    } catch { /* ignore */ }
    uid = await new Promise((resolve, reject) => {
      const off = onAuthStateChanged(auth, async (u) => {
        if (u) {
          off();
          resolve(u.uid);
        } else {
          signInAnonymously(auth).catch((e) => {
            off();
            reject(e);
          });
        }
      });
    }).catch((e) => {
      // Já pareado: continua "conectado" (os pedidos esperam na fila); só avisa que está sem rede.
      set(device ? { lastError: 'Sem conexão com o Vértice agora. Tentando de novo…' } : { status: 'error', error: 'Sem conexão com o Vértice. Tentando de novo…' });
      console.warn('[vertice] sem conexão', e.code || e);
      setTimeout(start, 15_000);
      return null;
    });
    if (!uid) return;
    // O pareamento salvo é de outro login (o anônimo de antes sumiu): não adianta continuar com ele.
    if (saved?.uid && saved.uid !== uid) {
      console.warn('[vertice] login do caixa mudou', saved.uid, '->', uid);
      desparear(MSG_LOGIN_PERDIDO);
    } else if (device) salvarDispositivo();
    // Login renovado (a cada hora) ou trocado: a cópia fora da janela acompanha.
    offToken?.();
    offToken = onIdTokenChanged(auth, (u) => { if (u) avisarConexao('login'); });
    subscribeDevice();
  }

  /** Só confia no servidor; offline, vale o pareamento salvo (os pedidos entram na fila). */
  function subscribeDevice() {
    offDevice?.();
    offDevice = onSnapshot(doc(db, 'devices', uid), { includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.fromCache) return;
      const d = snap.exists() ? snap.data() : null;
      if (d && d.kind === 'integration') {
        clearTimeout(confirmaTimer);
        const same = device && device.companyId === d.companyId && device.unitId === (d.unitId ?? null);
        device = { companyId: d.companyId, unitId: d.unitId ?? null };
        salvarDispositivo();
        stopPairing();
        if (!same || state.status !== 'paired') {
          set({ status: 'paired', code: null, error: undefined, companyName: localStorage.getItem('vertice:companyName') || '', unitId: device.unitId });
          avisarConexao('pareado');
        }
        if (!hbTimer) {
          heartbeat();
          hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
        }
      } else if (!device) {
        if (state.status !== 'pairing') set({ status: 'unpaired', companyName: '' });
      } else {
        // Estava conectado e o servidor diz que não está mais. Confere de novo antes de largar
        // (uma resposta só não basta para apagar o pareamento deste caixa).
        clearTimeout(confirmaTimer);
        confirmaTimer = setTimeout(async () => {
          try {
            const again = await getDocFromServer(doc(db, 'devices', uid));
            if (again.exists() && again.data()?.kind === 'integration') return;
            desparear(MSG_REMOVIDO);
          } catch (e) {
            console.warn('[vertice] não consegui confirmar o pareamento', e.code || e); // sem rede: fica como está
          }
        }, CONFIRMA_REMOCAO_MS);
      }
    }, () => {
      set({ status: device ? 'paired' : 'error', error: device ? undefined : 'Não foi possível ler o pareamento.' });
      setTimeout(subscribeDevice, 15_000);
    });
  }

  async function startPairing() {
    if (!uid) await start();
    stopPairing();
    for (let i = 0; i < 6; i++) {
      const code = randomCode();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      try {
        await setDoc(doc(db, 'pairings', code), {
          code, kind: 'integration', integrationType: 'gerenciaai', uid, platform: 'gerenciaai',
          appVersion, claimed: false, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(expiresAt),
        });
        set({ status: 'pairing', code, expiresAt, error: undefined });
        offPairing = onSnapshot(doc(db, 'pairings', code), (s) => {
          const p = s.data();
          if (p?.claimed) localStorage.setItem('vertice:companyName', p.companyName || '');
        }, () => {});
        pairingTimer = setTimeout(() => {
          deleteDoc(doc(db, 'pairings', code)).catch(() => {});
          if (state.status === 'pairing') startPairing();
        }, PAIRING_TTL_MS);
        return code;
      } catch (e) {
        if (e.code !== 'permission-denied') {
          set({ status: 'error', error: 'Sem conexão com o Vértice.' });
          throw e;
        }
      }
    }
    throw new Error('Não foi possível gerar um código. Tente de novo.');
  }

  function stopPairing() {
    offPairing?.();
    offPairing = null;
    clearTimeout(pairingTimer);
  }

  function cancelPairing() {
    if (state.code) deleteDoc(doc(db, 'pairings', state.code)).catch(() => {});
    stopPairing();
    set({ status: device ? 'paired' : 'unpaired', code: null });
  }

  async function heartbeat() {
    if (!device) return;
    try {
      await updateDoc(doc(db, 'companies', device.companyId, 'integrations', uid), { lastSeen: serverTimestamp(), appVersion, terminal });
    } catch { /* offline: tenta no próximo */ }
  }

  function orderRef(saleId) {
    if (!device) throw new Error('GerenciaAI não está conectado ao Vértice.');
    return doc(db, 'companies', device.companyId, 'orders', `${uid}_${String(saleId).replace(/[/]/g, '-')}`);
  }

  /** Acompanha cada envio: quantos estão na fila, o último que chegou e o último erro. */
  function track(promise) {
    set({ pending: state.pending + 1 });
    promise.then(
      () => set({ pending: Math.max(0, state.pending - 1), lastSentAt: Date.now(), lastError: null }),
      (e) => {
        console.warn('[vertice] pedido não enviado', e.code || e);
        const denied = e.code === 'permission-denied';
        set({
          pending: Math.max(0, state.pending - 1),
          lastError: denied
            ? 'O Vértice recusou o pedido. Confira se este caixa ainda está conectado em Empresa › Integrações.'
            : 'Não foi possível enviar o pedido ao Vértice.',
        });
      },
    );
    return promise;
  }

  /** Grava o pedido. Não espera a internet: o Firestore enfileira e envia depois. */
  function upsert(sale, status, extra) {
    const ref = orderRef(sale.id);
    const base = {
      number: String(sale.number ?? sale.id).slice(0, 12),
      customerName: sale.customerName ? (sendFullName ? sale.customerName : shortName(sale.customerName)).slice(0, 80) : null,
      status,
      unitId: device.unitId,
      source: 'gerenciaai',
      terminal,
      integrationUid: uid,
      updatedAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + ORDER_TTL_MS),
      ...extra,
    };
    // A hora da venda (se o GerenciaAI informar) é estável: pode ir em todo envio.
    // Sem ela, marca a hora do servidor só no primeiro envio desta sessão.
    const created = sale.createdAt ? new Date(sale.createdAt).getTime() : NaN;
    if (Number.isFinite(created)) base.createdAt = Timestamp.fromMillis(created);
    else if (!sentCreated.has(ref.id)) base.createdAt = serverTimestamp();
    sentCreated.add(ref.id);
    track(setDoc(ref, base, { merge: true }));
    return ref.id;
  }

  return {
    start,
    startPairing,
    cancelPairing,
    /** Recebe atualizações de estado (para a tela de configurações). Devolve a função para parar. */
    onState(fn) {
      subs.add(fn);
      fn(state);
      return () => subs.delete(fn);
    },
    getState: () => state,
    isPaired: () => !!device,

    /** Pedido entrou na fila de preparo. sale = { id, number, customerName?, createdAt? } */
    orderPreparing: (sale) => device && upsert(sale, 'preparing', {}),
    /** Pedido pronto: a TV mostra o número e o nome. */
    // sale.readyAt (opcional): hora em que o pedido foi CHAMADO, vinda do sistema. Com ela o
    // reenvio do mesmo chamado não repete o aviso na TV, e chamar de novo (hora nova) repete.
    // Sem ela, vale a hora do servidor (cada envio conta como uma chamada nova).
    orderReady: (sale) => device && upsert(sale, 'ready', { readyAt: horaDe(sale.readyAt) || serverTimestamp() }),
    /** Cliente retirou: sai da TV. */
    orderDelivered: (sale) => device && upsert(sale, 'delivered', { deliveredAt: serverTimestamp() }),
    /** Venda cancelada: apaga o pedido. */
    async orderCancelled(sale) {
      if (!device) return;
      await track(deleteDoc(orderRef(sale.id))).catch(() => {});
    },

    /** Troca o nome do caixa mostrado no painel (ex.: quando o usuário renomeia o PDV). */
    setTerminal(name) {
      terminal = String(name || 'Caixa').slice(0, 40);
      set({ terminal });
      heartbeat();
    },

    /**
     * Pedido de teste: aparece como pronto nas TVs desta unidade por 1 minuto e depois sai.
     * Use no botão "Enviar pedido de teste" da tela de configurações.
     */
    sendTestOrder() {
      if (!device) throw new Error('Conecte o caixa ao Vértice primeiro.');
      const sale = { id: `teste-${Date.now()}`, number: 'TESTE', customerName: 'Pedido de teste' };
      const id = upsert(sale, 'ready', { readyAt: serverTimestamp() });
      setTimeout(() => upsert(sale, 'delivered', { deliveredAt: serverTimestamp() }), 60_000);
      return id;
    },

    /** Desconecta este caixa. Peça também para remover em Empresa › Integrações no painel. */
    async unpair() {
      stopPairing();
      clearInterval(hbTimer);
      clearTimeout(confirmaTimer);
      offDevice?.();
      offToken?.();
      device = null;
      hbTimer = null;
      localStorage.removeItem('vertice:companyName');
      localStorage.removeItem('vertice:device');
      await signOut(auth);
      uid = null;
      set({ status: 'unpaired', code: null, companyName: '', error: undefined });
      await start();
      avisarConexao('desconectado-aqui');
    },

    /**
     * Price: envia o catálogo de produtos (nome, preço, oferta) para as tabelas de preço do Vértice.
     * Manda só o que mudou desde o último envio; produto que sumiu (ou foi desativado) é apagado.
     * products = [{ id, name, category?, unit?, price, promoPrice?, promoUntil? ("YYYY-MM-DD"), active? }]
     * @returns {Promise<{ sent:number, removed:number, total:number }>}
     */
    async syncProducts(products = []) {
      if (!device || !uid) return { sent: 0, removed: 0, total: 0 };
      const cacheKey = `vertice:products:${device.companyId}:${uid}`;
      let cache = {};
      try { cache = JSON.parse(localStorage.getItem(cacheKey) || '{}'); } catch { /* recomeça */ }
      const next = {};
      const ops = [];
      const list = products.filter((p) => p && p.id && p.name && p.active !== false).slice(0, MAX_PRODUCTS);
      for (const p of list) {
        const data = {
          name: String(p.name).trim().slice(0, 80),
          category: p.category ? String(p.category).slice(0, 40) : null,
          unit: p.unit ? String(p.unit).slice(0, 12) : null,
          price: Math.max(0, Math.round((Number(p.price) || 0) * 100) / 100),
          promoPrice: Number(p.promoPrice) > 0 ? Math.round(Number(p.promoPrice) * 100) / 100 : null,
          promoUntil: /^\d{4}-\d{2}-\d{2}/.test(String(p.promoUntil || '')) ? String(p.promoUntil).slice(0, 10) : null,
          active: true,
        };
        if (!data.name) continue;
        const id = String(p.id).replace(/[/]/g, '-');
        const hash = JSON.stringify(data);
        next[id] = hash;
        if (cache[id] !== hash) ops.push({ set: true, id, data });
      }
      for (const id of Object.keys(cache)) if (!next[id]) ops.push({ set: false, id });
      for (let i = 0; i < ops.length; i += 400) {
        const b = writeBatch(db);
        for (const o of ops.slice(i, i + 400)) {
          const ref = doc(db, 'companies', device.companyId, 'products', `${uid}_${o.id}`);
          if (o.set) b.set(ref, { ...o.data, integrationUid: uid, updatedAt: serverTimestamp() });
          else b.delete(ref);
        }
        await track(b.commit());
      }
      localStorage.setItem(cacheKey, JSON.stringify(next));
      const sent = ops.filter((o) => o.set).length;
      set({ productsSentAt: Date.now(), productsCount: Object.keys(next).length, productsTruncated: products.length > MAX_PRODUCTS });
      return { sent, removed: ops.length - sent, total: Object.keys(next).length };
    },

    /** Confere se um pedido chegou ao servidor (útil para suporte). */
    async debugOrder(saleId) {
      const s = await getDoc(orderRef(saleId));
      return s.exists() ? s.data() : null;
    },
  };
}

/** Data/ISO/ms -> Timestamp; inválido -> null. */
function horaDe(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(ms) && ms > 0 ? Timestamp.fromMillis(ms) : null;
}

function randomCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return [...a].map((n) => PAIRING_ALPHABET[n % PAIRING_ALPHABET.length]).join('');
}

/** "MARIA DA SILVA" → "Maria S." */
export function shortName(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const cap = (w) => w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1).toLocaleLowerCase('pt-BR');
  const rest = parts.slice(1).filter((w) => !/^(d[aeo]s?|e)$/i.test(w));
  const last = rest[rest.length - 1];
  return last ? `${cap(parts[0])} ${last.charAt(0).toLocaleUpperCase('pt-BR')}.` : cap(parts[0]);
}
