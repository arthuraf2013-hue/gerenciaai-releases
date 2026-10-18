// Única porta pra rede: Firestore + Storage do MESMO projeto Firebase do
// GerenciaAI (gerenciaai-licencas). Licença e backup só conversam com
// esta interface -- nos testes entra uma nuvem falsa no lugar.
import { initializeApp } from 'firebase/app';
import {
  initializeFirestore, doc, getDocFromServer, setDoc, updateDoc, onSnapshot, collection, getDocs, query, orderBy,
  deleteDoc, serverTimestamp, documentId, where,
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { AGORA_SERVIDOR } from './base.js';
import { juntarCatalogo } from './terminalMemoria.js';

// Mesma config do desktop (electron/services/licenseService.js) e do
// pwa-mobile -- não é segredo (já vai embutida no instalador do desktop).
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};

const TIMEOUT_MS = 20000;

function comTimeout(promessa, ms = TIMEOUT_MS) {
  // Escrita no Firestore sem rede fica pendente pra sempre (só resolve
  // quando a conexão volta) -- sem isso, cada ping offline empilhava uma
  // promessa nunca resolvida.
  let t;
  return Promise.race([
    promessa.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Sem resposta do servidor (sem internet?)')), ms); }),
  ]);
}

function converter(dados) {
  const o = {};
  for (const [k, v] of Object.entries(dados)) o[k] = v === AGORA_SERVIDOR ? serverTimestamp() : v;
  return o;
}

function ms(ts) {
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null;
}

export function criarNuvemFirebase(config = FIREBASE_CONFIG) {
  const app = initializeApp(config);
  // Long polling automático: rede de celular atrás de proxy/operadora às
  // vezes derruba o WebChannel do Firestore; o SDK detecta e troca.
  const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const storage = getStorage(app);
  storage.maxUploadRetryTime = 60000;
  storage.maxOperationRetryTime = 60000;
  const instalacao = (id) => doc(db, 'installations', id);

  return {
    async lerAtivacao(codigo) {
      const snap = await comTimeout(getDocFromServer(doc(db, 'ativacoes_mobile', codigo)));
      if (!snap.exists()) return null;
      const d = snap.data();
      return { clienteId: d.clienteId || null, usado: !!d.usado, usadoPorInstallId: d.usadoPorInstallId || null, expiraEmMs: ms(d.expiraEm) };
    },

    async resgatarAtivacao(codigo, installId) {
      await comTimeout(updateDoc(doc(db, 'ativacoes_mobile', codigo), { usado: true, usadoPorInstallId: installId, usadoEm: serverTimestamp() }));
    },

    /** Cria (ou completa) o documento e devolve o horário do servidor. */
    async criarInstalacao(id, dados) {
      await comTimeout(setDoc(instalacao(id), converter({
        ...dados, criadoEm: AGORA_SERVIDOR, ultimoContato: AGORA_SERVIDOR, ultimoPing: AGORA_SERVIDOR,
      }), { merge: true }));
      const snap = await comTimeout(getDocFromServer(instalacao(id)));
      return ms(snap.data()?.ultimoContato);
    },

    async lerInstalacao(id) {
      const snap = await comTimeout(getDocFromServer(instalacao(id)));
      return snap.exists() ? snap.data() : null;
    },

    async atualizarInstalacao(id, campos) {
      await comTimeout(setDoc(instalacao(id), converter(campos), { merge: true }));
    },

    async ping(id, extras) {
      await comTimeout(setDoc(instalacao(id), converter({ ...extras, ultimoPing: AGORA_SERVIDOR }), { merge: true }));
    },

    escutarInstalacao(id, cb) {
      return onSnapshot(instalacao(id), { includeMetadataChanges: true }, (snap) => {
        const dados = snap.exists() ? snap.data({ serverTimestamps: 'none' }) : null;
        if (dados) dados.ultimoPingMs = ms(dados.ultimoPing);
        cb({ dados, pendente: snap.metadata.hasPendingWrites, doCache: snap.metadata.fromCache });
      }, (err) => console.warn('[nuvem] escuta da instalação falhou', err));
    },

    async enviarArquivo(caminho, bytes) {
      await uploadBytes(ref(storage, caminho), bytes, { contentType: 'application/gzip' });
    },

    async baixarArquivo(caminho) {
      return new Uint8Array(await getBytes(ref(storage, caminho)));
    },

    async registrarBackup(id, nomeArquivo, meta) {
      await comTimeout(setDoc(doc(db, 'installations', id, 'backups', nomeArquivo), converter(meta)));
    },

    async listarBackups(id) {
      const snap = await comTimeout(getDocs(query(collection(db, 'installations', id, 'backups'), orderBy('criadoEm', 'desc'))));
      return snap.docs.map((d) => {
        const b = d.data();
        return { id: d.id, nomeArquivo: b.nomeArquivo, caminhoStorage: b.caminhoStorage, criadoEmMs: b.criadoEmMs ?? ms(b.criadoEm) };
      });
    },

    async apagarBackup(id, backup) {
      try {
        await deleteObject(ref(storage, backup.caminhoStorage));
      } catch (err) {
        if (err?.code !== 'storage/object-not-found') throw err;
      }
      await comTimeout(deleteDoc(doc(db, 'installations', id, 'backups', backup.id || backup.nomeArquivo)));
    },

    // --- modo terminal (ver services/terminal.js e, no desktop,
    // electron/services/pdvMobileTerminalService.js). Tudo debaixo da
    // instalação DESTE celular: o computador escuta aqui.

    /** Sobe um evento da fila. Reenviar o mesmo id é seguro: o computador aplica cada evento uma vez só. */
    async enviarEventoTerminal(id, ev) {
      await comTimeout(setDoc(doc(db, 'installations', id, 'terminal_eventos', ev.id), converter({ ...ev, status: 'novo', enviadoEm: AGORA_SERVIDOR })));
    },

    escutarAcksTerminal(id, cb) {
      return onSnapshot(collection(db, 'installations', id, 'terminal_acks'), (snap) => {
        cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }, (err) => console.warn('[nuvem] escuta das confirmações do computador falhou', err));
    },

    async apagarAckTerminal(id, ackId) {
      await comTimeout(deleteDoc(doc(db, 'installations', id, 'terminal_acks', ackId)));
    },

    escutarCatalogoTerminal(id, cb) {
      return onSnapshot(doc(db, 'installations', id, 'terminal_catalogo', 'meta'), (snap) => {
        cb(snap.exists() ? snap.data() : null);
      }, (err) => console.warn('[nuvem] escuta do catálogo falhou', err));
    },

    async lerCatalogoTerminal(id, meta) {
      const nomes = [];
      for (let i = 0; i < (meta.partesProdutos || 0); i++) nomes.push(`p${i}`);
      for (let i = 0; i < (meta.partesClientes || 0); i++) nomes.push(`c${i}`);
      const docs = {};
      // `in` aceita até 30 valores por consulta.
      for (let i = 0; i < nomes.length; i += 30) {
        const snap = await comTimeout(getDocs(query(collection(db, 'installations', id, 'terminal_catalogo'), where(documentId(), 'in', nomes.slice(i, i + 30)))), 60000);
        for (const d of snap.docs) docs[d.id] = d.data();
      }
      return juntarCatalogo(meta, docs);
    },
  };
}
