/**
 * Caixa do grupo falando com o servidor pela rede local.
 *
 * Ligação (uma vez): acha o servidor na rede, troca chaves com o código de
 * 8 caracteres mostrado lá (lanCripto) e guarda a chave em lan_cliente.
 * Depois disso, cada pedido vai assinado e cada resposta é conferida.
 * Achar o servidor: endereço digitado > último que funcionou > anúncio do
 * servidor no Realtime Database > pergunta na rede (UDP).
 */

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const { getDb } = require('../db/database');
const cripto = require('./lanCripto');

const PORTA_DESCOBERTA = 47821;
const PORTA_PADRAO = 47820;

// ------------------------------------------------------------ configuração

function config() {
  const l = getDb().prepare(`SELECT * FROM lan_cliente WHERE id = 'default'`).get();
  if (!l) return null;
  let enderecos = [];
  try { enderecos = JSON.parse(l.enderecos || '[]'); } catch { /* lista quebrada */ }
  return { grupoId: l.grupo_id, hubId: l.hub_install_id, hubNome: l.hub_nome, chave: l.chave, enderecos };
}

function guardarEnderecoQueFuncionou(endereco) {
  const c = config();
  if (!c) return;
  const lista = [endereco, ...c.enderecos.filter((e) => e !== endereco)].slice(0, 5);
  getDb().prepare(`UPDATE lan_cliente SET enderecos = ? WHERE id = 'default'`).run(JSON.stringify(lista));
}

function desligar() {
  getDb().prepare(`DELETE FROM lan_cliente WHERE id = 'default'`).run();
  enderecoAtual = null;
  return { ok: true };
}

// ------------------------------------------------------------ HTTP

function normalizarEndereco(texto) {
  const s = String(texto || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!s) return null;
  const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  return `${m[1]}:${m[2] || PORTA_PADRAO}`;
}

function postar(endereco, caminho, corpoTexto, cabecalhos = {}, timeoutMs = 8000) {
  const [host, portaTxt] = endereco.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port: Number(portaTxt), path: caminho, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpoTexto), ...cabecalhos },
    }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8'), assinatura: res.headers['x-assinatura'] }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('sem resposta do servidor'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(corpoTexto);
  });
}

let enderecoAtual = null;

/**
 * Pedido assinado ao servidor. Lança Error com `.status` (resposta) ou
 * `.rede = true` (não chegou). Resposta sem assinatura certa = erro.
 */
async function pedido(caminho, corpo = {}, { timeoutMs = 8000 } = {}) {
  const c = config();
  if (!c) throw Object.assign(new Error('Este caixa não está ligado a um servidor na rede local.'), { status: 0 });
  const texto = JSON.stringify(corpo);
  const candidatos = [...new Set([enderecoAtual, ...c.enderecos].filter(Boolean))];
  let ultimo = null;
  for (const endereco of candidatos) {
    const ass = cripto.assinarPedido(c.chave, { metodo: 'POST', caminho, corpo: texto });
    let r;
    try {
      r = await postar(endereco, caminho, texto, { 'x-caixa': require('./pdvRegistryService').getOrCreateDeviceUid(), 'x-ts': ass.ts, 'x-nonce': ass.nonce, 'x-assinatura': ass.assinatura }, timeoutMs);
    } catch (err) {
      ultimo = Object.assign(new Error(err?.message || 'rede'), { rede: true });
      continue;
    }
    if (r.status === 200) {
      if (!cripto.conferirResposta(c.chave, { nonce: ass.nonce, corpo: r.corpo, assinatura: r.assinatura })) {
        ultimo = Object.assign(new Error('Resposta do servidor sem assinatura válida.'), { status: 401 });
        continue;
      }
      if (enderecoAtual !== endereco) { enderecoAtual = endereco; guardarEnderecoQueFuncionou(endereco); }
      return JSON.parse(r.corpo);
    }
    let msg = `HTTP ${r.status}`;
    try { msg = JSON.parse(r.corpo).erro || msg; } catch { /* sem corpo */ }
    throw Object.assign(new Error(msg), { status: r.status });
  }
  throw ultimo || Object.assign(new Error('Servidor não encontrado na rede.'), { rede: true });
}

// ------------------------------------------------------------ achar o servidor

function enderecosDeBroadcast() {
  const lista = new Set(['255.255.255.255']);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number);
      const mascara = i.netmask.split('.').map(Number);
      lista.add(ip.map((b, k) => (b | (~mascara[k] & 255))).join('.'));
    }
  }
  return [...lista];
}

/** Pergunta na rede quem é o servidor do grupo. Devolve [{ endereco, hubId, nome }]. */
function procurarNaRede(grupoId, esperaMs = 1500) {
  return new Promise((resolve) => {
    const achados = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { resolve([]); return; }
    const fim = () => { try { sock.close(); } catch { /* fechado */ } resolve([...achados.values()]); };
    sock.on('error', fim);
    sock.on('message', (msg, rinfo) => {
      const texto = msg.toString('utf8');
      if (!texto.startsWith('GERENCIAAI-LAN!')) return;
      try {
        const r = JSON.parse(texto.slice('GERENCIAAI-LAN!'.length));
        if (r.grupoId !== grupoId || !Number.isInteger(r.porta)) return;
        achados.set(r.hubId, { endereco: `${rinfo.address}:${r.porta}`, hubId: r.hubId, nome: r.nome || null });
      } catch { /* outro programa */ }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        const pergunta = Buffer.from('GERENCIAAI-LAN?' + JSON.stringify({ grupoId }));
        for (const destino of enderecosDeBroadcast()) sock.send(pergunta, PORTA_DESCOBERTA, destino, () => {});
      } catch { /* sem rede */ }
      setTimeout(fim, esperaMs).unref?.();
    });
  });
}

/** Anúncio do servidor no Realtime Database (quando existe e há internet). */
async function anuncioNaNuvem(grupoId) {
  try {
    const url = `${require('./presencaService').RTDB_URL}/hubs/${encodeURIComponent(grupoId)}.json`;
    const controle = new AbortController();
    const t = setTimeout(() => controle.abort(), 5000); t.unref?.();
    const r = await fetch(url, { signal: controle.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return [];
    const d = await r.json();
    if (!d || !Array.isArray(d.enderecos)) return [];
    return d.enderecos.filter((e) => typeof e === 'string').map((endereco) => ({ endereco, hubId: d.hubId || null, nome: d.nome || null }));
  } catch { return []; }
}

async function candidatos(grupoId, enderecoDigitado) {
  const lista = [];
  const digitado = normalizarEndereco(enderecoDigitado);
  if (digitado) lista.push({ endereco: digitado });
  const c = config();
  if (c && c.grupoId === grupoId) for (const e of c.enderecos) lista.push({ endereco: e, hubId: c.hubId });
  if (!digitado) {
    lista.push(...(await anuncioNaNuvem(grupoId)));
    lista.push(...(await procurarNaRede(grupoId)));
  }
  const vistos = new Set();
  return lista.filter((x) => (vistos.has(x.endereco) ? false : vistos.add(x.endereco)));
}

// ------------------------------------------------------------ ligar a um servidor

async function parear({ codigo, endereco } = {}) {
  const grupoId = require('./syncStateService').getGrupoSincronizacaoId();
  if (!grupoId) return { ok: false, error: 'Este computador não está em nenhum grupo de sincronização.' };
  if (require('./syncStateService').ehServidorDoGrupo()) return { ok: false, error: 'Este computador é o servidor do grupo: os outros caixas é que se ligam a ele.' };
  const cod = cripto.normalizarCodigo(codigo);
  if (!cod) return { ok: false, error: 'Código inválido: são 8 letras/números, como aparece no servidor (ex.: ABCD-EF23).' };
  const caixaId = require('./pdvRegistryService').getOrCreateDeviceUid();
  let nome = null;
  try { nome = require('./licenseService').nomeDoComputador(); } catch { /* sem nome */ }

  const lista = await candidatos(grupoId, endereco);
  if (!lista.length) {
    return { ok: false, error: 'Não achei o servidor na rede. Confira se ele está ligado, com o GerenciaAI aberto, e digite o endereço que aparece na tela dele.' };
  }
  let ultimoErro = null;
  for (const alvo of lista) {
    try {
      const par = cripto.novoParDeChaves();
      const r1 = await postar(alvo.endereco, '/v1/parear/inicio', JSON.stringify({ caixaId, nome, grupoId, publica: par.publica }));
      const d1 = JSON.parse(r1.corpo || '{}');
      if (r1.status !== 200) { ultimoErro = d1.erro || `HTTP ${r1.status}`; continue; }
      const segredo = cripto.segredoCompartilhado(par.privada, d1.publica);
      const chaveSessao = cripto.chaveDePareamento({ segredo, codigo: cod, grupoId, caixaId, hubId: d1.hubId });
      const r2 = await postar(alvo.endereco, '/v1/parear/fim', JSON.stringify({ sessao: d1.sessao, prova: cripto.provaDoCaixa(chaveSessao, d1.sessao) }));
      const d2 = JSON.parse(r2.corpo || '{}');
      if (r2.status !== 200) { ultimoErro = d2.erro || `HTTP ${r2.status}`; continue; }
      if (!cripto.iguais(d2.prova, cripto.provaDoServidor(chaveSessao, d1.sessao))) { ultimoErro = 'O servidor não provou que conhece o código.'; continue; }
      getDb().prepare(
        `INSERT INTO lan_cliente (id, grupo_id, hub_install_id, hub_nome, chave, enderecos) VALUES ('default', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET grupo_id = excluded.grupo_id, hub_install_id = excluded.hub_install_id,
           hub_nome = excluded.hub_nome, chave = excluded.chave, enderecos = excluded.enderecos`
      ).run(grupoId, d1.hubId, d1.hubNome || null, cripto.chaveDoCaixa(chaveSessao), JSON.stringify([alvo.endereco]));
      enderecoAtual = alvo.endereco;
      setImmediate(() => { try { require('./grupoTransporteService').reavaliar(); } catch { /* testes */ } });
      return { ok: true, servidor: d1.hubNome || alvo.nome || alvo.endereco, endereco: alvo.endereco };
    } catch (err) {
      ultimoErro = err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'EHOSTUNREACH'
        ? `O servidor em ${alvo.endereco} não respondeu (firewall do Windows?).` : (err?.message || String(err));
    }
  }
  return { ok: false, error: ultimoErro || 'Não foi possível ligar ao servidor.' };
}

/** Atualiza a lista de endereços com o anúncio/descoberta (IP do servidor pode mudar). */
async function reencontrar() {
  const c = config();
  if (!c) return false;
  const achados = [...(await anuncioNaNuvem(c.grupoId)), ...(await procurarNaRede(c.grupoId))]
    .filter((a) => !a.hubId || a.hubId === c.hubId).map((a) => a.endereco);
  if (!achados.length) return false;
  const lista = [...new Set([...achados, ...c.enderecos])].slice(0, 5);
  getDb().prepare(`UPDATE lan_cliente SET enderecos = ? WHERE id = 'default'`).run(JSON.stringify(lista));
  return true;
}

// ------------------------------------------------------------ operações (backend do grupo)

async function lerTodos(colecao) {
  const r = await pedido('/v1/ler', { colecao }, { timeoutMs: 30000 });
  return new Map(r.docs);
}

/** Só os documentos pedidos (fotos). Até 20 por pedido. */
async function lerAlguns(colecao, ids) {
  const docs = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const r = await pedido('/v1/ler-alguns', { colecao, ids: ids.slice(i, i + 20) }, { timeoutMs: 60000 });
    for (const [id, d] of r.docs) docs.set(id, d);
  }
  return docs;
}

async function gravarLote(colecao, itens) {
  for (let i = 0; i < itens.length; i += 1000) {
    await pedido('/v1/gravar', { colecao, itens: itens.slice(i, i + 1000) }, { timeoutMs: 30000 });
  }
}

/** Como onSnapshot: tudo primeiro, depois as mudanças (pedido longo). */
function escutar(colecao, aoMudar, aoErrar) {
  let ativo = true;
  let desde = 0;
  (async () => {
    while (ativo) {
      try {
        const r = await pedido('/v1/feed', { colecao, desde, esperarMs: desde === 0 ? 0 : 20000 }, { timeoutMs: 30000 });
        if (!ativo) break;
        desde = r.seq;
        if (r.docs.length) aoMudar(new Map(r.docs));
      } catch (err) {
        if (!ativo) break;
        try { aoErrar?.(err); } catch { /* quem escuta se vira */ }
        await new Promise((ok) => { const t = setTimeout(ok, 3000); t.unref?.(); });
      }
    }
  })();
  return () => { ativo = false; };
}

async function vendasDoPeriodo(de, ate) {
  const r = await pedido('/v1/vendas', { de, ate }, { timeoutMs: 30000 });
  return r.vendas;
}

async function aplicarMovimento(m) { return pedido('/v1/estoque/movimento', m); }
async function verificarEDebitar(itens, operacaoId) { return pedido('/v1/estoque/debitar', { itens, operacaoId }, { timeoutMs: 10000 }); }
async function saldosDeEstoque(ids = null) { return pedido('/v1/estoque/saldos', ids ? { ids } : {}, { timeoutMs: 3000 }); }
async function ping() { return pedido('/v1/ping', {}, { timeoutMs: 4000 }); }

module.exports = {
  saldosDeEstoque,
  config, parear, desligar, reencontrar, pedido, ping, lerTodos, lerAlguns, gravarLote, escutar, vendasDoPeriodo,
  aplicarMovimento, verificarEDebitar, procurarNaRede, normalizarEndereco,
};
