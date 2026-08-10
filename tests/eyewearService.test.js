const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const eyewearService = require('../electron/services/eyewearService');

function criarCliente(db, nome = 'Cliente Teste') {
  const id = randomUUID();
  db.prepare('INSERT INTO customers (id, nome) VALUES (?, ?)').run(id, nome);
  return id;
}

test('cadastra receita e lista de volta', () => {
  const { db } = freshTestDb();
  const clienteId = criarCliente(db);
  const r = eyewearService.upsert({
    customerId: clienteId, dataReceita: '2026-08-01',
    odEsferico: -1.5, odCilindrico: -0.5, odEixo: 90,
    oeEsferico: -1.75, oeCilindrico: -0.25, oeEixo: 85,
    distanciaPupilar: 62, tipoLente: 'Monofocal',
  });
  assert.equal(r.ok, true);

  const historico = eyewearService.listByCustomer(clienteId);
  assert.equal(historico.length, 1);
  assert.equal(historico[0].tipo_lente, 'Monofocal');
  assert.equal(historico[0].od_esferico, -1.5);
});

test('recusa cadastrar receita sem cliente vinculado', () => {
  const { db } = freshTestDb();
  const r = eyewearService.upsert({ dataReceita: '2026-08-01' });
  assert.equal(r.ok, false);
});

test('histórico vem ordenado da receita mais recente pra mais antiga', () => {
  const { db } = freshTestDb();
  const clienteId = criarCliente(db);
  eyewearService.upsert({ customerId: clienteId, dataReceita: '2024-03-10', tipoLente: 'Monofocal' });
  eyewearService.upsert({ customerId: clienteId, dataReceita: '2026-08-01', tipoLente: 'Multifocal' });

  const historico = eyewearService.listByCustomer(clienteId);
  assert.equal(historico.length, 2);
  assert.equal(historico[0].data_receita, '2026-08-01', 'a mais recente deveria vir primeiro');
  assert.equal(historico[1].data_receita, '2024-03-10');
});

test('editar uma receita existente atualiza os dados, não cria uma nova', () => {
  const { db } = freshTestDb();
  const clienteId = criarCliente(db);
  const r = eyewearService.upsert({ customerId: clienteId, dataReceita: '2026-08-01', odEsferico: -1.5 });

  eyewearService.upsert({ id: r.id, customerId: clienteId, dataReceita: '2026-08-01', odEsferico: -2.0 });

  const historico = eyewearService.listByCustomer(clienteId);
  assert.equal(historico.length, 1, 'deveria ter atualizado a mesma receita, não criado outra');
  assert.equal(historico[0].od_esferico, -2.0);
});

test('remover uma receita some do histórico, mas não mexe nas outras do mesmo cliente', () => {
  const { db } = freshTestDb();
  const clienteId = criarCliente(db);
  const antiga = eyewearService.upsert({ customerId: clienteId, dataReceita: '2024-03-10' });
  eyewearService.upsert({ customerId: clienteId, dataReceita: '2026-08-01' });

  eyewearService.deactivate(antiga.id);

  const historico = eyewearService.listByCustomer(clienteId);
  assert.equal(historico.length, 1);
  assert.equal(historico[0].data_receita, '2026-08-01');
});

test('campos numéricos aceitam null (campo em branco) sem quebrar', () => {
  const { db } = freshTestDb();
  const clienteId = criarCliente(db);
  const r = eyewearService.upsert({ customerId: clienteId, dataReceita: '2026-08-01', odEsferico: null, distanciaPupilar: null });
  assert.equal(r.ok, true);
  const historico = eyewearService.listByCustomer(clienteId);
  assert.equal(historico[0].od_esferico, null);
});
