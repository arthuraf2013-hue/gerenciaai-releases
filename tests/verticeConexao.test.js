const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Conexão do caixa com o Vértice guardada fora da janela (verticeConexaoService.js) e a
// decisão de restaurar (verticeSync.precisaRestaurar). Motivo: o GerenciaAI voltava a pedir
// código quando o armazenamento da janela era outro (instalado x código-fonte) ou sumia.
process.env.GERENCIAAI_VERTICE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gerenciaai-vertice-'));
const svc = require('../electron/services/verticeConexaoService');
const sync = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'integrations', 'vertice', 'verticeSync.js')).href);

const UID = 'AbC123xyz789UidAnonimo';
const sessao = JSON.stringify({ uid: UID, isAnonymous: true, stsTokenManager: { refreshToken: 'rt-1', accessToken: 'at', expirationTime: 1 } });
const conexao = { uid: UID, sessao, dispositivo: { companyId: 'empresa123', unitId: null }, empresa: 'Padaria', motivo: 'pareado' };

test('Vértice: guarda e devolve a conexão do caixa', () => {
  assert.deepEqual(svc.ler(), { ok: true, conexao: null });
  assert.deepEqual(svc.gravar(conexao), { ok: true });
  assert.deepEqual(svc.ler(), { ok: true, conexao: { uid: UID, sessao, dispositivo: { companyId: 'empresa123', unitId: null }, empresa: 'Padaria' } });
});

test('Vértice: recusa conexão estranha (login de outro uid, sem token, pareamento inválido)', () => {
  assert.equal(svc.gravar({ ...conexao, uid: 'x' }).ok, false);
  assert.equal(svc.gravar({ ...conexao, sessao: JSON.stringify({ uid: 'outro123456', stsTokenManager: { refreshToken: 'r' } }) }).ok, false);
  assert.equal(svc.gravar({ ...conexao, sessao: JSON.stringify({ uid: UID }) }).ok, false);
  assert.equal(svc.gravar({ ...conexao, sessao: '{quebrado' }).ok, false);
  assert.equal(svc.gravar({ ...conexao, dispositivo: { companyId: '../../x' } }).ok, false);
  assert.equal(svc.gravar(null).ok, false);
  // Recusar não apaga o que estava salvo.
  assert.equal(svc.ler().conexao.uid, UID);
});

test('Vértice: histórico guarda só os últimos 20 eventos e nunca o token', () => {
  for (let i = 0; i < 25; i++) svc.gravar({ ...conexao, motivo: `m${i}` });
  const arquivo = JSON.parse(fs.readFileSync(svc.caminho(), 'utf-8'));
  assert.equal(arquivo.historico.length, 20);
  assert.equal(arquivo.historico.at(-1).motivo, 'm24');
  assert.ok(!JSON.stringify(arquivo.historico).includes('rt-1'));
});

test('Vértice: restaura só quando esta janela não tem o pareamento daquele login', async () => {
  const { precisaRestaurar } = await sync();
  const salva = { uid: UID, sessao };
  assert.equal(precisaRestaurar(null, salva), true, 'janela sem nada (armazenamento apagado ou outra origem)');
  assert.equal(precisaRestaurar({ companyId: 'empresa123', unitId: null }, salva), true, 'pareamento antigo, sem uid');
  assert.equal(precisaRestaurar({ companyId: 'empresa123', uid: 'outroLogin123' }, salva), true, 'outro login nesta janela');
  assert.equal(precisaRestaurar({ companyId: 'empresa123', uid: UID }, salva), false, 'já é o mesmo');
  assert.equal(precisaRestaurar(null, null), false);
  assert.equal(precisaRestaurar(null, { uid: UID, sessao: '{x' }), false);
  assert.equal(precisaRestaurar(null, { uid: UID, sessao: JSON.stringify({ uid: 'outro', stsTokenManager: { refreshToken: 'r' } }) }), false);
});
