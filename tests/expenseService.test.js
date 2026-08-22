const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const expenseService = require('../electron/services/expenseService');

test('create recusa valor inválido ou descrição vazia', () => {
  const { locationId, operadorId } = freshTestDb();
  const semValor = expenseService.create({ categoria: 'outro', descricao: 'x', valor: 0, locationId, operadorId });
  assert.equal(semValor.ok, false);
  const semDescricao = expenseService.create({ categoria: 'outro', descricao: '  ', valor: 10, locationId, operadorId });
  assert.equal(semDescricao.ok, false);
});

test('markAsPaid marca uma despesa pendente como paga e recusa marcar de novo', () => {
  const { locationId, operadorId } = freshTestDb();
  const { id } = expenseService.create({
    categoria: 'fornecedor', descricao: 'Conta', valor: 100, locationId, operadorId, dataVencimento: '2030-01-01',
  });
  const primeira = expenseService.markAsPaid({ expenseId: id, operadorId });
  assert.equal(primeira.ok, true);
  const segunda = expenseService.markAsPaid({ expenseId: id, operadorId });
  assert.equal(segunda.ok, false);
});

/**
 * list foi reescrita pra um filtro sargable (comparação direta de
 * timestamp UTC em vez de `date(e.criado_em, '-3 hours') BETWEEN ...`).
 * Confere que as fronteiras do dia local (UTC-3) continuam corretas.
 */
test('list respeita as fronteiras do dia local (UTC-3) no filtro de data', () => {
  const { db, locationId, operadorId } = freshTestDb();

  const inserirDespesa = (criadoEmUtc) => {
    db.prepare(
      `INSERT INTO expenses (id, categoria, descricao, valor, location_id, operador_id, criado_em)
       VALUES (?, 'outro', 'teste', 10, ?, ?, ?)`
    ).run(randomUUID(), locationId, operadorId, criadoEmUtc);
  };

  inserirDespesa('2026-07-31 02:59:59'); // 30/07 local — fora
  inserirDespesa('2026-07-31 03:00:00'); // 31/07 00:00 local — dentro (início)
  inserirDespesa('2026-09-01 02:59:59'); // 31/08 23:59:59 local — dentro (fim)
  inserirDespesa('2026-09-01 03:00:00'); // 01/09 local — fora

  const resultado = expenseService.list({ locationId, dataInicio: '2026-07-31', dataFim: '2026-08-31' });
  assert.equal(resultado.length, 2);
});

test('list com apenasPendentes filtra só despesas sem data_pagamento', () => {
  const { locationId, operadorId } = freshTestDb();
  expenseService.create({ categoria: 'outro', descricao: 'Já paga', valor: 10, locationId, operadorId }); // sem vencimento = já paga
  expenseService.create({ categoria: 'fornecedor', descricao: 'Pendente', valor: 20, locationId, operadorId, dataVencimento: '2030-01-01' });

  const todas = expenseService.list({ locationId, dataInicio: '2020-01-01', dataFim: '2030-12-31' });
  assert.equal(todas.length, 2);

  const pendentes = expenseService.list({ locationId, dataInicio: '2020-01-01', dataFim: '2030-12-31', apenasPendentes: true });
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].descricao, 'Pendente');
});
