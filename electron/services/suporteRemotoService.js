const crypto = require('crypto');
const P = require('./suporteRemotoProtocolo');

/**
 * Acesso remoto de suporte do GerenciaAI (lado do COMPUTADOR do cliente).
 *
 * Objetivo: o suporte da Vetta (Arthur, pela Central) consegue, com o
 * consentimento do cliente, VER a tela ao vivo, rodar comandos de shell
 * em segundo plano, disparar correções específicas e trocar arquivos e
 * texto -- tudo pra dar manutenção sem precisar estar na loja.
 *
 * Princípios (iguais ao TeamViewer/AnyDesk, e o que separa isto de um
 * backdoor):
 *   1. CONSENTIMENTO: o cliente gera um código de 6 dígitos (ou liga o
 *      acesso não supervisionado de propósito, em Configurações). Sem o
 *      código/segredo conferido DENTRO do canal cifrado, o técnico não
 *      roda nada nem recebe tela.
 *   2. VISIBILIDADE: enquanto a sessão existe, o app mostra uma faixa
 *      fixa "Suporte remoto ativo"; o cliente pode encerrar a qualquer
 *      momento.
 *   3. RASTRO: toda ação (sessão, shell, correção, arquivo) fica na
 *      Auditoria (audit_log), com usuário 'suporte'.
 *
 * Transporte:
 *   - O Firestore de licenciamento (installations/{id}/suporte_remoto/sessao)
 *     carrega SÓ a sinalização do WebRTC (SDP/ICE) e o estado -- NUNCA
 *     tela, shell ou arquivo.
 *   - Tela, shell, arquivos e área de transferência trafegam pelo canal
 *     P2P do WebRTC, cifrado ponta a ponta (DTLS/SRTP). A verificação do
 *     código acontece por dentro desse canal.
 *   - A biblioteca do Firestore só existe no processo PRINCIPAL (o
 *     renderer não tem Firebase). O WebRTC precisa de um renderer
 *     (Chromium): roda numa janela OCULTA dedicada (electron/suporte-remoto/),
 *     e este serviço faz a ponte entre ela e o Firestore/SQLite/shell.
 *
 * A parte pura (código, hash, estados, fatiamento) está em
 * suporteRemotoProtocolo.js, testada em tests/suporteRemoto.test.js.
 */

const DOC_SESSAO = 'sessao';

// Estado em memória da sessão corrente (uma por vez por máquina).
let sessao = null;        // { codigoHash, criadoEmMs, estado, tentativas, naoSupervisionado, tecnico }
let janelaPeer = null;    // BrowserWindow oculta com o WebRTC
let pararEscuta = null;   // cancela o onSnapshot da sinalização
// Nonces de pedidoConectar já tratados NESTE processo. Fica fora de `sessao`
// de propósito: a sessão vira null ao encerrar, e se a memória do "já
// tratei esse pedido" morresse junto, o mesmo pedido (que o computador não
// pode apagar do Firestore) seria aceito de novo a cada snapshot -- laço
// abre-janela/fecha-janela que fazia a tela piscar no não supervisionado.
const noncesTratados = new Set();
// Se a conexão não autenticar em 60 s depois de aceita, desiste (sem isso
// uma negociação travada deixava a captura de tela aberta à toa).
const TEMPO_NEGOCIACAO_MS = 60 * 1000;
let temporizadorNegociacao = null;
let temporizadorCodigo = null;

function getDb() { return require('../db/database').getDb(); }
function agoraMs() { try { return require('./timeService').nowMs(); } catch { return Date.now(); } }

// ------------------------------------------------------------------
// Config (acesso não supervisionado) -- guardada no SQLite local.
// ------------------------------------------------------------------
function getConfig() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM suporte_remoto_config WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO suporte_remoto_config (id, nao_supervisionado) VALUES (1, 0)').run();
    return { naoSupervisionado: false, temSegredo: false };
  }
  return { naoSupervisionado: row.nao_supervisionado === 1, temSegredo: !!row.segredo_hash };
}

/** Liga/desliga o acesso não supervisionado. Ao LIGAR, gera um segredo
 * novo e devolve ele em claro UMA única vez (pro cliente passar pro
 * suporte guardar) -- depois só fica o hash. Ao desligar, apaga o segredo. */
function salvarConfig({ naoSupervisionado }, { operadorId } = {}) {
  const db = getDb();
  getConfig(); // garante a linha
  if (naoSupervisionado) {
    const segredo = P.gerarSegredoNaoSupervisionado();
    const { sal, hash } = P.hashSegredo(segredo);
    db.prepare('UPDATE suporte_remoto_config SET nao_supervisionado = 1, segredo_sal = ?, segredo_hash = ?, atualizado_em = NOW_SYNCED() WHERE id = 1')
      .run(sal, hash);
    auditar('suporte_remoto_config', operadorId, 'Acesso remoto não supervisionado LIGADO');
    publicarConvite({ naoSupervisionado: true, segredo });
    return { ok: true, naoSupervisionado: true, segredo };
  }
  db.prepare('UPDATE suporte_remoto_config SET nao_supervisionado = 0, segredo_sal = NULL, segredo_hash = NULL, atualizado_em = NOW_SYNCED() WHERE id = 1').run();
  auditar('suporte_remoto_config', operadorId, 'Acesso remoto não supervisionado DESLIGADO');
  publicarConvite({ naoSupervisionado: false, segredo: null });
  return { ok: true, naoSupervisionado: false };
}

// ------------------------------------------------------------------
// Auditoria
// ------------------------------------------------------------------
function auditar(tipoEvento, solicitanteId, motivo) {
  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento, solicitanteId: solicitanteId || idDeSuporteOuAdmin(), motivo,
    });
  } catch (err) {
    console.error('[suporteRemoto] falha ao auditar:', err.message);
  }
}
/** Primeiro usuário suporte/admin ativo, pra carimbar a Auditoria quando
 * a ação vem do técnico (não há sessão de UI por trás). */
function idDeSuporteOuAdmin() {
  try {
    return getDb().prepare(
      `SELECT id FROM users WHERE ativo = 1 AND role IN ('suporte','admin') ORDER BY (role='suporte') DESC LIMIT 1`
    ).get()?.id || null;
  } catch { return null; }
}

// ------------------------------------------------------------------
// Firestore de sinalização
// ------------------------------------------------------------------
function refs(docId = DOC_SESSAO) {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { doc } = require('firebase/firestore');
  const firestore = licenseService.getLicenseFirestore();
  const installId = pdvRegistryService.getOrCreateDeviceUid();
  return { firestore, installId, docRef: doc(firestore, 'installations', installId, 'suporte_remoto', docId) };
}

async function escreverSinal(campos) {
  try {
    const { setDoc, serverTimestamp } = require('firebase/firestore');
    const { docRef } = refs();
    await setDoc(docRef, { ...campos, atualizadoEm: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error('[suporteRemoto] falha ao escrever sinal:', err.message);
  }
}

/** Documento `convite` (installations/{id}/suporte_remoto/convite): é o
 * que faz o código (e o acesso não supervisionado) APARECER NA CENTRAL.
 * Diferente do doc `sessao` (leitura aberta, só sinalização), a regra do
 * Firestore deixa só o ADMIN autenticado ler o convite -- o computador
 * escreve sem login, mas não lê. Gravar aqui não dá acesso a ninguém: a
 * conferência continua sendo feita pelo computador, dentro do canal
 * cifrado, contra o hash local. */
async function publicarConvite(campos) {
  try {
    const { setDoc, serverTimestamp } = require('firebase/firestore');
    const { docRef } = refs('convite');
    await setDoc(docRef, { ...campos, atualizadoEm: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error('[suporteRemoto] falha ao publicar convite:', err.message);
  }
}

/** No boot: não há sessão nem código vivo; reflete o não supervisionado.
 * O segredo em claro só existe na hora de ligar (salvarConfig) -- aqui não
 * mexe nele (merge), pra Central continuar com o que recebeu. */
async function publicarConfigNaCentral() {
  const cfg = getConfig();
  const ligado = cfg.naoSupervisionado && cfg.temSegredo;
  await publicarConvite(ligado
    ? { naoSupervisionado: true, codigo: null, codigoExpiraEmMs: null }
    : { naoSupervisionado: false, segredo: null, codigo: null, codigoExpiraEmMs: null });
}

// ------------------------------------------------------------------
// Ciclo de vida da sessão
// ------------------------------------------------------------------

/** Cliente clicou "Gerar código de suporte". Cria o código, entra em
 * AGUARDANDO e espera o técnico pedir conexão. */
function gerarCodigo({ operadorId } = {}) {
  encerrarSessaoLocal('substituida'); // só uma sessão por vez
  const codigo = P.gerarCodigo();
  const { sal, hash } = P.hashSegredo(codigo);
  sessao = {
    codigoSal: sal, codigoHash: hash, criadoEmMs: agoraMs(), estado: P.ESTADOS.AGUARDANDO,
    tentativas: 0, naoSupervisionado: false, tecnico: null, autenticada: false,
  };
  registrarSessaoNoBanco('aguardando');
  // O computador NUNCA escreve pedidoConectar/central* (campos do técnico) --
  // a regra do Firestore reserva esses ao admin. Aqui só reseta os campos do
  // próprio computador; um pedidoConectar antigo que tenha sobrado é ignorado
  // por ser mais velho que criadoEmMs (ver processSinal).
  escreverSinal({ estado: P.ESTADOS.AGUARDANDO, versaoApp: versao(), desktopSdp: null, desktopIce: [] });
  if (temporizadorCodigo) clearTimeout(temporizadorCodigo);
  temporizadorCodigo = setTimeout(() => {
    if (sessao && sessao.estado === P.ESTADOS.AGUARDANDO) encerrarSessaoLocal('codigo_expirou');
  }, P.DURACAO_CODIGO_MS);
  publicarConvite({ codigo, codigoExpiraEmMs: sessao.criadoEmMs + P.DURACAO_CODIGO_MS });
  auditar('suporte_remoto_sessao', operadorId, 'Código de suporte remoto gerado (aguardando conexão)');
  notificarRenderer();
  return { ok: true, codigo, expiraEmMs: sessao.criadoEmMs + P.DURACAO_CODIGO_MS };
}

function versao() { try { return require('electron').app.getVersion(); } catch { return null; } }

/** Status pro app (faixa + tela de código). Nunca devolve o código em
 * claro (quem gerou já o recebeu na hora). */
function getStatus() {
  const cfg = getConfig();
  if (!sessao || sessao.estado === P.ESTADOS.OCIOSO || sessao.estado === P.ESTADOS.ENCERRADA) {
    return { estado: P.ESTADOS.OCIOSO, naoSupervisionado: cfg.naoSupervisionado };
  }
  return {
    estado: sessao.estado,
    naoSupervisionado: cfg.naoSupervisionado,
    sessaoNaoSupervisionada: sessao.naoSupervisionado,
    aguardandoPermissao: sessao.estado === P.ESTADOS.AGUARDANDO && !!sessao.pedidoPendente,
    expiraEmMs: sessao.criadoEmMs + P.DURACAO_CODIGO_MS,
  };
}

/** Avisa o renderer (faixa/tela) que algo mudou. */
function notificarRenderer() {
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== janelaPeer && !w.isDestroyed()) w.webContents.send('suporteRemoto:mudou', getStatus());
    }
  } catch { /* janela ainda não existe */ }
}

/** O cliente autorizou (clicou em "Permitir") OU é não supervisionado:
 * abre a janela peer, que captura a tela e inicia o WebRTC. */
function aceitarConexao({ operadorId } = {}) {
  if (!sessao || sessao.estado !== P.ESTADOS.AGUARDANDO) return { ok: false, error: 'Não há pedido de conexão aguardando.' };
  sessao.estado = P.ESTADOS.NEGOCIANDO;
  sessao.pedidoPendente = false;
  registrarSessaoNoBanco('negociando');
  auditar('suporte_remoto_sessao', operadorId, `Conexão de suporte autorizada${sessao.naoSupervisionado ? ' (não supervisionada)' : ''}`);
  abrirJanelaPeer();
  escreverSinal({ estado: P.ESTADOS.NEGOCIANDO });
  if (temporizadorNegociacao) clearTimeout(temporizadorNegociacao);
  temporizadorNegociacao = setTimeout(() => {
    temporizadorNegociacao = null;
    if (sessao && !sessao.autenticada) encerrarSessaoLocal('tempo_esgotado');
  }, TEMPO_NEGOCIACAO_MS);
  notificarRenderer();
  return { ok: true };
}

/** Cliente (ou técnico, ou timeout) encerra. */
function encerrarSessao({ operadorId, motivo = 'encerrada_pelo_cliente' } = {}) {
  auditar('suporte_remoto_sessao', operadorId, `Sessão de suporte encerrada (${motivo})`);
  encerrarSessaoLocal(motivo);
  return { ok: true };
}

function encerrarSessaoLocal(motivo) {
  if (temporizadorCodigo) { clearTimeout(temporizadorCodigo); temporizadorCodigo = null; }
  if (temporizadorNegociacao) { clearTimeout(temporizadorNegociacao); temporizadorNegociacao = null; }
  const tinhaCodigo = !!(sessao && sessao.codigoHash);
  if (sessao) {
    sessao.estado = P.ESTADOS.ENCERRADA;
    registrarSessaoNoBanco('encerrada', motivo);
  }
  fecharJanelaPeer();
  escreverSinal({ estado: P.ESTADOS.ENCERRADA, motivoFim: motivo, desktopSdp: null, desktopIce: [] });
  if (tinhaCodigo) publicarConvite({ codigo: null, codigoExpiraEmMs: null });
  sessao = null;
  notificarRenderer();
}

function registrarSessaoNoBanco(estado, motivo) {
  try {
    const db = getDb();
    if (estado === 'aguardando') {
      sessao.id = crypto.randomUUID();
      db.prepare('INSERT INTO suporte_remoto_sessoes (id, estado, nao_supervisionado, criado_em) VALUES (?, ?, ?, NOW_SYNCED())')
        .run(sessao.id, estado, sessao.naoSupervisionado ? 1 : 0);
    } else if (sessao?.id) {
      db.prepare('UPDATE suporte_remoto_sessoes SET estado = ?, motivo_fim = ?, atualizado_em = NOW_SYNCED() WHERE id = ?')
        .run(estado, motivo || null, sessao.id);
    }
  } catch (err) { console.error('[suporteRemoto] registro no banco falhou:', err.message); }
}

// ------------------------------------------------------------------
// Escuta da sinalização (o que o técnico escreve no Firestore)
// ------------------------------------------------------------------
function iniciarEscutaSuporte() {
  try {
    if (pararEscuta) { pararEscuta(); pararEscuta = null; }
    const { onSnapshot } = require('firebase/firestore');
    const { docRef } = refs();
    publicarConfigNaCentral();
    pararEscuta = onSnapshot(docRef, (snap) => {
      if (!snap.exists()) return;
      processarSinal(snap.data());
    }, (err) => console.error('[suporteRemoto] escuta de sinalização falhou:', err.message));
  } catch (err) {
    console.error('[suporteRemoto] não foi possível iniciar a escuta:', err.message);
  }
}

function processarSinal(dados) {
  try {
    // 1) Pedido de conexão do técnico (ele digitou o código / usou o
    //    acesso não supervisionado e clicou em Conectar na Central).
    if (dados.pedidoConectar && (!sessao || sessao.estado === P.ESTADOS.AGUARDANDO)) {
      const nonce = String(dados.pedidoConectar.nonce || '');
      // O computador não consegue apagar o pedidoConectar do técnico (a regra
      // reserva esse campo ao admin), então um pedido ANTERIOR sempre pode
      // estar sobrando no documento. Só vale um pedido: com nonce, nunca
      // tratado neste processo, recente, e posterior ao código atual.
      const valido = P.pedidoConectarValido({
        nonce, emMs: dados.pedidoConectar.em, agoraMs: agoraMs(),
        criadoEmMs: sessao ? sessao.criadoEmMs : null, jaTratado: noncesTratados.has(nonce),
      });
      if (valido) {
        noncesTratados.add(nonce); // antes de qualquer coisa: nunca reprocessa
        const naoSup = !!dados.pedidoConectar.naoSupervisionado;
        if (!sessao) {
          // Acesso não supervisionado: o técnico pode iniciar mesmo sem o
          // cliente ter gerado código, SE estiver ligado.
          const cfg = getConfig();
          if (!(naoSup && cfg.naoSupervisionado && cfg.temSegredo)) return;
          sessao = { estado: P.ESTADOS.AGUARDANDO, criadoEmMs: agoraMs(), tentativas: 0, naoSupervisionado: true, autenticada: false };
          registrarSessaoNoBanco('aguardando');
        }
        sessao.ultimoPedidoNonce = nonce;
        sessao.naoSupervisionado = naoSup && getConfig().naoSupervisionado;
        sessao.tecnico = String(dados.pedidoConectar.tecnico || 'suporte').slice(0, 80);
        if (sessao.naoSupervisionado) {
          aceitarConexao({}); // sem prompt: o cliente ligou o não supervisionado de propósito
        } else {
          sessao.pedidoPendente = true; // espera o cliente clicar em Permitir na faixa
          notificarRenderer();
        }
        return; // o resto do documento ainda é do pedido anterior
      }
    }

    // Daqui pra baixo só vale o que pertence ao pedido da sessão ATUAL. A
    // Central grava pedidoConectar + zera centralSdp/centralIce no mesmo
    // setDoc, então resposta/ICE que convivem com o nonce atual são desta
    // sessão; com outro nonce, é sobra de sessão antiga.
    const doPedidoAtual = !!(sessao && sessao.ultimoPedidoNonce
      && dados.pedidoConectar && String(dados.pedidoConectar.nonce || '') === sessao.ultimoPedidoNonce);
    if (!doPedidoAtual) return;

    // 2) Resposta/ICE do técnico (answer + candidatos) -> repassa pro peer.
    if (janelaPeer && !janelaPeer.isDestroyed()) {
      if (dados.centralSdp) enviarAoPeer('sinal-remoto', { tipo: 'answer', sdp: dados.centralSdp });
      if (Array.isArray(dados.centralIce) && dados.centralIce.length) enviarAoPeer('sinal-remoto', { tipo: 'ice', candidatos: dados.centralIce });
    }

    // 3) Técnico encerrou pelo lado dele.
    if (dados.estado === P.ESTADOS.ENCERRADA && sessao && dados.encerradoPeloTecnico === sessao.ultimoPedidoNonce) {
      encerrarSessaoLocal('encerrada_pelo_tecnico');
    }
  } catch (err) {
    console.error('[suporteRemoto] erro ao processar sinal:', err.message);
  }
}

// ------------------------------------------------------------------
// Janela peer (WebRTC + captura de tela) -- oculta
// ------------------------------------------------------------------
function abrirJanelaPeer() {
  try {
    const { BrowserWindow, session, desktopCapturer } = require('electron');
    const path = require('path');
    fecharJanelaPeer();

    // Sessão/partição própria -- o auto-grant de captura de tela abaixo
    // vale SÓ pra esta janela, nunca pra janela principal do app.
    const part = session.fromPartition('suporte-remoto-peer');
    part.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback(sources.length ? { video: sources[0] } : {});
      }).catch(() => callback({}));
    }, { useSystemPicker: false });
    // A janela principal do app nega quase toda permissão (ver seguranca.js);
    // esta partição é só da janela peer, então libera a captura de tela aqui
    // (e nada mais) sem afetar o resto do app.
    part.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'display-capture' || perm === 'media'));
    part.setPermissionCheckHandler((_wc, perm) => perm === 'display-capture' || perm === 'media');

    janelaPeer = new BrowserWindow({
      show: false, width: 320, height: 240,
      webPreferences: {
        preload: path.join(__dirname, '../suporte-remoto/peer-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        session: part, backgroundThrottling: false,
      },
    });
    janelaPeer.loadFile(path.join(__dirname, '../suporte-remoto/peer.html'));
    janelaPeer.webContents.once('did-finish-load', () => {
      enviarAoPeer('iniciar', { iceServers: iceServers() });
    });
    janelaPeer.on('closed', () => { janelaPeer = null; });
  } catch (err) {
    console.error('[suporteRemoto] não foi possível abrir a janela peer:', err.message);
    encerrarSessaoLocal('erro_peer');
  }
}

function fecharJanelaPeer() {
  if (janelaPeer && !janelaPeer.isDestroyed()) {
    try { janelaPeer.destroy(); } catch { /* já foi */ }
  }
  janelaPeer = null;
}

function enviarAoPeer(canal, dados) {
  if (janelaPeer && !janelaPeer.isDestroyed()) {
    try { janelaPeer.webContents.send(canal, dados); } catch { /* fechando */ }
  }
}

/** Servidores ICE. STUN público por padrão; um TURN opcional pode vir do
 * Firestore (config/suporte) pra casos de NAT simétrico (loja atrás de
 * CGNAT). Sem TURN, a conexão só funciona quando pelo menos um lado é
 * alcançável por STUN. */
function iceServers() {
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
}

// ------------------------------------------------------------------
// Ponte com a janela peer (IPC) -- registrada no main.js
// ------------------------------------------------------------------
function registrarBridgePeer() {
  const { ipcMain } = require('electron');
  const doPeer = (fn) => (event, dados) => {
    if (!janelaPeer || janelaPeer.isDestroyed() || event.sender !== janelaPeer.webContents) return; // só da janela peer
    return fn(dados || {});
  };

  // Sinalização que a janela peer gerou (offer/ICE do computador) -> Firestore.
  ipcMain.on('suporteRemotoPeer:sinal', doPeer((d) => {
    if (d.tipo === 'offer') escreverSinal({ estado: P.ESTADOS.NEGOCIANDO, desktopSdp: d.sdp });
    else if (d.tipo === 'ice' && d.candidato) {
      const { arrayUnion } = require('firebase/firestore');
      escreverSinal({ desktopIce: arrayUnion(d.candidato) });
    }
  }));

  // Mensagens de aplicação que chegaram pelo canal cifrado (datachannel).
  ipcMain.on('suporteRemotoPeer:mensagem', doPeer((msg) => tratarMensagemDoCanal(msg)));

  // A janela peer avisa que o canal abriu / conectou / caiu.
  ipcMain.on('suporteRemotoPeer:evento', doPeer((d) => {
    if (d.evento === 'canal_aberto') { /* espera AUTENTICAR */ }
    if (d.evento === 'desconectou') encerrarSessaoLocal('conexao_caiu');
  }));

  // Pedido de fonte de captura (quando não usa getDisplayMedia).
  ipcMain.handle('suporteRemotoPeer:fontes', doPeer(async () => {
    const { desktopCapturer } = require('electron');
    const fontes = await desktopCapturer.getSources({ types: ['screen'] });
    return fontes.map((f) => ({ id: f.id, nome: f.name }));
  }));
}

/** Processa uma mensagem de aplicação vinda do técnico pelo canal cifrado.
 * A AUTENTICAÇÃO é conferida aqui; nada sensível roda antes dela. */
function tratarMensagemDoCanal(msg) {
  if (!sessao) return;
  const tipo = msg?.tipo;

  // --- Autenticação (código de 6 díg. ou segredo não supervisionado) ---
  if (tipo === P.MSG.AUTENTICAR) {
    if (sessao.autenticada) { responderCanal({ tipo: P.MSG.AUTENTICADO, ok: true }); return; }
    const { bloqueado } = P.avaliarTentativa(sessao.tentativas);
    if (bloqueado) { encerrarSessaoLocal('tentativas_excedidas'); return; }
    let ok = false;
    if (sessao.naoSupervisionado) {
      const cfg = getDb().prepare('SELECT segredo_sal, segredo_hash FROM suporte_remoto_config WHERE id = 1').get() || {};
      ok = P.verificarSegredo(msg.segredo, { sal: cfg.segredo_sal, hash: cfg.segredo_hash });
    } else {
      ok = P.codigoValido(sessao.criadoEmMs, agoraMs())
        && P.verificarSegredo(msg.segredo, { sal: sessao.codigoSal, hash: sessao.codigoHash });
    }
    if (ok) {
      sessao.autenticada = true;
      sessao.estado = P.ESTADOS.ATIVA;
      registrarSessaoNoBanco('ativa');
      escreverSinal({ estado: P.ESTADOS.ATIVA });
      auditar('suporte_remoto_sessao', null, `Sessão de suporte AUTENTICADA e ativa${sessao.naoSupervisionado ? ' (não supervisionada)' : ''}`);
      responderCanal({ tipo: P.MSG.AUTENTICADO, ok: true });
      notificarRenderer();
    } else {
      sessao.tentativas++;
      const { restantes } = P.avaliarTentativa(sessao.tentativas);
      responderCanal({ tipo: P.MSG.AUTENTICADO, ok: false, restantes });
      if (restantes <= 0) encerrarSessaoLocal('tentativas_excedidas');
    }
    return;
  }

  // Daqui pra baixo, NADA roda sem a sessão autenticada.
  if (!sessao.autenticada) { responderCanal({ tipo: P.MSG.AVISO, texto: 'Autentique primeiro com o código.' }); return; }

  if (tipo === P.MSG.SHELL) return executarShell(msg);
  if (tipo === P.MSG.CORRECAO) return executarCorrecao(msg);
  if (tipo === P.MSG.ARQUIVO_ENVIAR_INICIO) return receberArquivoInicio(msg);
  if (tipo === P.MSG.ARQUIVO_ENVIAR_PARTE) return receberArquivoParte(msg);
  if (tipo === P.MSG.ARQUIVO_ENVIAR_FIM) return receberArquivoFim(msg);
  if (tipo === P.MSG.ARQUIVO_PEDIR) return enviarArquivo(msg);
  if (tipo === P.MSG.CLIPBOARD_DEFINIR) return definirClipboard(msg);
  if (tipo === P.MSG.CLIPBOARD_PEGAR) return pegarClipboard();
}

function responderCanal(msg) { enviarAoPeer('enviar-canal', msg); }

// ------------------------------------------------------------------
// Shell (operações em segundo plano) -- confinado à pasta do app
// ------------------------------------------------------------------
const shellsAtivos = new Map();

function executarShell(msg) {
  const id = String(msg.id || crypto.randomUUID());
  const comando = P.sanitizarComando(msg.comando);
  if (!comando) { responderCanal({ tipo: P.MSG.SHELL_FIM, id, codigo: -1 }); return; }
  auditar('suporte_remoto_shell', null, `Shell: ${comando.slice(0, 180)}`);

  const { spawn } = require('child_process');
  const ehWin = process.platform === 'win32';
  const cwd = pastaDoApp();
  let child;
  try {
    child = ehWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando], { cwd, windowsHide: true })
      : spawn('bash', ['-lc', comando], { cwd });
  } catch (err) {
    responderCanal({ tipo: P.MSG.SHELL_SAIDA, id, fluxo: 'stderr', texto: `Não consegui iniciar o shell: ${err.message}` });
    responderCanal({ tipo: P.MSG.SHELL_FIM, id, codigo: -1 });
    return;
  }
  shellsAtivos.set(id, child);
  let enviados = 0;
  const mandar = (fluxo, buf) => {
    if (enviados >= P.SHELL_SAIDA_MAX_BYTES) return;
    let texto = buf.toString('utf8');
    enviados += Buffer.byteLength(texto);
    if (enviados >= P.SHELL_SAIDA_MAX_BYTES) texto += '\n[saída cortada em 1 MB]';
    responderCanal({ tipo: P.MSG.SHELL_SAIDA, id, fluxo, texto });
  };
  child.stdout.on('data', (b) => mandar('stdout', b));
  child.stderr.on('data', (b) => mandar('stderr', b));
  const timeout = setTimeout(() => { try { child.kill(); } catch { /* já morreu */ } }, P.SHELL_TIMEOUT_MS);
  child.on('close', (codigo) => {
    clearTimeout(timeout);
    shellsAtivos.delete(id);
    responderCanal({ tipo: P.MSG.SHELL_FIM, id, codigo });
  });
  child.on('error', (err) => {
    clearTimeout(timeout);
    shellsAtivos.delete(id);
    responderCanal({ tipo: P.MSG.SHELL_SAIDA, id, fluxo: 'stderr', texto: err.message });
    responderCanal({ tipo: P.MSG.SHELL_FIM, id, codigo: -1 });
  });
}

function pastaDoApp() {
  try { return require('path').dirname(require('electron').app.getPath('exe')); } catch { return process.cwd(); }
}

// ------------------------------------------------------------------
// Correções rápidas (botões da Central)
// ------------------------------------------------------------------
async function executarCorrecao(msg) {
  const id = String(msg.id || crypto.randomUUID());
  const acao = msg.acao;
  if (!P.correcaoValida(acao)) { responderCanal({ tipo: P.MSG.CORRECAO_RESULTADO, id, ok: false, mensagem: 'Correção desconhecida.' }); return; }
  auditar('suporte_remoto_correcao', null, `Correção: ${P.ROTULO_CORRECAO[acao]}`);
  try {
    const mensagem = await rodarCorrecao(acao);
    responderCanal({ tipo: P.MSG.CORRECAO_RESULTADO, id, ok: true, mensagem });
  } catch (err) {
    responderCanal({ tipo: P.MSG.CORRECAO_RESULTADO, id, ok: false, mensagem: err.message });
  }
}

async function rodarCorrecao(acao) {
  const db = getDb();
  switch (acao) {
    case 'limpar_cache_busca':
      db.prepare(`UPDATE cache_versao SET valor = valor + 1 WHERE chave = 'produtos'`).run();
      return 'Cache de busca de produtos invalidado — será reconstruído na próxima busca.';
    case 'recompilar_indices':
      db.exec('REINDEX;');
      require('../db/database').otimizarBanco();
      return 'Índices recompilados e banco otimizado.';
    case 'otimizar_banco':
      require('../db/database').otimizarBanco();
      return 'Banco otimizado (PRAGMA optimize).';
    case 'resync_grupo': {
      await require('./stockSyncService').enviarVariacoesPendentes().catch(() => {});
      await require('./salesSyncService').pushPeriodico().catch(() => {});
      return 'Re-sincronização do grupo disparada (vendas e estoque pendentes).';
    }
    case 'reparar_instalacao': {
      if (process.platform !== 'win32') return 'Reparo automático só se aplica ao Windows.';
      const reparo = require('./reparoInstalacaoService');
      await reparo.prepararReparo();
      const r = await reparo.manterCopiaDoInstalador({
        versaoAtual: versao(), publish: reparo.lerPublishDoApp(), reportar: () => {},
      }).catch((e) => ({ ok: false, erro: e.message }));
      return `Reparo preparado (script de login e cópia do instalador conferidos).${r && r.ok === false ? ` Aviso: ${r.erro || 'cópia pendente'}` : ''}`;
    }
    case 'reset_pin_admin': {
      const admin = db.prepare(`SELECT id, nome FROM users WHERE ativo = 1 AND role = 'admin' ORDER BY criado_em LIMIT 1`).get();
      if (!admin) return 'Nenhum usuário admin ativo encontrado.';
      const novoPin = String(crypto.randomInt(1000, 10000)); // 4 dígitos temporário
      const bcrypt = require('bcryptjs');
      db.prepare('UPDATE users SET pin_hash = ?, pin_temporario = 1, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?')
        .run(bcrypt.hashSync(novoPin, 10), admin.id);
      auditar('pin_resetado', admin.id, `PIN de "${admin.nome}" redefinido pelo suporte remoto`);
      return `PIN do admin "${admin.nome}" redefinido para ${novoPin} (temporário — ele troca no próximo login).`;
    }
    case 'reiniciar_app': {
      responderCanal({ tipo: P.MSG.AVISO, texto: 'Reiniciando o aplicativo...' });
      setTimeout(() => { try { const { app } = require('electron'); app.relaunch(); app.exit(0); } catch { /* */ } }, 800);
      return 'Reiniciando o aplicativo.';
    }
    default:
      return 'Correção não implementada.';
  }
}

// ------------------------------------------------------------------
// Transferência de arquivos (pelo canal cifrado)
// ------------------------------------------------------------------
const recebendo = new Map(); // id -> { nome, partes[], tamanho }

function pastaDeDownloads() {
  const path = require('path');
  const base = (() => { try { return require('electron').app.getPath('downloads'); } catch { return require('os').tmpdir(); } })();
  const dir = path.join(base, 'GerenciaAI-suporte');
  try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* existe */ }
  return dir;
}

function nomeSeguro(nome) {
  return String(nome || 'arquivo').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'arquivo';
}

function receberArquivoInicio(msg) {
  if (Number(msg.tamanho) > P.TAMANHO_MAXIMO_ARQUIVO) {
    responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id: msg.id, ok: false, erro: 'Arquivo maior que o limite de 200 MB.' });
    return;
  }
  recebendo.set(String(msg.id), { nome: nomeSeguro(msg.nome), partes: [], tamanho: Number(msg.tamanho) || 0 });
}
function receberArquivoParte(msg) {
  const r = recebendo.get(String(msg.id));
  if (!r) return;
  r.partes[Number(msg.seq)] = msg.dados;
}
function receberArquivoFim(msg) {
  const r = recebendo.get(String(msg.id));
  if (!r) { responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id: msg.id, ok: false, erro: 'Transferência não iniciada.' }); return; }
  recebendo.delete(String(msg.id));
  try {
    const path = require('path');
    const destino = path.join(pastaDeDownloads(), r.nome);
    require('fs').writeFileSync(destino, P.remontarPartes(r.partes));
    auditar('suporte_remoto_arquivo', null, `Arquivo recebido do suporte: ${r.nome}`);
    responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id: msg.id, ok: true });
    try { require('electron').shell.showItemInFolder(destino); } catch { /* opcional */ }
  } catch (err) {
    responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id: msg.id, ok: false, erro: err.message });
  }
}

function enviarArquivo(msg) {
  const id = String(msg.id || crypto.randomUUID());
  try {
    const fs = require('fs'); const path = require('path');
    const pedido = String(msg.caminho || '');
    // Só dentro da pasta do app ou da pasta de dados do usuário -- nunca um
    // caminho arbitrário do disco do cliente.
    const base = pastaDoApp();
    const resolvido = path.resolve(base, pedido);
    if (resolvido !== base && !resolvido.startsWith(base + path.sep)) {
      responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id, ok: false, erro: 'Caminho fora da pasta do aplicativo.' });
      return;
    }
    const buf = fs.readFileSync(resolvido);
    if (buf.length > P.TAMANHO_MAXIMO_ARQUIVO) { responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id, ok: false, erro: 'Arquivo maior que 200 MB.' }); return; }
    const nome = path.basename(resolvido);
    const partes = P.fatiarBuffer(buf);
    partes.forEach((dados, seq) => responderCanal({ tipo: P.MSG.ARQUIVO_PARTE, id, seq, dados, nome, tamanho: buf.length, total: partes.length }));
    auditar('suporte_remoto_arquivo', null, `Arquivo enviado ao suporte: ${nome}`);
    responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id, ok: true, nome });
  } catch (err) {
    responderCanal({ tipo: P.MSG.ARQUIVO_FIM, id, ok: false, erro: err.message });
  }
}

// ------------------------------------------------------------------
// Área de transferência
// ------------------------------------------------------------------
function definirClipboard(msg) {
  try { require('electron').clipboard.writeText(String(msg.texto || '').slice(0, 100000)); responderCanal({ tipo: P.MSG.AVISO, texto: 'Texto colado na área de transferência do cliente.' }); }
  catch (err) { responderCanal({ tipo: P.MSG.AVISO, texto: 'Falha ao colar: ' + err.message }); }
}
function pegarClipboard() {
  try { responderCanal({ tipo: P.MSG.CLIPBOARD_TEXTO, texto: require('electron').clipboard.readText().slice(0, 100000) }); }
  catch (err) { responderCanal({ tipo: P.MSG.AVISO, texto: 'Falha ao ler área de transferência: ' + err.message }); }
}

module.exports = {
  iniciarEscutaSuporte, registrarBridgePeer,
  gerarCodigo, getStatus, getConfig, salvarConfig, aceitarConexao, encerrarSessao,
  // exportados pra teste de integração futuro (não tocam rede/UI diretamente):
  rodarCorrecao,
};
