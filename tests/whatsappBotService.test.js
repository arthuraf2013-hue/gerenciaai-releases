const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const whatsappBotService = require('../electron/services/whatsappBotService');

// conectar/desconectar só aparecem na aba WhatsApp de Configurações pra
// admin/gerente — o backend precisa recusar operador também, mesmo que
// alguém chame o canal IPC direto. Só testamos aqui o caminho de recusa
// (ok:false): o caminho de sucesso de fato abre/fecha uma conexão real
// via Baileys, fora do escopo de um teste unitário sem rede.

test('conectar recusa operador', () => {
  const { operadorId } = freshTestDb();
  const result = whatsappBotService.conectar(operadorId);
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('conectar recusa usuário inexistente/inativo', () => {
  const result = whatsappBotService.conectar('id-que-nao-existe');
  assert.equal(result.ok, false);
});

test('desconectar recusa operador', async () => {
  const { operadorId } = freshTestDb();
  const result = await whatsappBotService.desconectar(operadorId);
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('desconectar funciona pra suporte, igual admin/gerente (passa da checagem de permissão)', async () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  const result = await whatsappBotService.desconectar(suporteId);
  assert.equal(result.ok, true);
});
