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

  // Devoluções feitas durante esta sessão também tiram dinheiro do caixa
  // físico (o cliente é reembolsado na hora) -- ignorar isso fazia o caixa
  // "faltar" dinheiro sempre que havia uma devolução de venda paga (ao
  // menos em parte) em dinheiro. Não existe campo de "método de
  // reembolso" nas devoluções, então a estimativa é proporcional: se a
  // venda original foi X% paga em dinheiro, assume-se que X% do valor
  // devolvido saiu do caixa em dinheiro também.
  const devolucoesDoPeriodo = db.prepare(
    `SELECT r.sale_id, r.valor_devolvido FROM returns r
     WHERE r.location_id = ? AND r.criado_em >= ?`
  ).all(session.location_id, session.aberta_em);

  let totalDevolvidoEmDinheiro = 0;
  for (const devolucao of devolucoesDoPeriodo) {
    if (!(devolucao.valor_devolvido > 0)) continue;
    const pagamentosDaVenda = db.prepare(
      `SELECT metodo, COALESCE(SUM(valor), 0) as total FROM payments WHERE sale_id = ? GROUP BY metodo`
    ).all(devolucao.sale_id);
    const totalPagoNaVenda = pagamentosDaVenda.reduce((soma, p) => soma + p.total, 0);
    const totalPagoEmDinheiro = pagamentosDaVenda.find((p) => p.metodo === 'dinheiro')?.total || 0;
    if (totalPagoNaVenda > 0 && totalPagoEmDinheiro > 0) {
      totalDevolvidoEmDinheiro += devolucao.valor_devolvido * (totalPagoEmDinheiro / totalPagoNaVenda);
    }
  }

  const valorEsperado = session.valor_abertura + totalDinheiro - totalDevolvidoEmDinheiro;

  return {
    session,
    porMetodo,
    valorAbertura: session.valor_abertura,
    totalVendasDinheiro: totalDinheiro,
    totalDevolvidoEmDinheiro,
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

/** Lista os fechamentos de caixa de um período — pra conferir
 * diferenças ao longo do tempo, não só sessão por sessão. */
function listClosedSessions({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  return db.prepare(
    `SELECT cs.*, ua.nome as operador_abertura_nome, uf.nome as operador_fechamento_nome
     FROM cash_sessions cs
     JOIN users ua ON ua.id = cs.operador_abertura_id
     LEFT JOIN users uf ON uf.id = cs.operador_fechamento_id
     WHERE cs.location_id = ? AND cs.status = 'fechada'
       AND date(cs.fechada_em) BETWEEN date(?) AND date(?)
     ORDER BY cs.fechada_em DESC`
  ).all(locationId, dataInicio, dataFim);
}

/** Resumo do período — quantas sessões, soma das diferenças (positiva
 * = sobrou, negativa = faltou), e quantas bateram exatamente certo. */
function getClosedSessionsSummary({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) as total_sessoes,
       COALESCE(SUM(diferenca), 0) as soma_diferencas,
       COALESCE(SUM(CASE WHEN diferenca = 0 THEN 1 ELSE 0 END), 0) as sessoes_certas,
       COALESCE(SUM(CASE WHEN diferenca != 0 THEN 1 ELSE 0 END), 0) as sessoes_com_diferenca
     FROM cash_sessions
     WHERE location_id = ? AND status = 'fechada' AND date(fechada_em) BETWEEN date(?) AND date(?)`
  ).get(locationId, dataInicio, dataFim);
  return row;
}

module.exports = { getOpenSession, openSession, getSessionSummary, closeSession, listClosedSessions, getClosedSessionsSummary };
