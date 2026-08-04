const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/** Lança uma despesa nova. Sem data_vencimento, considera já paga na
 * hora (data_pagamento = agora). Com data_vencimento, fica pendente
 * até alguém marcar como paga. */
function create({ categoria, descricao, valor, fornecedorId, dataVencimento, locationId, operadorId }) {
  const db = getDb();
  if (!(Number(valor) > 0)) return { ok: false, error: 'Informe um valor válido (maior que zero).' };
  if (!descricao?.trim()) return { ok: false, error: 'Informe uma descrição.' };

  const id = randomUUID();
  const jaEstaPaga = !dataVencimento;
  db.prepare(
    `INSERT INTO expenses (id, categoria, descricao, valor, fornecedor_id, data_vencimento, data_pagamento, location_id, operador_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, categoria || 'outro', descricao.trim(), Number(valor), fornecedorId || null,
    dataVencimento || null, jaEstaPaga ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    locationId, operadorId
  );
  return { ok: true, id };
}

/** Marca uma despesa pendente como paga agora. */
function markAsPaid({ expenseId, operadorId }) {
  const db = getDb();
  const despesa = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  if (!despesa) return { ok: false, error: 'Despesa não encontrada.' };
  if (despesa.data_pagamento) return { ok: false, error: 'Essa despesa já está marcada como paga.' };

  db.prepare('UPDATE expenses SET data_pagamento = ? WHERE id = ?')
    .run(new Date().toISOString().slice(0, 19).replace('T', ' '), expenseId);
  return { ok: true };
}

/** Lista despesas de um período, com filtro opcional por status. */
function list({ locationId, dataInicio, dataFim, apenasPendentes }) {
  const db = getDb();
  let sql = `
    SELECT e.*, s.nome as fornecedor_nome
    FROM expenses e LEFT JOIN suppliers s ON s.id = e.fornecedor_id
    WHERE e.location_id = ? AND date(e.criado_em) >= date(?) AND date(e.criado_em) <= date(?)`;
  const params = [locationId, dataInicio, dataFim];
  if (apenasPendentes) sql += ' AND e.data_pagamento IS NULL';
  sql += ' ORDER BY COALESCE(e.data_vencimento, e.criado_em)';
  return db.prepare(sql).all(...params);
}

/** Contas a pagar em aberto — pendentes, ordenadas por vencimento
 * mais próximo primeiro (as atrasadas aparecem no topo). */
function listPending({ locationId }) {
  const db = getDb();
  return db.prepare(
    `SELECT e.*, s.nome as fornecedor_nome
     FROM expenses e LEFT JOIN suppliers s ON s.id = e.fornecedor_id
     WHERE e.location_id = ? AND e.data_pagamento IS NULL
     ORDER BY e.data_vencimento IS NULL, e.data_vencimento`
  ).all(locationId);
}

function remove({ expenseId }) {
  const db = getDb();
  db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  return { ok: true };
}

module.exports = { create, markAsPaid, list, listPending, remove };
