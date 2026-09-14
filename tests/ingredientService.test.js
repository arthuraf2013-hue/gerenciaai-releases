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

// ---------------------------------------------------------------------
// upsert() editava nome/unidade/custo E sobrescrevia estoque_atual pelo
// MESMO formulário, sem log nenhum -- corrigir só o custo de um insumo
// zerava (ou trocava) o estoque de verdade por acidente. Agora upsert
// nunca mexe em estoque_atual numa edição; ajuste de estoque só
// acontece por adjustStock, que registra em ingredient_stock_movements
// (auditoria, seção 4).
// ---------------------------------------------------------------------

test('upsert em insumo NOVO grava o estoque inicial informado', () => {
  const { db } = freshTestDb();
  const r = ingredientService.upsert({ nome: 'Farinha', custoUnitario: 2, estoqueAtual: 50 });
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(r.id).estoque_atual, 50);
});

test('upsert em insumo EXISTENTE não mexe no estoque, mesmo se o formulário mandar outro valor', () => {
  const { db } = freshTestDb();
  const farinha = criarInsumo(db, { estoqueAtual: 30 });

  const r = ingredientService.upsert({ id: farinha, nome: 'Farinha de Trigo', custoUnitario: 3.5, estoqueAtual: 0 });
  assert.equal(r.ok, true);

  const depois = db.prepare('SELECT nome, custo_unitario, estoque_atual FROM ingredients WHERE id = ?').get(farinha);
  assert.equal(depois.nome, 'Farinha de Trigo', 'nome deveria ter mudado');
  assert.equal(depois.custo_unitario, 3.5, 'custo deveria ter mudado');
  assert.equal(depois.estoque_atual, 30, 'estoque NÃO deveria ter mudado só por editar nome/custo');
});

test('adjustStock aplica o delta, registra o movimento e devolve o estoque atualizado', () => {
  const { db } = freshTestDb();
  const farinha = criarInsumo(db, { estoqueAtual: 20 });

  const entrada = ingredientService.adjustStock({ ingredientId: farinha, quantidade: 10, tipo: 'entrada', motivo: 'nota 123', operadorId: null });
  assert.equal(entrada.ok, true);
  assert.equal(entrada.estoqueAtual, 30);
  assert.equal(db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual, 30);

  const perda = ingredientService.adjustStock({ ingredientId: farinha, quantidade: -5, tipo: 'perda', motivo: 'vencido' });
  assert.equal(perda.ok, true);
  assert.equal(perda.estoqueAtual, 25);

  const movimentos = ingredientService.listStockMovements(farinha);
  assert.equal(movimentos.length, 2);
  assert.equal(movimentos[0].tipo, 'perda', 'mais recente primeiro');
  assert.equal(movimentos[0].estoque_antes, 30);
  assert.equal(movimentos[0].estoque_depois, 25);
  assert.equal(movimentos[1].tipo, 'entrada');
  assert.equal(movimentos[1].motivo, 'nota 123');
});

test('adjustStock recusa quantidade zero e tipo inválido', () => {
  const { db } = freshTestDb();
  const farinha = criarInsumo(db, { estoqueAtual: 20 });

  const zero = ingredientService.adjustStock({ ingredientId: farinha, quantidade: 0, tipo: 'entrada' });
  assert.equal(zero.ok, false);

  const tipoInvalido = ingredientService.adjustStock({ ingredientId: farinha, quantidade: 5, tipo: 'venda' });
  assert.equal(tipoInvalido.ok, false);

  assert.equal(db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual, 20, 'estoque não deveria ter mudado');
});

test('adjustStock recusa insumo inexistente', () => {
  freshTestDb();
  const r = ingredientService.adjustStock({ ingredientId: 'nao-existe', quantidade: 5, tipo: 'entrada' });
  assert.equal(r.ok, false);
});
