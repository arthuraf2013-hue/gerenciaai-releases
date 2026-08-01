const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function list({ query } = {}) {
  const db = getDb();
  if (query) {
    return db.prepare(
      `SELECT * FROM customers WHERE ativo = 1 AND (nome LIKE ? OR telefone LIKE ? OR cpf LIKE ? OR cnpj LIKE ?) ORDER BY nome`
    ).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  }
  return db.prepare('SELECT * FROM customers WHERE ativo = 1 ORDER BY nome').all();
}

function upsert(customer) {
  if (!customer.nome?.trim()) return { ok: false, error: 'Informe o nome do cliente.' };
  const db = getDb();
  const id = customer.id || randomUUID();
  db.prepare(
    `INSERT INTO customers (id, nome, telefone, cpf, cnpj) VALUES (@id, @nome, @telefone, @cpf, @cnpj)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone, cpf=excluded.cpf, cnpj=excluded.cnpj`
  ).run({ id, nome: customer.nome.trim(), telefone: customer.telefone || null, cpf: customer.cpf || null, cnpj: customer.cnpj || null });
  return { ok: true, id };
}

/** Saldo devedor = soma dos movimentos de fiado (dívida positiva, pagamento negativo no saldo). */
function getSaldoFiado(customerId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END), 0) as saldo
     FROM customer_credit_movements WHERE customer_id = ?`
  ).get(customerId);
  return row.saldo;
}

function listWithSaldo({ query } = {}) {
  return list({ query }).map((c) => ({ ...c, saldoFiado: getSaldoFiado(c.id) }));
}

function getCreditHistory(customerId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM customer_credit_movements WHERE customer_id = ? ORDER BY criado_em DESC`
  ).all(customerId);
}

/** Chamado pelo saleService quando uma venda com pagamento 'fiado' é registrada. */
function registrarDivida({ customerId, valor, saleId, operadorId }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, operador_id) VALUES (?, ?, 'divida', ?, ?, ?)`
  ).run(randomUUID(), customerId, valor, saleId, operadorId);
}

function registrarPagamento({ customerId, valor, motivo, operadorId }) {
  const db = getDb();
  if (valor <= 0) return { ok: false, error: 'Informe um valor de pagamento válido.' };
  db.prepare(
    `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, motivo, operador_id) VALUES (?, ?, 'pagamento', ?, ?, ?)`
  ).run(randomUUID(), customerId, valor, motivo || null, operadorId);
  return { ok: true, saldoAtual: getSaldoFiado(customerId) };
}

// --- Fidelidade ---

function getLoyaltyConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM loyalty_config WHERE id = ?').get('default');
}

function updateLoyaltyConfig(payload) {
  const db = getDb();
  const current = getLoyaltyConfig();
  db.prepare(
    `UPDATE loyalty_config SET ativado = ?, reais_por_ponto = ?, valor_resgate_ponto = ? WHERE id = 'default'`
  ).run(
    payload.ativado ? 1 : 0,
    payload.reaisPorPonto ?? current.reais_por_ponto,
    payload.valorResgatePonto ?? current.valor_resgate_ponto
  );
  return { ok: true };
}

/** Chamado ao finalizar uma venda vinculada a um cliente — soma pontos
 * proporcional ao valor pago (não ao valor com desconto, para não criar
 * um ciclo de pontos gerando mais pontos). */
function acumularPontos(customerId, valorVenda) {
  const db = getDb();
  const config = getLoyaltyConfig();
  if (!config.ativado || !customerId) return;
  const pontosGanhos = Math.floor(valorVenda / config.reais_por_ponto);
  if (pontosGanhos > 0) {
    db.prepare('UPDATE customers SET pontos = pontos + ? WHERE id = ?').run(pontosGanhos, customerId);
  }
}

/** Resgata pontos como desconto — devolve o valor do desconto sem
 * debitar ainda (o débito de pontos só acontece se a venda for
 * finalizada de fato, ver saleService). */
function calcularValorResgate(pontos) {
  const config = getLoyaltyConfig();
  return Number((pontos * config.valor_resgate_ponto).toFixed(2));
}

function debitarPontos(customerId, pontos) {
  const db = getDb();
  db.prepare('UPDATE customers SET pontos = MAX(0, pontos - ?) WHERE id = ?').run(pontos, customerId);
}

module.exports = {
  list, upsert, getSaldoFiado, listWithSaldo, getCreditHistory, registrarDivida, registrarPagamento,
  getLoyaltyConfig, updateLoyaltyConfig, acumularPontos, calcularValorResgate, debitarPontos,
};
