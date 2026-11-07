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
 */
import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInAnonymously, onAuthStateChanged,
  signOut, connectAuthEmulator, getAuth,
} from 'firebase/auth';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, setDoc, updateDoc, deleteDoc, onSnapshot, getDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore';

const APP_NAME = 'vertice';
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIRING_TTL_MS = 30 * 60 * 1000;
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * @param {object} opts
 * @param {object} opts.firebaseConfig  config do projeto Firebase do Vértice (não o do GerenciaAI)
 * @param {string} [opts.terminal]      nome do caixa (ex.: "Caixa 1")
 * @param {string} [opts.appVersion]    versão do GerenciaAI
 * @param {boolean} [opts.sendFullName] false (padrão): envia só "Maria S." (LGPD: o mínimo necessário)
 * @param {boolean} [opts.emulator]     true para testar com os emuladores locais do Firebase
 */
export function createVerticeSync({ firebaseConfig, terminal: terminalName = 'Caixa', appVersion = '', sendFullName = false, emulator = false } = {}) {
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
  const sentCreated = new Set();

  async function start() {
    // Abre já conectado se pareou antes: envia (ou enfileira) pedidos mesmo sem internet.
    try {
      const saved = JSON.parse(localStorage.getItem('vertice:device') || 'null');
      if (saved && !device) {
        device = saved;
        set({ status: 'paired', companyName: localStorage.getItem('vertice:companyName') || '', unitId: saved.unitId });
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
      set({ status: 'error', error: 'Sem conexão com o Vértice. Tentando de novo…' });
      console.warn('[vertice] sem conexão', e.code || e);
      setTimeout(start, 15_000);
      return null;
    });
    if (!uid) return;
    subscribeDevice();
  }

  /** Só confia no servidor; offline, vale o pareamento salvo (os pedidos entram na fila). */
  function subscribeDevice() {
    offDevice?.();
    offDevice = onSnapshot(doc(db, 'devices', uid), { includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.fromCache) return;
      const d = snap.exists() ? snap.data() : null;
      if (d && d.kind === 'integration') {
        const same = device && device.companyId === d.companyId && device.unitId === (d.unitId ?? null);
        device = { companyId: d.companyId, unitId: d.unitId ?? null };
        localStorage.setItem('vertice:device', JSON.stringify(device));
        stopPairing();
        if (!same || state.status !== 'paired') {
          set({ status: 'paired', code: null, companyName: localStorage.getItem('vertice:companyName') || '', unitId: device.unitId });
        }
        if (!hbTimer) {
          heartbeat();
          hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
        }
      } else {
        device = null;
        localStorage.removeItem('vertice:device');
        clearInterval(hbTimer);
        hbTimer = null;
        if (state.status !== 'pairing') set({ status: 'unpaired', companyName: '' });
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
        set({ status: 'pairing', code, expiresAt });
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
    orderReady: (sale) => device && upsert(sale, 'ready', { readyAt: serverTimestamp() }),
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
      offDevice?.();
      device = null;
      hbTimer = null;
      localStorage.removeItem('vertice:companyName');
      localStorage.removeItem('vertice:device');
      await signOut(auth);
      uid = null;
      set({ status: 'unpaired', code: null, companyName: '' });
      await start();
    },

    /** Confere se um pedido chegou ao servidor (útil para suporte). */
    async debugOrder(saleId) {
      const s = await getDoc(orderRef(saleId));
      return s.exists() ? s.data() : null;
    },
  };
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
