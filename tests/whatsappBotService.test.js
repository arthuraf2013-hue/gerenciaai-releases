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

test('resultadoCampanhas: conta quem voltou depois da mensagem e o quanto comprou, uma vez por cliente', () => {
  const { randomUUID } = require('crypto');
  const { db, locationId, operadorId } = require('./helpers/testDb').freshTestDb();
  const w = require('../electron/services/whatsappAutomationService');
  const cli1 = randomUUID(); const cli2 = randomUUID();
  db.prepare(`INSERT INTO customers (id, nome) VALUES (?, 'Ana'), (?, 'Beto')`).run(cli1, cli2);
  db.prepare(`INSERT INTO campanha_envios (id, customer_id, tipo, enviado_em) VALUES (?, ?, 'reconquista', datetime('now', '-10 days'))`).run(randomUUID(), cli1);
  db.prepare(`INSERT INTO campanha_envios (id, customer_id, tipo, enviado_em) VALUES (?, ?, 'reconquista', datetime('now', '-9 days'))`).run(randomUUID(), cli1);
  db.prepare(`INSERT INTO campanha_envios (id, customer_id, tipo, enviado_em) VALUES (?, ?, 'reconquista', datetime('now', '-10 days'))`).run(randomUUID(), cli2);
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em) VALUES (?, ?, ?, ?, 'finalizada', 80, datetime('now', '-5 days'))`).run(randomUUID(), locationId, operadorId, cli1);
  // compra ANTES da mensagem não conta
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em) VALUES (?, ?, ?, ?, 'finalizada', 999, datetime('now', '-20 days'))`).run(randomUUID(), locationId, operadorId, cli2);
  const r = w.resultadoCampanhas({ dias: 30, janelaDias: 15 });
  assert.deepEqual(r.porTipo.reconquista, { enviados: 2, voltaram: 1, receita: 80 });
});
