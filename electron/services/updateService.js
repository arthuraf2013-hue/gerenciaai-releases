const { autoUpdater } = require('electron-updater');

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
  // downloadUpdate abaixo, chamados separadamente).
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
  });
  autoUpdater.on('update-downloaded', () => {
    status = { ...status, baixando: false, baixado: true, progresso: 100 };
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

module.exports = { setupAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall, getStatus };
