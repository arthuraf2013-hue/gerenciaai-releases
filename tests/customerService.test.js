const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const customerService = require('../electron/services/customerService');

function criarVendaFinalizada(db, { locationId, operadorId, customerId, diasAtras }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em)
     VALUES (?, ?, ?, ?, 'finalizada', 10, datetime('now', '-' || ? || ' days'))`
  ).run(id, locationId, operadorId, customerId, diasAtras);
}

test('detecta cliente regular que sumiu — comparando com o RITMO PRÓPRIO dele, não um número fixo', () => {
  const { db, locationId, adminId } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Maria Regular', '81999998888');
  // Compra a cada ~7 dias, mas a última foi há 25 -- bem acima do dobro do ritmo dela (14)
  [60, 53, 46, 39, 32, 25].forEach((dias) => criarVendaFinalizada(db, { locationId, operadorId: adminId, customerId: clienteId, diasAtras: dias }));

  const sumidos = customerService.listClientesQueSumiram();
  assert.equal(sumidos.length, 1);
  assert.equal(sumidos[0].id, clienteId);
});

test('não aponta cliente esporádico como sumido se ele ainda está dentro do PRÓPRIO ritmo', () => {
  const { db, locationId, adminId } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'João Esporádico', '81999997777');
  // Compra a cada ~90 dias, a última foi há 40 -- normal pro ritmo dele, não deveria disparar
  [130, 40].forEach((dias) => criarVendaFinalizada(db, { locationId, operadorId: adminId, customerId: clienteId, diasAtras: dias }));

  const sumidos = customerService.listClientesQueSumiram();
  assert.equal(sumidos.length, 0);
});

test('ignora cliente com só 1 compra — sem ritmo pra comparar', () => {
  const { db, locationId, adminId } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Pedro Única Compra', '81999996666');
  criarVendaFinalizada(db, { locationId, operadorId: adminId, customerId: clienteId, diasAtras: 100 });

  const sumidos = customerService.listClientesQueSumiram();
  assert.equal(sumidos.length, 0);
});

test('montarLinkReconquista monta o link certo, com DDI e mensagem personalizada com o primeiro nome', () => {
  const { db } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Maria Regular Silva', '81999998888');

  const link = customerService.montarLinkReconquista(clienteId);
  assert.equal(link.ok, true);
  assert.match(link.url, /^https:\/\/wa\.me\/5581999998888\?text=/);
  assert.match(link.mensagem, /Maria/);
});

test('montarLinkReconquista recusa quando o cliente não tem telefone cadastrado', () => {
  const { db } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, NULL)').run(clienteId, 'Sem Telefone');

  const link = customerService.montarLinkReconquista(clienteId);
  assert.equal(link.ok, false);
});
