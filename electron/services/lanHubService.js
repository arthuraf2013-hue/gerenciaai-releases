/**
 * Servidor do grupo atendendo os caixas da loja pela rede local.
 *
 * Só liga no computador servidor do grupo, e só enquanto houver caixa
 * ligado a ele (ou um código de ligação esperando). Porta TCP 47820 (ou
 * a próxima livre) para os pedidos, UDP 47821 para os caixas o acharem na
 * rede. Todo pedido e resposta é assinado (lanCripto).
 */

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const cripto = require('./lanCripto');
const armazem = require('./lanArmazemService');

const PORTA_PADRAO = 47820;
const PORTA_DESCOBERTA = 47821;
const VALIDADE_CODIGO_MS = 10 * 60 * 1000;
const MAX_ERROS_CODIGO = 5;
const MAX_CORPO = 8 * 1024 * 1024;
const ESPERA_MAX_FEED_MS = 25000;

let servidor = null;
let udp = null;
let porta = null;
let contexto = null; // { grupoId, hubId, nome }
let codigoAtivo = null; // { codigo, expiraEm, erros }
const sessoes = new Map();
const noncesVistos = new Map();
const contatoGravadoEm = new Map();

// ------------------------------------------------------------ caixas ligados

function listarCaixas() {
  return getDb().prepare('SELECT install_id, nome, criado_em, ultimo_contato FROM lan_caixas ORDER BY nome').all();
}
function temCaixas() { return !!getDb().prepare('SELECT 1 FROM lan_caixas LIMIT 1').get(); }
function removerCaixa(installId) {
  getDb().prepare('DELETE FROM lan_caixas WHERE install_id = ?').run(installId);
  return { ok: true };
}
function esquecerTodosOsCaixas() { getDb().prepare('DELETE FROM lan_caixas').run(); }
function chaveDoCaixa(installId) { return getDb().prepare('SELECT chave FROM lan_caixas WHERE install_id = ?').get(installId)?.chave || null; }

// ------------------------------------------------------------ código de ligação

function gerarCodigo(agoraMs = Date.now()) {
  codigoAtivo = { codigo: cripto.gerarCodigo(), expiraEm: agoraMs + VALIDADE_CODIGO_MS, erros: 0 };
  return { codigo: cripto.formatarCodigo(codigoAtivo.codigo), expiraEm: new Date(codigoAtivo.expiraEm).toISOString() };
}
function cancelarCodigo() { codigoAtivo = null; }
function codigoValido(agoraMs = Date.now()) { return !!codigoAtivo && codigoAtivo.expiraEm > agoraMs && codigoAtivo.erros < MAX_ERROS_CODIGO; }

// ------------------------------------------------------------ endereços

function enderecosLocais() {
  const lista = [];
  for (const [, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) lista.push(i.address);
    }
  }
  return lista;
}

// ------------------------------------------------------------ HTTP

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > MAX_CORPO) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function responder(res, status, objeto, { chave = null, nonce = null } = {}) {
  const corpo = JSON.stringify(objeto);
  const cab = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (chave && nonce) cab['x-assinatura'] = cripto.assinarResposta(chave, { nonce, corpo });
  res.writeHead(status, cab);
  res.end(corpo);
}

function nonceVisto(nonce, agoraMs = Date.now()) {
  for (const [n, t] of noncesVistos) if (agoraMs - t > 2 * cripto.JANELA_MS) noncesVistos.delete(n);
  if (noncesVistos.has(nonce)) return true;
  noncesVistos.set(nonce, agoraMs);
  return false;
}

function registrarContato(installId) {
  const agora = Date.now();
  if (agora - (contatoGravadoEm.get(installId) || 0) < 60000) return;
  contatoGravadoEm.set(installId, agora);
  try { getDb().prepare(`UPDATE lan_caixas SET ultimo_contato = datetime('now') WHERE install_id = ?`).run(installId); } catch { /* banco fechando */ }
}

async function pareamentoInicio(corpo) {
  const { caixaId, nome, grupoId, publica } = corpo || {};
  if (!contexto || grupoId !== contexto.grupoId) return [409, { erro: 'Este computador não é o servidor desse grupo.' }];
  if (!codigoValido()) {
    return [403, { erro: codigoAtivo ? 'Código expirado ou usado errado muitas vezes. Gere um novo no servidor.' : 'Nenhum código de ligação ativo no servidor. Gere um código novo lá.' }];
  }
  if (typeof caixaId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(caixaId)) return [400, { erro: 'Caixa inválido.' }];
  const par = cripto.novoParDeChaves();
  let segredo;
  try { segredo = cripto.segredoCompartilhado(par.privada, publica); } catch { return [400, { erro: 'Chave inválida.' }]; }
  const sessao = crypto.randomBytes(16).toString('hex');
  for (const [s, v] of sessoes) if (Date.now() - v.criadoEm > 2 * 60 * 1000) sessoes.delete(s);
  sessoes.set(sessao, { caixaId, nome: String(nome || '').slice(0, 63) || null, segredo, criadoEm: Date.now() });
  return [200, { sessao, publica: par.publica, hubId: contexto.hubId, hubNome: contexto.nome }];
}

async function pareamentoFim(corpo) {
  const s = sessoes.get(corpo?.sessao);
  if (!s) return [403, { erro: 'Ligação expirou. Tente de novo.' }];
  sessoes.delete(corpo.sessao);
  if (!codigoValido()) return [403, { erro: 'Código expirado ou usado errado muitas vezes. Gere um novo no servidor.' }];
  const chaveSessao = cripto.chaveDePareamento({ segredo: s.segredo, codigo: codigoAtivo.codigo, grupoId: contexto.grupoId, caixaId: s.caixaId, hubId: contexto.hubId });
  if (!cripto.iguais(corpo?.prova, cripto.provaDoCaixa(chaveSessao, corpo.sessao))) {
    codigoAtivo.erros += 1;
    return [403, { erro: 'Código errado.' }];
  }
  const chave = cripto.chaveDoCaixa(chaveSessao);
  getDb().prepare(
    `INSERT INTO lan_caixas (install_id, nome, chave) VALUES (?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET nome = excluded.nome, chave = excluded.chave`
  ).run(s.caixaId, s.nome, chave);
  codigoAtivo = null; // um código liga um caixa
  setImmediate(() => { try { require('./grupoTransporteService').reavaliar(); } catch { /* sem transporte nos testes */ } });
  return [200, { prova: cripto.provaDoServidor(chaveSessao, corpo.sessao), hubId: contexto.hubId, hubNome: contexto.nome, grupoId: contexto.grupoId }];
}

function exigirPronto() {
  return require('./lanEspelhoService').pronto(contexto.grupoId) ? null : [503, { erro: 'aquecendo' }];
}

async function atender(caminho, corpo, caixaId) {
  const g = contexto.grupoId;
  switch (caminho) {
    case '/v1/ping':
      return [200, { grupoId: g, hubId: contexto.hubId, hubNome: contexto.nome, pronto: require('./lanEspelhoService').pronto(g), seq: armazem.seqAtual() }];
    case '/v1/ler': {
      const p = exigirPronto(); if (p) return p;
      if (!armazem.colecaoValida(corpo.colecao)) return [400, { erro: 'coleção' }];
      return [200, { docs: [...armazem.lerTodos(g, corpo.colecao)], seq: armazem.seqAtual() }];
    }
    case '/v1/gravar': {
      if (!armazem.colecaoValida(corpo.colecao) || !Array.isArray(corpo.itens) || corpo.itens.length > 2000) return [400, { erro: 'pedido' }];
      return [200, armazem.gravar(g, corpo.colecao, corpo.itens)];
    }
    case '/v1/feed': {
      const p = exigirPronto(); if (p) return p;
      if (!armazem.colecaoValida(corpo.colecao)) return [400, { erro: 'coleção' }];
      let r = armazem.mudancasDesde(g, corpo.colecao, corpo.desde);
      const espera = Math.min(Math.max(Number(corpo.esperarMs) || 0, 0), ESPERA_MAX_FEED_MS);
      if (!r.docs.length && espera > 0) {
        await armazem.esperarMudanca(g, corpo.colecao, espera);
        r = armazem.mudancasDesde(g, corpo.colecao, corpo.desde);
      }
      return [200, r];
    }
    case '/v1/vendas':
      return [200, { vendas: armazem.vendasDoPeriodo(g, corpo.de, corpo.ate) }];
    case '/v1/estoque/movimento':
      return [200, armazem.aplicarMovimento(g, corpo)];
    case '/v1/estoque/debitar': {
      if (!Array.isArray(corpo.itens) || !corpo.itens.length) return [400, { erro: 'itens' }];
      const itens = corpo.itens.map((i) => ({ productId: String(i.productId), quantidade: Number(i.quantidade), nome: i.nome || null }));
      if (itens.some((i) => !i.productId || !Number.isFinite(i.quantidade) || i.quantidade <= 0)) return [400, { erro: 'itens' }];
      return [200, armazem.verificarEDebitar(g, itens, corpo.operacaoId ? `${caixaId}:${corpo.operacaoId}` : null)];
    }
    default:
      return [404, { erro: 'não existe' }];
  }
}

async function aoPedido(req, res) {
  const caminho = (req.url || '').split('?')[0];
  try {
    if (req.method !== 'POST') return responder(res, 405, { erro: 'método' });
    const texto = await lerCorpo(req);
    let corpo = {};
    try { corpo = texto ? JSON.parse(texto) : {}; } catch { return responder(res, 400, { erro: 'json' }); }
    if (!contexto) return responder(res, 503, { erro: 'desligado' });

    if (caminho === '/v1/parear/inicio' || caminho === '/v1/parear/fim') {
      const [st, obj] = caminho.endsWith('inicio') ? await pareamentoInicio(corpo) : await pareamentoFim(corpo);
      return responder(res, st, obj);
    }

    const caixaId = String(req.headers['x-caixa'] || '');
    const chave = chaveDoCaixa(caixaId);
    if (!chave) return responder(res, 401, { erro: 'Caixa não ligado a este servidor.' });
    const nonce = String(req.headers['x-nonce'] || '');
    const conf = cripto.conferirPedido(chave, {
      metodo: 'POST', caminho, corpo: texto, ts: req.headers['x-ts'], nonce, assinatura: req.headers['x-assinatura'],
    }, { nonceVisto });
    if (!conf.ok) return responder(res, 401, { erro: `pedido recusado (${conf.motivo})` });
    registrarContato(caixaId);
    const [st, obj] = await atender(caminho, corpo, caixaId);
    return responder(res, st, obj, { chave, nonce });
  } catch (err) {
    console.error('[lanHub] pedido falhou:', caminho, err?.message || err);
    try { responder(res, err?.status || 500, { erro: 'falha no servidor' }); } catch { /* conexão já fechou */ }
  }
}

function escutarNaPorta(srv, p, host) {
  return new Promise((resolve, reject) => {
    const erro = (e) => { srv.off('listening', ok); reject(e); };
    const ok = () => { srv.off('error', erro); resolve(srv.address().port); };
    srv.once('error', erro);
    srv.once('listening', ok);
    srv.listen(p, host);
  });
}

// ------------------------------------------------------------ UDP (achar o servidor)

function ligarDescoberta() {
  try {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', (err) => { console.error('[lanHub] descoberta (UDP) falhou:', err?.message || err); try { udp.close(); } catch { /* já fechado */ } udp = null; });
    udp.on('message', (msg, rinfo) => {
      try {
        const texto = msg.toString('utf8');
        if (!texto.startsWith('GERENCIAAI-LAN?') || !contexto) return;
        const pedido = JSON.parse(texto.slice('GERENCIAAI-LAN?'.length));
        if (pedido.grupoId !== contexto.grupoId) return;
        const resposta = Buffer.from('GERENCIAAI-LAN!' + JSON.stringify({ grupoId: contexto.grupoId, hubId: contexto.hubId, nome: contexto.nome, porta }));
        udp.send(resposta, rinfo.port, rinfo.address);
      } catch { /* pacote de outro programa */ }
    });
    udp.bind(PORTA_DESCOBERTA, '0.0.0.0');
  } catch (err) {
    console.error('[lanHub] não deu para ligar a descoberta:', err?.message || err);
  }
}

// ------------------------------------------------------------ ligar / desligar

/**
 * { grupoId, hubId, nome }; porta 0 = qualquer livre. Nos testes, host
 * 127.0.0.1: escutar só na própria máquina não abre o aviso do firewall.
 */
async function ligar(ctx, { portaPreferida = PORTA_PADRAO, descoberta = true, host = '0.0.0.0' } = {}) {
  contexto = ctx;
  if (servidor) return porta;
  const srv = http.createServer((req, res) => { aoPedido(req, res); });
  srv.keepAliveTimeout = 30000;
  srv.headersTimeout = 35000;
  srv.requestTimeout = 60000;
  let ultimaFalha = null;
  const tentativas = portaPreferida === 0 ? [0] : [0, 1, 2, 3, 4, 5].map((i) => portaPreferida + i);
  for (const p of tentativas) {
    try { porta = await escutarNaPorta(srv, p, host); servidor = srv; break; } catch (e) { ultimaFalha = e; }
  }
  if (!servidor) { contexto = null; throw ultimaFalha || new Error('sem porta livre'); }
  if (descoberta) ligarDescoberta();
  return porta;
}

function desligar() {
  if (servidor) { try { servidor.close(); servidor.closeAllConnections?.(); } catch { /* já fechado */ } }
  if (udp) { try { udp.close(); } catch { /* já fechado */ } }
  servidor = null; udp = null; porta = null; contexto = null;
  sessoes.clear();
}

function status() {
  return {
    ligado: !!servidor, porta, enderecos: servidor ? enderecosLocais().map((ip) => `${ip}:${porta}`) : [],
    codigo: codigoValido() ? { codigo: cripto.formatarCodigo(codigoAtivo.codigo), expiraEm: new Date(codigoAtivo.expiraEm).toISOString() } : null,
    caixas: listarCaixas(),
  };
}

module.exports = {
  ligar, desligar, status, gerarCodigo, cancelarCodigo, codigoValido, listarCaixas, temCaixas, removerCaixa,
  esquecerTodosOsCaixas, enderecosLocais, PORTA_PADRAO, PORTA_DESCOBERTA,
};
