const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
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

test('changeOwnPin também bloqueia após tentativas erradas (não é uma porta lateral do bloqueio)', () => {
  const { adminId } = freshTestDb();
  for (let i = 0; i < 5; i++) {
    authService.changeOwnPin(adminId, 'senha-errada', '9999');
  }
  const result = authService.changeOwnPin(adminId, '0000', '9999'); // PIN certo, mas já bloqueado
  assert.equal(result.ok, false);
  assert.match(result.error, /bloqueado/i);
});
