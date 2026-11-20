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

test('mesas 1 e 2 excluídas: o próximo número volta a ser 1, não o fim da lista', () => {
  const { db, locationId } = freshTestDb();
  tableService.createTablesEmLote({ locationId, quantidade: 22 });
  for (const n of ['1', '2']) {
    const t = db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(locationId, n);
    assert.equal(tableService.deleteTable(t.id).ok, true);
  }
  assert.equal(tableService.proximoNumeroDeMesa(locationId), 1);
  assert.deepEqual(tableService.proximaFaixaLivre(locationId), { numero: 1, buracos: 2 });
  const r = tableService.createTablesEmLote({ locationId, quantidade: 2 });
  assert.deepEqual(r.criadas, ['1', '2']);
  assert.deepEqual(tableService.proximaFaixaLivre(locationId), { numero: 23, buracos: 0 });
});

test('organizar: grava a ordem escolhida, mesa nova vai para o fim e dá para voltar à ordem por número', () => {
  const { db, locationId } = freshTestDb();
  tableService.createTablesEmLote({ locationId, quantidade: 4 });
  const idDe = (n) => db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(locationId, n).id;
  const lista = () => tableService.listTables(locationId).map((t) => t.numero);
  assert.deepEqual(lista(), ['1', '2', '3', '4']);

  assert.equal(tableService.reorderTables({ locationId, ids: [idDe('3'), idDe('1'), idDe('4'), idDe('2')] }).ok, true);
  assert.deepEqual(lista(), ['3', '1', '4', '2']);

  tableService.createTable({ locationId, numero: '5' });
  assert.deepEqual(lista(), ['3', '1', '4', '2', '5']);

  // id de outro local/inexistente é ignorado; mesa que ficou fora da lista não some
  assert.equal(tableService.reorderTables({ locationId, ids: [idDe('2'), 'nao-existe'] }).ok, true);
  assert.deepEqual(lista(), ['2', '3', '1', '4', '5']);

  assert.equal(tableService.reorderTables({ locationId, ids: 'x' }).ok, false);
  assert.equal(tableService.reorderTables({ locationId, ids: [] }).ok, true);
  assert.deepEqual(lista(), ['1', '2', '3', '4', '5']);
});
