const path = require('path');
const authService = require('./authService');
const botOrderService = require('./botOrderService');
const whatsappBotHandler = require('./whatsappBotHandler');

/**
 * ⚠️ ATENÇÃO — assim como a integração com balança digital (ver o
 * aviso equivalente em scaleHardwareService.js), esta parte NÃO foi
 * testada contra uma conta de WhatsApp real (não há como parear um
 * número de verdade neste ambiente onde este código foi escrito).
 *
 * Usa a biblioteca não-oficial Baileys (@whiskeysockets/baileys), que
 * se conecta imitando o WhatsApp Web do navegador — NÃO é a API
 * oficial da Meta, e usar isso viola os Termos de Serviço do
 * WhatsApp. Existe risco real do número usado ser banido,
 * principalmente com volume alto de mensagens ou comportamento fora
 * do padrão de uso humano. Use um número de teste (não o principal da
 * farmácia) até confiar no funcionamento, e veja as instruções de uso
 * enviadas junto com este código antes de ativar em produção.
 *
 * Todo o `require('electron')` e `require('@whiskeysockets/baileys')`
 * aqui é feito só DENTRO das funções (nunca no topo do arquivo) de
 * propósito — mesmo padrão do resto do projeto (ver scaleHardwareService,
 * printService) — assim este arquivo pode ser importado com segurança
 * mesmo fora do Electron (ex: se algum dia um teste precisar importar
 * o módulo só pra checar outra coisa) sem quebrar por falta do módulo
 * `electron` de verdade.
 */

let sock = null;
let statusAtual = 'desconectado'; // desconectado | aguardando_leitura | conectando | conectado | erro
let ultimoQrDataUrl = null;
let numeroConectado = null;
let ultimoErro = null;
let conectando = false;
// Timestamps (ms) das últimas vezes que a conexão caiu e precisou
// reconectar sozinha — usado só pra estimar estabilidade (ver
// calcularQualidade). O WhatsApp/Baileys não expõe um "sinal" de
// verdade tipo barra de operadora — é uma conexão via internet
// (WebSocket), não rádio — então "qualidade" aqui é uma estimativa de
// estabilidade, não uma métrica oficial do WhatsApp.
let reconexoesRecentes = [];

function pastaAuth() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'whatsapp-bot-auth');
}

function calcularQualidade() {
  if (statusAtual !== 'conectado') return 'sem_conexao';
  const agora = Date.now();
  reconexoesRecentes = reconexoesRecentes.filter((t) => agora - t < 10 * 60 * 1000);
  return reconexoesRecentes.length >= 2 ? 'instavel' : 'boa';
}

function getStatus() {
  return {
    status: statusAtual,
    qrCodeDataUrl: statusAtual === 'aguardando_leitura' ? ultimoQrDataUrl : null,
    numero: numeroConectado,
    qualidade: calcularQualidade(),
    erro: ultimoErro,
  };
}

function loggerSilencioso() {
  const noop = () => {};
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, level: 'silent' };
  logger.child = () => logger;
  return logger;
}

async function tratarMensagemRecebida(msg) {
  if (!msg.message || msg.key?.fromMe) return;
  const jid = msg.key?.remoteJid || '';
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return; // ignora grupo e status/stories

  const config = botOrderService.getConfig();
  if (!config.ativo) return; // "Separação" desligada nas Configurações -- bot fica quieto

  const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  const telefone = jid.split('@')[0];

  const { resposta } = whatsappBotHandler.processarMensagem({ telefone, texto, nomeExibicao: msg.pushName });
  if (resposta && sock) {
    try { await sock.sendMessage(jid, { text: resposta }); } catch (err) { console.error('[whatsappBot] falha ao responder', err); }
  }
}

async function iniciarConexao() {
  if (conectando || statusAtual === 'conectado' || statusAtual === 'conectando') return;
  conectando = true;
  ultimoErro = null;
  try {
    const baileys = require('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    const QRCode = require('qrcode');

    const { state, saveCreds } = await useMultiFileAuthState(pastaAuth());
    const { version } = await fetchLatestBaileysVersion();

    statusAtual = 'conectando';
    sock = makeWASocket({ version, auth: state, logger: loggerSilencioso(), printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        try { ultimoQrDataUrl = await QRCode.toDataURL(qr); } catch (err) { console.error('[whatsappBot] falha ao gerar QR', err); }
        statusAtual = 'aguardando_leitura';
      }

      if (connection === 'open') {
        statusAtual = 'conectado';
        ultimoQrDataUrl = null;
        numeroConectado = (sock?.user?.id || '').split(':')[0].split('@')[0] || null;
      }

      if (connection === 'close') {
        const codigoSaida = lastDisconnect?.error?.output?.statusCode;
        const deslogado = codigoSaida === DisconnectReason.loggedOut;
        sock = null;
        conectando = false;
        if (deslogado) {
          // sessão invalidada do lado do WhatsApp (ex: desconectado pelo
          // celular) -- precisa ler QR de novo na próxima vez que
          // "Conectar" for chamado, não adianta tentar sozinho.
          statusAtual = 'desconectado';
          numeroConectado = null;
          try { require('fs').rmSync(pastaAuth(), { recursive: true, force: true }); } catch { /* ignora */ }
          return;
        }
        // Queda de rede/instabilidade -- tenta reconectar sozinho.
        reconexoesRecentes.push(Date.now());
        statusAtual = 'conectando';
        iniciarConexao().catch((err) => { ultimoErro = err.message; statusAtual = 'erro'; });
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' || !Array.isArray(messages)) return;
      for (const msg of messages) {
        tratarMensagemRecebida(msg).catch((err) => console.error('[whatsappBot] erro ao tratar mensagem', err));
      }
    });
  } catch (err) {
    ultimoErro = err.message;
    statusAtual = 'erro';
    sock = null;
  } finally {
    conectando = false;
  }
}

/** Inicia (ou reinicia) a conexão -- chamado pela tela de
 * Configurações quando alguém clica em "Conectar". Tanto admin quanto
 * gerente podem fazer isso. */
function conectar(requestingUserId) {
  const guard = authService.requireRole(requestingUserId, ['admin', 'gerente']);
  if (!guard.ok) return guard;
  iniciarConexao().catch((err) => { ultimoErro = err.message; statusAtual = 'erro'; });
  return { ok: true };
}

/** Desconecta e apaga a sessão salva -- a próxima conexão sempre pede
 * um QR Code novo de propósito (evita ficar com uma sessão "zumbi"
 * meio conectada). Tanto admin quanto gerente podem fazer isso. */
async function desconectar(requestingUserId) {
  const guard = authService.requireRole(requestingUserId, ['admin', 'gerente']);
  if (!guard.ok) return guard;
  try {
    if (sock) await sock.logout().catch(() => {});
  } finally {
    sock = null;
    conectando = false;
    statusAtual = 'desconectado';
    numeroConectado = null;
    ultimoQrDataUrl = null;
    ultimoErro = null;
    reconexoesRecentes = [];
    try { require('fs').rmSync(pastaAuth(), { recursive: true, force: true }); } catch { /* ignora */ }
  }
  return { ok: true };
}

/** Chamado uma vez, na inicialização do app -- se esta máquina já foi
 * pareada com um número antes e a aba "Separação" está ativada,
 * reconecta sozinho sem precisar abrir Configurações. Se nunca foi
 * pareada, não faz nada (não tem QR pra ler sozinho). */
function iniciarAutomaticamenteSeConfigurado() {
  try {
    const fs = require('fs');
    if (!botOrderService.getConfig().ativo) return;
    if (!fs.existsSync(pastaAuth())) return;
    iniciarConexao().catch((err) => { ultimoErro = err.message; statusAtual = 'erro'; });
  } catch (err) {
    console.error('[whatsappBot] erro ao iniciar automaticamente', err);
  }
}

module.exports = { getStatus, conectar, desconectar, iniciarAutomaticamenteSeConfigurado };
