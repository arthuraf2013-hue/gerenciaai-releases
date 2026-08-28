const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const authService = require('../electron/services/authService');

test('login com PIN correto funciona e devolve os dados do usuário', () => {
  const { adminId } = freshTestDb();
  const result = authService.login(adminId, '0000');
  assert.equal(result.ok, true);
  assert.equal(result.user.role, 'admin');
  assert.equal(result.user.pinTemporario, true); // seed nasce com PIN temporário
});

test('login com PIN errado falha sem travar de primeira', () => {
  const { adminId } = freshTestDb();
  const result = authService.login(adminId, '9999');
  assert.equal(result.ok, false);
  assert.match(result.error, /incorreto/i);
});

test('5 tentativas erradas bloqueiam o login, mesmo com o PIN certo na 6ª vez', () => {
  const { adminId } = freshTestDb();
  for (let i = 0; i < 5; i++) {
    authService.login(adminId, 'errado');
  }
  const result = authService.login(adminId, '0000'); // PIN certo, mas já bloqueado
  assert.equal(result.ok, false);
  assert.match(result.error, /bloqueado/i);
});

test('login correto antes de bloquear zera o contador de tentativas', () => {
  const { adminId } = freshTestDb();
  authService.login(adminId, 'errado');
  authService.login(adminId, 'errado');
  const sucesso = authService.login(adminId, '0000');
  assert.equal(sucesso.ok, true);

  // contador foi zerado pelo login certo — 3 erradas de novo não bastam pra bloquear
  authService.login(adminId, 'errado');
  authService.login(adminId, 'errado');
  authService.login(adminId, 'errado');
  const aindaFunciona = authService.login(adminId, '0000');
  assert.equal(aindaFunciona.ok, true); // prova que o contador não "vazou" do ciclo anterior
});

test('authorizeManagerOverride rejeita quando o autorizador é o próprio operador', () => {
  const { gerenteId } = freshTestDb();
  const result = authService.authorizeManagerOverride({
    candidateUserId: gerenteId,
    pin: '1234',
    currentOperatorId: gerenteId, // mesma pessoa!
    tipoEvento: 'cancelamento_item',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /outra pessoa/i);
});

test('authorizeManagerOverride rejeita operador tentando autorizar (não é gerente/admin)', () => {
  const { operadorId, gerenteId } = freshTestDb();
  const result = authService.authorizeManagerOverride({
    candidateUserId: operadorId, // é operador, não gerente
    pin: '5678',
    currentOperatorId: gerenteId,
    tipoEvento: 'cancelamento_item',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('authorizeManagerOverride aceita um gerente diferente do operador, com PIN certo', () => {
  const { gerenteId, operadorId } = freshTestDb();
  const result = authService.authorizeManagerOverride({
    candidateUserId: gerenteId,
    pin: '1234',
    currentOperatorId: operadorId,
    tipoEvento: 'cancelamento_item',
  });
  assert.equal(result.ok, true);
  assert.equal(result.autorizadoPor.id, gerenteId);
});

test('authorizeManagerOverride aceita um usuário suporte diferente do operador, com PIN certo (mesma permissão de gerente/admin)', () => {
  const { db, operadorId } = freshTestDb();
  const suporteId = createSuporteUser(db, { pin: '9999' });
  const result = authService.authorizeManagerOverride({
    candidateUserId: suporteId,
    pin: '9999',
    currentOperatorId: operadorId,
    tipoEvento: 'cancelamento_item',
  });
  assert.equal(result.ok, true);
  assert.equal(result.autorizadoPor.id, suporteId);
});

test('changeOwnPin também bloqueia após tentativas erradas (não é uma porta lateral do bloqueio)', () => {
  const { adminId } = freshTestDb();
  for (let i = 0; i < 5; i++) {
    authService.changeOwnPin(adminId, 'senha-errada', '9999');
  }
  const result = authService.changeOwnPin(adminId, '0000', '9999'); // PIN certo, mas já bloqueado
  assert.equal(result.ok, false);
  assert.match(result.error, /bloqueado/i);
});

// ---------------------------------------------------------------------
// requireRole / updateSecurityConfig — a checagem de permissão precisa
// estar no backend, não só escondida na tela (ver handlers.js): mesmo que
// a UI esconda o botão de quem não é admin, o canal IPC em si tem que
// recusar a chamada.
// ---------------------------------------------------------------------

test('requireRole recusa usuário com papel fora da lista permitida', () => {
  const { gerenteId } = freshTestDb();
  const result = authService.requireRole(gerenteId, ['admin']);
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('requireRole recusa usuário inexistente ou inativo', () => {
  const result = authService.requireRole('id-que-nao-existe', ['admin']);
  assert.equal(result.ok, false);
});

test('requireRole aceita usuário com papel permitido', () => {
  const { adminId } = freshTestDb();
  const result = authService.requireRole(adminId, ['admin']);
  assert.equal(result.ok, true);
  assert.equal(result.role, 'admin');
});

test('updateSecurityConfig recusa gerente (é a trava de segurança central do sistema — só admin desliga)', () => {
  const { gerenteId } = freshTestDb();
  const result = authService.updateSecurityConfig(gerenteId, { exigirAutorizacaoCancelamento: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('updateSecurityConfig recusa operador', () => {
  const { operadorId } = freshTestDb();
  const result = authService.updateSecurityConfig(operadorId, { exigirAutorizacaoCancelamento: false });
  assert.equal(result.ok, false);
});

test('updateSecurityConfig funciona pra admin e o valor realmente muda no banco', () => {
  const { adminId } = freshTestDb();
  const result = authService.updateSecurityConfig(adminId, { exigirAutorizacaoCancelamento: false });
  assert.equal(result.ok, true);
  assert.equal(authService.getSecurityConfig().exigir_autorizacao_cancelamento, 0);
});

test('updateSecurityConfig funciona pra suporte, igual admin', () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  const result = authService.updateSecurityConfig(suporteId, { exigirAutorizacaoCancelamento: false });
  assert.equal(result.ok, true);
  assert.equal(authService.getSecurityConfig().exigir_autorizacao_cancelamento, 0);
});

test('updateSecurityConfig grava um evento de auditoria só quando algo de fato muda', () => {
  const { db, adminId } = freshTestDb();

  authService.updateSecurityConfig(adminId, { exigirAutorizacaoCancelamento: false });
  const eventos1 = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'config_seguranca_alterada'`).all();
  assert.equal(eventos1.length, 1, 'deveria ter gravado um evento na primeira mudança real');
  assert.equal(eventos1[0].solicitante_id, adminId);

  // Chamar de novo pedindo o mesmo valor que já está (nada muda de fato)
  // não deveria poluir a auditoria com um evento repetido.
  authService.updateSecurityConfig(adminId, { exigirAutorizacaoCancelamento: false });
  const eventos2 = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'config_seguranca_alterada'`).all();
  assert.equal(eventos2.length, 1, 'não deveria gravar de novo se o valor não mudou');
});

/**
 * listAuditLog foi reescrita pra usar um filtro sargable em vez de
 * `date(criado_em, '-3 hours') BETWEEN date(?) AND date(?)` -- trava o
 * comportamento nas fronteiras do dia local (UTC-3).
 */
test('listAuditLog inclui só entradas dentro do intervalo local pedido', () => {
  const { db, operadorId, adminId } = freshTestDb();
  const inserir = (criadoEm) => db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, solicitante_id, sucesso, criado_em) VALUES (lower(hex(randomblob(16))), 'cancelamento_venda', ?, 1, ?)`
  ).run(operadorId, criadoEm);

  inserir('2026-07-31 02:59:59'); // fora (30/07 local)
  inserir('2026-07-31 03:00:00'); // dentro (31/07 00:00 local)
  inserir('2026-09-01 02:59:59'); // dentro (31/08 23:59:59 local)
  inserir('2026-09-01 03:00:00'); // fora (01/09 local)

  const resultado = authService.listAuditLog({ dataInicio: '2026-07-31', dataFim: '2026-08-31', requestingUserId: adminId });
  assert.equal(resultado.length, 2);
});

// ---------------------------------------------------------------------
// listAuditLog é a fonte da tela de Auditoria (só admin/suporte acessam
// na UI -- ver Dashboard.jsx) -- mas o canal IPC aceitava a chamada de
// qualquer usuário logado, já que a função nem recebia quem estava
// pedindo. Isso deixava a trilha de auditoria inteira (inclusive
// tentativas negadas de cancelamento/desconto) legível por um
// operador ou garçom comum.
// ---------------------------------------------------------------------

test('listAuditLog recusa operador comum', () => {
  const { operadorId } = freshTestDb();
  const resultado = authService.listAuditLog({ dataInicio: '2020-01-01', dataFim: '2030-12-31', requestingUserId: operadorId });
  assert.equal(resultado.ok, false);
});

test('listAuditLog recusa quando nenhum requestingUserId é informado', () => {
  freshTestDb();
  const resultado = authService.listAuditLog({ dataInicio: '2020-01-01', dataFim: '2030-12-31' });
  assert.equal(resultado.ok, false);
});

test('listAuditLog permite admin e suporte', () => {
  const { db, adminId } = freshTestDb();
  const suporteId = createSuporteUser(db);
  assert.ok(Array.isArray(authService.listAuditLog({ dataInicio: '2020-01-01', dataFim: '2030-12-31', requestingUserId: adminId })));
  assert.ok(Array.isArray(authService.listAuditLog({ dataInicio: '2020-01-01', dataFim: '2030-12-31', requestingUserId: suporteId })));
});
