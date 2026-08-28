const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
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

// ---------------------------------------------------------------------
// remove() precisa checar o papel de quem pede -- sem isso, qualquer
// operador logado apagava qualquer despesa (mesmo já paga) direto pelo
// IPC, sem deixar rastro nenhum na Auditoria.
// ---------------------------------------------------------------------

test('remove recusa operador comum e não apaga a despesa', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const { id } = expenseService.create({ categoria: 'outro', descricao: 'Conta', valor: 50, locationId, operadorId });

  const result = expenseService.remove({ expenseId: id, operadorId });
  assert.equal(result.ok, false);
  assert.match(result.error, /gerente|admin|suporte/i);

  const aindaExiste = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id);
  assert.ok(aindaExiste, 'despesa não deveria ter sido apagada');
});

test('remove recusa quando nenhum operadorId é informado', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const { id } = expenseService.create({ categoria: 'outro', descricao: 'Conta', valor: 50, locationId, operadorId });

  const result = expenseService.remove({ expenseId: id });
  assert.equal(result.ok, false);
  assert.ok(db.prepare('SELECT id FROM expenses WHERE id = ?').get(id));
});

test('remove permite gerente, apaga a despesa e grava na auditoria', () => {
  const { db, locationId, operadorId, gerenteId } = freshTestDb();
  const { id } = expenseService.create({ categoria: 'outro', descricao: 'Conta de luz', valor: 75, locationId, operadorId });

  const result = expenseService.remove({ expenseId: id, operadorId: gerenteId });
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT id FROM expenses WHERE id = ?').get(id), undefined);

  const evento = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'despesa_removida' AND solicitante_id = ?`).get(gerenteId);
  assert.ok(evento, 'deveria ter gravado um evento de auditoria');
  assert.match(evento.motivo, /Conta de luz/);
});

test('remove permite suporte apagar uma despesa já paga, e o motivo registra isso', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const suporteId = createSuporteUser(db);
  const { id } = expenseService.create({ categoria: 'outro', descricao: 'Já paga', valor: 20, locationId, operadorId }); // sem vencimento = já paga na hora

  const result = expenseService.remove({ expenseId: id, operadorId: suporteId });
  assert.equal(result.ok, true);

  const evento = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'despesa_removida' AND solicitante_id = ?`).get(suporteId);
  assert.match(evento.motivo, /já estava paga/);
});

test('remove com despesa inexistente devolve erro', () => {
  const { gerenteId } = freshTestDb();
  const result = expenseService.remove({ expenseId: randomUUID(), operadorId: gerenteId });
  assert.equal(result.ok, false);
});
