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
const INTERVALO_CHECAGEM_MS = 6 * 60 * 60 * 1000; // confere a cada 6h

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

function saveLocalState({ ultimoContatoOk, congeladaDesde, statusAtual }) {
  const db = getDb();
  const atual = getLocalState();
  db.prepare(
    `UPDATE license_state SET ultimo_contato_ok = ?, congelada_desde = ?, status_atual = ? WHERE id = 1`
  ).run(
    ultimoContatoOk !== undefined ? ultimoContatoOk : atual.ultimo_contato_ok,
    congeladaDesde !== undefined ? congeladaDesde : atual.congelada_desde,
    statusAtual !== undefined ? statusAtual : atual.status_atual,
  );
}

/**
 * Consulta o servidor de licenciamento e atualiza o estado local.
 * Sempre resiliente a falha de rede — se não conseguir falar com o
 * servidor (sem internet, projeto ainda não configurado, etc.), não
 * atualiza nada; o cálculo de acesso usa o último estado local
 * conhecido, então o app continua funcionando normalmente dentro da
 * carência.
 */
async function checkLicense() {
  try {
    const { doc, getDoc, setDoc, serverTimestamp } = require('firebase/firestore');
    const { app: electronApp } = require('electron');
    const firestore = getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const ref = doc(firestore, 'installations', installId);
    const snap = await getDoc(ref);

    let ativo = true;
    if (snap.exists()) {
      ativo = snap.data().ativo !== false;
      await setDoc(ref, { ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion() }, { merge: true });
    } else {
      // Primeira vez que essa instalação fala com o servidor — se
      // registra sozinha, sempre começando ativa (o congelamento é
      // sempre uma ação manual sua depois, pelo painel).
      await setDoc(ref, {
        ativo: true, criadoEm: serverTimestamp(), ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion(),
      });
    }

    const agora = new Date().toISOString();
    const estadoAnterior = getLocalState();
    if (!ativo) {
      saveLocalState({ ultimoContatoOk: agora, congeladaDesde: estadoAnterior.congelada_desde || agora, statusAtual: 'inativa' });
    } else {
      saveLocalState({ ultimoContatoOk: agora, congeladaDesde: null, statusAtual: 'ativa' });
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

/**
 * Decide se o app deve funcionar normal, mostrar aviso, ou bloquear —
 * baseado só no estado LOCAL, sem chamada de rede. Pode ser chamado a
 * qualquer momento, inclusive totalmente offline.
 */
function computeAccessStatus() {
  const state = getLocalState();
  const agora = Date.now();

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
  checkLicense, computeAccessStatus, GRACE_CONGELADA_DIAS, GRACE_SEM_INTERNET_DIAS, INTERVALO_CHECAGEM_MS,
};
