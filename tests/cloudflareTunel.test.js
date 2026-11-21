const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { freshTestDb } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem Firebase neste teste'); };
const mesaLocal = require('../electron/services/mesaLocalService');
const tunel = require('../electron/services/cloudflareTunelService');

// Túnel da Cloudflare montado sozinho (API falsa, cloudflared falso).

mesaLocal.atualizar = async () => ({ ok: true }); // não abre porta de verdade no teste

function cloudflareFalsa({ tunelExistente = null, dns = null, recusar = false } = {}) {
  const chamadas = [];
  const fetch = async (url, opcoes = {}) => {
    const caminho = url.replace('https://api.cloudflare.com/client/v4', '');
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ metodo: opcoes.method, caminho, corpo, auth: opcoes.headers?.Authorization });
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, errors: [], result }) });
    if (recusar) return { ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: 'Authentication error' }] }) };
    if (caminho.startsWith('/zones?name=')) return ok(caminho.includes('barcharque.com.br') ? [{ id: 'zona1', account: { id: 'conta1' } }] : []);
    if (caminho.startsWith('/accounts/conta1/cfd_tunnel?name=')) return ok(tunelExistente ? [{ id: tunelExistente }] : []);
    if (caminho === '/accounts/conta1/cfd_tunnel' && opcoes.method === 'POST') return ok({ id: 'tunel-novo', token: 'eyJtokenDoTunelNovo1234567890abcdef' });
    if (/^\/accounts\/conta1\/cfd_tunnel\/[^/]+\/token$/.test(caminho)) return ok('eyJtokenDoTunelVelho1234567890abcdef');
    if (/\/configurations$/.test(caminho)) return ok({});
    if (caminho.startsWith('/zones/zona1/dns_records?name=')) return ok(dns ? [dns] : []);
    if (caminho.startsWith('/zones/zona1/dns_records')) return ok({ id: 'dns1' });
    return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ message: 'rota falsa sem resposta' }] }) };
  };
  return { fetch, chamadas };
}

function processoFalso() {
  const lancados = [];
  const spawn = (exe, args, opcoes) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.pid = 1000 + lancados.length;
    p.morto = false;
    p.kill = () => { p.morto = true; };
    lancados.push({ exe, args, opcoes, p });
    return p;
  };
  return { spawn, lancados };
}

function preparar(opcoes) {
  const ctx = freshTestDb();
  const cf = cloudflareFalsa(opcoes);
  const pr = processoFalso();
  tunel.parar();
  tunel._definirParaTeste({ fetch: cf.fetch, spawn: pr.spawn, garantirBinario: async () => 'C:/fake/cloudflared.exe', pasta: '/tmp' });
  return { ctx, cf, pr };
}

test.afterEach(() => { tunel.parar(); tunel._definirParaTeste({}); });

test('configura tudo sozinho: túnel, endereço, DNS e liga o cloudflared com o token pelo ambiente', async () => {
  const { ctx, cf, pr } = preparar();
  const r = await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'https://www.BarCharque.com.br/', nome: 'mesa', requestingUserId: ctx.adminId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.endereco, 'https://mesa.barcharque.com.br');

  const criar = cf.chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/accounts/conta1/cfd_tunnel');
  assert.equal(criar.corpo.config_src, 'cloudflare');
  assert.match(criar.corpo.name, /^gerenciaai-mesas-/);
  const cfg = cf.chamadas.find((c) => /configurations$/.test(c.caminho));
  assert.deepEqual(cfg.corpo.config.ingress[0], { hostname: 'mesa.barcharque.com.br', service: 'http://localhost:47830', originRequest: {} });
  assert.deepEqual(cfg.corpo.config.ingress[1], { service: 'http_status:404' }, 'o resto dá 404');
  const dns = cf.chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/zones/zona1/dns_records');
  assert.deepEqual(dns.corpo, { type: 'CNAME', proxied: true, name: 'mesa.barcharque.com.br', content: 'tunel-novo.cfargotunnel.com' });
  assert.ok(cf.chamadas.every((c) => c.auth === 'Bearer TOKENDAAPI_0123456789abcdef'));

  const linha = ctx.db.prepare("SELECT * FROM mesa_local_config WHERE id = 'default'").get();
  assert.equal(linha.ativo, 1);
  assert.equal(linha.tunel_ativo, 1);
  assert.equal(linha.tunel_id, 'tunel-novo');
  assert.equal(linha.endereco_publico, 'https://mesa.barcharque.com.br');
  assert.ok(!JSON.stringify(linha).includes('TOKENDAAPI'), 'o token da API não fica guardado');
  assert.equal(mesaLocal.getConfig().endereco, 'https://mesa.barcharque.com.br', 'o QR passa a usar o túnel');

  assert.equal(pr.lancados.length, 1);
  assert.deepEqual(pr.lancados[0].args, ['tunnel', '--no-autoupdate', 'run']);
  assert.equal(pr.lancados[0].opcoes.env.TUNNEL_TOKEN, 'eyJtokenDoTunelNovo1234567890abcdef');
  assert.ok(!pr.lancados[0].args.join(' ').includes('eyJ'), 'token fora da linha de comando');
  assert.equal(pr.lancados[0].opcoes.windowsHide, true);

  // Conectou: o status mostra; o token não aparece no log da tela.
  pr.lancados[0].p.stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0 token=eyJtokenDoTunelNovo1234567890abcdef\n'));
  const st = tunel.getStatus();
  assert.equal(st.conectado, true);
  assert.equal(st.host, 'mesa.barcharque.com.br');
  assert.ok(!st.log.join(' ').includes('eyJtoken'));
});

test('reaproveita o túnel desta máquina e acerta o DNS antigo de túnel; pega o token pelo endpoint', async () => {
  const { ctx, cf, pr } = preparar({ tunelExistente: 'tunel-velho', dns: { id: 'd9', type: 'CNAME', content: 'outro-tunel.cfargotunnel.com', proxied: true } });
  const r = await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br', requestingUserId: ctx.adminId });
  assert.equal(r.ok, true, r.error);
  assert.equal(cf.chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/accounts/conta1/cfd_tunnel'), false, 'não cria outro túnel');
  const upd = cf.chamadas.find((c) => c.metodo === 'PUT' && c.caminho === '/zones/zona1/dns_records/d9');
  assert.equal(upd.corpo.content, 'tunel-velho.cfargotunnel.com');
  assert.equal(pr.lancados[0].opcoes.env.TUNNEL_TOKEN, 'eyJtokenDoTunelVelho1234567890abcdef');
});

test('não estraga registro DNS que já existe e não é de túnel; nada fica salvo', async () => {
  const { ctx, cf, pr } = preparar({ dns: { id: 'd1', type: 'A', content: '200.1.2.3', proxied: false } });
  const r = await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br', requestingUserId: ctx.adminId });
  assert.equal(r.ok, false);
  assert.match(r.error, /não é de túnel/);
  assert.equal(cf.chamadas.some((c) => c.caminho.startsWith('/zones/zona1/dns_records/') || (c.metodo === 'POST' && c.caminho.startsWith('/zones/zona1/dns_records'))), false);
  assert.equal(ctx.db.prepare("SELECT tunel_ativo FROM mesa_local_config WHERE id = 'default'").get().tunel_ativo, 0);
  assert.equal(pr.lancados.length, 0);
});

test('token sem permissão, domínio de fora e dados inválidos: mensagem clara', async () => {
  let { ctx } = preparar({ recusar: true });
  let r = await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br', requestingUserId: ctx.adminId });
  assert.match(r.error, /Cloudflare Tunnel > Editar/);

  ({ ctx } = preparar());
  r = await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'outrodominio.com', requestingUserId: ctx.adminId });
  assert.match(r.error, /não está nesta conta/);
  assert.match((await tunel.configurarAutomatico({ apiToken: 'curto', dominio: 'barcharque.com.br', requestingUserId: ctx.adminId })).error, /Cole o token/);
  assert.match((await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'x', requestingUserId: ctx.adminId })).error, /Domínio inválido/);
  assert.match((await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br', nome: 'a b', requestingUserId: ctx.adminId })).error, /Nome inválido/);
  assert.match((await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br' })).error, /gerente ou administrador/);
});

test('cloudflared caiu: religa sozinho; desligar para de vez e o QR volta para a rede da loja', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx, pr } = preparar();
  assert.equal((await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br', requestingUserId: ctx.adminId })).ok, true);
  assert.equal(pr.lancados.length, 1);
  pr.lancados[0].p.emit('exit', 1);
  assert.equal(tunel.getStatus().rodando, false);
  assert.match(tunel.getStatus().ultimoErro, /Religando/);
  t.mock.timers.tick(6000);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(pr.lancados.length, 2, 'religou');

  assert.equal(tunel.desligar({ requestingUserId: ctx.adminId }).ok, true);
  assert.equal(pr.lancados[1].p.morto, true);
  assert.equal(mesaLocal.getConfig().pelaInternet, false);
  pr.lancados[1].p.emit('exit', 0); // saída depois de desligar não religa
  t.mock.timers.tick(600000);
  await new Promise((r) => setImmediate(r));
  assert.equal(pr.lancados.length, 2);

  const r = await tunel.religar({ requestingUserId: ctx.adminId });
  assert.equal(r.ok, true, r.error);
  assert.equal(pr.lancados.length, 3);
  assert.equal(mesaLocal.getConfig().endereco, 'https://mesa.barcharque.com.br');
});

test('caixa que não é o servidor do grupo não liga o túnel', async () => {
  const { ctx, pr } = preparar();
  const sync = require('../electron/services/syncStateService');
  const antes = { g: sync.getGrupoSincronizacaoId, s: sync.ehServidorDoGrupo };
  sync.getGrupoSincronizacaoId = () => 'grupo-1';
  sync.ehServidorDoGrupo = () => false;
  try {
    const r = await tunel.configurarAutomatico({ apiToken: 'TOKENDAAPI_0123456789abcdef', dominio: 'barcharque.com.br', requestingUserId: ctx.adminId });
    assert.equal(r.ok, false);
    assert.match(r.error, /SERVIDOR/);
    assert.equal(pr.lancados.length, 0);
  } finally {
    sync.getGrupoSincronizacaoId = antes.g;
    sync.ehServidorDoGrupo = antes.s;
  }
});
