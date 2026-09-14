const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const quoteService = require('../electron/services/quoteService');
const ingredientService = require('../electron/services/ingredientService');

test('cria orçamento e adiciona item, sem mexer em estoque', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35 });
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  assert.equal(quote.ok, true);

  const item = quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 5 });
  assert.equal(item.ok, true);

  const estoque = db.prepare('SELECT COALESCE(SUM(quantidade),0) as t FROM stock_movements WHERE product_id = ?').get(produtoId).t;
  assert.equal(estoque, 10, 'orçamento não deveria mexer em estoque');
});

test('getQuote calcula o total certo somando os itens', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35 });

  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 5 });

  const cheio = quoteService.getQuote(quote.id);
  assert.equal(cheio.total, 175);
  assert.equal(cheio.items.length, 1);
});

test('adicionar o mesmo produto duas vezes soma a quantidade, não duplica a linha', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35 });
  const quote = quoteService.createQuote({ locationId, operadorId: adminId });

  quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 3 });
  quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 2 });

  const cheio = quoteService.getQuote(quote.id);
  assert.equal(cheio.items.length, 1);
  assert.equal(cheio.items[0].quantidade, 5);
});

test('converter orçamento em venda desconta o estoque de verdade e marca como convertido', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35 });
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 5 });

  const resultado = quoteService.convertToSale({ quoteId: quote.id, operadorId: adminId, deviceId: 'device-teste' });
  assert.equal(resultado.ok, true);
  assert.ok(resultado.saleId);

  const estoque = db.prepare('SELECT COALESCE(SUM(quantidade),0) as t FROM stock_movements WHERE product_id = ?').get(produtoId).t;
  assert.equal(estoque, 5);

  const quoteDepois = quoteService.getQuote(quote.id);
  assert.equal(quoteDepois.status, 'convertido');
  assert.equal(quoteDepois.sale_id, resultado.saleId);
});

test('conversão com estoque insuficiente falha sem deixar rastro órfão, orçamento continua aberto', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35 });
  addStock(db, { productId: produtoId, locationId, quantidade: 3, operadorId: adminId }); // só 3, vai pedir 10

  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 10 });

  const resultado = quoteService.convertToSale({ quoteId: quote.id, operadorId: adminId, deviceId: 'device-teste' });
  assert.equal(resultado.ok, false);

  const totalVendas = db.prepare('SELECT COUNT(*) as c FROM sales').get().c;
  assert.equal(totalVendas, 0, 'não deveria sobrar venda órfã');

  const quoteDepois = quoteService.getQuote(quote.id);
  assert.equal(quoteDepois.status, 'aberto', 'deveria continuar aberto pra tentar de novo');
});

/**
 * O rollback de convertToSale só desfazia stock_movements/sale_items/
 * sales -- não devolvia o insumo de ficha técnica que addItem já tinha
 * descontado dos itens adicionados ANTES do item que falhou. Estoque de
 * insumo vazava (ficava sutilmente a menos do que devia) toda vez que
 * uma conversão falhava no meio do caminho (auditoria, seção 3).
 */
test('conversão que falha no meio reverte o insumo de ficha técnica já descontado, não deixa vazar estoque', () => {
  const { db, locationId, adminId } = freshTestDb();

  const pratoId = createProduct(db, { nome: 'Prato com Ficha', preco: 20 });
  addStock(db, { productId: pratoId, locationId, quantidade: 10, operadorId: adminId });
  const arroz = ingredientService.upsert({ nome: 'Arroz', custoUnitario: 1, estoqueAtual: 100 });
  ingredientService.setRecipe(pratoId, [{ ingredientId: arroz.id, quantidade: 2 }]); // 2kg de arroz por porção

  // Segundo item da lista, sem estoque suficiente -- é o que derruba a
  // conversão no meio, DEPOIS do prato já ter sido adicionado e já ter
  // descontado o arroz.
  const semEstoqueId = createProduct(db, { nome: 'Sem Estoque Suficiente', preco: 5 });
  addStock(db, { productId: semEstoqueId, locationId, quantidade: 1, operadorId: adminId });

  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  quoteService.addQuoteItem({ quoteId: quote.id, productId: pratoId, quantidade: 3 }); // descontaria 6kg de arroz
  quoteService.addQuoteItem({ quoteId: quote.id, productId: semEstoqueId, quantidade: 5 }); // só tem 1 -- vai falhar

  const resultado = quoteService.convertToSale({ quoteId: quote.id, operadorId: adminId, deviceId: 'device-teste' });
  assert.equal(resultado.ok, false);

  const arrozDepois = db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(arroz.id).estoque_atual;
  assert.equal(arrozDepois, 100, 'insumo do item que chegou a ser adicionado deveria voltar ao normal depois do rollback');

  const totalVendas = db.prepare('SELECT COUNT(*) as c FROM sales').get().c;
  assert.equal(totalVendas, 0, 'não deveria sobrar venda órfã');

  const quoteDepois = quoteService.getQuote(quote.id);
  assert.equal(quoteDepois.status, 'aberto');
});

test('recusa converter orçamento vazio', () => {
  const { db, locationId, adminId } = freshTestDb();
  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  const resultado = quoteService.convertToSale({ quoteId: quote.id, operadorId: adminId, deviceId: 'device-teste' });
  assert.equal(resultado.ok, false);
});

test('cancelQuote marca como cancelado, e recusa cancelar de novo', () => {
  const { db, locationId, adminId } = freshTestDb();
  const quote = quoteService.createQuote({ locationId, operadorId: adminId });

  const r1 = quoteService.cancelQuote(quote.id);
  assert.equal(r1.ok, true);
  assert.equal(quoteService.getQuote(quote.id).status, 'cancelado');

  const r2 = quoteService.cancelQuote(quote.id);
  assert.equal(r2.ok, false);
});

test('recusa adicionar item a orçamento que não está mais aberto', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35 });
  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  quoteService.cancelQuote(quote.id);

  const resultado = quoteService.addQuoteItem({ quoteId: quote.id, productId: produtoId, quantidade: 1 });
  assert.equal(resultado.ok, false);
});

test('listQuotes filtra por status quando pedido', () => {
  const { db, locationId, adminId } = freshTestDb();
  const quote1 = quoteService.createQuote({ locationId, operadorId: adminId });
  const quote2 = quoteService.createQuote({ locationId, operadorId: adminId });
  quoteService.cancelQuote(quote2.id);

  const abertos = quoteService.listQuotes({ locationId, status: 'aberto' });
  assert.equal(abertos.length, 1);
  assert.equal(abertos[0].id, quote1.id);
});

// ---------- Orçamento pedido pelo chatbot (cliente ainda sem cadastro) ----------

test('createQuote grava cliente avulso (nome/telefone) e origem, mesmo sem customer_id', () => {
  const { locationId } = freshTestDb();
  const quote = quoteService.createQuote({
    locationId, clienteNomeAvulso: 'Roberto WhatsApp', clienteTelefoneAvulso: '5511900007777', origem: 'whatsapp_bot',
  });
  assert.equal(quote.ok, true);

  const cheio = quoteService.getQuote(quote.id);
  assert.equal(cheio.origem, 'whatsapp_bot');
  assert.equal(cheio.clienteNome, 'Roberto WhatsApp', 'clienteNome deveria cair pro avulso quando não tem customer_id');
  assert.equal(cheio.clienteTelefone, '5511900007777');

  const [naLista] = quoteService.listQuotes({ locationId });
  assert.equal(naLista.clienteNome, 'Roberto WhatsApp');
});

test('createQuote sem customer_id, sem avulso, e sem origem continua funcionando como orçamento manual de antes', () => {
  const { locationId, adminId } = freshTestDb();
  const quote = quoteService.createQuote({ locationId, operadorId: adminId });
  assert.equal(quote.ok, true);

  const cheio = quoteService.getQuote(quote.id);
  assert.equal(cheio.origem, 'manual', 'origem deveria cair pro padrão manual quando não especificada');
  assert.equal(cheio.clienteNome, null);
});

test('createQuote prefere o nome do cliente CADASTRADO quando tem customer_id, mesmo com avulso preenchido', () => {
  const { db, locationId } = freshTestDb();
  const clienteId = require('crypto').randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Cliente Cadastrado', '5511900008888');

  const quote = quoteService.createQuote({
    locationId, customerId: clienteId, clienteNomeAvulso: 'Nome Que Não Deveria Aparecer',
  });
  const cheio = quoteService.getQuote(quote.id);
  assert.equal(cheio.clienteNome, 'Cliente Cadastrado');
});
