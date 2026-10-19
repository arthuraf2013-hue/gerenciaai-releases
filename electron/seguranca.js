const path = require('path');

/**
 * Regras de endurecimento do Electron, em funções puras (testáveis sem
 * abrir janela -- ver tests/segurancaElectron.test.js) + a ligação delas
 * no app (aplicarEmTodoWebContents / respostaDoProtocoloApp).
 */

// Esquemas que podem ser abertos FORA do app (navegador do sistema,
// WhatsApp, e-mail). Qualquer outro (file:, javascript:, smb:, ms-*:,
// protocolos de outros programas) é recusado.
const ESQUEMAS_EXTERNOS = new Set(['https:', 'http:', 'mailto:', 'tel:', 'whatsapp:']);

function urlExternaPermitida(url) {
  try {
    const u = new URL(String(url));
    return ESQUEMAS_EXTERNOS.has(u.protocol);
  } catch {
    return false;
  }
}

/** A janela do app só navega dentro do próprio app. */
function navegacaoPermitida(url, { isDev = false } = {}) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'app:' && u.host === 'app') return true;
    if (isDev && u.origin === 'http://localhost:5173') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Caminho do arquivo pedido via app://app/... -- devolve null se sair da
 * pasta base (ex.: "..%2f..%2f" decodificado vira "../../"; o parser de
 * URL não normaliza barra codificada).
 */
function resolverDentroDe(base, caminhoUrl) {
  let relativo;
  try {
    relativo = decodeURIComponent(caminhoUrl === '/' ? '/index.html' : caminhoUrl);
  } catch {
    return null;
  }
  // Byte nulo e barra invertida (separador no Windows) nunca aparecem num
  // arquivo legítimo do build.
  if (relativo.includes('\0') || relativo.includes('\\')) return null;
  const raiz = path.resolve(base);
  const completo = path.resolve(raiz, `.${path.sep}${relativo.replace(/^[/\\]+/, '')}`);
  if (completo !== raiz && !completo.startsWith(raiz + path.sep)) return null;
  return completo;
}

// CSP da interface empacotada. 'unsafe-inline' só em estilo (atributos
// style do React e o <style> do preview do cardápio em iframe srcdoc);
// script só do próprio app -- um texto injetado com <script> ou
// onerror="..." não executa.
const CSP_APP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' data: blob:",
  "object-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const PERMISSOES_PERMITIDAS = new Set(['clipboard-sanitized-write']);

function aplicarEmTodoWebContents(app, { isDev = false } = {}) {
  const { shell, session } = require('electron');
  app.on('web-contents-created', (_e, contents) => {
    // window.open / target=_blank: nunca abre janela nova do Electron (ela
    // herdaria o preload, e uma página da internet ganharia acesso ao IPC).
    contents.setWindowOpenHandler(({ url }) => {
      if (urlExternaPermitida(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', (evento, url) => {
      if (navegacaoPermitida(url, { isDev })) return;
      evento.preventDefault();
      if (urlExternaPermitida(url)) shell.openExternal(url).catch(() => {});
    });
    contents.on('will-attach-webview', (evento) => evento.preventDefault());
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, permissao, callback) => callback(PERMISSOES_PERMITIDAS.has(permissao)));
    session.defaultSession.setPermissionCheckHandler((_wc, permissao) => PERMISSOES_PERMITIDAS.has(permissao));
  });
}

/** Resposta do protocolo app:// (só em produção): arquivo de dist/ + CSP. */
async function respostaDoProtocoloApp(request, distDir) {
  const { net } = require('electron');
  const { pathToFileURL } = require('url');
  const { pathname } = new URL(request.url);
  const arquivo = resolverDentroDe(distDir, pathname);
  if (!arquivo) return new Response('Not found', { status: 404 });
  const resposta = await net.fetch(pathToFileURL(arquivo).toString());
  if (!/\.html?$/i.test(arquivo)) return resposta;
  const headers = new Headers(resposta.headers);
  headers.set('Content-Security-Policy', CSP_APP);
  return new Response(resposta.body, { status: resposta.status, headers });
}

module.exports = {
  urlExternaPermitida, navegacaoPermitida, resolverDentroDe, CSP_APP,
  aplicarEmTodoWebContents, respostaDoProtocoloApp,
};
