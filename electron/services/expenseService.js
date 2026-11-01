const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

/** Lança uma despesa nova. Sem data_vencimento, considera já paga na
 * hora (data_pagamento = agora). Com data_vencimento, fica pendente
 * até alguém marcar como paga. */
function create({ categoria, descricao, valor, fornecedorId, dataVencimento, locationId, operadorId, centroCustoId }) {
  const db = getDb();
  if (!(Number(valor) > 0)) return { ok: false, error: 'Informe um valor válido (maior que zero).' };
  if (!descricao?.trim()) return { ok: false, error: 'Informe uma descrição.' };
  if (centroCustoId && !db.prepare('SELECT 1 FROM cost_centers WHERE id = ? AND ativo = 1').get(centroCustoId)) {
    return { ok: false, error: 'Centro de custo inválido.' };
  }

  const bloqueio = require('./contabilService').bloqueioPorFechamento(locationId, [dataVencimento || timeService.hojeLocalISO()]);
  if (bloqueio) return bloqueio;

  const id = randomUUID();
  const jaEstaPaga = !dataVencimento;
  db.prepare(
    `INSERT INTO expenses (id, categoria, descricao, valor, fornecedor_id, data_vencimento, data_pagamento, location_id, operador_id, centro_custo_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, categoria || 'outro', descricao.trim(), Number(valor), fornecedorId || null,
    dataVencimento || null, jaEstaPaga ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    locationId, operadorId, centroCustoId || null
  );
  return { ok: true, id };
}

/** Marca uma despesa pendente como paga agora. */
function markAsPaid({ expenseId, operadorId }) {
  const db = getDb();
  const despesa = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  if (!despesa) return { ok: false, error: 'Despesa não encontrada.' };
  if (despesa.data_pagamento) return { ok: false, error: 'Essa despesa já está marcada como paga.' };
  const bloqueio = require('./contabilService').bloqueioPorFechamento(despesa.location_id, [timeService.hojeLocalISO()]);
  if (bloqueio) return bloqueio;

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
    SELECT e.*, s.nome as fornecedor_nome, cc.nome as centro_custo_nome
    FROM expenses e LEFT JOIN suppliers s ON s.id = e.fornecedor_id LEFT JOIN cost_centers cc ON cc.id = e.centro_custo_id
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

  // Mês fechado na contabilidade: não some nada de lá (nem a despesa,
  // nem o pagamento dela) sem reabrir o mês antes.
  // Mesmo critério da contabilidade: mês de competência (competência,
  // senão vencimento, senão pagamento, senão lançamento) e mês do pagamento.
  const { dataLocalDeUtc } = require('./financeiroService');
  const pagamento = despesa.data_pagamento ? dataLocalDeUtc(despesa.data_pagamento) : null;
  const competencia = despesa.competencia || despesa.data_vencimento || pagamento || dataLocalDeUtc(despesa.criado_em);
  const bloqueio = require('./contabilService').bloqueioPorFechamento(despesa.location_id, [competencia, pagamento]);
  if (bloqueio) return bloqueio;

  db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);

  try {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso, entidade, entidade_id, dados_antes)
       VALUES (?, 'despesa_removida', ?, ?, 1, 'expenses', ?, ?)`
    ).run(
      randomUUID(), operadorId,
      `Despesa "${despesa.descricao}" (R$ ${Number(despesa.valor).toFixed(2)}) excluída${despesa.data_pagamento ? ' — já estava paga' : ''}`,
      expenseId, JSON.stringify(despesa)
    );
  } catch (err) { /* auditoria não deve travar a exclusão se falhar */ }

  return { ok: true };
}

module.exports = { create, markAsPaid, list, listPending, remove };
