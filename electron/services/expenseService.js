const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

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
  // Sargable -- ver o mesmo comentário em dashboardService.js.
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  let sql = `
    SELECT e.*, s.nome as fornecedor_nome
    FROM expenses e LEFT JOIN suppliers s ON s.id = e.fornecedor_id
    WHERE e.location_id = ? AND e.criado_em >= ? AND e.criado_em < ?`;
  const params = [locationId, inicioUtc, fimUtcExclusivo];
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

/** Exclui uma despesa (definitivo). Só gerente/admin/suporte pode --
 * sem essa checagem, qualquer operador logado conseguia apagar
 * qualquer despesa (mesmo já paga) direto pelo IPC, sem deixar rastro
 * nenhum na Auditoria. */
function remove({ expenseId, operadorId }) {
  const db = getDb();
  const despesa = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  if (!despesa) return { ok: false, error: 'Despesa não encontrada.' };

  const operador = operadorId ? db.prepare('SELECT * FROM users WHERE id = ?').get(operadorId) : null;
  if (!operador || !['gerente', 'admin', 'suporte'].includes(operador.role)) {
    return { ok: false, error: 'Só gerente, admin ou suporte pode excluir uma despesa.' };
  }

  db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);

  try {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso)
       VALUES (?, 'despesa_removida', ?, ?, 1)`
    ).run(
      randomUUID(), operadorId,
      `Despesa "${despesa.descricao}" (R$ ${Number(despesa.valor).toFixed(2)}) excluída${despesa.data_pagamento ? ' — já estava paga' : ''}`
    );
  } catch (err) { /* auditoria não deve travar a exclusão se falhar */ }

  return { ok: true };
}

module.exports = { create, markAsPaid, list, listPending, remove };
