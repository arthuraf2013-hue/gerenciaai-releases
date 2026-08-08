const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const ingredientService = require('./ingredientService');

/** Sugestão de custo pra pré-preencher o formulário — só um ponto de
 * partida, o valor final sempre pode ser digitado/ajustado na hora. */
function suggestCost({ tipo, productId, ingredientId, quantidade }) {
  const db = getDb();
  const qtd = Number(quantidade) || 0;
  if (tipo === 'insumo' && ingredientId) {
    const ing = db.prepare('SELECT custo_unitario FROM ingredients WHERE id = ?').get(ingredientId);
    return (ing?.custo_unitario || 0) * qtd;
  }
  if (tipo === 'prato' && productId) {
    const custoBase = ingredientService.computeDishCost(productId);
    if (custoBase > 0) return custoBase * qtd;
    // Sem ficha técnica cadastrada pro prato — usa o custo de venda do
    // produto como aproximação (mais rústico, mas melhor que nada).
    const prod = db.prepare('SELECT custo FROM products WHERE id = ?').get(productId);
    return (prod?.custo || 0) * qtd;
  }
  return 0;
}

function registerWaste({ locationId, tipo, productId, ingredientId, quantidade, custoEstimado, motivo, operadorId }) {
  if (!['prato', 'insumo'].includes(tipo)) return { ok: false, error: 'Tipo inválido.' };
  if (tipo === 'prato' && !productId) return { ok: false, error: 'Selecione o prato.' };
  if (tipo === 'insumo' && !ingredientId) return { ok: false, error: 'Selecione o insumo.' };
  if (!quantidade || Number(quantidade) <= 0) return { ok: false, error: 'Informe uma quantidade válida.' };
  if (custoEstimado === undefined || custoEstimado === null || Number.isNaN(Number(custoEstimado)) || Number(custoEstimado) < 0) {
    return { ok: false, error: 'Informe o valor gasto (pode ser 0, mas precisa ser um número).' };
  }

  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO waste_log (id, location_id, tipo, product_id, ingredient_id, quantidade, custo_estimado, motivo, operador_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, locationId, tipo, productId || null, ingredientId || null, Number(quantidade), Number(custoEstimado), motivo || null, operadorId || null);

  return { ok: true, id };
}

function listWaste({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  return db.prepare(
    `SELECT w.*, p.nome as prato_nome, i.nome as insumo_nome, u.nome as operador_nome
     FROM waste_log w
     LEFT JOIN products p ON p.id = w.product_id
     LEFT JOIN ingredients i ON i.id = w.ingredient_id
     LEFT JOIN users u ON u.id = w.operador_id
     WHERE w.location_id = ? AND date(w.criado_em, '-3 hours') BETWEEN date(?) AND date(?)
     ORDER BY w.criado_em DESC`
  ).all(locationId, dataInicio, dataFim);
}

function getWasteSummary({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(custo_estimado), 0) as total, COUNT(*) as eventos
     FROM waste_log WHERE location_id = ? AND date(criado_em, '-3 hours') BETWEEN date(?) AND date(?)`
  ).get(locationId, dataInicio, dataFim);
  return row;
}

/** Total perdido por dia num período — pro gráfico do Painel. */
function getWasteByDay({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  return db.prepare(
    `SELECT date(criado_em, '-3 hours') as dia, COALESCE(SUM(custo_estimado), 0) as total
     FROM waste_log WHERE location_id = ? AND date(criado_em, '-3 hours') BETWEEN date(?) AND date(?)
     GROUP BY date(criado_em, '-3 hours') ORDER BY dia`
  ).all(locationId, dataInicio, dataFim);
}

module.exports = { suggestCost, registerWaste, listWaste, getWasteSummary, getWasteByDay };
