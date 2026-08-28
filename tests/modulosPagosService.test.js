const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const modulosPagosService = require('../electron/services/modulosPagosService');

// Só a parte de modulosPagosService.js que não depende de rede/Firestore
// -- aplicarClienteIdDaInstalacao com um clienteId de verdade inicia uma
// escuta em tempo real (onSnapshot) de clientes/{clienteId}, fora do
// escopo de um teste local (mesmo motivo por trás de gerarCodigo e
// iniciarEscutaPareamentos não serem testados aqui -- ver comentário em
// pairingService.test.js).

test('moduloAtivo devolve true quando o espelho local nunca sincronizou (não bloqueia por falta de dado)', () => {
  freshTestDb();
  assert.equal(modulosPagosService.moduloAtivo('appGarcom'), true);
  assert.equal(modulosPagosService.moduloAtivo('consultaRemota'), true);
});

test('aplicarClienteIdDaInstalacao com clienteId nulo confirma os dois módulos desativados', () => {
  freshTestDb();
  modulosPagosService.aplicarClienteIdDaInstalacao({ clienteId: null });
  assert.equal(modulosPagosService.moduloAtivo('appGarcom'), false);
  assert.equal(modulosPagosService.moduloAtivo('consultaRemota'), false);
});

test('aplicarClienteIdDaInstalacao com clienteId ausente (campo nem existe) tem o mesmo efeito de nulo', () => {
  freshTestDb();
  modulosPagosService.aplicarClienteIdDaInstalacao({});
  assert.equal(modulosPagosService.moduloAtivo('appGarcom'), false);
  assert.equal(modulosPagosService.moduloAtivo('consultaRemota'), false);
});

test('moduloAtivo reflete o estado já sincronizado e salvo localmente, por módulo', () => {
  const { db } = freshTestDb();
  db.prepare(
    `INSERT INTO modulos_pagos_state (id, cliente_id, consulta_remota, app_garcom, ja_sincronizado) VALUES ('default', 'cliente-x', 1, 0, 1)`
  ).run();
  assert.equal(modulosPagosService.moduloAtivo('consultaRemota'), true);
  assert.equal(modulosPagosService.moduloAtivo('appGarcom'), false);
});

test('aplicarClienteIdDaInstalacao com clienteId nulo sempre reafirma "desativado" (nunca depende de estado em memória do processo)', () => {
  const { db } = freshTestDb();
  // Simula um estado antigo (de uma instalação diferente, num processo
  // que já rodou antes) com módulo ativo salvo -- chamar de novo com
  // clienteId=null pra ESTA instalação tem que sobrescrever pra
  // desativado, nunca deixar um valor antigo "vazar".
  db.prepare(
    `INSERT INTO modulos_pagos_state (id, cliente_id, consulta_remota, app_garcom, ja_sincronizado) VALUES ('default', 'cliente-antigo', 1, 1, 1)`
  ).run();
  modulosPagosService.aplicarClienteIdDaInstalacao({ clienteId: null });
  assert.equal(modulosPagosService.moduloAtivo('consultaRemota'), false);
});
