const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getDb } = require('./db/database');
const { registerIpcHandlers } = require('./ipc/handlers');
const timeService = require('./services/timeService');
const backupService = require('./services/backupService');
const updateService = require('./services/updateService');
const licenseService = require('./services/licenseService');
const errorReportService = require('./services/errorReportService');

const isDev = !app.isPackaged;

// Reporta qualquer erro não tratado no processo principal antes de deixar
// o comportamento padrão do Node acontecer (fechar o processo) — sem
// isso, um crash no processo principal simplesmente fecharia o app sem
// nenhum rastro, nem pro Arthur nem pro cliente.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  errorReportService.reportarErro({ mensagem: err.message, stack: err.stack, contexto: 'processo-principal' })
    .finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err);
  errorReportService.reportarErro({ mensagem: err.message, stack: err.stack, contexto: 'processo-principal-promise' });
  // Não derruba o processo aqui — promise rejeitada sem handler é mais
  // comum e geralmente recuperável, diferente de uma exceção síncrona.
});

// Protocolo customizado app:// — evita as restrições do Chromium para
// carregar módulos ES via file:// em produção.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Impede duas instâncias do app rodando ao mesmo tempo na mesma
// máquina. Sem isso, uma instância antiga esquecida aberta (minimizada,
// ou de um teste anterior) continua rodando seu próprio checkLicense()
// periódico com a versão ANTIGA embutida — e pode sobrescrever, no
// Firestore, o que a instância nova acabou de escrever, fazendo a
// versão parecer "travada" no painel mesmo depois de atualizar de
// verdade e abrir o app novo. Quem tenta abrir uma segunda vez só foca
// a janela que já está aberta, em vez de abrir outra por cima.
const temOLock = app.requestSingleInstanceLock();
if (!temOLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const janelas = BrowserWindow.getAllWindows();
    if (janelas.length > 0) {
      const win = janelas[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, '../build/icon.png'),
    show: false, // só mostra a janela quando o conteúdo já estiver pronto (ver ready-to-show) — evita o flash de tela branca em PCs mais lentos, onde o carregamento demora mais
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // necessário para o visualizador de PDF nativo funcionar embutido (iframe)
    },
  });

  win.once('ready-to-show', () => win.show());

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
  // Segunda camada de proteção do lock de instância única — o
  // app.quit() chamado mais acima é assíncrono, então sem essa
  // checagem aqui, uma instância "perdedora" ainda podia chegar a
  // inicializar serviço (checkLicense, ping de presença) antes do
  // quit() terminar de verdade.
  if (!temOLock) return;
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
  backupService.runBackupIfNeeded().catch((err) => console.error('[backup]', err));
  setInterval(() => backupService.runBackupIfNeeded().catch((err) => console.error('[backup]', err)), 2 * 60 * 60 * 1000);

  // Atualização automática — só AVISA sozinho (nunca baixa/instala sem
  // pedir); verifica 1 min depois de abrir (não trava a abertura do
  // app) e depois a cada 4h.
  updateService.setupAutoUpdater();
  // Limpa o status de download/instalação no Firestore assim que o app
  // sobe — sem isso, depois que o cliente reinicia na versão nova, o
  // painel continuava mostrando "baixado, aguardando reiniciar" pra
  // sempre (o status só era escrito DURANTE o download, nunca
  // "zerado" depois que o reinício de verdade acontecia).
  updateService.reportarProgressoNoFirestore().catch((err) => console.error('[update]', err));
  updateService.iniciarEscutaAtualizacaoObrigatoria();
  setTimeout(() => { try { updateService.checkForUpdates(); } catch (err) { console.error('[update]', err); } }, 60 * 1000);
  setInterval(() => { try { updateService.checkForUpdates(); } catch (err) { console.error('[update]', err); } }, 4 * 60 * 60 * 1000);

  // Licenciamento — confere com o servidor central se a instalação
  // está ativa. Nunca trava a abertura do app esperando rede (roda em
  // segundo plano); o bloqueio de verdade, se acontecer, é decidido
  // pelo próprio React a partir do estado local já salvo.
  licenseService.checkLicense().catch((err) => console.error('[license]', err));
  licenseService.iniciarEscutaTempoReal();
  licenseService.iniciarPingDePresenca();
  require('./services/productSyncService').iniciarEscutaProdutos();
  require('./services/salesSyncService').pushTodoOHistorico();
  require('./services/messageService').iniciarEscutaMensagemGlobal();
  setInterval(() => licenseService.checkLicense().catch((err) => console.error('[license]', err)), licenseService.INTERVALO_CHECAGEM_MS);
  // Reenvio periódico de segurança — o push de cada venda ao finalizar
  // é best-effort (não trava a venda se a rede cair naquele instante
  // exato); sem isso, uma falha silenciosa isolada só seria corrigida
  // no próximo reinício do app. Reescrever a mesma venda de novo é
  // inofensivo (mesmo ID sobrescreve), então repetir isso não tem risco.
  setInterval(() => require('./services/salesSyncService').pushTodoOHistorico(), 15 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  // Se algo travar aqui (ex: uma migração de banco falhando, ou
  // qualquer outro erro síncrono na inicialização), sem esse catch o
  // app fecharia silenciosamente sem abrir janela nenhuma, sem deixar
  // nenhum rastro visível pra quem está usando — só um log que
  // ninguém vê. Mostra um alerta nativo em vez disso.
  console.error('[inicialização]', err);
  const { dialog } = require('electron');
  dialog.showErrorBox(
    'GerenciaAI não conseguiu iniciar',
    `Ocorreu um erro ao abrir o sistema:\n\n${err?.message || err}\n\nTente abrir o app de novo. Se continuar acontecendo, entre em contato com o suporte e informe esta mensagem.`
  );
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
