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
const INTERVALO_PING_MS = 2 * 60 * 1000; // ping de presença a cada 2min — só pra "está online agora?" no painel, escrita bem mais leve que checkLicense()

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

  // Mesmo documento, mesma leitura — só aproveita os campos de
  // mensagem que vieram junto, sem precisar de outra consulta.
  try {
    require('./messageService').aplicarMensagemDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarMensagemDaInstalacao falhou:', err);
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
      const metricas = require('./metricsService').getMetricasAgregadas();
      await setDoc(ref, {
        ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion(),
        totalVendasHistorico: metricas.totalVendasHistorico,
        vendasUltimos30Dias: metricas.vendasUltimos30Dias,
        perfilAtivo: metricas.perfilAtivo,
      }, { merge: true });
      aplicarDadosDoServidor(snap.data());
    } else {
      // Primeira vez que essa instalação fala com o servidor — se
      // registra sozinha, sempre começando ativa (o congelamento ou
      // bloqueio é sempre uma ação manual sua depois, pelo painel).
      await setDoc(ref, {
        ativo: true, bloqueioImediato: false, clienteId: null, nomeNegocio: null,
        totalVendasHistorico: 0, vendasUltimos30Dias: 0, perfilAtivo: null,
        criadoEm: serverTimestamp(), ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion(),
      });
      aplicarDadosDoServidor({ ativo: true, bloqueioImediato: false });
    }
  } catch (err) {
    // Sem internet ou servidor fora é normal e não deveria virar
    // ruído — mas qualquer OUTRO erro (ex: um bug de verdade em algo
    // chamado aqui dentro) ficava completamente invisível antes disso,
    // sem log nenhum, sem rastro nenhum. Se checkLicense() parar de
    // funcionar de vez (por qualquer motivo que não seja rede), agora
    // pelo menos aparece no painel → Erros, em vez de falhar pra
    // sempre em silêncio sem ninguém saber por quê.
    const pareceErroDeRede = /network|fetch|ECONNREFUSED|ENOTFOUND|timeout|offline/i.test(err?.message || '');
    if (!pareceErroDeRede) {
      console.error('[checkLicense] falhou (não parece ser erro de rede):', err);
      require('./errorReportService').reportarErro({
        mensagem: err?.message, stack: err?.stack, contexto: 'checkLicense',
      });
    }
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
 * Ping de presença — escreve `ultimoPing` no próprio documento a cada
 * 2 minutos, só isso, sem rodar o resto da lógica de checkLicense()
 * (não precisa reavaliar licença toda hora, só dar sinal de vida
 * leve). É o que o painel usa pra mostrar "online agora" de verdade —
 * o heartbeat de 6h sozinho é grosso demais pra isso (uma instalação
 * podia estar rodando faz horas e ainda aparecer "sem contato" se
 * dependesse só dele).
 *
 * Limitação honesta: como o Firestore não tem um mecanismo de
 * presença nativo tipo onDisconnect() (isso existe no Realtime
 * Database, não no Firestore), se o app fechar de forma abrupta
 * (queda de luz, processo morto à força), o painel só vai mostrar
 * "offline" depois de alguns minutos sem ping novo — não instantâneo.
 */
async function enviarPing() {
  try {
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const firestore = getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const ref = doc(firestore, 'installations', installId);
    await setDoc(ref, { ultimoPing: serverTimestamp() }, { merge: true });
  } catch (err) {
    // Sem internet, ou o app acabou de abrir e ainda nem criou o
    // documento — não tem problema, o próximo ping tenta de novo.
  }
}

function iniciarPingDePresenca() {
  enviarPing();
  setInterval(enviarPing, INTERVALO_PING_MS);
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
  checkLicense, computeAccessStatus, iniciarEscutaTempoReal, iniciarPingDePresenca, getLicenseFirestore,
  GRACE_CONGELADA_DIAS, GRACE_SEM_INTERNET_DIAS, INTERVALO_CHECAGEM_MS, INTERVALO_PING_MS,
};
