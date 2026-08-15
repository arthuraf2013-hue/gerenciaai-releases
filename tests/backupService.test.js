const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const backupService = require('../electron/services/backupService');

// Restaurar backup substitui TODOS os dados atuais sem volta — a tela que
// expõe esse botão só aparece pra admin (aba Configurações), então o
// backend precisa recusar qualquer outro papel, mesmo se alguém chamar o
// canal IPC diretamente sem passar pela tela.

test('restoreBackup recusa quem não é admin, antes mesmo de checar se o arquivo existe', () => {
  const { gerenteId } = freshTestDb();
  const result = backupService.restoreBackup(gerenteId, 'nao-importa.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('restoreBackup recusa operador', () => {
  const { operadorId } = freshTestDb();
  const result = backupService.restoreBackup(operadorId, 'nao-importa.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('restoreBackup passa da checagem de permissão pra admin (e só falha depois por arquivo inexistente, não por permissão)', () => {
  const { adminId } = freshTestDb();
  const result = backupService.restoreBackup(adminId, 'arquivo-que-nao-existe-de-verdade.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /não encontrado/i);
});
