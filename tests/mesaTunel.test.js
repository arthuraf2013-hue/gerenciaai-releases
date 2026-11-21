const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { freshTestDb } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem Firebase neste teste'); };

const mesaLocal = require('../electron/services/mesaLocalService');
const tableService = require('../electron/services/tableService');
const vitrine = require('../electron/services/vitrineService');

// QR da mesa pela internet SEM Firebase: Cloudflare Tunnel no próprio servidor
// leva https://mesa.dominio até o servidor das mesas deste computador.

function pedirSaude(porta) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: porta, path: '/api/saude' }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(partes).toString('utf8')) }));
    }).on('error', reject);
  });
}

function lojaComMesa() {
  const ctx = freshTestDb();
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '7' });
  const tableId = mesa.id || ctx.db.prepare("SELECT id FROM restaurant_tables WHERE numero = '7'").get().id;
  ctx.db.prepare("UPDATE restaurant_tables SET qr_token = 'ZyXwVuTsRqPoNmLkJiHgFe98' WHERE id = ?").run(tableId);
  return { ...ctx, tableId, token: 'ZyXwVuTsRqPoNmLkJiHgFe98' };
}

test('endereço pela internet: aceita só https://nome.dominio; completa o https e tira a barra', () => {
  const v = mesaLocal.enderecoPublicoValido;
  assert.equal(v(''), '');
  assert.equal(v('mesa.barcharque.com.br'), 'https://mesa.barcharque.com.br');
  assert.equal(v('HTTPS://Mesa.BarCharque.com.br/'), 'https://mesa.barcharque.com.br');
  assert.equal(v('http://mesa.barcharque.com.br'), null, 'sem https não');
  assert.equal(v('https://mesa.barcharque.com.br/m/abc'), null, 'sem caminho');
  assert.equal(v('https://192.168.0.10'), null, 'IP não é endereço do túnel');
  assert.equal(v('https://mesa.barcharque.com.br:8443'), null, 'sem porta');
  assert.equal(v('https://<script>.com'), null);
});

test('com o endereço pela internet, o QR da mesa usa ele (um QR só, sem Firebase); sem ele, volta à rede da loja', () => {
  const ctx = lojaComMesa();
  const salvar = (extra) => mesaLocal.saveConfig({ ativo: true, enderecoFixo: '192.168.0.10', requestingUserId: ctx.adminId, ...extra });
  assert.equal(salvar({ enderecoPublico: 'mesa.barcharque.com.br' }).ok, true);
  const c = mesaLocal.getConfig();
  assert.equal(c.pelaInternet, true);
  assert.equal(c.endereco, 'https://mesa.barcharque.com.br');
  assert.equal(c.enderecoLocal, 'http://192.168.0.10:47830');
  assert.equal(mesaLocal.linkDaMesa(ctx.token), `https://mesa.barcharque.com.br/m/${ctx.token}`);

  assert.equal(salvar({ enderecoPublico: 'http://inseguro.com' }).ok, false);
  assert.equal(mesaLocal.getConfig().enderecoPublico, 'https://mesa.barcharque.com.br', 'inválido não apaga o que estava');
  assert.equal(salvar({}).ok, true, 'tela antiga sem o campo');
  assert.equal(mesaLocal.getConfig().enderecoPublico, 'https://mesa.barcharque.com.br', 'mantém');

  assert.equal(salvar({ enderecoPublico: '' }).ok, true);
  assert.equal(mesaLocal.getConfig().pelaInternet, false);
  assert.equal(mesaLocal.linkDaMesa(ctx.token), `http://192.168.0.10:47830/m/${ctx.token}`);
  mesaLocal.parar();
});

test('QR das mesas com o túnel: um QR só, mesmo com a vitrine do Firebase ligada', async () => {
  const ctx = lojaComMesa();
  vitrine.getConfig();
  ctx.db.prepare("UPDATE vitrine_config SET slug = 'bar-teste', ativa = 1, pedidos_online = 1 WHERE id = 'default'").run();
  mesaLocal.saveConfig({ ativo: true, enderecoFixo: '192.168.0.10', enderecoPublico: 'mesa.barcharque.com.br', requestingUserId: ctx.adminId });
  const r = await vitrine.qrDasMesas();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.duplo, false);
  assert.equal(r.mesas[0].link, `https://mesa.barcharque.com.br/m/${ctx.token}`);
  assert.equal(r.mesas[0].linkInternet, null);
  const uma = await vitrine.qrDaMesa(ctx.tableId);
  assert.equal(uma.url, `https://mesa.barcharque.com.br/m/${ctx.token}`);
  assert.equal(uma.urlInternet, null);
  mesaLocal.parar();
});

test('IP do cliente pelo túnel: CF-Connecting-IP só vale vindo do próprio computador', () => {
  const req = (remoto, cf) => ({ socket: { remoteAddress: remoto }, headers: cf ? { 'cf-connecting-ip': cf } : {} });
  assert.equal(mesaLocal.ipDoCliente(req('127.0.0.1', '177.10.20.30')), '177.10.20.30', 'cloudflared local');
  assert.equal(mesaLocal.ipDoCliente(req('::1', '2804:14c::1')), '2804:14c::1');
  assert.equal(mesaLocal.ipDoCliente(req('::ffff:127.0.0.1', '177.10.20.30')), '177.10.20.30');
  assert.equal(mesaLocal.ipDoCliente(req('192.168.0.55', '1.2.3.4')), '192.168.0.55', 'celular na rede da loja não escolhe o próprio IP');
  assert.equal(mesaLocal.ipDoCliente(req('127.0.0.1', 'x; DROP')), '127.0.0.1', 'cabeçalho estranho é ignorado');
  assert.equal(mesaLocal.ipDoCliente(req('127.0.0.1')), '127.0.0.1');
});

test('testar endereço: confere que o túnel chega NESTE computador', async (t) => {
  const ctx = lojaComMesa();
  mesaLocal.saveConfig({ ativo: true, enderecoPublico: 'mesa.barcharque.com.br', requestingUserId: ctx.adminId });
  const r = await mesaLocal.iniciar(0);
  assert.equal(r.ok, true, r.error);
  t.after(() => { mesaLocal.parar(); mesaLocal._definirFetchParaTeste(null); });

  // O "túnel" falso repassa para o servidor de verdade (127.0.0.1:porta).
  const saude = await pedirSaude(r.porta);
  assert.equal(saude.status, 200);
  const chamadas = [];
  mesaLocal._definirFetchParaTeste(async (url) => {
    chamadas.push(url);
    return { ok: true, status: 200, json: async () => saude.json };
  });
  const ok = await mesaLocal.testarEnderecoPublico();
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(chamadas, ['https://mesa.barcharque.com.br/api/saude']);

  mesaLocal._definirFetchParaTeste(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: 'outro-pc' }) }));
  assert.match((await mesaLocal.testarEnderecoPublico()).error, /OUTRO computador/);

  mesaLocal._definirFetchParaTeste(async () => ({ ok: false, status: 530, json: async () => { throw new Error('html'); } }));
  assert.match((await mesaLocal.testarEnderecoPublico()).error, /erro 530/);

  mesaLocal._definirFetchParaTeste(async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; });
  assert.match((await mesaLocal.testarEnderecoPublico()).error, /10 segundos/);

  assert.match((await mesaLocal.testarEnderecoPublico({ endereco: '' })).error, /Preencha/);
});
