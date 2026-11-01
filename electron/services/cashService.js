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
       -- Venda que veio do PDV mobile (importada na migração ou recebida
       -- de um celular que é terminal deste computador) foi recebida no
       -- caixa DO CELULAR, não na gaveta deste computador -- contar aqui
       -- fazia o fechamento acusar sobra que não existe. A venda do "PDV
       -- móvel" pareado (origem 'pdv_movel') continua contando: essa é
       -- feita no caixa daqui. json_valid antes: detalhes antigo pode não
       -- ser JSON (json_extract lançaria erro).
       AND COALESCE(CASE WHEN json_valid(p.detalhes) THEN json_extract(p.detalhes, '$.origem') END, '') NOT IN ('pdv_mobile', 'pdv_mobile_terminal')
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

  // Sangria (dinheiro retirado da gaveta) e suprimento (troco colocado).
  const movimentos = listarMovimentos(sessionId);
  const totalSangrias = arred(movimentos.filter((m) => m.tipo === 'sangria').reduce((s, m) => s + m.valor, 0));
  const totalSuprimentos = arred(movimentos.filter((m) => m.tipo === 'suprimento').reduce((s, m) => s + m.valor, 0));

  const valorEsperado = arred(session.valor_abertura + totalDinheiro + totalSuprimentos - totalSangrias - totalDevolvidoEmDinheiro);

  return {
    session,
    porMetodo,
    valorAbertura: session.valor_abertura,
    totalVendasDinheiro: totalDinheiro,
    totalDevolvidoEmDinheiro,
    totalSangrias,
    totalSuprimentos,
    movimentos,
    valorEsperado,
  };
}

const arred = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function listarMovimentos(sessionId) {
  const db = getDb();
  try {
    return db.prepare(
      `SELECT m.*, u.nome AS operador_nome FROM cash_movements m LEFT JOIN users u ON u.id = m.operador_id
       WHERE m.cash_session_id = ? ORDER BY m.criado_em, m.rowid`
    ).all(sessionId);
  } catch (err) {
    // Migração versionada ainda não aplicada (ver db/migracoes.js): o
    // fechamento de caixa do PDV não pode parar por causa disso.
    if (/no such table/i.test(err.message || '')) return [];
    throw err;
  }
}

/**
 * Sangria (tira dinheiro da gaveta: depósito, pagamento de fornecedor em
 * espécie) ou suprimento (coloca troco). Só com caixa aberto; sangria não
 * pode passar do dinheiro que o sistema espera ter na gaveta. Não se
 * altera nem apaga depois (gatilho no banco): errou, lança o inverso.
 */
function registrarMovimento({ sessionId, tipo, valor, motivo, operadorId }) {
  if (!['sangria', 'suprimento'].includes(tipo)) return { ok: false, error: 'Escolha sangria ou suprimento.' };
  const v = arred(valor);
  if (!(v > 0)) return { ok: false, error: 'Informe um valor maior que zero.' };
  const texto = String(motivo || '').trim().slice(0, 200);
  if (tipo === 'sangria' && !texto) return { ok: false, error: 'Diga o motivo da sangria (ex.: depósito no banco, pagamento de fornecedor).' };
  const db = getDb();
  const resumo = getSessionSummary(sessionId);
  if (!resumo) return { ok: false, error: 'Caixa não encontrado.' };
  if (resumo.session.status !== 'aberta') return { ok: false, error: 'Este caixa já foi fechado.' };
  if (tipo === 'sangria' && v > resumo.valorEsperado + 0.005) {
    return { ok: false, error: `A sangria passa do dinheiro que deveria estar na gaveta (R$ ${resumo.valorEsperado.toFixed(2)}). Confira o valor.` };
  }
  const id = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO cash_movements (id, cash_session_id, tipo, valor, motivo, operador_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, tipo, v, texto || null, operadorId);
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso, entidade, entidade_id, dados_depois)
       VALUES (?, ?, ?, ?, 1, 'cash_movements', ?, ?)`
    ).run(randomUUID(), `caixa_${tipo}`, operadorId || null, `${tipo === 'sangria' ? 'Sangria' : 'Suprimento'} de R$ ${v.toFixed(2)}${texto ? ` — ${texto}` : ''}`, id, JSON.stringify({ sessionId, tipo, valor: v, motivo: texto || null }));
  })();
  return { ok: true, id, valorEsperado: getSessionSummary(sessionId).valorEsperado };
}

/** Caixa aberto do local com o resumo (tela Caixa). */
function caixaAtual({ locationId }) {
  const sessao = getOpenSession(locationId);
  if (!sessao) return { ok: true, aberto: false };
  const db = getDb();
  const operador = db.prepare('SELECT nome FROM users WHERE id = ?').get(sessao.operador_abertura_id);
  return { ok: true, aberto: true, operadorAberturaNome: operador?.nome || null, ...getSessionSummary(sessao.id) };
}

// Formas que se conferem no fechamento além do dinheiro (fiado não: é dívida do cliente).
const METODOS_CONFERIDOS = ['pix', 'cartao_debito', 'cartao_credito', 'outro'];

function closeSession({ sessionId, operadorId, valorInformado, conferencia }) {
  const db = getDb();
  const summary = getSessionSummary(sessionId);
  if (!summary) return { ok: false, error: 'Sessão de caixa não encontrada.' };
  if (summary.session.status !== 'aberta') return { ok: false, error: 'Este caixa já foi fechado.' };

  const valor = Number(valorInformado);
  if (Number.isNaN(valor) || valor < 0) {
    return { ok: false, error: 'Valor informado inválido.' };
  }

  const diferenca = arred(valor - summary.valorEsperado);

  // Conferência opcional das outras formas (comprovantes da maquininha,
  // extrato do Pix): o que o lojista contou × o que o sistema registrou.
  let diferencasPorMetodo = null;
  if (conferencia && typeof conferencia === 'object') {
    diferencasPorMetodo = [];
    for (const metodo of METODOS_CONFERIDOS) {
      const esperado = arred(summary.porMetodo.find((m) => m.metodo === metodo)?.total || 0);
      const bruto = conferencia[metodo];
      if (bruto === undefined || bruto === null || bruto === '') {
        if (esperado > 0) diferencasPorMetodo.push({ metodo, esperado, informado: null, diferenca: null });
        continue;
      }
      const informado = Number(bruto);
      if (!Number.isFinite(informado) || informado < 0) return { ok: false, error: 'Valor conferido inválido.' };
      diferencasPorMetodo.push({ metodo, esperado, informado: arred(informado), diferenca: arred(informado - esperado) });
    }
  }

  // conferencia_json só entra no UPDATE quando há conferência: o fechamento
  // simples (tela do PDV) não depende da coluna da migração versionada.
  const r = db.prepare(
    `UPDATE cash_sessions SET
       status = 'fechada', operador_fechamento_id = ?, valor_fechamento_informado = ?,
       valor_fechamento_esperado = ?, diferenca = ?, fechada_em = NOW_SYNCED()${diferencasPorMetodo ? ', conferencia_json = ?' : ''}
     WHERE id = ? AND status = 'aberta'`
  ).run(...[operadorId, valor, summary.valorEsperado, diferenca, ...(diferencasPorMetodo ? [JSON.stringify(diferencasPorMetodo)] : []), sessionId]);
  if (r.changes === 0) return { ok: false, error: 'Este caixa já foi fechado.' };

  return { ok: true, valorEsperado: summary.valorEsperado, diferenca, diferencasPorMetodo };
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

module.exports = {
  getOpenSession, openSession, getSessionSummary, closeSession, listClosedSessions, getClosedSessionsSummary,
  registrarMovimento, listarMovimentos, caixaAtual, METODOS_CONFERIDOS,
};
