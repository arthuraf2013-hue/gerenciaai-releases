/**
 * Presença no Realtime Database (redundância e economia da cota).
 *
 * Cada computador fica conectado em presenca/{installId}; o próprio
 * Firebase grava `on: false` quando a conexão cai (onDisconnect). A Central
 * e os celulares olham isto em vez de esperar batimentos gravados no
 * Firestore -- o Realtime Database não conta escritas por dia (o limite do
 * plano grátis é de conexões simultâneas e de tráfego).
 *
 * O servidor do grupo também anuncia aqui onde está na rede da loja
 * (hubs/{grupoId}), para os caixas o acharem (lanClienteService).
 *
 * Sem o banco criado no console (ou sem internet), nada muda: o app segue
 * com o ping no Firestore (licenseService) e os batimentos de sempre.
 */

const RTDB_URL = 'https://gerenciaai-licencas-default-rtdb.firebaseio.com';
// Teste com o emulador (o SDK também lê esta variável sozinho).
const EMULADOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST || null;
const RECHECAR_SEM_BANCO_MS = 6 * 60 * 60 * 1000;
const RECHECAR_SEM_REDE_MS = 5 * 60 * 1000;

let bancoDb = null;
let iniciado = false;
let conectado = false;
let relogioChecagem = null;
let hubAnunciado = null; // { grupoId, dados }
let fetchDeTeste = null;

function firebaseDesligado() {
  try { return require('./licenseService').firebaseRealDesligado(); } catch { return false; }
}

/** true = existe, false = não criado no console, null = não deu para saber agora. */
async function bancoExiste() {
  try {
    const controle = new AbortController();
    const t = setTimeout(() => controle.abort(), 8000); t.unref?.();
    const url = EMULADOR ? `http://${EMULADOR}/.json?shallow=true&ns=gerenciaai-licencas-default-rtdb` : `${RTDB_URL}/.json?shallow=true`;
    const r = await (fetchDeTeste || globalThis.fetch)(url, { signal: controle.signal }).finally(() => clearTimeout(t));
    if (r.status === 404) return false;
    return r.status === 200 || r.status === 401 || r.status === 403;
  } catch { return null; }
}

function dadosDaMaquina() {
  const { serverTimestamp } = require('firebase/database');
  let v = null; let nome = null; let grupo = null; let srv = false;
  try { v = require('electron').app.getVersion(); } catch { /* testes */ }
  try { nome = require('./licenseService').nomeDoComputador(); } catch { /* sem nome */ }
  try { grupo = require('./syncStateService').getGrupoSincronizacaoId() || null; srv = grupo ? require('./syncStateService').ehServidorDoGrupo() : false; } catch { /* banco abrindo */ }
  const d = { on: true, visto: serverTimestamp(), srv: !!srv };
  if (v) d.v = String(v).slice(0, 20);
  if (nome) d.nome = String(nome).slice(0, 63);
  d.grupo = grupo ? String(grupo).slice(0, 64) : null;
  return d;
}

async function aoConectar() {
  const { ref, onDisconnect, update, set, serverTimestamp } = require('firebase/database');
  const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
  const presRef = ref(bancoDb, `presenca/${installId}`);
  // onDisconnect com o documento inteiro (set): as regras conferem cada
  // campo de um update separado, e o "on" ainda não existe na 1ª conexão.
  const dados = dadosDaMaquina();
  await onDisconnect(presRef).set({ ...dados, on: false, visto: serverTimestamp() });
  await update(presRef, { ...dados, desde: serverTimestamp() });
  if (hubAnunciado) {
    const hubRef = ref(bancoDb, `hubs/${hubAnunciado.grupoId}`);
    await onDisconnect(hubRef).remove();
    await set(hubRef, { ...hubAnunciado.dados, on: true, atualizado: serverTimestamp() });
  }
  conectado = true;
}

function ligarSdk() {
  const { getDatabase, ref, onValue } = require('firebase/database');
  bancoDb = getDatabase(require('./licenseService').getLicenseApp(), RTDB_URL);
  onValue(ref(bancoDb, '.info/connected'), (snap) => {
    if (snap.val() !== true) { conectado = false; return; }
    aoConectar().catch((err) => {
      conectado = false;
      console.error('[presenca] não deu para marcar presença:', err?.message || err);
    });
  });
}

function agendarChecagem(ms) {
  if (relogioChecagem) clearTimeout(relogioChecagem);
  relogioChecagem = setTimeout(() => { relogioChecagem = null; iniciar(); }, ms);
  relogioChecagem.unref?.();
}

/** Liga a presença (se o banco existir). Pode chamar de novo: não duplica. */
async function iniciar() {
  if (iniciado || firebaseDesligado()) return;
  const existe = await bancoExiste();
  if (existe !== true) {
    agendarChecagem(existe === false ? RECHECAR_SEM_BANCO_MS : RECHECAR_SEM_REDE_MS);
    return;
  }
  try {
    ligarSdk();
    iniciado = true;
  } catch (err) {
    console.error('[presenca] Realtime Database indisponível neste app:', err?.message || err);
    agendarChecagem(RECHECAR_SEM_BANCO_MS);
  }
}

/** Grupo/servidor mudou (Central): atualiza o que a Central vê. */
function atualizarDados() {
  if (!bancoDb || !conectado) return;
  try {
    const { ref, update, onDisconnect, serverTimestamp } = require('firebase/database');
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    const presRef = ref(bancoDb, `presenca/${installId}`);
    const dados = dadosDaMaquina();
    onDisconnect(presRef).set({ ...dados, on: false, visto: serverTimestamp() })
      .then(() => update(presRef, dados)).catch(() => {});
  } catch { /* sem banco */ }
}

/** Servidor do grupo diz onde está na rede da loja (ou some, com null). */
function anunciarHub(grupoId, dados) {
  const antes = hubAnunciado;
  hubAnunciado = dados && grupoId ? { grupoId, dados } : null;
  if (!bancoDb || !conectado) return;
  try {
    const { ref, set, remove, onDisconnect, serverTimestamp } = require('firebase/database');
    if (antes && (!hubAnunciado || antes.grupoId !== hubAnunciado.grupoId)) {
      const velho = ref(bancoDb, `hubs/${antes.grupoId}`);
      onDisconnect(velho).cancel().catch(() => {});
      remove(velho).catch(() => {});
    }
    if (hubAnunciado) {
      const hubRef = ref(bancoDb, `hubs/${grupoId}`);
      onDisconnect(hubRef).remove().then(() => set(hubRef, { ...dados, on: true, atualizado: serverTimestamp() })).catch(() => {});
    }
  } catch { /* sem banco */ }
}

function estaConectado() { return conectado; }

/**
 * Os celulares pareados destes tipos já olham a presença? (o app novo do
 * celular avisa em dispositivos/{uid}.recursos.presenca). Enquanto algum
 * não olhar -- ou se esta máquina não estiver na presença -- o computador
 * mantém o batimento antigo no Firestore para ele.
 */
function celularesUsamPresenca(tipos) {
  if (!conectado) return false;
  try {
    const { getDb } = require('../db/database');
    const lista = getDb().prepare(
      `SELECT id FROM paired_devices WHERE ativo = 1 AND tipo IN (${tipos.map(() => '?').join(',')})`
    ).all(...tipos);
    const recursos = require('./pairingService').recursosDosDispositivos();
    return lista.every((d) => Number(recursos.get(d.id)?.presenca) >= 1);
  } catch { return false; }
}

function _bancoParaTeste() { return bancoDb; }

function _paraTeste({ fetch, conectado: c } = {}) {
  if (fetch !== undefined) fetchDeTeste = fetch;
  if (c !== undefined) conectado = c;
}

module.exports = {
  RTDB_URL, iniciar, bancoExiste, _bancoParaTeste, atualizarDados, anunciarHub, estaConectado, celularesUsamPresenca, _paraTeste,
};
