/**
 * Sessão real do processo principal — mapeia cada janela/processo de
 * renderer (webContents.id) para o usuário que efetivamente fez login
 * nela, com PIN validado por authService.login.
 *
 * Por que isso existe: até aqui, cada canal IPC confiava no campo
 * `requestingUserId` que o PRÓPRIO renderer mandava dentro do payload —
 * ou seja, "quem está pedindo isso" era uma alegação de quem chama, não
 * um fato verificado pelo processo principal. Isso não é uma
 * vulnerabilidade teórica: `requireRole`/`authorizeManagerOverride` são
 * a própria trava de segurança central do sistema (ver authService.js),
 * e elas só valem alguma coisa se "quem está pedindo" vier de um lugar
 * que o renderer não controla. Sem essa sessão, qualquer coisa capaz de
 * chamar um canal IPC diretamente (um script fora da UI normal, o
 * DevTools) podia se passar por admin só mandando o id de um admin no
 * payload, sem nunca ter digitado o PIN dele.
 *
 * A partir de agora, `handlers.js` resolve `requestingUserId` chamando
 * `resolverUsuarioLogado(event)` — nunca mais lendo esse campo do
 * payload enviado pelo renderer (ver o comentário em safeHandle).
 *
 * A sessão é só em memória (Map), por processo principal — não precisa
 * sobreviver a um restart do app (o operador loga de novo ao abrir),
 * e cada janela (`webContents.id`) tem a sua própria, isolada das
 * demais (relevante pro app do garçom / consulta remota, que fala com o
 * processo principal por outro canal, não por este IPC de janela).
 */

const sessoesPorWebContentsId = new Map();

/** Chamada só pelo handler de auth:login, após authService.login()
 * confirmar PIN correto. */
function iniciarSessao(webContentsId, { id, nome, role }) {
  if (webContentsId === undefined || webContentsId === null) return;
  sessoesPorWebContentsId.set(webContentsId, { id, nome, role, loginEm: Date.now() });
}

/** Chamada por auth:logout e quando a janela fecha (ver main.js) — evita
 * que a sessão de um operador continue "logada" pro processo principal
 * depois que a janela em que ele logou já não existe mais. */
function encerrarSessao(webContentsId) {
  sessoesPorWebContentsId.delete(webContentsId);
}

function getSessao(webContentsId) {
  return sessoesPorWebContentsId.get(webContentsId) || null;
}

/** Usado por safeHandle (handlers.js) pra resolver quem realmente está
 * logado NESTA janela, a partir do `event` que o próprio Electron
 * entrega pro handler — nunca a partir do payload que o renderer mandou.
 * Devolve null se a janela nunca fez login (ex: telas antes do login,
 * como a lista de usuários). */
function resolverUsuarioLogado(event) {
  const webContentsId = event?.sender?.id;
  if (webContentsId === undefined || webContentsId === null) return null;
  return getSessao(webContentsId);
}

module.exports = { iniciarSessao, encerrarSessao, getSessao, resolverUsuarioLogado };
