const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const ingredientService = require('../electron/services/ingredientService');

function criarInsumo(db, { estoqueAtual, custoUnitario = 1 } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo) VALUES (?, ?, 'un', ?, ?, 0)`
  ).run(id, `Insumo ${id.slice(0, 4)}`, custoUnitario, estoqueAtual);
  return id;
}

function vincularReceita(db, productId, ingredientId, quantidade) {
  db.prepare(`INSERT INTO dish_ingredients (id, product_id, ingredient_id, quantidade) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), productId, ingredientId, quantidade);
}

test('preverPorcoesPossiveis retorna null para produto sem ficha técnica', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { nome: 'Produto avulso' });
  assert.equal(ingredientService.preverPorcoesPossiveis(productId), null);
});

test('preverPorcoesPossiveis usa o insumo mais escasso como gargalo', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { nome: 'Bolo' });
  const farinha = criarInsumo(ctx.db, { estoqueAtual: 10 }); // 10 / 2 = 5 porções
  const ovo = criarInsumo(ctx.db, { estoqueAtual: 3 }); // 3 / 1 = 3 porções -- este é o gargalo
  vincularReceita(ctx.db, productId, farinha, 2);
  vincularReceita(ctx.db, productId, ovo, 1);

  assert.equal(ingredientService.preverPorcoesPossiveis(productId), 3);
});

test('preverPorcoesPossiveis arredonda pra baixo e nunca devolve negativo', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { nome: 'Bolo' });
  const farinha = criarInsumo(ctx.db, { estoqueAtual: 7 }); // 7 / 2 = 3.5 -> 3
  vincularReceita(ctx.db, productId, farinha, 2);
  assert.equal(ingredientService.preverPorcoesPossiveis(productId), 3);

  const productId2 = createProduct(ctx.db, { nome: 'Torta' });
  const queijo = criarInsumo(ctx.db, { estoqueAtual: -4 }); // estoque negativo (vendido além da conta)
  vincularReceita(ctx.db, productId2, queijo, 1);
  assert.equal(ingredientService.preverPorcoesPossiveis(productId2), 0); // nunca negativo
});

test('preverPorcoesPossiveisTodos devolve um mapa com todos os produtos que têm ficha técnica', () => {
  const ctx = freshTestDb();
  const bolo = createProduct(ctx.db, { nome: 'Bolo' });
  const torta = createProduct(ctx.db, { nome: 'Torta' });
  const semReceita = createProduct(ctx.db, { nome: 'Refrigerante' });
  const farinha = criarInsumo(ctx.db, { estoqueAtual: 10 });
  vincularReceita(ctx.db, bolo, farinha, 2);
  vincularReceita(ctx.db, torta, farinha, 5);

  const mapa = ingredientService.preverPorcoesPossiveisTodos();
  assert.equal(mapa[bolo], 5);
  assert.equal(mapa[torta], 2);
  assert.equal(semReceita in mapa, false);
});

test('descontarPorVenda e reverterPorVenda são simétricas', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { nome: 'Bolo' });
  const farinha = criarInsumo(ctx.db, { estoqueAtual: 10 });
  vincularReceita(ctx.db, productId, farinha, 2);

  ingredientService.descontarPorVenda(productId, 3);
  assert.equal(ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual, 4);

  ingredientService.reverterPorVenda(productId, 3);
  assert.equal(ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual, 10);
});
