const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const pairingService = require('../electron/services/pairingService');

// Só a parte de pairingService.js que não depende de rede/Firestore --
// gerarCodigo/revogarDispositivo/iniciarEscutaPareamentos exigem
// licenseService/Firestore de verdade, fora do escopo de um teste local
// (ver comentário "Exportados só pra teste" no próprio arquivo).
//
// EXCEÇÃO: o trecho novo de gerarCodigo que recusa por módulo pago
// desativado (ver modulosPagosService.js) roda ANTES de qualquer
// chamada ao Firestore -- então dá pra testar essa recusa localmente,
// simulando o espelho local "já confirmou que o módulo está
// desligado" direto no banco, sem precisar de rede nenhuma.

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

// Regressão: gerarCodigo chegou a gravar expira_em com `.toISOString()`
// puro ("2026-08-29T07:40:21.000Z") -- expira_em é TEXT, e o SQLite
// compara `>`/`<` byte a byte, não como data de verdade. "T" (0x54) é
// sempre "maior" que o espaço (0x20) do formato usado por NOW_SYNCED()/
// datetime('now'), então no MESMO dia um código expirado continuava
// aparecendo como pendente pra sempre (só sumia quando virasse o dia).
// O teste acima não pegava isso porque grava direto com
// datetime('now', ...), que já nasce no formato certo -- aqui simula o
// formato de verdade que gerarCodigo grava hoje (ver pairingService.js).
test('listarCodigosPendentes expira de verdade um código no formato que gerarCodigo grava (regressão do bug do "T"/"Z")', () => {
  const { db, adminId, gerenteId } = freshTestDb();
  const formatoDeVerdade = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('444444', 'garcom', ?, ?, ?)`
  ).run(gerenteId, adminId, formatoDeVerdade(Date.now() - 60_000));
  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('555555', 'garcom', ?, ?, ?)`
  ).run(gerenteId, adminId, formatoDeVerdade(Date.now() + 60_000));

  const ids = pairingService.listarCodigosPendentes().map((p) => p.id);
  assert.ok(!ids.includes('444444'), 'código já expirado (formato de verdade) não deveria aparecer como pendente');
  assert.ok(ids.includes('555555'));
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

test('gerarCodigo recusa na hora (sem tocar rede) quando o módulo "App do garçom" está confirmado desativado', async () => {
  const { db, adminId } = freshTestDb();
  const garcomId = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Garçom Teste', 'garcom', 'x')`).run(garcomId);
  db.prepare(
    `INSERT INTO modulos_pagos_state (id, cliente_id, consulta_remota, app_garcom, ja_sincronizado) VALUES ('default', 'cliente-x', 1, 0, 1)`
  ).run();

  const resultado = await pairingService.gerarCodigo({ tipo: 'garcom', vinculoUserId: garcomId, requestingUserId: adminId });
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /App do garçom/);

  // Nenhum código deveria ter sido gravado localmente -- a recusa foi
  // antes de qualquer tentativa de publicar.
  const pendentes = pairingService.listarCodigosPendentes();
  assert.equal(pendentes.length, 0);
});

test('gerarCodigo recusa na hora quando o módulo "Consulta remota" está confirmado desativado', async () => {
  const { db, adminId } = freshTestDb();
  db.prepare(
    `INSERT INTO modulos_pagos_state (id, cliente_id, consulta_remota, app_garcom, ja_sincronizado) VALUES ('default', 'cliente-x', 0, 1, 1)`
  ).run();

  const resultado = await pairingService.gerarCodigo({ tipo: 'consulta', vinculoUserId: adminId, requestingUserId: adminId });
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /Consulta remota/);
});

// Não testamos aqui o caminho "módulo ativo" de gerarCodigo -- passar
// da checagem de módulo cai direto na parte que precisa de
// licenseService/Firestore de verdade (mesma exclusão documentada no
// topo do arquivo).

test('listarDispositivosPareados traz ativos primeiro e junto o nome do vínculo', () => {
  const { gerenteId, adminId } = freshTestDb();
  pairingService.espelharDispositivoPareado({ uid: 'uid-a', tipo: 'garcom', vinculoUserId: gerenteId, ativo: false });
  pairingService.espelharDispositivoPareado({ uid: 'uid-b', tipo: 'consulta', vinculoUserId: adminId, ativo: true });

  const lista = pairingService.listarDispositivosPareados();
  assert.equal(lista.length, 2);
  assert.equal(lista[0].id, 'uid-b'); // ativo primeiro
  assert.equal(lista[0].vinculo_nome, 'Administrador'); // nome vem do JOIN com users
});
