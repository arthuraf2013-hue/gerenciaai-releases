// Garçom não fecha a mesa: lança e pede o fechamento; gerente/admin/caixa fecham (nov/2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { randomUUID } = require('node:crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

const canais = new Map();
const electronFalso = {
  ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  shell: { openPath: async () => '', openExternal: async () => {} },
  app: { getVersion: () => '0.0.0-teste', getPath: () => require('os').tmpdir() },
  Notification: { isSupported: () => false },
};
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronFalso;
  return loadOriginal.call(this, request, parent, isMain);
};
const { registerIpcHandlers } = require('../electron/ipc/handlers');
const sessionService = require('../electron/services/sessionService');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');
const mesaLocal = require('../electron/services/mesaLocalService');
registerIpcHandlers();
Module._load = loadOriginal;

const chamar = (canal, payload, id) => canais.get(canal)({ sender: { id } }, payload);

function mesaComConta() {
  const ctx = freshTestDb();
  const garcomId = randomUUID();
  ctx.db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Carlos', 'garcom', 'x')`).run(garcomId);
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '9' }).id;
  const suco = createProduct(ctx.db, { nome: 'Suco', preco: 10 });
  addStock(ctx.db, { productId: suco, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const saleId = tableService.openTable({ tableId: mesa, locationId: ctx.locationId, operadorId: garcomId }).saleId;
  assert.equal(saleService.addItem({ saleId, productId: suco, locationId: ctx.locationId, quantidade: 1, operadorId: garcomId, deviceId: 't' }).ok, true);
  return { ...ctx, garcomId, mesa, saleId };
}

test('garçom não recebe, não finaliza, não cancela, não libera e não puxa a conta', async () => {
  const { garcomId, mesa, saleId, db } = mesaComConta();
  sessionService.iniciarSessao(21, { id: garcomId, nome: 'Carlos', role: 'garcom' });
  const tentativas = [
    ['sale:addPayment', { saleId, metodo: 'dinheiro', valor: 10 }],
    ['sale:removePayment', { saleId, paymentId: 'x' }],
    ['sale:marcarPagamentoPessoa', { saleId, paymentId: 'x', pessoaNumero: 1 }],
    ['sale:finalize', { saleId }],
    ['sale:cancel', { saleId, motivo: 'x' }],
    ['table:release', { tableId: mesa }],
    ['mesaCompartilhada:puxar', { tableId: mesa }],
  ];
  for (const [canal, payload] of tentativas) {
    const r = await chamar(canal, payload, 21);
    assert.equal(r.ok, false, canal);
    assert.match(r.error, /Garçom não fecha a mesa/, canal);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(saleId).c, 0);
  assert.equal(db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId).status, 'aberta');
  assert.equal(db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(mesa).status, 'ocupada');
  // Lançar continua liberado para ele.
  const r = await chamar('table:getCart', { saleId }, 21);
  assert.notEqual(r?.ok, false);
});

test('garçom pede o fechamento: a mesa mostra "Pediu a conta · Garçom Carlos"', async () => {
  const { garcomId, mesa, db } = mesaComConta();
  sessionService.iniciarSessao(22, { id: garcomId, nome: 'Carlos', role: 'garcom' });
  const r = await chamar('table:pedirFechamento', { tableId: mesa }, 22);
  assert.equal(r.ok, true, r.error);
  const r2 = await chamar('table:pedirFechamento', { tableId: mesa }, 22);
  assert.equal(r2.ok, true);
  const chamados = db.prepare("SELECT tipo, nome FROM mesa_chamados WHERE table_id = ? AND atendido_em IS NULL").all(mesa);
  assert.deepEqual(chamados, [{ tipo: 'conta', nome: 'Garçom Carlos' }], 'pedir de novo não duplica');
  const mesas = db.prepare('SELECT * FROM restaurant_tables').all();
  assert.deepEqual(mesaLocal.indicadoresDasMesas(db, mesas).get(mesa).chamados.map((c) => [c.tipo, c.nome]), [['conta', 'Garçom Carlos']]);
  const livre = tableService.createTable({ locationId: db.prepare('SELECT id FROM locations LIMIT 1').get().id, numero: '10' }).id;
  const r3 = await chamar('table:pedirFechamento', { tableId: livre }, 22);
  assert.equal(r3.ok, false);
});

test('gerente e caixa continuam fechando a mesa', async () => {
  const { gerenteId, operadorId, saleId } = mesaComConta();
  sessionService.iniciarSessao(23, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  sessionService.iniciarSessao(24, { id: operadorId, nome: 'Op', role: 'operador' });
  for (const id of [23, 24]) {
    const r = await chamar('sale:addPayment', { saleId, metodo: 'dinheiro', valor: 1 }, id);
    assert.doesNotMatch(String(r?.error || ''), /Garçom não fecha/);
  }
});
