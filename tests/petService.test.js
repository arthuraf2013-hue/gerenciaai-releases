const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const petService = require('../electron/services/petService');

function diasAPartirDeHoje(dias) {
  return new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
}

function criarClienteComTelefone(db, { nome = 'Dono Teste', telefone = '81988887777' } = {}) {
  const id = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(id, nome, telefone);
  return id;
}

test('cadastra e lista pets de um cliente', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db);
  const r = petService.upsert({ customerId: clienteId, nome: 'Rex', especie: 'Cão' });
  assert.equal(r.ok, true);

  const pets = petService.listByCustomer(clienteId);
  assert.equal(pets.length, 1);
  assert.equal(pets[0].nome, 'Rex');
});

test('recusa cadastrar pet sem nome ou sem cliente vinculado', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db);
  assert.equal(petService.upsert({ customerId: clienteId, nome: '' }).ok, false);
  assert.equal(petService.upsert({ nome: 'Rex' }).ok, false);
});

test('listLembretesPendentes pega vacina vencendo dentro do prazo, ignora a que está bem no futuro', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db);
  const pertoDoVencimento = petService.upsert({ customerId: clienteId, nome: 'Rex', proximaVacinaEm: diasAPartirDeHoje(3) });
  petService.upsert({ customerId: clienteId, nome: 'Mimi', proximaVacinaEm: diasAPartirDeHoje(60) });

  const lembretes = petService.listLembretesPendentes();
  assert.equal(lembretes.length, 1);
  assert.equal(lembretes[0].id, pertoDoVencimento.id);
});

test('listLembretesPendentes distingue vacina já vencida de vacina só se aproximando', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db);
  const vencida = petService.upsert({ customerId: clienteId, nome: 'Vencida', proximaVacinaEm: diasAPartirDeHoje(-2) });
  const proxima = petService.upsert({ customerId: clienteId, nome: 'Proxima', proximaVacinaEm: diasAPartirDeHoje(2) });

  const lembretes = petService.listLembretesPendentes();
  const doVencido = lembretes.find((l) => l.id === vencida.id);
  const doProximo = lembretes.find((l) => l.id === proxima.id);
  assert.equal(doVencido.vacinaVencida, true);
  assert.equal(doProximo.vacinaVencida, false);
});

test('não lista pet sem nenhuma data cadastrada', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db);
  petService.upsert({ customerId: clienteId, nome: 'Sem Data Nenhuma' });

  const lembretes = petService.listLembretesPendentes();
  assert.equal(lembretes.length, 0);
});

test('pet removido (deactivate) não aparece mais na listagem nem nos lembretes', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db);
  const r = petService.upsert({ customerId: clienteId, nome: 'Rex', proximaVacinaEm: diasAPartirDeHoje(1) });

  petService.deactivate(r.id);

  assert.equal(petService.listByCustomer(clienteId).length, 0);
  assert.equal(petService.listLembretesPendentes().length, 0);
});

test('montarLinkLembrete gera mensagem gramaticalmente certa pra vencido e pra próximo', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db, { nome: 'João Dono' });
  const vencida = petService.upsert({ customerId: clienteId, nome: 'Rex', proximaVacinaEm: diasAPartirDeHoje(-1) });
  const proxima = petService.upsert({ customerId: clienteId, nome: 'Mimi', proximaVacinaEm: diasAPartirDeHoje(2) });

  const linkVencida = petService.montarLinkLembrete(vencida.id);
  assert.equal(linkVencida.ok, true);
  assert.match(linkVencida.mensagem, /pendente/);
  assert.doesNotMatch(linkVencida.mensagem, /próxima pendente/); // não pode duplicar as duas formas

  const linkProxima = petService.montarLinkLembrete(proxima.id);
  assert.equal(linkProxima.ok, true);
  assert.match(linkProxima.mensagem, /chegando perto/);
});

test('montarLinkLembrete recusa quando o dono não tem telefone cadastrado', () => {
  const { db } = freshTestDb();
  const clienteId = criarClienteComTelefone(db, { telefone: null });
  const r = petService.upsert({ customerId: clienteId, nome: 'Rex', proximaVacinaEm: diasAPartirDeHoje(1) });

  const link = petService.montarLinkLembrete(r.id);
  assert.equal(link.ok, false);
});
