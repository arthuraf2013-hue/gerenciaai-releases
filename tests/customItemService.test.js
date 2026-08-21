const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const customItemService = require('../electron/services/customItemService');
const ingredientService = require('../electron/services/ingredientService');
const saleService = require('../electron/services/saleService');
const stockService = require('../electron/services/stockService');

function criarInsumo(db, { nome = 'Insumo Teste', estoqueAtual = 100, custoUnitario = 2 } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo) VALUES (?, ?, 'un', ?, ?, 0)`
  ).run(id, nome, custoUnitario, estoqueAtual);
  return id;
}

function vincularReceita(db, productId, ingredientId, quantidade) {
  db.prepare(`INSERT INTO dish_ingredients (id, product_id, ingredient_id, quantidade) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), productId, ingredientId, quantidade);
}

test('garantirProdutoPersonalizado cria o produto-âncora uma única vez, escondido do catálogo', () => {
  const ctx = freshTestDb();
  const id1 = customItemService.garantirProdutoPersonalizado();
  const id2 = customItemService.garantirProdutoPersonalizado();
  assert.equal(id1, id2);

  const produto = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(id1);
  assert.equal(produto.ativo, 0); // escondido de qualquer busca/catálogo
});

test('sugerirPreco soma o custo de linhas de insumo e de produto (com e sem ficha técnica)', () => {
  const ctx = freshTestDb();
  const farinha = criarInsumo(ctx.db, { custoUnitario: 3 }); // 0.5kg x R$3 = R$1.50
  const pizzaComReceita = createProduct(ctx.db, { nome: 'Pizza Calabresa', preco: 40 });
  const queijo = criarInsumo(ctx.db, { custoUnitario: 10 });
  vincularReceita(ctx.db, pizzaComReceita, queijo, 0.2); // R$2 por unidade inteira da pizza
  const refrigerante = createProduct(ctx.db, { nome: 'Refrigerante lata', preco: 6 });
  ctx.db.prepare('UPDATE products SET custo = 3 WHERE id = ?').run(refrigerante); // sem ficha técnica, custo direto

  const { custoEstimado } = customItemService.sugerirPreco({
    linhas: [
      { tipo: 'insumo', insumoId: farinha, modo: 'quantidade', quantidade: 0.5 },
      { tipo: 'produto', produtoId: pizzaComReceita, modo: 'percentual', percentual: 50 }, // metade da receita -> R$1
      { tipo: 'produto', produtoId: refrigerante, modo: 'quantidade', quantidade: 1 }, // R$3
    ],
  });

  assert.equal(custoEstimado, 1.5 + 1 + 3);
});

test('addCustomItem cria uma linha nova a cada chamada, mesmo repetindo o mesmo produto-âncora', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const insumo = criarInsumo(ctx.db);

  const r1 = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Pizza especial A', preco: 30,
    linhas: [{ tipo: 'insumo', insumoId: insumo, modo: 'quantidade', quantidade: 1 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  const r2 = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Drink especial B', preco: 15,
    linhas: [{ tipo: 'insumo', insumoId: insumo, modo: 'quantidade', quantidade: 1 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.itemId, r2.itemId);

  const itens = saleService.getSaleItemsDetail(saleId);
  assert.equal(itens.length, 2);
  assert.deepEqual(itens.map((i) => i.nome).sort(), ['Drink especial B', 'Pizza especial A']);

  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId);
  assert.equal(sale.total, 45);
});

test('addCustomItem desconta insumo direto e produto-componente via receita proporcional, com fallback pro estoque do produto sem ficha técnica', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const farinha = criarInsumo(ctx.db, { estoqueAtual: 10 });
  const calabresa = createProduct(ctx.db, { nome: 'Pizza Calabresa' });
  const queijoCalabresa = criarInsumo(ctx.db, { nome: 'Queijo', estoqueAtual: 20 });
  vincularReceita(ctx.db, calabresa, queijoCalabresa, 0.4); // 0.4 por unidade inteira

  const lataRefrigerante = createProduct(ctx.db, { nome: 'Lata refrigerante' }); // sem ficha técnica
  addStock(ctx.db, { productId: lataRefrigerante, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });

  const result = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Combo personalizado', preco: 25,
    linhas: [
      { tipo: 'insumo', insumoId: farinha, modo: 'quantidade', quantidade: 2 },
      { tipo: 'produto', produtoId: calabresa, modo: 'percentual', percentual: 50 }, // 0.5 unidade -> 0.2 de queijo
      { tipo: 'produto', produtoId: lataRefrigerante, modo: 'quantidade', quantidade: 3 },
    ],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(result.ok, true);

  const farinhaRestante = ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual;
  assert.equal(farinhaRestante, 8);

  const queijoRestante = ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(queijoCalabresa).estoque_atual;
  assert.equal(queijoRestante, 20 - 0.2);

  // Pizza Calabresa em si (o produto usado como componente) não perde
  // estoque próprio -- o desconto foi todo pra ficha técnica dela.
  assert.equal(stockService.getCurrentStock(calabresa, ctx.locationId), 0);

  // Lata de refrigerante NÃO tem ficha técnica -> desconta o estoque
  // dela mesma, direto (fallback).
  assert.equal(stockService.getCurrentStock(lataRefrigerante, ctx.locationId), 47);
});

test('cancelSaleItem de um item personalizado devolve o estoque de insumos e produtos-componente', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const farinha = criarInsumo(ctx.db, { estoqueAtual: 10 });
  const lataRefrigerante = createProduct(ctx.db, { nome: 'Lata refrigerante' });
  addStock(ctx.db, { productId: lataRefrigerante, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });

  const { itemId } = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Combo personalizado', preco: 25,
    linhas: [
      { tipo: 'insumo', insumoId: farinha, modo: 'quantidade', quantidade: 2 },
      { tipo: 'produto', produtoId: lataRefrigerante, modo: 'quantidade', quantidade: 3 },
    ],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual, 8);
  assert.equal(stockService.getCurrentStock(lataRefrigerante, ctx.locationId), 47);

  const cancelResult = saleService.cancelSaleItem({
    saleId, saleItemId: itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
    deviceId: 'device-teste',
  });
  assert.equal(cancelResult.ok, true);

  assert.equal(ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(farinha).estoque_atual, 10);
  assert.equal(stockService.getCurrentStock(lataRefrigerante, ctx.locationId), 50);

  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId);
  assert.equal(sale.total, 0);
});

test('addCustomItem recusa sem nome, sem preço válido, ou sem nenhuma linha', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const insumo = criarInsumo(ctx.db);

  const semNome = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: '  ', preco: 10,
    linhas: [{ tipo: 'insumo', insumoId: insumo, modo: 'quantidade', quantidade: 1 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(semNome.ok, false);

  const semLinhas = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Combo', preco: 10, linhas: [],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(semLinhas.ok, false);

  const precoInvalido = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Combo', preco: -5,
    linhas: [{ tipo: 'insumo', insumoId: insumo, modo: 'quantidade', quantidade: 1 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(precoInvalido.ok, false);
});

test('listRecentlySold nunca inclui o produto-âncora personalizado nos atalhos', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const insumo = criarInsumo(ctx.db);
  saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Combo personalizado', preco: 10,
    linhas: [{ tipo: 'insumo', insumoId: insumo, modo: 'quantidade', quantidade: 1 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  const recentes = saleService.listRecentlySold({ locationId: ctx.locationId, modo: 'recente' });
  const frequentes = saleService.listRecentlySold({ locationId: ctx.locationId, modo: 'frequente' });
  assert.equal(recentes.find((p) => p.id === customItemService.PRODUTO_PERSONALIZADO_ID), undefined);
  assert.equal(frequentes.find((p) => p.id === customItemService.PRODUTO_PERSONALIZADO_ID), undefined);
});

test('ajustarLinhas aplica só a diferença (delta) no estoque do insumo', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const carne = criarInsumo(ctx.db, { estoqueAtual: 10 });

  const { itemId } = saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Prato personalizado', preco: 20,
    linhas: [{ tipo: 'insumo', insumoId: carne, modo: 'quantidade', quantidade: 0.3 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(carne).estoque_atual, 9.7);

  const [linha] = ctx.db.prepare('SELECT * FROM custom_item_lines WHERE sale_item_id = ?').all(itemId);
  const ajusteResult = customItemService.ajustarLinhas({
    ajustes: [{ linhaId: linha.id, quantidadeFinal: 0.35 }],
    operadorId: ctx.operadorId, locationId: ctx.locationId, deviceId: 'device-teste',
  });
  assert.equal(ajusteResult.ok, true);

  // Só desconta a diferença (0.05 a mais), não os 0.35 inteiros de novo.
  const estoqueFinal = ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(carne).estoque_atual;
  assert.ok(Math.abs(estoqueFinal - 9.65) < 1e-9, `esperava ~9.65, veio ${estoqueFinal}`);

  const linhaAtualizada = ctx.db.prepare('SELECT quantidade_ajustada FROM custom_item_lines WHERE id = ?').get(linha.id);
  assert.equal(linhaAtualizada.quantidade_ajustada, 0.35);
});

test('listItensParaAjuste devolve os itens personalizados recentes com as linhas de composição', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const carne = criarInsumo(ctx.db, { nome: 'Carne moída' });

  saleService.addCustomItem({
    saleId, locationId: ctx.locationId, nome: 'Hambúrguer especial', preco: 22,
    linhas: [{ tipo: 'insumo', insumoId: carne, modo: 'quantidade', quantidade: 0.2 }],
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  const lista = customItemService.listItensParaAjuste({ locationId: ctx.locationId, dias: 7 });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].nome, 'Hambúrguer especial');
  assert.equal(lista[0].linhas.length, 1);
  assert.equal(lista[0].linhas[0].nome, 'Carne moída');
  assert.equal(lista[0].linhas[0].quantidade, 0.2);
});
