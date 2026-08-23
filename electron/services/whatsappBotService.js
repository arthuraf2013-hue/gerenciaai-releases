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

  const {
    resposta, reservaConfirmada, agendamentoConfirmado, orcamentoCriado, quoteId, agendamentoCriado, appointmentId,
  } = whatsappBotHandler.processarMensagem({ telefone, texto, nomeExibicao: msg.pushName });
  if (resposta && sock) {
    try { await sock.sendMessage(jid, { text: resposta }); } catch (err) { console.error('[whatsappBot] falha ao responder', err); }
  }
  // Sinalizado pelo handler (que não conhece o Electron, ver comentário
  // no topo de whatsappBotHandler.js) -- é aqui, do lado de quem tem a
  // conexão de verdade, que a notificação nativa pro balcão é disparada.
  if (reservaConfirmada) {
    try { require('./notificationService').notifyReservationConfirmed(reservaConfirmada); } catch (err) { console.error('[whatsappBot] falha ao notificar reserva confirmada', err); }
  }
  if (agendamentoConfirmado) {
    try { require('./notificationService').notifyAppointmentConfirmed(agendamentoConfirmado); } catch (err) { console.error('[whatsappBot] falha ao notificar agendamento confirmado', err); }
  }
  if (orcamentoCriado && quoteId) {
    try {
      const quoteService = require('./quoteService');
      require('./notificationService').notifyNewQuoteFromBot(quoteService.getQuote(quoteId));
    } catch (err) { console.error('[whatsappBot] falha ao notificar novo orçamento', err); }
  }
  if (agendamentoCriado && appointmentId) {
    try {
      const db = require('../db/database').getDb();
      const ag = db.prepare(
        `SELECT a.*, p.nome as profissionalNome, COALESCE(c.nome, a.cliente_nome_avulso) as clienteNomeAvulso
         FROM appointments a JOIN appointment_professionals p ON p.id = a.professional_id
         LEFT JOIN customers c ON c.id = a.customer_id WHERE a.id = ?`
      ).get(appointmentId);
      if (ag) require('./notificationService').notifyNewAppointmentFromBot(ag);
    } catch (err) { console.error('[whatsappBot] falha ao notificar novo agendamento', err); }
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
        // Queda de rede/instabilidade -- OU o "restart" que o próprio
        // WhatsApp pede logo depois que o celular lê o QR Code
        // (statusCode 515, comportamento normal e documentado do
        // Baileys: ele fecha a conexão de propósito e espera reconectar
        // na hora pra terminar de parear). Tenta reconectar sozinho.
        //
        // IMPORTANTE: NÃO seta statusAtual = 'conectando' aqui -- isso
        // era o bug que travava a tela em "Conectando..." pra sempre.
        // iniciarConexao() começa recusando (`return` de propósito) se
        // statusAtual já for 'conectando', então setar isso antes de
        // chamá-la fazia a tentativa de reconexão virar um no-op
        // silencioso: nenhum QR novo era gerado e, pior, quando essa
        // reconexão automática era o "restart" pedido logo após o
        // celular ler o QR, ela nunca completava -- o WhatsApp do
        // celular acabava desistindo sozinho com "Não foi possível
        // conectar o dispositivo". Deixa o próprio iniciarConexao() setar o
        // status quando o processo realmente começar de novo.
        statusAtual = 'desconectado';
        reconexoesRecentes.push(Date.now());
        const reconexoesUltimos10s = reconexoesRecentes.filter((t) => Date.now() - t < 10 * 1000).length;
        // Se a conexão ficou caindo muito rápido (rede instável de
        // verdade, não o restart pontual pós-QR), espera um pouco antes
        // de tentar de novo -- evita martelar o WhatsApp com tentativas
        // em loop apertado, o que também aumenta o risco de bloqueio do
        // número (ver aviso no topo do arquivo).
        const atraso = reconexoesUltimos10s >= 3 ? 3000 : 0;
        setTimeout(() => {
          iniciarConexao().catch((err) => { ultimoErro = err.message; statusAtual = 'erro'; });
        }, atraso);
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

/** Manda uma mensagem de texto avulsa pra um número -- usado pelas
 * notificações automáticas de "pedido pronto" / "saiu para entrega"
 * (ver electron/ipc/handlers.js, que chama isso depois de um
 * botOrders:updateStatus bem-sucedido). Ao contrário de
 * tratarMensagemRecebida, essa mensagem NÃO é resposta a nada que o
 * cliente mandou -- é a loja iniciando contato. Isso tem um risco de
 * bloqueio um pouco maior do que responder (ver aviso no topo do
 * arquivo), principalmente pra número que nunca falou com a loja por
 * aqui antes -- mais um motivo pra testar com um número de teste
 * primeiro, como já orientado. */
async function enviarMensagem({ telefone, texto }) {
  if (statusAtual !== 'conectado' || !sock) return { ok: false, error: 'WhatsApp não está conectado.' };
  const numero = (telefone || '').replace(/\D/g, '');
  if (!numero) return { ok: false, error: 'Telefone inválido.' };
  try {
    await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: texto });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

module.exports = { getStatus, conectar, desconectar, iniciarAutomaticamenteSeConfigurado, enviarMensagem };
