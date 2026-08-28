const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const cashService = require('../electron/services/cashService');
const saleService = require('../electron/services/saleService');
const returnService = require('../electron/services/returnService');

test('não deixa abrir um segundo caixa enquanto o primeiro está aberto', () => {
  const ctx = freshTestDb();
  const primeira = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });
  assert.equal(primeira.ok, true);

  const segunda = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 50 });
  assert.equal(segunda.ok, false);
  assert.match(segunda.error, /já existe/i);
});

test('fechamento sem vendas espera exatamente o valor de abertura', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });

  const fechamento = cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: 100 });
  assert.equal(fechamento.ok, true);
  assert.equal(fechamento.valorEsperado, 100);
  assert.equal(fechamento.diferenca, 0);
});

test('venda em dinheiro depois da abertura entra no valor esperado do fechamento', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });

  const productId = createProduct(ctx.db, { preco: 30 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 30, detalhes: {} });
  saleService.finalizeSale(saleId);

  const resumo = cashService.getSessionSummary(sessionId);
  assert.equal(resumo.valorEsperado, 130); // 100 de abertura + 30 da venda em dinheiro

  const fechamentoComFalta = cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: 125 });
  assert.equal(fechamentoComFalta.diferenca, -5); // faltaram R$5
});

test('venda no cartão não entra no valor esperado em dinheiro', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });

  const productId = createProduct(ctx.db, { preco: 50 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  saleService.addPayment({ saleId, metodo: 'cartao_credito', valor: 50, detalhes: {} });
  saleService.finalizeSale(saleId);

  const resumo = cashService.getSessionSummary(sessionId);
  assert.equal(resumo.valorEsperado, 100); // cartão não conta como dinheiro físico no caixa
});

test('não deixa fechar um caixa que já foi fechado', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });
  cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: 100 });

  const segundoFechamento = cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: 100 });
  assert.equal(segundoFechamento.ok, false);
});

test('recusa abrir caixa com valor de abertura negativo', () => {
  const ctx = freshTestDb();
  const result = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: -50 });
  assert.equal(result.ok, false);
});

test('recusa fechar caixa com valor informado negativo', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });
  const result = cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: -10 });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------
// Devoluções de vendas pagas em dinheiro tiram dinheiro físico do caixa
// (o cliente é reembolsado na hora) -- sem isso, o caixa "falta" sempre
// que houve uma devolução.
// ---------------------------------------------------------------------

test('devolução de venda 100% em dinheiro reduz o valor esperado em dinheiro', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });

  const productId = createProduct(ctx.db, { preco: 30 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const { itemId } = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 30, detalhes: {} });
  saleService.finalizeSale(saleId);
  assert.equal(cashService.getSessionSummary(sessionId).valorEsperado, 130);

  const devolucao = returnService.createReturn({
    saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: itemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(devolucao.ok, true);

  const resumo = cashService.getSessionSummary(sessionId);
  assert.equal(resumo.totalDevolvidoEmDinheiro, 30);
  assert.equal(resumo.valorEsperado, 100); // 100 abertura + 30 venda - 30 devolvida em dinheiro
});

test('devolução de venda no cartão não mexe no valor esperado em dinheiro', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });

  const productId = createProduct(ctx.db, { preco: 50 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const { itemId } = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  saleService.addPayment({ saleId, metodo: 'cartao_credito', valor: 50, detalhes: {} });
  saleService.finalizeSale(saleId);

  returnService.createReturn({
    saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: itemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });

  const resumo = cashService.getSessionSummary(sessionId);
  assert.equal(resumo.totalDevolvidoEmDinheiro, 0);
  assert.equal(resumo.valorEsperado, 100); // devolução de venda no cartão não afeta dinheiro físico
});

test('devolução de venda com pagamento misto (dinheiro + cartão) abate só a parte em dinheiro', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });

  const productId = createProduct(ctx.db, { preco: 100 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const { itemId } = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  // venda de R$100: 40% dinheiro, 60% cartão
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 40, detalhes: {} });
  saleService.addPayment({ saleId, metodo: 'cartao_debito', valor: 60, detalhes: {} });
  saleService.finalizeSale(saleId);

  returnService.createReturn({
    saleId, locationId: ctx.locationId,
    itens: [{ saleItemId: itemId, quantidade: 1 }], // devolve o item inteiro, R$100
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });

  const resumo = cashService.getSessionSummary(sessionId);
  assert.equal(resumo.totalDevolvidoEmDinheiro, 40); // 40% de R$100
  assert.equal(resumo.valorEsperado, 100); // 100 abertura + 40 dinheiro da venda - 40 devolvido em dinheiro
});
