const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');

// Mesmo truque de tests/ipcPoliticaAcesso.test.js: ipcMain falso, para
// chamar os canais como o renderer chamaria, pela MESMA política de acesso.
const canais = new Map();
const electronFalso = {
  ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getFocusedWindow: () => null },
  shell: { openPath: async () => '', openExternal: async () => {} },
  app: { getVersion: () => '0.0.0-teste', getPath: () => require('os').tmpdir(), relaunch: () => {}, exit: () => {} },
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

const chamar = (canal, payload, id) => canais.get(canal)({ sender: { id } }, payload);
const CANAIS_DEMO = ['demo:estado', 'demo:carregar', 'demo:trocarPerfil', 'demo:limpar'];

test('demonstração: admin, gerente e operador são recusados em todos os canais, mesmo chamando direto', async () => {
  const { adminId, gerenteId, operadorId } = freshTestDb();
  const usuarios = [[10, adminId, 'admin'], [11, gerenteId, 'gerente'], [12, operadorId, 'operador']];
  for (const [janela, id, role] of usuarios) {
    sessionService.iniciarSessao(janela, { id, nome: role, role });
    for (const canal of CANAIS_DEMO) {
      const r = await chamar(canal, { perfil: 'armazem' }, janela);
      assert.equal(r.ok, false, `${role} não pode chamar ${canal}`);
      assert.match(r.error, /permissão/);
    }
  }
});

test('demonstração: sem login, recusado', async () => {
  freshTestDb();
  sessionService.encerrarSessao(13);
  const r = await chamar('demo:estado', undefined, 13);
  assert.equal(r.semSessao, true);
});

test('demonstração: o suporte consulta o estado (lista os 11 perfis)', async () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  sessionService.iniciarSessao(14, { id: suporteId, nome: 'Suporte', role: 'suporte' });
  const r = await chamar('demo:estado', undefined, 14);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.ativa, false);
  assert.equal(r.perfis.length, 11);
});
