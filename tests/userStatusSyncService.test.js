const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const userStatusSyncService = require('../electron/services/userStatusSyncService');

// Só getUsuariosParaConsulta é testável localmente sem rede --
// publicarUsuarios e iniciarPublicacaoContinua dependem de Firestore de
// verdade (mesmo critério de tests/liveStatusSyncService.test.js: a
// primeira é best-effort e engole erro de rede; a segunda mantém um
// setInterval vivo, que travaria `node --test`).

test('getUsuariosParaConsulta traz nome/role/ativo de todo mundo, ordenado por nome', () => {
  const { db } = freshTestDb(); // cria admin, "Gerente Teste", "Operador Teste"

  const usuarios = userStatusSyncService.getUsuariosParaConsulta();
  assert.equal(usuarios.length, 3);

  const nomes = usuarios.map((u) => u.nome);
  assert.deepEqual(nomes, [...nomes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'deveria vir ordenado por nome');

  const gerente = usuarios.find((u) => u.nome === 'Gerente Teste');
  assert.equal(gerente.role, 'gerente');
  assert.equal(gerente.ativo, true);
});

test('getUsuariosParaConsulta NUNCA traz pin_hash, pin_temporario, tentativas_falhas ou bloqueado_ate', () => {
  freshTestDb();
  const usuarios = userStatusSyncService.getUsuariosParaConsulta();
  assert.ok(usuarios.length > 0);
  for (const u of usuarios) {
    assert.deepEqual(Object.keys(u).sort(), ['ativo', 'id', 'nome', 'role']);
  }
});

test('getUsuariosParaConsulta traz usuário desativado também, com ativo=false (a tela remota mostra quem está desativado)', () => {
  const { db, operadorId } = freshTestDb();
  db.prepare('UPDATE users SET ativo = 0 WHERE id = ?').run(operadorId);

  const usuarios = userStatusSyncService.getUsuariosParaConsulta();
  const operador = usuarios.find((u) => u.nome === 'Operador Teste');
  assert.equal(operador.ativo, false);
});
