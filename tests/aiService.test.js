const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const aiService = require('../electron/services/aiService');

// Trocar a chave de API paga da IA também só aparece em Configurações
// (admin-only no menu) — o backend precisa recusar os outros papéis
// também, mesmo que alguém chame o canal IPC direto.

test('updateAiSettings recusa gerente', () => {
  const { gerenteId } = freshTestDb();
  const result = aiService.updateAiSettings(gerenteId, { ativado: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('updateAiSettings recusa operador', () => {
  const { operadorId } = freshTestDb();
  const result = aiService.updateAiSettings(operadorId, { ativado: true });
  assert.equal(result.ok, false);
});

test('updateAiSettings funciona pra admin', () => {
  const { adminId } = freshTestDb();
  const result = aiService.updateAiSettings(adminId, { ativado: true, modelo: 'gemini-3.1-flash-lite' });
  assert.equal(result.ok, true);
  const settings = aiService.getAiSettingsPublic();
  assert.equal(settings.ativado, true);
});
