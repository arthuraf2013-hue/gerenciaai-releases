// Túnel da Cloudflare AUTOMÁTICO para o QR da mesa (sem Firebase).
//
// A loja cola um token da API da Cloudflare, escolhe o domínio e pronto:
//   1. acha a zona (domínio) e a conta pela API;
//   2. cria (ou reaproveita) o túnel "gerenciaai-mesas-<máquina>";
//   3. aponta https://<nome>.<domínio> para o servidor das mesas daqui
//      (http://localhost:<porta>, ver mesaLocalService);
//   4. cria o DNS (CNAME para <túnel>.cfargotunnel.com, com proxy);
//   5. baixa o cloudflared oficial (assinatura da Cloudflare conferida) e
//      roda o túnel JUNTO com o GerenciaAI -- sem serviço do Windows e sem
//      administrador. Caiu, religa sozinho;
//   6. preenche o "endereço pela internet" e testa.
//
// O token da API NÃO fica guardado: só serve para montar. O que fica é o token
// do túnel (criptografado pelo Windows, ver secretsService), que só serve para
// rodar ESTE túnel.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { getDb } = require('../db/database');

const API = 'https://api.cloudflare.com/client/v4';
const URL_CLOUDFLARED = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const ESPERA_MIN_MS = 5000;
const ESPERA_MAX_MS = 5 * 60 * 1000;
const LINHAS_DE_LOG = 40;
const PAPEIS = ['gerente', 'admin', 'suporte'];

const estado = { proc: null, tentativas: 0, timer: null, ultimoErro: null, log: [], iniciadoEm: null, conexoes: 0, parando: false };

// Pontos de troca para os testes (rede, disco e processo).
let fetchDeTeste = null;
let spawnDeTeste = null;
let garantirBinarioDeTeste = null;
let pastaDeTeste = null;
function _definirParaTeste({ fetch: f, spawn: s, garantirBinario: g, pasta: p } = {}) {
  fetchDeTeste = f || null;
  spawnDeTeste = s || null;
  garantirBinarioDeTeste = g || null;
  pastaDeTeste = p || null;
}

function pasta() {
  if (pastaDeTeste) return pastaDeTeste;
  const { app } = require('electron');
  const base = app ? app.getPath('userData') : path.join(__dirname, '../../.data');
  const dir = path.join(base, 'cloudflared');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function linha() {
  require('./mesaLocalService').getConfig(); // garante a linha da config
  return getDb().prepare("SELECT * FROM mesa_local_config WHERE id = 'default'").get();
}

function getStatus() {
  const r = linha();
  return {
    configurado: !!(r.tunel_id && r.tunel_token),
    ativo: r.tunel_ativo === 1,
    host: r.tunel_host || null,
    rodando: !!estado.proc,
    conectado: estado.conexoes > 0,
    ultimoErro: estado.ultimoErro,
    log: estado.log.slice(-10),
  };
}

function anotar(texto) {
  const l = String(texto || '').trim();
  if (!l) return;
  // Token nunca vai para o log da tela.
  estado.log.push(l.replace(/eyJ[A-Za-z0-9_-]{20,}/g, '[token]').slice(0, 300));
  if (estado.log.length > LINHAS_DE_LOG) estado.log.splice(0, estado.log.length - LINHAS_DE_LOG);
  if (/Registered tunnel connection/i.test(l)) { estado.conexoes += 1; estado.ultimoErro = null; estado.tentativas = 0; }
  if (/Unregistered tunnel connection|connection.*(lost|closed)/i.test(l)) estado.conexoes = Math.max(0, estado.conexoes - 1);
}

// ------------------------------------------------------------------ API da Cloudflare

async function api(token, metodo, caminho, corpo) {
  const f = fetchDeTeste || fetch;
  let r;
  try {
    r = await f(`${API}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Sem conexão com a Cloudflare (${err?.cause?.code || err?.message || err}).`);
  }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok || !j || j.success === false) {
    const msg = (j?.errors || []).map((e) => e.message).filter(Boolean).join('; ');
    if (r.status === 401 || r.status === 403) {
      throw new Error(`A Cloudflare recusou o token${msg ? ` (${msg})` : ''}. Confira se o token tem as permissões: Conta > Cloudflare Tunnel > Editar; Zona > DNS > Editar; Zona > Zona > Ler.`);
    }
    throw new Error(`A Cloudflare respondeu erro ${r.status}${msg ? `: ${msg}` : ''}.`);
  }
  return j.result;
}

const DOMINIO = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NOME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function nomeDoTunel() {
  let id = 'pdv';
  try { id = require('./pdvRegistryService').getOrCreateDeviceUid(); } catch { /* teste */ }
  return `gerenciaai-mesas-${String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toLowerCase() || 'pdv'}`;
}

/**
 * Monta tudo na Cloudflare e liga o túnel. Devolve os passos (para a tela).
 */
async function configurarAutomatico({ apiToken, dominio, nome = 'mesa', requestingUserId } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !PAPEIS.includes(user.role)) return { ok: false, error: 'Apenas gerente ou administrador configura o túnel.' };
  const mesaLocal = require('./mesaLocalService');
  if (!mesaLocal.deveRodar({ ...linha(), ativo: 1 })) {
    return { ok: false, error: 'Faça isto no computador SERVIDOR do grupo: é nele que ficam as mesas.' };
  }
  const token = String(apiToken || '').trim();
  const dom = String(dominio || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const sub = String(nome || 'mesa').trim().toLowerCase();
  if (token.length < 20) return { ok: false, error: 'Cole o token da API da Cloudflare.' };
  if (!DOMINIO.test(dom)) return { ok: false, error: 'Domínio inválido. Use só o domínio, ex.: barcharque.com.br' };
  if (!NOME.test(sub)) return { ok: false, error: 'Nome inválido. Use letras, números e hífen, ex.: mesa' };
  const host = `${sub}.${dom}`;
  const porta = mesaLocal.getConfig().porta;
  const passos = [];
  const passo = (texto) => passos.push({ passo: texto, ok: true });

  try {
    // 1. Domínio e conta
    const zonas = await api(token, 'GET', `/zones?name=${encodeURIComponent(dom)}`);
    const zona = Array.isArray(zonas) ? zonas[0] : null;
    if (!zona?.id || !zona?.account?.id) throw new Error(`O domínio ${dom} não está nesta conta da Cloudflare (ou o token não pode ver zonas: falta Zona > Zona > Ler).`);
    const conta = zona.account.id;
    passo(`Domínio ${dom} encontrado`);

    // 2. Túnel (reaproveita o desta máquina, se já existir)
    const nomeTunel = nomeDoTunel();
    const existentes = await api(token, 'GET', `/accounts/${conta}/cfd_tunnel?name=${encodeURIComponent(nomeTunel)}&is_deleted=false`);
    let tunelId = Array.isArray(existentes) && existentes[0]?.id ? existentes[0].id : null;
    let tokenDoTunel = null;
    if (tunelId) {
      passo(`Túnel ${nomeTunel} já existia: reaproveitado`);
    } else {
      const criado = await api(token, 'POST', `/accounts/${conta}/cfd_tunnel`, { name: nomeTunel, config_src: 'cloudflare' });
      tunelId = criado?.id;
      tokenDoTunel = criado?.token || null;
      if (!tunelId) throw new Error('A Cloudflare não devolveu o túnel criado.');
      passo(`Túnel ${nomeTunel} criado`);
    }
    if (!tokenDoTunel) tokenDoTunel = await api(token, 'GET', `/accounts/${conta}/cfd_tunnel/${tunelId}/token`);
    if (typeof tokenDoTunel !== 'string' || tokenDoTunel.length < 20) throw new Error('A Cloudflare não devolveu o token do túnel.');

    // 3. Endereço -> servidor das mesas daqui
    await api(token, 'PUT', `/accounts/${conta}/cfd_tunnel/${tunelId}/configurations`, {
      config: { ingress: [{ hostname: host, service: `http://localhost:${porta}`, originRequest: {} }, { service: 'http_status:404' }] },
    });
    passo(`https://${host} aponta para o pedido pela mesa deste computador`);

    // 4. DNS
    const alvo = `${tunelId}.cfargotunnel.com`;
    const registros = await api(token, 'GET', `/zones/${zona.id}/dns_records?name=${encodeURIComponent(host)}`);
    const atual = Array.isArray(registros) ? registros[0] : null;
    if (!atual) {
      await api(token, 'POST', `/zones/${zona.id}/dns_records`, { type: 'CNAME', proxied: true, name: host, content: alvo });
      passo(`Endereço ${host} criado no DNS`);
    } else if (atual.type === 'CNAME' && /\.cfargotunnel\.com$/i.test(atual.content || '')) {
      if (atual.content !== alvo || atual.proxied !== true) {
        await api(token, 'PUT', `/zones/${zona.id}/dns_records/${atual.id}`, { type: 'CNAME', proxied: true, name: host, content: alvo });
        passo(`Endereço ${host} atualizado no DNS`);
      } else {
        passo(`Endereço ${host} já estava certo no DNS`);
      }
    } else {
      throw new Error(`Já existe no DNS um registro "${host}" que não é de túnel (${atual.type}). Escolha outro nome (ex.: pedido) para não estragar o que já está lá.`);
    }

    // 5. Guarda (o token da API não fica guardado)
    const cifrado = require('./secretsService').encrypt(tokenDoTunel);
    db.prepare(`UPDATE mesa_local_config SET ativo = 1, endereco_publico = ?, tunel_ativo = 1, tunel_id = ?, tunel_conta = ?, tunel_host = ?, tunel_token = ?,
      atualizado_em = NOW_SYNCED() WHERE id = 'default'`).run(`https://${host}`, tunelId, conta, host, cifrado);
    try {
      require('./authService').registrarEventoAuditoria({ tipoEvento: 'mesa_local_alterado', solicitanteId: requestingUserId, motivo: `Túnel da Cloudflare configurado: https://${host}` });
    } catch { /* auditoria é extra */ }
  } catch (err) {
    return { ok: false, error: err?.message || String(err), passos };
  }

  // 6. Liga o servidor das mesas e o túnel
  await mesaLocal.atualizar();
  const ligou = await atualizar({ forcar: true });
  if (!ligou.ok) return { ok: false, error: ligou.error, passos };
  passo('Túnel ligado neste computador (roda junto com o GerenciaAI)');
  return { ok: true, passos, endereco: `https://${host}` };
}

// ------------------------------------------------------------------ cloudflared

/** cloudflared oficial: baixa uma vez e confere a assinatura digital da Cloudflare. */
async function garantirBinario() {
  if (garantirBinarioDeTeste) return garantirBinarioDeTeste();
  if (process.platform !== 'win32') throw new Error('O túnel automático é para Windows.');
  const exe = path.join(pasta(), 'cloudflared.exe');
  if (fs.existsSync(exe) && (await assinaturaDaCloudflare(exe))) return exe;
  const tmp = `${exe}.baixando`;
  const r = await fetch(URL_CLOUDFLARED, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`Não consegui baixar o cloudflared (erro ${r.status}).`);
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  if (!(await assinaturaDaCloudflare(tmp))) {
    try { fs.unlinkSync(tmp); } catch { /* já foi */ }
    throw new Error('O cloudflared baixado não tem a assinatura digital da Cloudflare. Não vou rodar.');
  }
  try { fs.unlinkSync(exe); } catch { /* não tinha */ }
  fs.renameSync(tmp, exe);
  return exe;
}

/** Assinatura Authenticode válida e emitida para a Cloudflare? */
function assinaturaDaCloudflare(arquivo) {
  return new Promise((resolve) => {
    const cmd = "$s = Get-AuthenticodeSignature -LiteralPath $env:ARQ; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Cloudflare') { 'ok' } else { 'nao' }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: { ...process.env, ARQ: arquivo }, windowsHide: true, timeout: 60000 },
      (err, saida) => resolve(!err && String(saida).trim() === 'ok'));
  });
}

/** Mata um cloudflared que sobrou de uma execução anterior (app fechado à força). */
function matarSobra() {
  const arq = path.join(pasta(), 'pid.json');
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(arq, 'utf8')).pid; } catch { return; }
  try { fs.unlinkSync(arq); } catch { /* já foi */ }
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return;
  // Só mata se o processo com esse número ainda for o cloudflared (o número pode ter sido reaproveitado).
  execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, saida) => {
    if (!err && /cloudflared\.exe/i.test(String(saida))) execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => {});
  });
}

function agendarReinicio() {
  if (estado.timer || estado.parando) return;
  const espera = Math.min(ESPERA_MAX_MS, ESPERA_MIN_MS * 2 ** Math.min(estado.tentativas, 6));
  estado.tentativas += 1;
  estado.timer = setTimeout(() => { estado.timer = null; atualizar().catch(() => {}); }, espera);
  estado.timer.unref?.();
}

async function iniciarProcesso(tokenDoTunel) {
  const exe = await garantirBinario();
  if (!spawnDeTeste) matarSobra();
  const proc = (spawnDeTeste || spawn)(exe, ['tunnel', '--no-autoupdate', 'run'], {
    // Token pelo ambiente: não aparece na linha de comando do Gerenciador de Tarefas.
    env: { ...process.env, TUNNEL_TOKEN: tokenDoTunel },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  estado.proc = proc;
  estado.iniciadoEm = Date.now();
  estado.conexoes = 0;
  estado.parando = false;
  try { if (!spawnDeTeste) fs.writeFileSync(path.join(pasta(), 'pid.json'), JSON.stringify({ pid: proc.pid })); } catch { /* sem pid: segue */ }
  const ler = (fluxo) => {
    let resto = '';
    fluxo?.on?.('data', (d) => {
      const partes = (resto + d.toString('utf8')).split(/\r?\n/);
      resto = partes.pop();
      partes.forEach(anotar);
    });
  };
  ler(proc.stdout);
  ler(proc.stderr);
  proc.on('exit', (codigo) => {
    if (estado.proc !== proc) return;
    estado.proc = null;
    estado.conexoes = 0;
    if (estado.parando) return;
    estado.ultimoErro = `O túnel parou (código ${codigo}). Religando...`;
    agendarReinicio();
  });
  proc.on('error', (err) => {
    if (estado.proc !== proc) return;
    estado.proc = null;
    estado.ultimoErro = `Não consegui rodar o túnel: ${err?.message || err}`;
    agendarReinicio();
  });
}

function parar() {
  estado.parando = true;
  if (estado.timer) { clearTimeout(estado.timer); estado.timer = null; }
  const proc = estado.proc;
  estado.proc = null;
  estado.conexoes = 0;
  if (proc) { try { proc.kill(); } catch { /* já parou */ } }
  try { if (!spawnDeTeste) fs.unlinkSync(path.join(pasta(), 'pid.json')); } catch { /* não tinha */ }
}

/**
 * Liga/desliga o túnel conforme a configuração e o papel (chamado na abertura,
 * a cada minuto e ao configurar). Só no computador que roda o pedido pela mesa.
 */
async function atualizar({ forcar = false } = {}) {
  let r;
  try { r = linha(); } catch { return { ok: true }; }
  let deve = false;
  try { deve = r.tunel_ativo === 1 && !!r.tunel_token && require('./mesaLocalService').deveRodar(r); } catch { deve = false; }
  if (!deve) { if (estado.proc || estado.timer) parar(); return { ok: true, ligado: false }; }
  if (estado.proc) return { ok: true, ligado: true };
  if (estado.timer && !forcar) return { ok: true, ligado: false, esperando: true };
  if (estado.timer) { clearTimeout(estado.timer); estado.timer = null; }
  const tokenDoTunel = require('./secretsService').decrypt(r.tunel_token);
  try {
    await iniciarProcesso(tokenDoTunel);
    return { ok: true, ligado: true };
  } catch (err) {
    estado.ultimoErro = err?.message || String(err);
    agendarReinicio();
    return { ok: false, error: estado.ultimoErro };
  }
}

/** Desliga o túnel neste computador (a configuração na Cloudflare fica). */
function desligar({ requestingUserId } = {}) {
  const user = getDb().prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !PAPEIS.includes(user.role)) return { ok: false, error: 'Apenas gerente ou administrador desliga o túnel.' };
  linha();
  getDb().prepare("UPDATE mesa_local_config SET tunel_ativo = 0, endereco_publico = NULL WHERE id = 'default'").run();
  parar();
  estado.tentativas = 0;
  estado.ultimoErro = null;
  return { ok: true };
}

/** Religa com a configuração que já está guardada. */
async function religar({ requestingUserId } = {}) {
  const user = getDb().prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !PAPEIS.includes(user.role)) return { ok: false, error: 'Apenas gerente ou administrador religa o túnel.' };
  const r = linha();
  if (!r.tunel_token || !r.tunel_host) return { ok: false, error: 'O túnel ainda não foi configurado.' };
  getDb().prepare("UPDATE mesa_local_config SET tunel_ativo = 1, endereco_publico = ? WHERE id = 'default'").run(`https://${r.tunel_host}`);
  parar();
  estado.tentativas = 0;
  return atualizar({ forcar: true });
}

module.exports = {
  configurarAutomatico, atualizar, parar, desligar, religar, getStatus, nomeDoTunel, anotar, _definirParaTeste,
};
