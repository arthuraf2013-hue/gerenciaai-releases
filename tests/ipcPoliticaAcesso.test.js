const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { freshTestDb } = require('./helpers/testDb');

// Fora do Electron, require('electron') devolve só uma string. Aqui o
// ipcMain é trocado por um registro em memória pra chamar os canais como o
// renderer chamaria -- passando pela MESMA política de acesso do app.
const canais = new Map();
const electronFalso = {
  ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getFocusedWindow: () => null },
  shell: { openPath: async () => '', openExternal: async () => {} },
  app: { getVersion: () => '0.0.0-teste', getPath: () => require('os').tmpdir() },
};
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronFalso;
  return loadOriginal.call(this, request, parent, isMain);
};
const { registerIpcHandlers } = require('../electron/ipc/handlers');
const sessionService = require('../electron/services/sessionService');
registerIpcHandlers();
Module._load = loadOriginal;

const evento = (id) => ({ sender: { id } });
const chamar = (canal, payload, id = 1) => canais.get(canal)(evento(id), payload);

test('sem ninguém logado: canal comum é recusado, canal de login/licença/atualização funciona', async () => {
  freshTestDb();
  sessionService.encerrarSessao(1);
  const r = await chamar('product:list', {});
  assert.equal(r.ok, false);
  assert.equal(r.semSessao, true);
  const usuarios = await chamar('auth:listActiveUsers', {});
  assert.ok(Array.isArray(usuarios) || usuarios?.ok !== false);
  const status = await chamar('license:getStatus');
  assert.notEqual(status?.semSessao, true);
});

test('operador logado usa o PDV, mas não muda chave Pix, perfil, nem importa produtos', async () => {
  const { operadorId } = freshTestDb();
  sessionService.iniciarSessao(2, { id: operadorId, nome: 'Op', role: 'operador' });
  const lista = await chamar('product:list', {}, 2);
  assert.notEqual(lista?.semSessao, true);
  for (const canal of ['payment:updateConfig', 'profile:delete', 'io:importProducts', 'dashboard:getSummary', 'backup:runNow']) {
    const r = await chamar(canal, { pixChave: 'golpe@x.com', id: 'x' }, 2);
    assert.equal(r.ok, false, canal);
    assert.match(r.error, /permissão/, canal);
  }
});

test('gerente troca a chave Pix e isso fica na Auditoria com antes e depois', async () => {
  const { db, gerenteId } = freshTestDb();
  sessionService.iniciarSessao(3, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const r = await chamar('payment:updateConfig', { pixChave: 'nova@loja.com', pixNomeRecebedor: 'LOJA' }, 3);
  assert.equal(r.ok, true);
  const ev = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'chave_pix_alterada'`).get();
  assert.ok(ev);
  assert.equal(ev.solicitante_id, gerenteId);
  assert.match(ev.motivo, /nova@loja\.com/);
});

test('operador vem sempre da sessão: um operadorId falso no payload é trocado pelo logado', async () => {
  const { db, locationId, operadorId, gerenteId } = freshTestDb();
  sessionService.iniciarSessao(4, { id: operadorId, nome: 'Op', role: 'operador' });
  const r = await chamar('cash:open', { locationId, operadorId: gerenteId, valorAbertura: 50 }, 4);
  assert.equal(r.ok, true);
  const sessao = db.prepare('SELECT operador_abertura_id AS operador_id FROM cash_sessions ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(sessao.operador_id, operadorId);
});

test('as listas da política só citam canais que existem (pega erro de digitação)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../electron/ipc/handlers.js'), 'utf-8');
  const bloco = (nome) => src.slice(src.indexOf(nome), src.indexOf(';', src.indexOf(nome)));
  const citados = [...bloco('const CANAIS_PUBLICOS').matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g), ...bloco('const PAPEL_POR_CANAL').matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(citados.length > 50);
  for (const c of citados) assert.ok(canais.has(c), `canal inexistente na política: ${c}`);
});
