const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function getOpenSession(locationId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM cash_sessions WHERE location_id = ? AND status = 'aberta' ORDER BY aberta_em DESC LIMIT 1`
  ).get(locationId);
}

function openSession({ locationId, operadorId, valorAbertura }) {
  if (!locationId) {
    return { ok: false, error: 'Local (loja) não identificado. Reinicie o app — se persistir, avise o suporte.' };
  }
  const valor = Number(valorAbertura);
  if (Number.isNaN(valor) || valor < 0) {
    return { ok: false, error: 'Valor de abertura inválido.' };
  }

  const db = getDb();
  const existing = getOpenSession(locationId);
  if (existing) return { ok: false, error: 'Já existe um caixa aberto para este local.' };

  const id = randomUUID();
  db.prepare(
    `INSERT INTO cash_sessions (id, location_id, operador_abertura_id, valor_abertura) VALUES (?, ?, ?, ?)`
  ).run(id, locationId, operadorId, valor);

  return { ok: true, id };
}

/** Resumo para a tela de fechamento: quanto o sistema espera encontrar em dinheiro. */
function getSessionSummary(sessionId) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const porMetodo = db.prepare(
    `SELECT p.metodo, COALESCE(SUM(p.valor), 0) as total
     FROM payments p
     JOIN sales s ON s.id = p.sale_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ?
     GROUP BY p.metodo`
  ).all(session.location_id, session.aberta_em);

  const totalDinheiro = porMetodo.find((m) => m.metodo === 'dinheiro')?.total || 0;
  const valorEsperado = session.valor_abertura + totalDinheiro;

  return {
    session,
    porMetodo,
    valorAbertura: session.valor_abertura,
    totalVendasDinheiro: totalDinheiro,
    valorEsperado,
  };
}

function closeSession({ sessionId, operadorId, valorInformado }) {
  const db = getDb();
  const summary = getSessionSummary(sessionId);
  if (!summary) return { ok: false, error: 'Sessão de caixa não encontrada.' };
  if (summary.session.status !== 'aberta') return { ok: false, error: 'Este caixa já foi fechado.' };

  const valor = Number(valorInformado);
  if (Number.isNaN(valor) || valor < 0) {
    return { ok: false, error: 'Valor informado inválido.' };
  }

  const diferenca = valor - summary.valorEsperado;

  db.prepare(
    `UPDATE cash_sessions SET
       status = 'fechada', operador_fechamento_id = ?, valor_fechamento_informado = ?,
       valor_fechamento_esperado = ?, diferenca = ?, fechada_em = NOW_SYNCED()
     WHERE id = ?`
  ).run(operadorId, valor, summary.valorEsperado, diferenca, sessionId);

  return { ok: true, valorEsperado: summary.valorEsperado, diferenca };
}

module.exports = { getOpenSession, openSession, getSessionSummary, closeSession };
