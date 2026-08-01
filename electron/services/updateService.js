const { autoUpdater } = require('electron-updater');
const { getDb } = require('../db/database');

let status = {
  checking: false,
  disponivel: false,
  versaoDisponivel: null,
  baixando: false,
  progresso: 0,
  baixado: false,
  erro: null,
  versaoAtual: null,
};

function setupAutoUpdater() {
  // Nunca baixa sozinho sem o usuário pedir — só avisa que tem uma nova
  // versão. Baixar consome banda e o operador pode estar no meio do
  // expediente; melhor deixar a decisão explícita (ver checkForUpdates/
  // downloadUpdate abaixo, chamados separadamente) — EXCETO no fluxo de
  // atualização obrigatória, que chama downloadUpdate() diretamente
  // quando o usuário confirma na tela de bloqueio.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  status.versaoAtual = require('electron').app.getVersion();

  autoUpdater.on('checking-for-update', () => {
    status = { ...status, checking: true, erro: null };
  });
  autoUpdater.on('update-available', (info) => {
    status = { ...status, checking: false, disponivel: true, versaoDisponivel: info.version };
  });
  autoUpdater.on('update-not-available', () => {
    status = { ...status, checking: false, disponivel: false };
  });
  autoUpdater.on('download-progress', (p) => {
    status = { ...status, baixando: true, progresso: Math.round(p.percent) };
    reportarProgressoNoFirestore().catch(() => {}); // best-effort, nunca trava o download por causa disso
  });
  autoUpdater.on('update-downloaded', () => {
    status = { ...status, baixando: false, baixado: true, progresso: 100 };
    reportarProgressoNoFirestore().catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    // Erro mais comum aqui: o publish do package.json ainda não foi
    // configurado com um repositório GitHub real (owner/repo de
    // exemplo) — no lugar de travar o app, só marca no status, a tela
    // mostra isso como "verifique a configuração de publicação".
    status = { ...status, checking: false, baixando: false, erro: err.message };
  });
}

function checkForUpdates() {
  status = { ...status, erro: null };
  autoUpdater.checkForUpdates().catch((err) => {
    status = { ...status, checking: false, erro: err.message };
  });
  return { ok: true };
}

function downloadUpdate() {
  if (!status.disponivel) return { ok: false, error: 'Nenhuma atualização disponível pra baixar.' };
  autoUpdater.downloadUpdate().catch((err) => {
    status = { ...status, baixando: false, erro: err.message };
  });
  return { ok: true };
}

function quitAndInstall() {
  if (!status.baixado) return { ok: false, error: 'A atualização ainda não terminou de baixar.' };
  autoUpdater.quitAndInstall();
  return { ok: true };
}

function getStatus() {
  return status;
}

// ============================================================
// Atualização obrigatória — publicada remotamente pelo painel de
// licenciamento, pra não precisar atualizar cliente por cliente na
// mão. Reaproveita o MESMO projeto Firebase do licenciamento (não
// precisa de um projeto separado) e o MESMO id de instalação.
// ============================================================

/** Compara duas versões tipo "0.4.10" — mais seguro que comparar como
 * texto puro (que erraria "0.4.10" < "0.4.9", já que '1' < '9'). */
function versaoMenorQue(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

function getLocalForcedUpdateState() {
  const db = getDb();
  return db.prepare('SELECT * FROM forced_update_state WHERE id = ?').get('default');
}

function saveLocalForcedUpdateState({ versaoMinimaExigida, obrigatoria }) {
  const db = getDb();
  db.prepare('UPDATE forced_update_state SET versao_minima_exigida = ?, obrigatoria = ? WHERE id = ?')
    .run(versaoMinimaExigida || null, obrigatoria ? 1 : 0, 'default');
}

/** Decide, só com dado local (sem rede), se a atualização obrigatória
 * está bloqueando o uso agora — pode ser chamado a qualquer momento,
 * inclusive offline (usa o último valor conhecido). */
function verificarAtualizacaoObrigatoria() {
  const state = getLocalForcedUpdateState();
  const versaoAtual = require('electron').app.getVersion();
  if (!state.obrigatoria || !state.versao_minima_exigida) {
    return { bloqueado: false };
  }
  const precisaAtualizar = versaoMenorQue(versaoAtual, state.versao_minima_exigida);
  return { bloqueado: precisaAtualizar, versaoMinimaExigida: state.versao_minima_exigida, versaoAtual };
}

let pararEscutaAtualizacao = null;

/** Escuta em tempo real o documento único de config de atualização
 * (publicado pelo painel) — assim que você publica uma nova versão
 * obrigatória, todo cliente conectado percebe em poucos segundos. */
function iniciarEscutaAtualizacaoObrigatoria() {
  try {
    const licenseService = require('./licenseService');
    const { doc, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const ref = doc(firestore, 'config', 'atualizacao');

    if (pararEscutaAtualizacao) pararEscutaAtualizacao();
    pararEscutaAtualizacao = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          saveLocalForcedUpdateState({ versaoMinimaExigida: d.versaoMinimaExigida, obrigatoria: d.obrigatoria === true });
        } else {
          saveLocalForcedUpdateState({ versaoMinimaExigida: null, obrigatoria: false });
        }
      },
      (err) => console.error('[updateService] escuta de atualização obrigatória falhou:', err)
    );
  } catch (err) {
    console.error('[updateService] não foi possível iniciar a escuta de atualização obrigatória:', err);
  }
}

/** Escreve o progresso do download no próprio documento da instalação
 * no Firestore (mesma coleção `installations` do licenciamento) — é
 * assim que o painel consegue mostrar a barra de progresso de cada
 * cliente. Melhor esforço só — nunca trava o download por causa disso. */
async function reportarProgressoNoFirestore() {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { doc, setDoc } = require('firebase/firestore');
  const firestore = licenseService.getLicenseFirestore();
  const installId = pdvRegistryService.getOrCreateDeviceUid();
  const ref = doc(firestore, 'installations', installId);
  await setDoc(ref, {
    atualizacaoBaixando: status.baixando,
    atualizacaoProgresso: status.progresso,
    atualizacaoBaixado: status.baixado,
    atualizacaoVersaoAlvo: status.versaoDisponivel || null,
  }, { merge: true });
}

module.exports = {
  setupAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall, getStatus,
  verificarAtualizacaoObrigatoria, iniciarEscutaAtualizacaoObrigatoria, versaoMenorQue,
};
