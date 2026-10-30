const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Custo médio ponderado móvel (ERP, Fase 1).
 *
 * Toda ENTRADA com custo conhecido recalcula products.custo:
 *
 *   médio novo = (qtd atual × médio atual + qtd entrada × custo entrada)
 *                / (qtd atual + qtd entrada)
 *
 * Saída (venda, perda, ajuste) não muda o médio -- só a quantidade.
 * Entrada SEM custo (ajuste manual, entrada pelo celular) também não muda:
 * equivale a entrar pelo médio atual.
 *
 * "Qtd atual" é o estoque do produto somando todos os locais -- o custo é
 * do produto, não do local. Estoque zerado ou negativo (vendeu sem dar
 * entrada) não tem médio confiável pra ponderar: o novo médio passa a ser
 * o custo da própria entrada. products.custo continua editável no
 * cadastro; a ponderação parte do valor que estiver lá na hora.
 *
 * As funções que gravam recebem o `db` e devem ser chamadas DENTRO da
 * transação de quem dá a entrada, ANTES de gravar o movimento de estoque
 * (a quantidade "antes" é lida do ledger naquele instante).
 */

const CASAS_CUSTO = 4; // o médio guarda 4 casas; a tela mostra 2

function arredondar(valor, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(valor) + Number.EPSILON) * f) / f;
}

function estoqueTotal(db, productId) {
  return db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS total FROM stock_movements WHERE product_id = ?')
    .get(productId).total;
}

/** Conta pura, sem banco -- é o que os testes conferem número a número. */
function calcularMedio({ qtdAntes, custoAntes, qtdEntrada, custoEntrada }) {
  const q0 = Number(qtdAntes) || 0;
  const c0 = Number(custoAntes) || 0;
  const q1 = Number(qtdEntrada);
  const c1 = Number(custoEntrada);
  if (!(q1 > 0) || !(c1 >= 0)) throw new Error('Entrada de custo precisa de quantidade positiva e custo não negativo.');
  if (q0 <= 0) return arredondar(c1, CASAS_CUSTO);
  return arredondar((q0 * c0 + q1 * c1) / (q0 + q1), CASAS_CUSTO);
}

/**
 * Desfaz uma entrada no médio (estorno). Se a conta não fechar -- o que
 * sobra de estoque é zero/negativo, ou o resultado sairia negativo porque
 * o estoque já foi vendido a outro médio -- mantém o médio atual: é o
 * valor mais defensável que existe naquele ponto.
 */
function calcularMedioSemEntrada({ qtdAntes, custoAntes, qtdEstornada, custoEstornado }) {
  const q0 = Number(qtdAntes) || 0;
  const c0 = Number(custoAntes) || 0;
  const q1 = Number(qtdEstornada) || 0;
  const c1 = Number(custoEstornado) || 0;
  const restante = q0 - q1;
  if (restante <= 0) return arredondar(c0, CASAS_CUSTO);
  const medio = (q0 * c0 - q1 * c1) / restante;
  if (!(medio >= 0)) return arredondar(c0, CASAS_CUSTO);
  return arredondar(medio, CASAS_CUSTO);
}

/**
 * Aplica uma entrada com custo: grava o livro e atualiza products.custo.
 * Devolve { custoAntes, custoDepois, qtdAntes }.
 */
function registrarEntrada(db, { productId, quantidade, custoUnitario, origem, origemId, operadorId }) {
  const produto = db.prepare('SELECT id, custo FROM products WHERE id = ?').get(productId);
  if (!produto) throw new Error('Produto não encontrado para atualizar o custo.');
  const qtdAntes = estoqueTotal(db, productId);
  const custoAntes = Number(produto.custo) || 0;
  const custoDepois = calcularMedio({ qtdAntes, custoAntes, qtdEntrada: quantidade, custoEntrada: custoUnitario });
  db.prepare(
    `INSERT INTO product_cost_history
       (id, product_id, tipo, qtd_antes, custo_antes, qtd_movimento, custo_movimento, custo_depois, origem, origem_id, operador_id)
     VALUES (?, ?, 'entrada', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), productId, qtdAntes, custoAntes, Number(quantidade), arredondar(custoUnitario, CASAS_CUSTO),
    custoDepois, origem, origemId || null, operadorId || null);
  db.prepare('UPDATE products SET custo = ? WHERE id = ?').run(custoDepois, productId);
  return { qtdAntes, custoAntes, custoDepois };
}

/** Estorno de uma entrada com custo -- mesmo contrato de registrarEntrada
 * (chamar antes de gravar o movimento de saída do estorno). */
function registrarEstorno(db, { productId, quantidade, custoUnitario, origem, origemId, operadorId }) {
  const produto = db.prepare('SELECT id, custo FROM products WHERE id = ?').get(productId);
  if (!produto) throw new Error('Produto não encontrado para atualizar o custo.');
  const qtdAntes = estoqueTotal(db, productId);
  const custoAntes = Number(produto.custo) || 0;
  const custoDepois = calcularMedioSemEntrada({ qtdAntes, custoAntes, qtdEstornada: quantidade, custoEstornado: custoUnitario });
  db.prepare(
    `INSERT INTO product_cost_history
       (id, product_id, tipo, qtd_antes, custo_antes, qtd_movimento, custo_movimento, custo_depois, origem, origem_id, operador_id)
     VALUES (?, ?, 'estorno', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), productId, qtdAntes, custoAntes, Number(quantidade), arredondar(custoUnitario, CASAS_CUSTO),
    custoDepois, origem, origemId || null, operadorId || null);
  db.prepare('UPDATE products SET custo = ? WHERE id = ?').run(custoDepois, productId);
  return { qtdAntes, custoAntes, custoDepois };
}

/** Histórico de custo de um produto, mais recente primeiro. */
function historico(productId, { limite = 50 } = {}) {
  const db = getDb();
  return db.prepare(
    `SELECT h.*, u.nome AS operador_nome FROM product_cost_history h
     LEFT JOIN users u ON u.id = h.operador_id
     WHERE h.product_id = ? ORDER BY h.criado_em DESC, h.rowid DESC LIMIT ?`
  ).all(productId, Math.max(1, Math.min(500, Number(limite) || 50)));
}

module.exports = { calcularMedio, calcularMedioSemEntrada, registrarEntrada, registrarEstorno, historico, arredondar, estoqueTotal };
