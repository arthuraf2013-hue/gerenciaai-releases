const test = require('node:test');
const assert = require('node:assert');
const { freshTestDb } = require('./helpers/testDb');
const userService = require('../electron/services/userService');

test('gerente pode criar garcom, mas não admin', () => {
  const { gerenteId } = freshTestDb();

  const garcom = userService.create(gerenteId, { nome: 'Garçom 1', role: 'garcom', pin: '1111' });
  assert.equal(garcom.ok, true);

  const admin = userService.create(gerenteId, { nome: 'Tentativa Admin', role: 'admin', pin: '2222' });
  assert.equal(admin.ok, false);
});

test('admin pode criar garcom', () => {
  const { adminId } = freshTestDb();
  const result = userService.create(adminId, { nome: 'Garçom 2', role: 'garcom', pin: '3333' });
  assert.equal(result.ok, true);

  const db = require('../electron/db/database').getDb();
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(result.id);
  assert.equal(row.role, 'garcom');
});

test('operador não pode criar usuário nenhum, nem garcom', () => {
  const { operadorId } = freshTestDb();
  const result = userService.create(operadorId, { nome: 'Garçom 3', role: 'garcom', pin: '4444' });
  assert.equal(result.ok, false);
});

test('papel inválido é rejeitado', () => {
  const { adminId } = freshTestDb();
  const result = userService.create(adminId, { nome: 'X', role: 'super-admin', pin: '5555' });
  assert.equal(result.ok, false);
});
