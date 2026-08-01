const { getDb } = require('../db/database');
const pdvRegistryService = require('./pdvRegistryService');

// Config do projeto Firebase DE LICENCIAMENTO — este é um projeto SEU
// (Arthur), separado do Firebase que cada cliente configura pra
// sincronizar PDVs entre si. Todo instalador leva a MESMA config
// (diferente do sync, que cada cliente digita a sua). Preencha antes
// de publicar — veja LICENCIAMENTO.md pra criar o projeto e pegar
// esses valores.
const LICENSE_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};

const GRACE_CONGELADA_DIAS = 2;
const GRACE_SEM_INTERNET_DIAS = 3;
const INTERVALO_CHECAGEM_MS = 6 * 60 * 60 * 1000; // confere a cada 6h (reconciliação de reserva — a escuta em tempo real é o caminho principal enquanto online)

let licenseApp = null;
function getLicenseFirestore() {
  const { initializeApp, getApps } = require('firebase/app');
  const { getFirestore } = require('firebase/firestore');
  if (!licenseApp) {
    const existente = getApps().find((a) => a.name === 'licensing');
    licenseApp = existente || initializeApp(LICENSE_FIREBASE_CONFIG, 'licensing');
  }
  return getFirestore(licenseApp);
}

function getLocalState() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM license_state WHERE id = 1').get();
  if (!row) {
    db.prepare(`INSERT INTO license_state (id, status_atual) VALUES (1, 'ativa')`).run();
    row = db.prepare('SELECT * FROM license_state WHERE id = 1').get();
  }
  return row;
}

function saveLocalState({ ultimoContatoOk, congeladaDesde, bloqueioImediato, statusAtual }) {
  const db = getDb();
  const atual = getLocalState();
  db.prepare(
    `UPDATE license_state SET ultimo_contato_ok = ?, congelada_desde = ?, bloqueio_imediato = ?, status_atual = ? WHERE id = 1`
  ).run(
    ultimoContatoOk !== undefined ? ultimoContatoOk : atual.ultimo_contato_ok,
    congeladaDesde !== undefined ? congeladaDesde : atual.congelada_desde,
    bloqueioImediato !== undefined ? (bloqueioImediato ? 1 : 0) : atual.bloqueio_imediato,
    statusAtual !== undefined ? statusAtual : atual.status_atual,
  );
}

/** Aplica o que veio do servidor (via getDoc ou via onSnapshot) no
 * estado local — usado tanto pela checagem periódica quanto pela
 * escuta em tempo real, pra não duplicar essa lógica nos dois lugares. */
function aplicarDadosDoServidor(dados) {
  const ativo = dados.ativo !== false;
  const bloqueioImediato = dados.bloqueioImediato === true;
  const agora = new Date().toISOString();
  const estadoAnterior = getLocalState();

  if (bloqueioImediato) {
    // Bloqueio direto — sem carência nenhuma, diferente do congelamento.
    saveLocalState({ ultimoContatoOk: agora, bloqueioImediato: true, statusAtual: 'inativa' });
  } else if (!ativo) {
    saveLocalState({
      ultimoContatoOk: agora, bloqueioImediato: false,
      congeladaDesde: estadoAnterior.congelada_desde || agora, statusAtual: 'inativa',
    });
  } else {
    saveLocalState({ ultimoContatoOk: agora, congeladaDesde: null, bloqueioImediato: false, statusAtual: 'ativa' });
  }
}

/**
 * Consulta o servidor de licenciamento uma vez e atualiza o estado
 * local. Sempre resiliente a falha de rede — se não conseguir falar
 * com o servidor, não atualiza nada; o cálculo de acesso usa o último
 * estado local conhecido, então o app continua funcionando normalmente
 * dentro da carência. Também garante o "heartbeat" (ultimoContato,
 * versaoApp) pro painel saber que a instalação está viva.
 */
async function checkLicense() {
  try {
    const { doc, getDoc, setDoc, serverTimestamp } = require('firebase/firestore');
    const { app: electronApp } = require('electron');
    const firestore = getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const ref = doc(firestore, 'installations', installId);
    const snap = await getDoc(ref);

    if (snap.exists()) {
      await setDoc(ref, { ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion() }, { merge: true });
      aplicarDadosDoServidor(snap.data());
    } else {
      // Primeira vez que essa instalação fala com o servidor — se
      // registra sozinha, sempre começando ativa (o congelamento ou
      // bloqueio é sempre uma ação manual sua depois, pelo painel).
      await setDoc(ref, {
        ativo: true, bloqueioImediato: false, clienteId: null, nomeNegocio: null,
        criadoEm: serverTimestamp(), ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion(),
      });
      aplicarDadosDoServidor({ ativo: true, bloqueioImediato: false });
    }
  } catch (err) {
    // Sem internet, servidor fora, ou config ainda não preenchida —
    // silenciosamente não atualiza nada. computeAccessStatus() decide
    // o que fazer com base no último contato bem-sucedido.
  }

  try {
    return computeAccessStatus();
  } catch (err) {
    // Nunca deixa isso subir sem tratamento — checkLicense() é chamada
    // sem await no main.js (fire-and-forget), e uma promise rejeitada
    // sem handler pode derrubar o processo principal do Electron.
    console.error('[licenseService] computeAccessStatus falhou:', err);
    return { status: 'ok' }; // na dúvida, nunca bloqueia o app por causa de erro interno daqui
  }
}

let pararEscuta = null;

/**
 * Escuta em tempo real o próprio documento da instalação — assim,
 * quando você congela ou bloqueia pelo painel, o app percebe assim
 * que a mudança chega (poucos segundos, se estiver online), em vez de
 * esperar a checagem periódica de 6h. É o que faz o "bloqueio
 * imediato" ser imediato de verdade, e não só "na próxima checagem".
 * A checagem periódica (checkLicense) continua rodando como reforço —
 * cobre o caso de a escuta cair e não reconectar sozinha, e é o que
 * atualiza o heartbeat (ultimoContato) que o painel mostra.
 */
function iniciarEscutaTempoReal() {
  try {
    const { doc, onSnapshot } = require('firebase/firestore');
    const firestore = getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const ref = doc(firestore, 'installations', installId);

    if (pararEscuta) pararEscuta(); // evita duplicar se chamado mais de uma vez
    pararEscuta = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) aplicarDadosDoServidor(snap.data());
      },
      (err) => {
        // Erro de conexão/permissão — não derruba nada, só loga. A
        // checagem periódica continua cobrindo enquanto a escuta não
        // se restabelece sozinha (o SDK do Firestore tenta reconectar
        // automaticamente).
        console.error('[licenseService] escuta em tempo real falhou:', err);
      }
    );
  } catch (err) {
    console.error('[licenseService] não foi possível iniciar a escuta em tempo real:', err);
  }
}

/**
 * Decide se o app deve funcionar normal, mostrar aviso, ou bloquear —
 * baseado só no estado LOCAL, sem chamada de rede. Pode ser chamado a
 * qualquer momento, inclusive totalmente offline.
 */
function computeAccessStatus() {
  const state = getLocalState();
  const agora = Date.now();

  if (state.bloqueio_imediato) {
    return { status: 'bloqueado', motivo: 'bloqueio_imediato' };
  }

  if (state.congelada_desde) {
    const diasCongelada = (agora - new Date(state.congelada_desde).getTime()) / 86400000;
    if (diasCongelada >= GRACE_CONGELADA_DIAS) {
      return { status: 'bloqueado', motivo: 'congelada' };
    }
    return { status: 'aviso', motivo: 'congelada', diasRestantes: Math.max(0, GRACE_CONGELADA_DIAS - diasCongelada) };
  }

  if (state.ultimo_contato_ok) {
    const diasSemContato = (agora - new Date(state.ultimo_contato_ok).getTime()) / 86400000;
    if (diasSemContato >= GRACE_SEM_INTERNET_DIAS) {
      return { status: 'bloqueado', motivo: 'sem_internet' };
    }
  }
  // Se ultimo_contato_ok ainda é nulo (instalação nova, ou nunca
  // conseguiu falar com o servidor desde sempre), deixa passar — não
  // trava alguém só porque a rede caiu bem na primeira execução, ou
  // porque o projeto de licenciamento ainda não foi configurado.

  return { status: 'ok' };
}

module.exports = {
  checkLicense, computeAccessStatus, iniciarEscutaTempoReal,
  GRACE_CONGELADA_DIAS, GRACE_SEM_INTERNET_DIAS, INTERVALO_CHECAGEM_MS,
};
