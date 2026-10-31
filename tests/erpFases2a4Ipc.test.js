const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freshTestDb, createProduct } = require('./helpers/testDb');

// ERP, Fases 2 a 4 pelo IPC: papel exigido, módulo pago e caminho de arquivo
// nascendo no diálogo do processo principal (nunca no payload).
const canais = new Map();
let destinoDoDialogo = null;
const pastasMostradas = [];
const electronFalso = {
  ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => (destinoDoDialogo ? { canceled: false, filePath: destinoDoDialogo } : { canceled: true }),
  },
  BrowserWindow: { getFocusedWindow: () => null },
  shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: (p) => pastasMostradas.push(p) },
  app: { getVersion: () => '0.0.0-teste', getPath: () => os.tmpdir() },
};
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronFalso;
  return loadOriginal.call(this, request, parent, isMain);
};
const { registerIpcHandlers } = require('../electron/ipc/handlers');
const sessionService = require('../electron/services/sessionService');
registerIpcHandlers();
// Fica trocado durante o arquivo todo: o handler do pacote faz require('electron') na hora.
test.after(() => { Module._load = loadOriginal; });

const chamar = (canal, payload, id) => canais.get(canal)({ sender: { id } }, payload);

const CANAIS_FINANCEIRO = ['financeiro:getTaxas', 'financeiro:contasAReceber', 'financeiro:listarRecorrencias', 'financeiro:fluxoDeCaixa', 'financeiro:dre'];
const CANAIS_ESTOQUE = ['inventario:listar', 'inventario:abrir', 'inventario:kardex'];
const CANAIS_FISCAL = ['assistenteFiscal:painel', 'assistenteFiscal:diagnostico', 'assistenteFiscal:relatorioMei', 'assistenteFiscal:gerarPacoteContador'];

test('operador não abre financeiro, inventário, assistente fiscal nem a configuração do ERP', async () => {
  const { operadorId } = freshTestDb();
  sessionService.iniciarSessao(21, { id: operadorId, nome: 'Op', role: 'operador' });
  for (const canal of ['erp:getConfig', 'erp:salvarConfig', 'financeiro:pagarDespesaNaData', ...CANAIS_FINANCEIRO, ...CANAIS_ESTOQUE, ...CANAIS_FISCAL, 'assistenteFiscal:aplicarSugestoes']) {
    assert.ok(canais.has(canal), `canal ${canal} não registrado`);
    const r = await chamar(canal, {}, 21);
    assert.equal(r.ok, false, canal);
    assert.match(r.error, /permissão/, canal);
  }
});

test('módulo confirmado desligado recusa só as telas dele; a configuração e o pagamento em data continuam', async () => {
  const { db, gerenteId, locationId } = freshTestDb();
  sessionService.iniciarSessao(22, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  db.prepare(`INSERT INTO modulos_pagos_state (id, cliente_id, erp_compras, erp_financeiro, erp_estoque, erp_fiscal, ja_sincronizado)
              VALUES ('default', 'c1', 1, 0, 0, 0, 1)`).run();
  const st = await chamar('erp:status', undefined, 22);
  assert.deepEqual({ compras: st.compras, financeiro: st.financeiro, estoque: st.estoque, fiscal: st.fiscal },
    { compras: true, financeiro: false, estoque: false, fiscal: false });
  for (const canal of [...CANAIS_FINANCEIRO, ...CANAIS_ESTOQUE, ...CANAIS_FISCAL]) {
    const r = await chamar(canal, { locationId }, 22);
    assert.equal(r.ok, false, canal);
    assert.equal(r.moduloInativo, true, canal);
  }
  const cfg = await chamar('erp:getConfig', undefined, 22);
  assert.equal(cfg.dia_pacote_contador, 5);

  db.prepare(`UPDATE modulos_pagos_state SET erp_financeiro = 1, erp_estoque = 1, erp_fiscal = 1`).run();
  assert.equal((await chamar('financeiro:fluxoDeCaixa', { locationId, dataInicio: '2026-10-01', dataFim: '2026-10-31' }, 22)).ok, true);
  assert.equal((await chamar('assistenteFiscal:painel', { locationId }, 22)).ok, true);
  assert.ok(Array.isArray(await chamar('inventario:listar', { locationId }, 22)));
});

test('instalação que nunca sincronizou com a Central não perde as telas novas', async () => {
  const { gerenteId, locationId } = freshTestDb();
  sessionService.iniciarSessao(23, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const st = await chamar('erp:status', undefined, 23);
  assert.equal(st.financeiro && st.estoque && st.fiscal, true);
  assert.equal((await chamar('financeiro:dre', { locationId, competencias: ['2026-10'] }, 23)).ok, true);
});

test('inventário pelo IPC: o operador gravado é o da sessão, não o do payload', async () => {
  const { db, gerenteId, operadorId, locationId } = freshTestDb();
  sessionService.iniciarSessao(24, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  createProduct(db);
  const r = await chamar('inventario:abrir', { locationId, operadorId, cega: false }, 24);
  assert.equal(r.ok, true, r.error);
  assert.equal(db.prepare('SELECT aberta_por_id FROM inventory_counts WHERE id = ?').get(r.id).aberta_por_id, gerenteId);
});

test('pacote do contador: grava só no caminho escolhido no diálogo; cancelar não grava nada', async () => {
  const { gerenteId, locationId } = freshTestDb();
  sessionService.iniciarSessao(25, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  destinoDoDialogo = null;
  const cancelado = await chamar('assistenteFiscal:gerarPacoteContador', { locationId, competencia: '2026-09', filePath: '/tmp/x.zip' }, 25);
  assert.equal(cancelado.canceled, true);
  assert.equal(fs.existsSync('/tmp/x.zip'), false);

  destinoDoDialogo = path.join(os.tmpdir(), `pacote-teste-${process.pid}.zip`);
  try {
    const r = await chamar('assistenteFiscal:gerarPacoteContador', { locationId, competencia: '2026-09' }, 25);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.arquivo, path.basename(destinoDoDialogo));
    const zip = fs.readFileSync(destinoDoDialogo);
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    assert.deepEqual(pastasMostradas.slice(-1), [destinoDoDialogo]);
  } finally {
    fs.rmSync(destinoDoDialogo, { force: true });
    destinoDoDialogo = null;
  }
});
