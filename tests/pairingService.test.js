const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const pairingService = require('../electron/services/pairingService');

// Só a parte de pairingService.js que não depende de rede/Firestore --
// gerarCodigo/revogarDispositivo/iniciarEscutaPareamentos exigem
// licenseService/Firestore de verdade, fora do escopo de um teste local
// (ver comentário "Exportados só pra teste" no próprio arquivo).

test('marcarCodigoComoUsado marca usado=1 e carimba usado_em, sem mexer em outro código', () => {
  const { db, adminId, gerenteId } = freshTestDb();
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('111111', 'garcom', ?, ?, datetime('now', '+10 minutes'))`
  ).run(gerenteId, adminId);
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('222222', 'consulta', ?, ?, datetime('now', '+10 minutes'))`
  ).run(adminId, adminId);

  pairingService.marcarCodigoComoUsado('111111');

  const usado = db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get('111111');
  assert.equal(usado.usado, 1);
  assert.ok(usado.usado_em);

  const outro = db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get('222222');
  assert.equal(outro.usado, 0);
  assert.equal(outro.usado_em, null);
});

test('listarCodigosPendentes só traz código não usado e ainda não expirado', () => {
  const { db, adminId, gerenteId } = freshTestDb();
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('111111', 'garcom', ?, ?, datetime('now', '+10 minutes'))`
  ).run(gerenteId, adminId);
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em, usado) VALUES ('222222', 'consulta', ?, ?, datetime('now', '+10 minutes'), 1)`
  ).run(adminId, adminId);
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('333333', 'garcom', ?, ?, datetime('now', '-1 minutes'))`
  ).run(gerenteId, adminId);

  const pendentes = pairingService.listarCodigosPendentes();
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].id, '111111');
});

test('espelharDispositivoPareado cria dispositivo novo quando ainda não existe localmente', () => {
  const { db, gerenteId } = freshTestDb();
  pairingService.espelharDispositivoPareado({
    uid: 'uid-celular-1', tipo: 'garcom', vinculoUserId: gerenteId, nomeDispositivo: 'Celular do João', ativo: true,
  });

  const dispositivo = db.prepare('SELECT * FROM paired_devices WHERE id = ?').get('uid-celular-1');
  assert.ok(dispositivo);
  assert.equal(dispositivo.tipo, 'garcom');
  assert.equal(dispositivo.vinculo_user_id, gerenteId);
  assert.equal(dispositivo.nome_dispositivo, 'Celular do João');
  assert.equal(dispositivo.ativo, 1);
});

test('espelharDispositivoPareado atualiza dispositivo já existente em vez de duplicar', () => {
  const { db, gerenteId, adminId } = freshTestDb();
  pairingService.espelharDispositivoPareado({
    uid: 'uid-celular-2', tipo: 'consulta', vinculoUserId: adminId, nomeDispositivo: 'iPhone', ativo: true,
  });
  pairingService.espelharDispositivoPareado({
    uid: 'uid-celular-2', tipo: 'consulta', vinculoUserId: adminId, nomeDispositivo: 'iPhone do Arthur', ativo: false,
  });

  const total = db.prepare('SELECT COUNT(*) as c FROM paired_devices').get().c;
  assert.equal(total, 1);
  const dispositivo = db.prepare('SELECT * FROM paired_devices WHERE id = ?').get('uid-celular-2');
  assert.equal(dispositivo.nome_dispositivo, 'iPhone do Arthur');
  assert.equal(dispositivo.ativo, 0);
});

test('espelharDispositivoPareado ignora silenciosamente vínculo apontando pra usuário que não existe mais', () => {
  const { db } = freshTestDb();
  assert.doesNotThrow(() => {
    pairingService.espelharDispositivoPareado({
      uid: 'uid-orfao', tipo: 'garcom', vinculoUserId: 'usuario-inexistente', nomeDispositivo: 'X', ativo: true,
    });
  });
  const dispositivo = db.prepare('SELECT * FROM paired_devices WHERE id = ?').get('uid-orfao');
  assert.equal(dispositivo, undefined);
});

test('listarDispositivosPareados traz ativos primeiro e junto o nome do vínculo', () => {
  const { gerenteId, adminId } = freshTestDb();
  pairingService.espelharDispositivoPareado({ uid: 'uid-a', tipo: 'garcom', vinculoUserId: gerenteId, ativo: false });
  pairingService.espelharDispositivoPareado({ uid: 'uid-b', tipo: 'consulta', vinculoUserId: adminId, ativo: true });

  const lista = pairingService.listarDispositivosPareados();
  assert.equal(lista.length, 2);
  assert.equal(lista[0].id, 'uid-b'); // ativo primeiro
  assert.equal(lista[0].vinculo_nome, 'Administrador'); // nome vem do JOIN com users
});
