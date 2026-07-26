const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getDb } = require('./db/database');
const { registerIpcHandlers } = require('./ipc/handlers');
const timeService = require('./services/timeService');
const backupService = require('./services/backupService');
const updateService = require('./services/updateService');

const isDev = !app.isPackaged;

// Protocolo customizado app:// — evita as restrições do Chromium para
// carregar módulos ES via file:// em produção.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // necessário para o visualizador de PDF nativo funcionar embutido (iframe)
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    // Host fixo "app" — nunca muda durante o carregamento de recursos
    // relativos (JS/CSS gerados pelo Vite), então o "pathname" da URL
    // sempre reflete o caminho real do arquivo dentro de dist/.
    // (Carregar "app://index.html" direto, sem host fixo, faz o Chromium
    // tratar "index.html" como se fosse o domínio — todo recurso relativo
    // carregado depois vira "app://index.html/assets/...", uma pasta que
    // não existe. Essa era a causa da tela branca no build empacotado.)
    win.loadURL('app://app/index.html');
  }

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('[did-fail-load]', errorCode, errorDescription, validatedURL);
  });
}

app.whenReady().then(() => {
  if (!isDev) {
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const relativePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const fullPath = path.join(__dirname, '../dist', relativePath);
      return net.fetch(pathToFileURL(fullPath).toString());
    });
  }

  getDb(); // garante schema criado e seed aplicado antes de abrir a janela
  timeService.startAutoSync(); // sincroniza com a internet assim que possível, e a cada 15 min
  registerIpcHandlers();
  createWindow();

  // Backup automático (uma vez por dia) — não trava a abertura do app.
  // Verifica de novo periodicamente porque muita farmácia deixa o app
  // aberto o dia inteiro sem reiniciar.
  backupService.runBackupIfNeeded();
  setInterval(() => backupService.runBackupIfNeeded(), 2 * 60 * 60 * 1000);

  // Atualização automática — só AVISA sozinho (nunca baixa/instala sem
  // pedir); verifica 1 min depois de abrir (não trava a abertura do
  // app) e depois a cada 4h.
  updateService.setupAutoUpdater();
  setTimeout(() => updateService.checkForUpdates(), 60 * 1000);
  setInterval(() => updateService.checkForUpdates(), 4 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
