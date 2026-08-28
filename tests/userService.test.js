const test = require('node:test');
const assert = require('node:assert');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const userService = require('../electron/services/userService');

test('gerente pode criar garcom, mas não admin nem suporte', () => {
  const { gerenteId } = freshTestDb();

  const garcom = userService.create(gerenteId, { nome: 'Garçom 1', role: 'garcom', pin: '1111' });
  assert.equal(garcom.ok, true);

  const admin = userService.create(gerenteId, { nome: 'Tentativa Admin', role: 'admin', pin: '2222' });
  assert.equal(admin.ok, false);

  const suporte = userService.create(gerenteId, { nome: 'Tentativa Suporte', role: 'suporte', pin: '2223' });
  assert.equal(suporte.ok, false);
});

test('admin pode criar suporte, e suporte tem as mesmas permissões de admin pra gerenciar usuários', () => {
  const { adminId } = freshTestDb();

  const criado = userService.create(adminId, { nome: 'Suporte 1', role: 'suporte', pin: '6666' });
  assert.equal(criado.ok, true);
  const suporteId = criado.id;

  // Suporte consegue fazer tudo que admin faz em userService: criar,
  // listar, ativar/desativar e resetar PIN de outros usuários.
  const listagem = userService.listAll(suporteId);
  assert.equal(listagem.ok, true);

  const novoOperador = userService.create(suporteId, { nome: 'Operador via Suporte', role: 'operador', pin: '7777' });
  assert.equal(novoOperador.ok, true);

  const reset = userService.resetPin(suporteId, { userId: novoOperador.id, novoPin: '8888' });
  assert.equal(reset.ok, true);

  const desativar = userService.setActive(suporteId, { userId: novoOperador.id, ativo: false });
  assert.equal(desativar.ok, true);
});

test('gerente não pode desativar nem resetar PIN de um usuário suporte', () => {
  const { db, gerenteId } = freshTestDb();
  const suporteId = createSuporteUser(db);

  const desativar = userService.setActive(gerenteId, { userId: suporteId, ativo: false });
  assert.equal(desativar.ok, false);

  const reset = userService.resetPin(gerenteId, { userId: suporteId, novoPin: '9999' });
  assert.equal(reset.ok, false);
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

test('resetPin grava um evento de auditoria (dá acesso à conta de outra pessoa, precisa ficar rastreável)', () => {
  const { db, adminId } = freshTestDb();
  const alvo = userService.create(adminId, { nome: 'Operador Alvo', role: 'operador', pin: '1234' });

  const reset = userService.resetPin(adminId, { userId: alvo.id, novoPin: '4321' });
  assert.equal(reset.ok, true);

  const evento = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'pin_resetado' AND solicitante_id = ?`).get(adminId);
  assert.ok(evento, 'deveria ter gravado um evento de auditoria');
  assert.match(evento.motivo, /Operador Alvo/);
});
