const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const tableService = require('../electron/services/tableService');

const numeros = (db, loc) => db.prepare('SELECT numero FROM restaurant_tables WHERE location_id = ? ORDER BY CAST(numero AS INTEGER)').all(loc).map((r) => r.numero);

test('cadastra N mesas de uma vez, começando da 1 quando não há nenhuma', () => {
  const { db, locationId } = freshTestDb();
  const r = tableService.createTablesEmLote({ locationId, quantidade: 12 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.criadas, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  assert.deepEqual(r.jaExistiam, []);
  assert.equal(numeros(db, locationId).length, 12);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM restaurant_tables WHERE status = 'livre'`).get().n, 12);
});

test('sem número inicial, continua da maior mesa que já existe', () => {
  const { db, locationId } = freshTestDb();
  tableService.createTablesEmLote({ locationId, quantidade: 10 });
  tableService.createTable({ locationId, numero: 'Varanda' }); // nome não atrapalha a conta
  assert.equal(tableService.proximoNumeroDeMesa(locationId), 11);
  const r = tableService.createTablesEmLote({ locationId, quantidade: 5 });
  assert.deepEqual(r.criadas, ['11', '12', '13', '14', '15']);
  assert.equal(numeros(db, locationId).length, 16);
});

test('número que já existe é pulado, sem duplicar nem parar o resto', () => {
  const { db, locationId } = freshTestDb();
  tableService.createTable({ locationId, numero: '3' });
  tableService.createTable({ locationId, numero: '5' });
  const r = tableService.createTablesEmLote({ locationId, quantidade: 6, inicio: 1 });
  assert.deepEqual(r.criadas, ['1', '2', '4', '6']);
  assert.deepEqual(r.jaExistiam, ['3', '5']);
  assert.deepEqual(numeros(db, locationId), ['1', '2', '3', '4', '5', '6']);
});

test('recusa quantidade e início fora do limite', () => {
  const { db, locationId } = freshTestDb();
  assert.equal(tableService.createTablesEmLote({ locationId, quantidade: 0 }).ok, false);
  assert.equal(tableService.createTablesEmLote({ locationId, quantidade: 201 }).ok, false);
  assert.equal(tableService.createTablesEmLote({ locationId, quantidade: 2.5 }).ok, false);
  assert.equal(tableService.createTablesEmLote({ locationId, quantidade: 5, inicio: 0 }).ok, false);
  assert.equal(tableService.createTablesEmLote({ locationId, quantidade: 5, inicio: 9998 }).ok, false);
  assert.equal(numeros(db, locationId).length, 0);
});
