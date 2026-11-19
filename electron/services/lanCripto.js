/**
 * Segurança da sincronização pela rede local (caixas do grupo <-> servidor).
 *
 * O Wi-Fi da loja pode ter clientes, então nada vai sem prova:
 *
 * 1. Ligar um caixa ao servidor (uma vez): o servidor mostra um código de
 *    8 caracteres (vale 10 min). Os dois lados fazem uma troca de chaves
 *    X25519 (ninguém escutando a rede descobre a chave) e cada um prova que
 *    sabe o código (HMAC com chave derivada do segredo + código). Quem não
 *    sabe o código não completa; 5 erros invalidam o código.
 * 2. Depois disso, todo pedido do caixa e toda resposta do servidor levam
 *    HMAC-SHA256 com a chave daquele caixa. Pedido com hora fora de ±2 min
 *    ou com número único (nonce) repetido é recusado; a resposta é amarrada
 *    ao nonce do pedido -- um falso "servidor" na rede não consegue
 *    responder, e uma resposta velha não serve para outro pedido.
 */

const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L
const TAMANHO_CODIGO = 8;
const JANELA_MS = 2 * 60 * 1000;

function gerarCodigo() {
  let s = '';
  for (let i = 0; i < TAMANHO_CODIGO; i++) s += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return s;
}

/** "abcd efgh" / "ABCD-EFGH" -> "ABCDEFGH" (null se não tiver o tamanho certo). */
function normalizarCodigo(texto) {
  const s = String(texto || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== TAMANHO_CODIGO) return null;
  for (const c of s) if (!ALFABETO.includes(c)) return null;
  return s;
}

function formatarCodigo(codigo) {
  return `${codigo.slice(0, 4)}-${codigo.slice(4)}`;
}

function novoParDeChaves() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publica: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privada: privateKey };
}

function segredoCompartilhado(privada, publicaOutroBase64) {
  const publicKey = crypto.createPublicKey({ key: Buffer.from(String(publicaOutroBase64 || ''), 'base64'), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: privada, publicKey });
}

/** Chave da sessão de pareamento: segredo X25519 + código + quem está falando com quem. */
function chaveDePareamento({ segredo, codigo, grupoId, caixaId, hubId }) {
  const info = Buffer.from(`gerenciaai-lan-v1|${grupoId}|${caixaId}|${hubId}`);
  return Buffer.from(crypto.hkdfSync('sha256', segredo, Buffer.from(codigo), info, 32));
}

function hmac(chave, texto) {
  return crypto.createHmac('sha256', Buffer.isBuffer(chave) ? chave : Buffer.from(chave, 'base64')).update(texto).digest('base64');
}

function iguais(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function provaDoCaixa(chaveSessao, sessao) { return hmac(chaveSessao, `caixa|${sessao}`); }
function provaDoServidor(chaveSessao, sessao) { return hmac(chaveSessao, `servidor|${sessao}`); }

/** A chave definitiva do caixa (base64) sai da chave da sessão, nunca é a mesma. */
function chaveDoCaixa(chaveSessao) {
  return Buffer.from(crypto.hkdfSync('sha256', chaveSessao, Buffer.alloc(0), Buffer.from('gerenciaai-lan-v1|chave-do-caixa'), 32)).toString('base64');
}

function resumo(corpo) {
  return crypto.createHash('sha256').update(corpo || '').digest('base64');
}

function textoDoPedido({ metodo, caminho, ts, nonce, corpo }) {
  return `pedido\n${metodo}\n${caminho}\n${ts}\n${nonce}\n${resumo(corpo)}`;
}

function assinarPedido(chave, { metodo, caminho, corpo, agoraMs = Date.now() }) {
  const ts = String(agoraMs);
  const nonce = crypto.randomBytes(16).toString('base64');
  return { ts, nonce, assinatura: hmac(chave, textoDoPedido({ metodo, caminho, ts, nonce, corpo })) };
}

/** Confere hora e assinatura. `nonceVisto(nonce)` devolve true se já foi usado (replay). */
function conferirPedido(chave, { metodo, caminho, corpo, ts, nonce, assinatura }, { agoraMs = Date.now(), nonceVisto = () => false } = {}) {
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(agoraMs - t) > JANELA_MS) return { ok: false, motivo: 'hora' };
  if (!nonce || String(nonce).length > 64) return { ok: false, motivo: 'nonce' };
  if (!iguais(assinatura, hmac(chave, textoDoPedido({ metodo, caminho, ts, nonce, corpo })))) return { ok: false, motivo: 'assinatura' };
  if (nonceVisto(nonce)) return { ok: false, motivo: 'repetido' };
  return { ok: true };
}

function assinarResposta(chave, { nonce, corpo }) {
  return hmac(chave, `resposta\n${nonce}\n${resumo(corpo)}`);
}

function conferirResposta(chave, { nonce, corpo, assinatura }) {
  return iguais(assinatura, assinarResposta(chave, { nonce, corpo }));
}

module.exports = {
  gerarCodigo, normalizarCodigo, formatarCodigo, novoParDeChaves, segredoCompartilhado, chaveDePareamento,
  provaDoCaixa, provaDoServidor, chaveDoCaixa, assinarPedido, conferirPedido, assinarResposta, conferirResposta,
  iguais, JANELA_MS,
};
