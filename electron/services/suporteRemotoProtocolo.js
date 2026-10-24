const crypto = require('crypto');

/**
 * Parte PURA do módulo de acesso remoto -- sem Electron, sem Firestore,
 * sem SQLite. Fica separada de suporteRemotoService.js exatamente pra
 * poder ser testada em qualquer Node (inclusive sem o binário nativo do
 * better-sqlite3), igual loja-util.js faz pra vitrine. Tudo que é "regra"
 * do protocolo (formato do código, verificação do segredo, máquina de
 * estados, limite de tentativas, fatiamento de arquivo, tipos de mensagem
 * do canal de dados) mora aqui.
 *
 * Modelo de segurança (ver também o comentário no topo de
 * suporteRemotoService.js e em firestore.rules):
 *   - O Firestore carrega SÓ a sinalização do WebRTC (SDP/ICE) e o estado
 *     da sessão -- NUNCA saída de shell, conteúdo de arquivo, área de
 *     transferência ou tela. Tudo isso trafega pelo canal P2P do WebRTC,
 *     que é cifrado ponta a ponta (DTLS/SRTP).
 *   - O código de 6 dígitos é conferido DENTRO do canal cifrado, pelo
 *     computador do cliente (como a senha do TeamViewer é conferida pelo
 *     aparelho, não pelo servidor de sinalização). A sinalização sozinha
 *     não dá acesso a nada.
 */

// ------------------------------------------------------------------
// Estados da sessão de suporte (no computador do cliente).
// ------------------------------------------------------------------
const ESTADOS = Object.freeze({
  OCIOSO: 'ocioso',           // nada acontecendo
  AGUARDANDO: 'aguardando',   // código gerado, esperando o técnico conectar
  NEGOCIANDO: 'negociando',   // WebRTC trocando SDP/ICE; código ainda não conferido
  ATIVA: 'ativa',             // código conferido, tela/shell liberados
  ENCERRADA: 'encerrada',     // acabou (pelo cliente, pelo técnico ou timeout)
});

// Transições válidas -- qualquer outra é recusada (defesa contra um lado
// tentar "pular" direto pra ATIVA sem conferir o código).
const TRANSICOES = Object.freeze({
  [ESTADOS.OCIOSO]: [ESTADOS.AGUARDANDO],
  [ESTADOS.AGUARDANDO]: [ESTADOS.NEGOCIANDO, ESTADOS.ENCERRADA],
  [ESTADOS.NEGOCIANDO]: [ESTADOS.ATIVA, ESTADOS.AGUARDANDO, ESTADOS.ENCERRADA],
  [ESTADOS.ATIVA]: [ESTADOS.ENCERRADA],
  [ESTADOS.ENCERRADA]: [ESTADOS.OCIOSO],
});

function transicaoPermitida(de, para) {
  if (de === para) return true; // reenviar o mesmo estado é inofensivo (idempotente)
  return (TRANSICOES[de] || []).includes(para);
}

// ------------------------------------------------------------------
// Código de sessão e segredo de acesso não supervisionado.
// ------------------------------------------------------------------
const DURACAO_CODIGO_MS = 10 * 60 * 1000; // o código some em 10 min se ninguém conectar
const MAX_TENTATIVAS_CODIGO = 5;          // erros de código antes de derrubar a tentativa de conexão

/** Código curto que o cliente lê pro técnico. 6 dígitos, nunca começa com
 * 0 pra sempre ter 6 caracteres (evita "012345" virar "12345" em algum
 * lugar que trate como número). */
function gerarCodigo() {
  return String(crypto.randomInt(100000, 1000000));
}

/** Segredo forte (não é pra humano digitar) usado no acesso não
 * supervisionado -- o cliente gera uma vez, mostra pro técnico guardar, e
 * a partir daí a conexão é liberada por ele em vez do código de 6 dígitos.
 * 160 bits em base32-ish (sem caracteres ambíguos). */
function gerarSegredoNaoSupervisionado() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I,O,0,1
  const bytes = crypto.randomBytes(20);
  let saida = '';
  for (let i = 0; i < bytes.length; i++) saida += alfabeto[bytes[i] % alfabeto.length];
  // Grupos de 4 pra facilitar ler/anotar: XXXX-XXXX-XXXX-XXXX-XXXX
  return saida.match(/.{1,4}/g).join('-');
}

/** Guarda só o hash do código/segredo (scrypt + sal), nunca o valor em
 * claro -- nem no SQLite local, nem no Firestore. */
function hashSegredo(valor, salHex) {
  const sal = salHex ? Buffer.from(salHex, 'hex') : crypto.randomBytes(16);
  const derivado = crypto.scryptSync(String(valor), sal, 32);
  return { sal: sal.toString('hex'), hash: derivado.toString('hex') };
}

/** Compara em tempo constante -- não vaza, pelo tempo de resposta, quantos
 * caracteres do código bateram. */
function verificarSegredo(valor, { sal, hash }) {
  if (!valor || !sal || !hash) return false;
  try {
    const derivado = crypto.scryptSync(String(valor), Buffer.from(sal, 'hex'), 32);
    const esperado = Buffer.from(hash, 'hex');
    return derivado.length === esperado.length && crypto.timingSafeEqual(derivado, esperado);
  } catch {
    return false;
  }
}

/** Decide, só com o número de tentativas erradas até agora, se ainda pode
 * tentar de novo. Função pura (o estado mora em quem chama). */
function avaliarTentativa(tentativasErradas, max = MAX_TENTATIVAS_CODIGO) {
  const usadas = Math.max(0, Number(tentativasErradas) || 0);
  const restantes = Math.max(0, max - usadas);
  return { bloqueado: restantes <= 0, restantes };
}

/** True se o código ainda está dentro da validade. */
function codigoValido(criadoEmMs, agoraMs = Date.now(), duracaoMs = DURACAO_CODIGO_MS) {
  return Number.isFinite(criadoEmMs) && (agoraMs - criadoEmMs) <= duracaoMs;
}

// ------------------------------------------------------------------
// Protocolo do canal de dados do WebRTC (tudo que trafega cifrado P2P).
// ------------------------------------------------------------------
const MSG = Object.freeze({
  // técnico -> cliente
  AUTENTICAR: 'autenticar',       // { segredo } (código de 6 dígitos ou segredo não-sup.)
  SHELL: 'shell',                 // { id, comando }
  CORRECAO: 'correcao',           // { id, acao }
  ARQUIVO_ENVIAR_INICIO: 'arquivo_enviar_inicio', // técnico -> cliente: { id, nome, tamanho }
  ARQUIVO_ENVIAR_PARTE: 'arquivo_enviar_parte',   // { id, seq, dados(base64) }
  ARQUIVO_ENVIAR_FIM: 'arquivo_enviar_fim',       // { id }
  ARQUIVO_PEDIR: 'arquivo_pedir', // técnico pede um arquivo do cliente: { id, caminho }
  CLIPBOARD_DEFINIR: 'clipboard_definir', // { texto }
  CLIPBOARD_PEGAR: 'clipboard_pegar',     // {}
  // cliente -> técnico
  AUTENTICADO: 'autenticado',     // { ok, restantes? }
  SHELL_SAIDA: 'shell_saida',     // { id, fluxo:'stdout'|'stderr', texto }
  SHELL_FIM: 'shell_fim',         // { id, codigo }
  CORRECAO_RESULTADO: 'correcao_resultado', // { id, ok, mensagem }
  ARQUIVO_PARTE: 'arquivo_parte', // cliente -> técnico (resposta a ARQUIVO_PEDIR): { id, seq, dados, nome, tamanho }
  ARQUIVO_FIM: 'arquivo_fim',     // { id, ok, erro? }
  CLIPBOARD_TEXTO: 'clipboard_texto', // { texto }
  AVISO: 'aviso',                 // { texto } (mensagem informativa)
});

// 16 KB por parte: abaixo do limite seguro de uma mensagem de
// RTCDataChannel (o SCTP fragmenta acima disso e alguns navegadores
// recusam mensagens muito grandes).
const CHUNK_BYTES = 16 * 1024;
const TAMANHO_MAXIMO_ARQUIVO = 200 * 1024 * 1024; // 200 MB por transferência

function numeroDeFatias(tamanhoBytes, chunk = CHUNK_BYTES) {
  if (!Number.isFinite(tamanhoBytes) || tamanhoBytes <= 0) return 0;
  return Math.ceil(tamanhoBytes / chunk);
}

/** Quebra um Buffer em pedaços base64 prontos pra mandar no canal. */
function fatiarBuffer(buffer, chunk = CHUNK_BYTES) {
  const partes = [];
  for (let i = 0; i < buffer.length; i += chunk) {
    partes.push(buffer.subarray(i, i + chunk).toString('base64'));
  }
  return partes;
}

/** Remonta as partes base64 de volta num Buffer, na ordem da sequência. */
function remontarPartes(partesBase64) {
  return Buffer.concat(partesBase64.map((p) => Buffer.from(p, 'base64')));
}

// ------------------------------------------------------------------
// Shell: limites (o shell é livre, mas com teto de tamanho e sem bytes
// de controle que poderiam quebrar o PowerShell).
// ------------------------------------------------------------------
const COMANDO_MAX_LEN = 4000;
const SHELL_TIMEOUT_MS = 2 * 60 * 1000;
const SHELL_SAIDA_MAX_BYTES = 1 * 1024 * 1024; // corta a saída de um comando em 1 MB

function sanitizarComando(texto) {
  const limpo = String(texto ?? '').replace(/\0/g, '').slice(0, COMANDO_MAX_LEN);
  return limpo;
}

// Correções rápidas que o botão da Central pode disparar -- o identificador
// é validado contra esta lista no computador do cliente antes de executar.
const CORRECOES = Object.freeze([
  'reparar_instalacao',
  'limpar_cache_busca',
  'recompilar_indices',
  'resync_grupo',
  'reset_pin_admin',
  'otimizar_banco',
  'reiniciar_app',
]);

function correcaoValida(acao) {
  return CORRECOES.includes(acao);
}

// Rótulos legíveis pra Auditoria (o app e a Central mostram estes textos).
const ROTULO_CORRECAO = Object.freeze({
  reparar_instalacao: 'Reparar/reinstalar',
  limpar_cache_busca: 'Limpar cache de busca',
  recompilar_indices: 'Recompilar índices do banco',
  resync_grupo: 'Forçar re-sync do grupo',
  reset_pin_admin: 'Resetar PIN de admin',
  otimizar_banco: 'Otimizar banco',
  reiniciar_app: 'Reiniciar o aplicativo',
});

// ------------------------------------------------------------------
// Pedido de conexão do técnico: novo ou sobra?
// ------------------------------------------------------------------
// O computador não consegue apagar o pedidoConectar (campo do técnico), então
// um pedido de sessão anterior SEMPRE pode estar no documento. Aceitar uma
// sobra fazia o não supervisionado entrar em laço (aceita -> falha -> grava
// -> snapshot -> aceita de novo), abrindo e fechando a captura de tela.
const JANELA_PEDIDO_MS = 5 * 60 * 1000;

/** true só se o pedido é novo: tem nonce, nunca foi tratado, é recente e
 * (havendo código gerado) é posterior a ele. */
function pedidoConectarValido({ nonce, emMs, agoraMs, criadoEmMs = null, jaTratado = false }) {
  if (!nonce || jaTratado) return false;
  const em = Number(emMs) || 0;
  if (!em || Math.abs(agoraMs - em) > JANELA_PEDIDO_MS) return false;
  if (criadoEmMs != null && em < criadoEmMs) return false;
  return true;
}

module.exports = {
  ESTADOS, TRANSICOES, transicaoPermitida,
  DURACAO_CODIGO_MS, MAX_TENTATIVAS_CODIGO,
  gerarCodigo, gerarSegredoNaoSupervisionado, hashSegredo, verificarSegredo,
  avaliarTentativa, codigoValido,
  MSG, CHUNK_BYTES, TAMANHO_MAXIMO_ARQUIVO, numeroDeFatias, fatiarBuffer, remontarPartes,
  COMANDO_MAX_LEN, SHELL_TIMEOUT_MS, SHELL_SAIDA_MAX_BYTES, sanitizarComando,
  CORRECOES, correcaoValida, ROTULO_CORRECAO,
  JANELA_PEDIDO_MS, pedidoConectarValido,
};
