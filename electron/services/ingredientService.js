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

  // No UPDATE (editar um insumo já existente), estoque_atual NÃO entra
  // no SET -- editar nome/unidade/custo usava o MESMO formulário que
  // "estoque atual", e sobrescrevia o estoque de verdade (direto, sem
  // log nenhum) toda vez que alguém só queria corrigir o custo, por
  // exemplo. Ajuste de estoque de insumo agora só acontece por
  // adjustStock, que fica registrado em ingredient_stock_movements
  // (auditoria, seção 4). estoque_atual só é gravado aqui na CRIAÇÃO
  // (INSERT) de um insumo novo, como estoque inicial.
  db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo)
     VALUES (@id, @nome, @unidade, @custoUnitario, @estoqueAtual, @estoqueMinimo)
     ON CONFLICT(id) DO UPDATE SET
       nome=excluded.nome, unidade=excluded.unidade, custo_unitario=excluded.custo_unitario,
       estoque_minimo=excluded.estoque_minimo`
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

const TIPOS_AJUSTE_VALIDOS = ['entrada', 'ajuste', 'perda'];

/**
 * Ajuste manual de estoque de insumo (entrada de mercadoria, perda,
 * correção de inventário) — separado de upsert (que só edita
 * nome/unidade/custo/mínimo) pra sempre deixar rastro de quem mudou o
 * estoque, quando, e por quê, igual ao que já existe pra estoque de
 * PRODUTO (stockService.adjustStock). O sinal de `quantidade` vem de
 * quem chama (positivo pra somar, negativo pra subtrair).
 */
function adjustStock({ ingredientId, quantidade, tipo, motivo, operadorId }) {
  if (!TIPOS_AJUSTE_VALIDOS.includes(tipo)) {
    return { ok: false, error: `Tipo de movimento inválido. Use: ${TIPOS_AJUSTE_VALIDOS.join(', ')}.` };
  }
  const qtd = Number(quantidade);
  if (!qtd || Number.isNaN(qtd)) {
    return { ok: false, error: 'Informe uma quantidade diferente de zero.' };
  }

  const db = getDb();
  const ingrediente = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingredientId);
  if (!ingrediente) return { ok: false, error: 'Insumo não encontrado.' };

  const estoqueDepois = ingrediente.estoque_atual + qtd;
  const id = randomUUID();

  const tx = db.transaction(() => {
    db.prepare('UPDATE ingredients SET estoque_atual = ? WHERE id = ?').run(estoqueDepois, ingredientId);
    db.prepare(
      `INSERT INTO ingredient_stock_movements (id, ingredient_id, tipo, quantidade, estoque_antes, estoque_depois, motivo, operador_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ingredientId, tipo, qtd, ingrediente.estoque_atual, estoqueDepois, motivo || null, operadorId || null);
  });
  tx();

  return { ok: true, id, estoqueAtual: estoqueDepois };
}

/** Histórico de ajustes de um insumo — mais recente primeiro. */
function listStockMovements(ingredientId) {
  const db = getDb();
  // criado_em só tem precisão de segundo (NOW_SYNCED) -- dois ajustes
  // feitos em rápida sucessão (comum: entrada seguida de uma correção)
  // empatam nesse campo, deixando a ordem entre eles arbitrária. rowid
  // sempre cresce na ordem de inserção, então desempata certo sem
  // precisar de uma coluna de sequência nova.
  return db.prepare(
    `SELECT m.*, u.nome as operador_nome FROM ingredient_stock_movements m
     LEFT JOIN users u ON u.id = m.operador_id
     WHERE m.ingredient_id = ? ORDER BY m.criado_em DESC, m.rowid DESC`
  ).all(ingredientId);
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

/**
 * Desconta o estoque de cada insumo da ficha técnica de um prato,
 * proporcional à quantidade vendida — chamada de DENTRO da transação
 * de saleService.addItem (mesma transação que já debita o estoque do
 * PRODUTO em si), pra manter os dois descontos atômicos: se um falhar,
 * o outro também não é gravado. Por isso não abre a própria transação
 * aqui (nested transaction não é permitido no better-sqlite3) — só usa
 * prepared statements soltos, que entram na transação de quem chamou.
 * Produto sem ficha técnica cadastrada: não faz nada (silencioso).
 * Não bloqueia a venda se o insumo não tiver estoque suficiente — só
 * desconta (podendo ficar negativo), igual a um ajuste manual de
 * estoque já permite hoje. Bloquear a venda por causa do insumo não
 * foi pedido e mudaria o fluxo do caixa.
 */
function descontarPorVenda(productId, quantidadeVendida) {
  const db = getDb();
  const receita = db.prepare('SELECT ingredient_id, quantidade FROM dish_ingredients WHERE product_id = ?').all(productId);
  for (const linha of receita) {
    db.prepare('UPDATE ingredients SET estoque_atual = estoque_atual - ? WHERE id = ?')
      .run(linha.quantidade * quantidadeVendida, linha.ingredient_id);
  }
}

/** Estorna (devolve) o estoque de insumos de um prato cancelado —
 * espelho exato de descontarPorVenda, chamada de dentro da mesma
 * transação de saleService.cancelSaleItem/cancelSale. */
function reverterPorVenda(productId, quantidadeCancelada) {
  const db = getDb();
  const receita = db.prepare('SELECT ingredient_id, quantidade FROM dish_ingredients WHERE product_id = ?').all(productId);
  for (const linha of receita) {
    db.prepare('UPDATE ingredients SET estoque_atual = estoque_atual + ? WHERE id = ?')
      .run(linha.quantidade * quantidadeCancelada, linha.ingredient_id);
  }
}

/**
 * Previsão de quantas porções de um prato dá pra fazer com o estoque
 * ATUAL dos insumos — cálculo direto (não é "IA" nenhuma, só divisão:
 * pra cada insumo da receita, estoque_atual / quantidade_por_porção,
 * arredondado pra baixo; o prato só pode ser feito tantas vezes quanto
 * o insumo mais escasso permitir). Sem ficha técnica: retorna null
 * (não aplicável — diferente de 0, que sugeriria estoque zerado).
 */
function preverPorcoesPossiveis(productId) {
  const db = getDb();
  const receita = db.prepare(
    `SELECT di.quantidade, i.estoque_atual FROM dish_ingredients di
     JOIN ingredients i ON i.id = di.ingredient_id WHERE di.product_id = ?`
  ).all(productId);
  if (receita.length === 0) return null;

  let porcoes = Infinity;
  for (const linha of receita) {
    if (!(linha.quantidade > 0)) continue;
    porcoes = Math.min(porcoes, Math.floor(linha.estoque_atual / linha.quantidade));
  }
  return Number.isFinite(porcoes) ? Math.max(0, porcoes) : null;
}

/** Mesma previsão, mas pra todos os produtos com ficha técnica de uma
 * vez só — evita uma chamada IPC por prato quando o Cardápio do dia
 * precisa mostrar o badge em cada um. Devolve um mapa productId -> porções. */
function preverPorcoesPossiveisTodos() {
  const db = getDb();
  const produtos = db.prepare('SELECT DISTINCT product_id FROM dish_ingredients').all();
  const resultado = {};
  for (const { product_id } of produtos) {
    resultado[product_id] = preverPorcoesPossiveis(product_id);
  }
  return resultado;
}

module.exports = {
  list, upsert, deactivate, adjustStock, listStockMovements, getRecipe, setRecipe, computeDishCost,
  descontarPorVenda, reverterPorVenda, preverPorcoesPossiveis, preverPorcoesPossiveisTodos,
};
