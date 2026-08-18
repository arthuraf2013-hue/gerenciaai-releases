const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const stockService = require('../electron/services/stockService');
const customerService = require('../electron/services/customerService');

function abrirVendaComItem(ctx, { quantidadeEstoque = 10, quantidadeVenda = 1, preco = 10 } = {}) {
  const productId = createProduct(ctx.db, { preco, estoqueMinimo: 2 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: quantidadeEstoque, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const addResult = saleService.addItem({
    saleId, productId, locationId: ctx.locationId, quantidade: quantidadeVenda,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  return { ...ctx, productId, saleId, addResult };
}

test('addItem recusa vender mais do que o estoque disponível', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const result = saleService.addItem({
    saleId, productId, locationId: ctx.locationId, quantidade: 5, // pede mais do que tem (2)
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /insuficiente/i);
});

test('addItem baixa o estoque imediatamente ao vender', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { quantidadeEstoque: 10, quantidadeVenda: 3 });
  assert.equal(ctx.addResult.ok, true);
  const estoqueAtual = stockService.getCurrentStock(ctx.productId, ctx.locationId);
  assert.equal(estoqueAtual, 7);
});

test('cancelSaleItem rejeita quando o autorizador é o próprio operador do caixa', () => {
  const ctx = abrirVendaComItem(freshTestDb());
  // Autorização só é exigida depois que já tem pagamento registrado —
  // sem isso, o cancelamento é livre por design, e o teste não estaria
  // testando a rejeição de autoaprovação de verdade.
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10 });
  const result = saleService.cancelSaleItem({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.operadorId, pin: '5678',
    deviceId: 'device-teste',
  });
  assert.equal(result.ok, false);
});

test('cancelSaleItem autorizado por um gerente diferente estorna o estoque', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { quantidadeEstoque: 10, quantidadeVenda: 4 });
  assert.equal(stockService.getCurrentStock(ctx.productId, ctx.locationId), 6);

  const result = saleService.cancelSaleItem({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
    deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  assert.equal(stockService.getCurrentStock(ctx.productId, ctx.locationId), 10); // voltou ao original
});

function criarPratoComReceita(ctx, { estoqueFarinha = 10, estoqueOvo = 20, qtdFarinhaPorPrato = 2, qtdOvoPorPrato = 1 } = {}) {
  const { randomUUID } = require('crypto');
  const farinhaId = randomUUID();
  const ovoId = randomUUID();
  ctx.db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo) VALUES (?, 'Farinha', 'kg', 5, ?, 1)`
  ).run(farinhaId, estoqueFarinha);
  ctx.db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo) VALUES (?, 'Ovo', 'un', 1, ?, 6)`
  ).run(ovoId, estoqueOvo);

  const productId = createProduct(ctx.db, { nome: 'Bolo', preco: 30, estoqueMinimo: 0 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 999, operadorId: ctx.adminId }); // estoque do produto em si nunca é o gargalo aqui
  ctx.db.prepare(`INSERT INTO dish_ingredients (id, product_id, ingredient_id, quantidade) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), productId, farinhaId, qtdFarinhaPorPrato);
  ctx.db.prepare(`INSERT INTO dish_ingredients (id, product_id, ingredient_id, quantidade) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), productId, ovoId, qtdOvoPorPrato);

  return { ...ctx, productId, farinhaId, ovoId };
}

function estoqueInsumo(db, ingredientId) {
  return db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(ingredientId).estoque_atual;
}

test('addItem desconta os insumos da ficha técnica do prato vendido', () => {
  const ctx = criarPratoComReceita(freshTestDb());
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const result = saleService.addItem({
    saleId, productId: ctx.productId, locationId: ctx.locationId, quantidade: 3,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  assert.equal(estoqueInsumo(ctx.db, ctx.farinhaId), 10 - 2 * 3); // 3 bolos x 2kg de farinha cada
  assert.equal(estoqueInsumo(ctx.db, ctx.ovoId), 20 - 1 * 3); // 3 bolos x 1 ovo cada
});

test('addItem em produto sem ficha técnica não mexe em nenhum insumo', () => {
  const ctx = criarPratoComReceita(freshTestDb());
  const produtoSemReceita = createProduct(ctx.db, { nome: 'Refrigerante', preco: 8 });
  addStock(ctx.db, { productId: produtoSemReceita, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const result = saleService.addItem({
    saleId, productId: produtoSemReceita, locationId: ctx.locationId, quantidade: 2,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  assert.equal(estoqueInsumo(ctx.db, ctx.farinhaId), 10); // intocado
  assert.equal(estoqueInsumo(ctx.db, ctx.ovoId), 20); // intocado
});

test('cancelSaleItem devolve os insumos descontados', () => {
  const ctx = criarPratoComReceita(freshTestDb());
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const addResult = saleService.addItem({
    saleId, productId: ctx.productId, locationId: ctx.locationId, quantidade: 4,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(estoqueInsumo(ctx.db, ctx.farinhaId), 10 - 2 * 4);

  const cancelResult = saleService.cancelSaleItem({
    saleId, saleItemId: addResult.itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
    deviceId: 'device-teste',
  });

  assert.equal(cancelResult.ok, true);
  assert.equal(estoqueInsumo(ctx.db, ctx.farinhaId), 10); // voltou ao original
  assert.equal(estoqueInsumo(ctx.db, ctx.ovoId), 20);
});

test('cancelSale devolve os insumos de todos os itens em aberto', () => {
  const ctx = criarPratoComReceita(freshTestDb());
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({
    saleId, productId: ctx.productId, locationId: ctx.locationId, quantidade: 5,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(estoqueInsumo(ctx.db, ctx.farinhaId), 10 - 2 * 5);

  const cancelResult = saleService.cancelSale({
    saleId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId,
    candidateManagerId: ctx.gerenteId, pin: '1234', motivo: 'Teste', deviceId: 'device-teste',
  });

  assert.equal(cancelResult.ok, true);
  assert.equal(estoqueInsumo(ctx.db, ctx.farinhaId), 10);
  assert.equal(estoqueInsumo(ctx.db, ctx.ovoId), 20);
});

test('finalizeSale recusa quando o pagamento não cobre o total', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 15, detalhes: {} });
  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, false);
  assert.match(result.error, /incompleto/i);
});

test('finalizeSale aceita quando o pagamento cobre exatamente o total', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 20, detalhes: {} });
  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, true);
});

test('desconto de fidelidade reduz o valor exigido no pagamento', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Teste' });
  ctx.db.prepare('UPDATE customers SET pontos = 100 WHERE id = ?').run(customerId);
  saleService.setCustomer(ctx.saleId, customerId);

  const resgate = saleService.redeemLoyaltyPoints({ saleId: ctx.saleId, pontos: 100 }); // 100 * 0.05 = R$5 de desconto
  assert.equal(resgate.ok, true);
  assert.equal(resgate.desconto, 5);

  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 15, detalhes: {} }); // 20 - 5 = 15
  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, true);

  const clienteDepois = ctx.db.prepare('SELECT pontos FROM customers WHERE id = ?').get(customerId);
  assert.equal(clienteDepois.pontos, 0); // pontos debitados após finalizar
});

test('pagamento em fiado exige cliente vinculado à venda', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'fiado', valor: 20, detalhes: {} });
  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, false);
  assert.match(result.error, /cliente/i);
});

test('pagamento em fiado registra a dívida no cliente vinculado', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Fiado' });
  saleService.setCustomer(ctx.saleId, customerId);
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'fiado', valor: 20, detalhes: {} });

  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, true);
  assert.equal(customerService.getSaldoFiado(customerId), 20);
});

// --- Testes da auditoria de pré-produção ---

test('addItem recusa quantidade zero ou negativa', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const zero = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 0, operadorId: ctx.operadorId, deviceId: 'd' });
  const negativo = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: -1, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(zero.ok, false);
  assert.equal(negativo.ok, false);
});

test('addItem recusa adicionar item numa venda já finalizada', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1, quantidadeEstoque: 10 });
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });
  saleService.finalizeSale(ctx.saleId);

  const result = saleService.addItem({
    saleId: ctx.saleId, productId: ctx.productId, locationId: ctx.locationId,
    quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /não está mais aberta/i);
});

test('addPayment recusa valor zero ou negativo', () => {
  const ctx = abrirVendaComItem(freshTestDb());
  const zero = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 0, detalhes: {} });
  const negativo = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: -5, detalhes: {} });
  assert.equal(zero.ok, false);
  assert.equal(negativo.ok, false);
});

test('cancelSale recusa cancelar uma venda já finalizada (paga)', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1, quantidadeEstoque: 10 });
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });
  saleService.finalizeSale(ctx.saleId);

  const result = saleService.cancelSale({
    saleId: ctx.saleId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId,
    candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /já foi finalizada/i);
});

test('redeemLoyaltyPoints recusa pontos zero ou negativos (evita desconto negativo)', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 });
  const { id: customerId } = customerService.upsert({ nome: 'Cliente X' });
  ctx.db.prepare('UPDATE customers SET pontos = 100 WHERE id = ?').run(customerId);
  saleService.setCustomer(ctx.saleId, customerId);

  const zero = saleService.redeemLoyaltyPoints({ saleId: ctx.saleId, pontos: 0 });
  const negativo = saleService.redeemLoyaltyPoints({ saleId: ctx.saleId, pontos: -10 });
  assert.equal(zero.ok, false);
  assert.equal(negativo.ok, false);
});

test('applyManagerDiscount rejeita quando o autorizador é o próprio operador', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const result = saleService.applyManagerDiscount({
    saleId: ctx.saleId, valor: 5, motivo: 'cliente antigo',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.operadorId, pin: '5678',
  });
  assert.equal(result.ok, false);
});

test('applyManagerDiscount recusa valor zero ou maior que o total da venda', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const zero = saleService.applyManagerDiscount({
    saleId: ctx.saleId, valor: 0, motivo: '',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
  });
  assert.equal(zero.ok, false);

  const excessivo = saleService.applyManagerDiscount({
    saleId: ctx.saleId, valor: 999, motivo: '',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
  });
  assert.equal(excessivo.ok, false);
});

test('applyManagerDiscount autorizado reduz o total a pagar, e convive com o desconto de fidelidade', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const { id: customerId } = customerService.upsert({ nome: 'Cliente VIP' });
  ctx.db.prepare('UPDATE customers SET pontos = 100 WHERE id = ?').run(customerId); // 100 pontos * 0.05 = R$5
  saleService.setCustomer(ctx.saleId, customerId);
  saleService.redeemLoyaltyPoints({ saleId: ctx.saleId, pontos: 100 }); // desconto fidelidade = 5

  const desconto = saleService.applyManagerDiscount({
    saleId: ctx.saleId, valor: 3, motivo: 'cliente antigo',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
  });
  assert.equal(desconto.ok, true);

  // total 20 - fidelidade 5 - gerente 3 = 12 a pagar
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 12, detalhes: {} });
  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, true);
});

test('desconto de fidelidade não estoura o total quando somado ao desconto de gerente já aplicado', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Y' });
  ctx.db.prepare('UPDATE customers SET pontos = 1000 WHERE id = ?').run(customerId); // pontos de sobra
  saleService.setCustomer(ctx.saleId, customerId);

  saleService.applyManagerDiscount({
    saleId: ctx.saleId, valor: 18, motivo: '',
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
  });
  // só sobram R$2 de total — mesmo pedindo resgate que valeria mais que isso, trava em 2
  const resgate = saleService.redeemLoyaltyPoints({ saleId: ctx.saleId, pontos: 1000 }); // valeria R$50
  assert.equal(resgate.ok, true);
  assert.equal(resgate.desconto, 2);
});
