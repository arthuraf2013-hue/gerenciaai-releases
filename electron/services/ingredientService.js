const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function list({ query } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM ingredients WHERE ativo = 1';
  const params = [];
  if (query) {
    sql += ' AND nome LIKE ?';
    params.push(`%${query}%`);
  }
  sql += ' ORDER BY nome';
  return db.prepare(sql).all(...params);
}

function upsert(ingredient) {
  if (!ingredient.nome?.trim()) return { ok: false, error: 'Informe o nome do insumo.' };
  if (Number.isNaN(Number(ingredient.custoUnitario)) || Number(ingredient.custoUnitario) < 0) {
    return { ok: false, error: 'Custo unitário inválido.' };
  }

  const db = getDb();
  const id = ingredient.id || randomUUID();

  db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo)
     VALUES (@id, @nome, @unidade, @custoUnitario, @estoqueAtual, @estoqueMinimo)
     ON CONFLICT(id) DO UPDATE SET
       nome=excluded.nome, unidade=excluded.unidade, custo_unitario=excluded.custo_unitario,
       estoque_atual=excluded.estoque_atual, estoque_minimo=excluded.estoque_minimo`
  ).run({
    id,
    nome: ingredient.nome.trim(),
    unidade: ingredient.unidade || 'un',
    custoUnitario: Number(ingredient.custoUnitario) || 0,
    estoqueAtual: Number(ingredient.estoqueAtual) || 0,
    estoqueMinimo: Number(ingredient.estoqueMinimo) || 0,
  });

  return { ok: true, id };
}

function deactivate(id) {
  const db = getDb();
  db.prepare('UPDATE ingredients SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

/** Ficha técnica de um prato — quais insumos e quanto de cada. */
function getRecipe(productId) {
  const db = getDb();
  return db.prepare(
    `SELECT di.*, i.nome, i.unidade, i.custo_unitario
     FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
     WHERE di.product_id = ? ORDER BY i.nome`
  ).all(productId);
}

/** Substitui a ficha técnica inteira de um prato pela lista enviada —
 * mais simples do que tentar calcular diffs, e o formulário sempre
 * manda a lista completa mesmo assim. */
function setRecipe(productId, itens) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM dish_ingredients WHERE product_id = ?').run(productId);
    for (const item of itens || []) {
      if (!item.ingredientId || !item.quantidade || Number(item.quantidade) <= 0) continue;
      db.prepare(
        `INSERT INTO dish_ingredients (id, product_id, ingredient_id, quantidade) VALUES (?, ?, ?, ?)`
      ).run(randomUUID(), productId, item.ingredientId, Number(item.quantidade));
    }
  });
  tx();
  return { ok: true };
}

/** Custo calculado do prato, somando quantidade × custo unitário de
 * cada insumo da ficha técnica. Retorna 0 se não tiver ficha técnica
 * cadastrada ainda (não é erro — só não tem base pra calcular). */
function computeDishCost(productId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(di.quantidade * i.custo_unitario), 0) as custo
     FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
     WHERE di.product_id = ?`
  ).get(productId);
  return row.custo;
}

module.exports = { list, upsert, deactivate, getRecipe, setRecipe, computeDishCost };
