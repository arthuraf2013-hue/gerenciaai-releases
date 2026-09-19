const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock, createSuporteUser } = require('./helpers/testDb');
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

// ---------------------------------------------------------------------
// Taxa de serviço de mesa (setServiceCharge) era só um percentual
// decorativo -- nunca entrava no total oficial da venda (sales.total),
// então: 1) um pagamento em cartão/pix que cobrisse exatamente o que a
// tela mostrou pro cliente (subtotal + taxa) era rejeitado pelo teto de
// addPayment; 2) finalizeSale deixava fechar a venda sem cobrir a taxa;
// 3) todo relatório que soma `total - desconto - desconto_gerente`
// (dashboard, etc.) subcontava o faturamento real (auditoria, seção 2).
// ---------------------------------------------------------------------

test('addPayment em cartão aceita cobrir subtotal + taxa de serviço (antes era rejeitado)', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 100, quantidadeVenda: 1 }); // total = 100
  saleService.setServiceCharge(ctx.saleId, 10); // 10% => deve poder cobrar até 110

  const exato = saleService.addPayment({ saleId: ctx.saleId, metodo: 'cartao_credito', valor: 110, detalhes: {} });
  assert.equal(exato.ok, true, 'pagamento de R$110 (100 + 10% de taxa) precisa ser aceito');
});

test('addPayment em cartão ainda rejeita valor acima de subtotal + taxa de serviço', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 100, quantidadeVenda: 1 }); // total = 100
  saleService.setServiceCharge(ctx.saleId, 10); // teto = 110

  const acima = saleService.addPayment({ saleId: ctx.saleId, metodo: 'cartao_credito', valor: 110.5, detalhes: {} });
  assert.equal(acima.ok, false);
});

test('finalizeSale exige que o pagamento cubra a taxa de serviço, não só o subtotal', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 100, quantidadeVenda: 1 }); // total = 100
  saleService.setServiceCharge(ctx.saleId, 10); // precisa de 110
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 100, detalhes: {} }); // só cobre o subtotal

  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, false);
  assert.match(result.error, /incompleto/i);
});

test('finalizeSale soma a taxa de serviço em sales.total -- passa a valer pro recibo e pros relatórios', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 100, quantidadeVenda: 1 }); // total = 100
  saleService.setServiceCharge(ctx.saleId, 10);
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 110, detalhes: {} });

  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, true);

  const saleFinal = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(saleFinal.total, 110, 'sales.total precisa já incluir a taxa de serviço depois de finalizada');
});

test('finalizeSale calcula a taxa de serviço sobre o subtotal DEPOIS do desconto, não sobre o valor bruto', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 100, quantidadeVenda: 1 }); // total = 100
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Teste' });
  ctx.db.prepare('UPDATE customers SET pontos = 200 WHERE id = ?').run(customerId);
  saleService.setCustomer(ctx.saleId, customerId);
  saleService.redeemLoyaltyPoints({ saleId: ctx.saleId, pontos: 200 }); // 200 * 0.05 = R$10 de desconto -> subtotal 90
  saleService.setServiceCharge(ctx.saleId, 10); // 10% de 90 = 9 -> deve cobrar 99

  const pagamento = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 99, detalhes: {} });
  assert.equal(pagamento.ok, true);
  const result = saleService.finalizeSale(ctx.saleId);
  assert.equal(result.ok, true);

  const saleFinal = ctx.db.prepare('SELECT total, desconto FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(saleFinal.total - saleFinal.desconto, 99);
});

test('finalizeSale recusa uma segunda chamada pra mesma venda (não duplica fiado nem pontos)', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 }); // total = 20
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Fiado' });
  saleService.setCustomer(ctx.saleId, customerId);
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'fiado', valor: 20, detalhes: {} });

  const primeira = saleService.finalizeSale(ctx.saleId);
  assert.equal(primeira.ok, true);
  const saldoDepoisDaPrimeira = customerService.getSaldoFiado(customerId);

  const segunda = saleService.finalizeSale(ctx.saleId);
  assert.equal(segunda.ok, false);
  assert.match(segunda.error, /não está mais aberta/i);

  const saldoFinal = customerService.getSaldoFiado(customerId);
  assert.equal(saldoFinal, saldoDepoisDaPrimeira, 'a dívida fiado não deveria dobrar numa segunda chamada');
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

// ---------------------------------------------------------------------
// addPayment não tinha teto nenhum contra o que falta da venda -- pra
// métodos sem troco (fiado, cartão, pix, outro) dava pra registrar um
// valor maior que o total, e no caso de fiado isso virava dívida de
// verdade em cima do cliente, maior que a própria venda (auditoria,
// seção 3). Dinheiro continua liberado pra passar (troco de verdade).
// ---------------------------------------------------------------------

test('addPayment recusa fiado maior que o total da venda — não pode inflar a dívida', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 }); // total = 10
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Fiado' });
  saleService.setCustomer(ctx.saleId, customerId);

  const resultado = saleService.addPayment({ saleId: ctx.saleId, metodo: 'fiado', valor: 50, detalhes: {} });
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /passa do que falta/i);
});

test('addPayment aceita pix maior que o que falta: limita ao restante e guarda o valor recebido', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 20, quantidadeVenda: 1 }); // total = 20
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 9, detalhes: {} }); // falta 11

  const pix = saleService.addPayment({ saleId: ctx.saleId, metodo: 'pix', valor: 15, detalhes: {} });
  assert.equal(pix.ok, true);
  assert.equal(pix.valor, 11);

  const fim = saleService.finalizeSale(ctx.saleId);
  assert.equal(fim.ok, true);
});

test('addPayment com pix numa venda já quitada não erra nem lança nada', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 20, quantidadeVenda: 1 });
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 20, detalhes: {} });

  const pix = saleService.addPayment({ saleId: ctx.saleId, metodo: 'pix', valor: 5, detalhes: {} });
  assert.equal(pix.ok, true);
  assert.equal(pix.semLancamento, true);
});

test('addPayment recusa cartão/pix/outro maior que o que falta, mesmo em split', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 20, quantidadeVenda: 1 }); // total = 20
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 5, detalhes: {} }); // falta 15

  const cartao = saleService.addPayment({ saleId: ctx.saleId, metodo: 'cartao_credito', valor: 15.01, detalhes: {} });
  assert.equal(cartao.ok, false);

  const exato = saleService.addPayment({ saleId: ctx.saleId, metodo: 'cartao_credito', valor: 15, detalhes: {} });
  assert.equal(exato.ok, true, 'valor exatamente igual ao que falta continua permitido');
});

test('addPayment em dinheiro pode passar do total — troco de verdade, não é bug', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 }); // total = 10
  const resultado = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 50, detalhes: {} });
  assert.equal(resultado.ok, true, 'dinheiro pode ser maior que o total — o troco é calculado em cima disso');
});

// ---------------------------------------------------------------------
// removePayment era a única operação sensível do domínio sem
// autorização de gerente nem trilha de auditoria — apagava dinheiro já
// lançado sem deixar rastro nenhum (auditoria, seção 3). Agora segue o
// mesmo padrão de cancelSaleItem/cancelSale/applyManagerDiscount.
// ---------------------------------------------------------------------

test('removePayment exige autorização de gerente quando a config está ligada (padrão)', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 });
  const pagamento = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });

  const semAuth = saleService.removePayment({ paymentId: pagamento.id, saleId: ctx.saleId, currentOperatorId: ctx.operadorId });
  assert.equal(semAuth.ok, false);

  const pagamentos = require('../electron/db/database').getDb()
    .prepare('SELECT COUNT(*) as c FROM payments WHERE sale_id = ?').get(ctx.saleId).c;
  assert.equal(pagamentos, 1, 'pagamento não pode sumir sem autorização');
});

test('removePayment rejeita quando o autorizador é o próprio operador do caixa', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 });
  const pagamento = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });

  const result = saleService.removePayment({
    paymentId: pagamento.id, saleId: ctx.saleId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.operadorId, pin: '5678',
  });
  assert.equal(result.ok, false);
});

test('removePayment autorizado por um gerente remove o pagamento e registra na auditoria', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 });
  const pagamento = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });

  const result = saleService.removePayment({
    paymentId: pagamento.id, saleId: ctx.saleId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
  });
  assert.equal(result.ok, true);

  const db = require('../electron/db/database').getDb();
  const pagamentos = db.prepare('SELECT COUNT(*) as c FROM payments WHERE sale_id = ?').get(ctx.saleId).c;
  assert.equal(pagamentos, 0);

  const auditoria = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'remocao_pagamento' AND sale_id = ?`).get(ctx.saleId);
  assert.ok(auditoria, 'precisa deixar rastro de auditoria');
  assert.equal(auditoria.sucesso, 1);
  assert.equal(auditoria.autorizado_por_id, ctx.gerenteId);
});

test('removePayment ainda registra na auditoria (sem exigir aprovação) quando a config está desligada', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 });
  const db = require('../electron/db/database').getDb();
  db.prepare('UPDATE security_config SET exigir_autorizacao_cancelamento = 0').run();
  const pagamento = saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });

  const result = saleService.removePayment({ paymentId: pagamento.id, saleId: ctx.saleId, currentOperatorId: ctx.operadorId });
  assert.equal(result.ok, true);

  const pagamentos = db.prepare('SELECT COUNT(*) as c FROM payments WHERE sale_id = ?').get(ctx.saleId).c;
  assert.equal(pagamentos, 0);

  const auditoria = db.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'remocao_pagamento_sem_autorizacao_configurada' AND sale_id = ?`).get(ctx.saleId);
  assert.ok(auditoria, 'mesmo sem exigir aprovação, precisa deixar rastro de quem removeu');
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

// ---------------------------------------------------------------------
// Venda de serviço (tipo='servico') — mão de obra, consulta, taxa: nunca
// tem estoque físico, então addItem/cancelSaleItem/cancelSale nunca podem
// gerar ou tentar estornar um stock_movements pra ele (saldo fantasma).
// ---------------------------------------------------------------------

test('addItem vende serviço mesmo com estoque zerado, sem gerar stock_movements', () => {
  const ctx = freshTestDb();
  const servicoId = createProduct(ctx.db, { nome: 'Corte de cabelo', preco: 50, tipo: 'servico' });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const result = saleService.addItem({
    saleId, productId: servicoId, locationId: ctx.locationId, quantidade: 1,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  const movimentos = ctx.db.prepare('SELECT COUNT(*) as c FROM stock_movements WHERE product_id = ?').get(servicoId).c;
  assert.equal(movimentos, 0, 'serviço nunca deveria gerar stock_movements');
});

test('cancelSaleItem de um serviço não gera estorno de estoque (nunca existiu)', () => {
  const ctx = freshTestDb();
  const servicoId = createProduct(ctx.db, { nome: 'Consulta', preco: 80, tipo: 'servico' });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const addResult = saleService.addItem({
    saleId, productId: servicoId, locationId: ctx.locationId, quantidade: 1,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  const result = saleService.cancelSaleItem({
    saleId, saleItemId: addResult.itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234',
    deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  const movimentos = ctx.db.prepare('SELECT COUNT(*) as c FROM stock_movements WHERE product_id = ?').get(servicoId).c;
  assert.equal(movimentos, 0, 'cancelar item de serviço não deveria gerar estorno de estoque');
});

test('cancelSale com item de serviço não gera estorno de estoque pra ele', () => {
  const ctx = freshTestDb();
  const servicoId = createProduct(ctx.db, { nome: 'Taxa de entrega', preco: 15, tipo: 'servico' });
  const produtoId = createProduct(ctx.db, { nome: 'Produto físico', preco: 10, estoqueMinimo: 1 });
  addStock(ctx.db, { productId: produtoId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId: servicoId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  saleService.addItem({ saleId, productId: produtoId, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  assert.equal(stockService.getCurrentStock(produtoId, ctx.locationId), 8);

  const result = saleService.cancelSale({
    saleId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId,
    candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  const movimentosServico = ctx.db.prepare('SELECT COUNT(*) as c FROM stock_movements WHERE product_id = ?').get(servicoId).c;
  assert.equal(movimentosServico, 0, 'serviço nunca deveria ter stock_movements, nem no cancelamento da venda inteira');
  assert.equal(stockService.getCurrentStock(produtoId, ctx.locationId), 10, 'estoque do produto físico deveria voltar ao normal');
});

// ---------------------------------------------------------------------
// setItemPrice — restrito a gerente/admin/suporte, checado no backend
// (não só escondido no botão "Editar preço" da tela).
// ---------------------------------------------------------------------

test('setItemPrice recusa operador (não tem acesso a alterar preço)', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10 });
  const result = saleService.setItemPrice({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, novoPreco: 5, currentOperatorId: ctx.operadorId,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /gerente ou admin/i);
});

test('setItemPrice funciona pra gerente e atualiza o total da venda', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 });
  const result = saleService.setItemPrice({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, novoPreco: 8, currentOperatorId: ctx.gerenteId,
  });
  assert.equal(result.ok, true);
  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 16); // 2 * 8
});

// ---------------------------------------------------------------------
// addItem, ao somar o MESMO produto que já está no carrinho (merge na
// linha existente em vez de criar uma nova), somava em sales.total o
// preço de CATÁLOGO recém-calculado -- não o preço que já estava na
// linha, mesmo quando esse preço tinha sido editado na mão com
// setItemPrice. Bipar de novo o mesmo produto depois de editar o preço
// dele fazia sales.total divergir da soma real de sale_items, usando o
// valor nativo em vez do editado (relatado pelo usuário: total exigido
// pra finalizar não batia com os valores alterados).
// ---------------------------------------------------------------------

test('addItem soma o preço EDITADO da linha (não o preço de catálogo) ao repetir o mesmo produto depois de setItemPrice', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 }); // 1un a R$10 -> total = 10

  const edicao = saleService.setItemPrice({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, novoPreco: 16, currentOperatorId: ctx.gerenteId,
  });
  assert.equal(edicao.ok, true);
  assert.equal(ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId).total, 16);

  // Bipa o MESMO produto de novo -- antes do fix, isso somava R$10
  // (preço de catálogo) em vez de R$16 (preço editado da linha).
  const segundo = saleService.addItem({
    saleId: ctx.saleId, productId: ctx.productId, locationId: ctx.locationId,
    quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(segundo.ok, true);
  assert.equal(segundo.quantidadeTotal, 2, 'devia mesclar na linha existente, não criar uma segunda');
  assert.equal(segundo.precoUnitario, 16, 'precoUnitario devolvido pra tela atualizar o total precisa ser o editado, não o de catálogo');

  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 32, '2 unidades a R$16 (preço editado) = 32 -- não 26 (16 + 10 do preço nativo)');

  const item = ctx.db.prepare('SELECT preco_unitario, quantidade FROM sale_items WHERE id = ?').get(ctx.addResult.itemId);
  assert.equal(sale.total, item.preco_unitario * item.quantidade, 'sales.total precisa bater com a soma real da linha (preco_unitario × quantidade)');
});

test('cancelar o único item de uma venda zera sales.total mesmo que ele já estivesse com deriva acumulada', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 }); // total = 10

  // Simula a deriva do bug antigo: sales.total fica acima do que a soma
  // real das linhas diz (ex: resto de um addItem que somou preço errado
  // antes do fix). cancelSaleItem precisa RECALCULAR do zero, não
  // subtrair só o valor do item cancelado -- senão esse resto (aqui,
  // R$1.98) sobrevive pra sempre no carrinho vazio, como aconteceu de
  // verdade.
  ctx.db.prepare('UPDATE sales SET total = total + 1.98 WHERE id = ?').run(ctx.saleId);
  assert.equal(ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId).total, 11.98);

  const result = saleService.cancelSaleItem({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(result.ok, true);
  assert.equal(result.novoTotal, 0, 'novoTotal devolvido pra tela precisa ser 0, não um resto de deriva antiga');

  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 0, 'carrinho sem nenhum item ativo tem que ter total 0, mesmo que sales.total já tivesse deriva acumulada antes');
});

test('cancelSale (venda inteira) zera sales.total mesmo com deriva acumulada, e devolve novoTotal', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 1 });
  ctx.db.prepare('UPDATE sales SET total = total + 1.98 WHERE id = ?').run(ctx.saleId);

  const result = saleService.cancelSale({
    saleId: ctx.saleId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId,
    candidateManagerId: ctx.gerenteId, pin: '1234', motivo: 'Teste', deviceId: 'device-teste',
  });
  assert.equal(result.ok, true);
  assert.equal(result.novoTotal, 0);

  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 0, 'cancelSale nunca tocava em sales.total antes -- agora tem que recalcular e zerar');
});

test('setItemPrice funciona pra suporte, igual gerente/admin', () => {
  const ctx = abrirVendaComItem(freshTestDb(), { preco: 10, quantidadeVenda: 2 });
  const suporteId = createSuporteUser(ctx.db);
  const result = saleService.setItemPrice({
    saleId: ctx.saleId, saleItemId: ctx.addResult.itemId, novoPreco: 8, currentOperatorId: suporteId,
  });
  assert.equal(result.ok, true);
  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 16);
});

// ---------------------------------------------------------------------
// editarHistoricoVenda — restrito a admin/suporte, checado no backend.
// ---------------------------------------------------------------------

function abrirVendaFinalizada(ctx, { preco = 10, quantidadeVenda = 1 } = {}) {
  const comItem = abrirVendaComItem(ctx, { preco, quantidadeVenda });
  saleService.addPayment({ saleId: comItem.saleId, metodo: 'dinheiro', valor: preco * quantidadeVenda, detalhes: {} });
  saleService.finalizeSale(comItem.saleId);
  return comItem;
}

test('editarHistoricoVenda recusa gerente (só admin/suporte pode)', async () => {
  const ctx = abrirVendaFinalizada(freshTestDb());
  const result = await saleService.editarHistoricoVenda({
    saleId: ctx.saleId, novoTotal: 50, currentOperatorId: ctx.gerenteId,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /admin/i);
});

test('editarHistoricoVenda funciona pra admin e o total realmente muda', async () => {
  const ctx = abrirVendaFinalizada(freshTestDb());
  const result = await saleService.editarHistoricoVenda({
    saleId: ctx.saleId, novoTotal: 50, currentOperatorId: ctx.adminId,
  });
  assert.equal(result.ok, true);
  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 50);
});

test('editarHistoricoVenda funciona pra suporte, igual admin', async () => {
  const ctx = abrirVendaFinalizada(freshTestDb());
  const suporteId = createSuporteUser(ctx.db);
  const result = await saleService.editarHistoricoVenda({
    saleId: ctx.saleId, novoTotal: 42, currentOperatorId: suporteId,
  });
  assert.equal(result.ok, true);
  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.total, 42);
});

// ---------------------------------------------------------------------
// excluirDoHistorico/reexibirNoHistorico — restrito a gerente/admin/
// suporte (mesmo nível de acesso do botão na tela de Histórico), checado
// no backend, não só escondido no botão.
// ---------------------------------------------------------------------

test('excluirDoHistorico recusa operador', () => {
  const ctx = abrirVendaFinalizada(freshTestDb());
  const result = saleService.excluirDoHistorico({ saleId: ctx.saleId, operadorId: ctx.operadorId });
  assert.equal(result.ok, false);
  assert.match(result.error, /gerente ou admin/i);
  const sale = ctx.db.prepare('SELECT oculta_historico FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.oculta_historico, 0, 'nada deveria ter mudado quando a permissão é recusada');
});

test('excluirDoHistorico funciona pra gerente e reexibirNoHistorico desfaz', () => {
  const ctx = abrirVendaFinalizada(freshTestDb());

  const excluir = saleService.excluirDoHistorico({ saleId: ctx.saleId, operadorId: ctx.gerenteId, motivo: 'teste' });
  assert.equal(excluir.ok, true);
  assert.equal(ctx.db.prepare('SELECT oculta_historico FROM sales WHERE id = ?').get(ctx.saleId).oculta_historico, 1);

  const reexibirComOperador = saleService.reexibirNoHistorico({ saleId: ctx.saleId, operadorId: ctx.operadorId });
  assert.equal(reexibirComOperador.ok, false, 'operador também não deveria poder reexibir');

  const reexibir = saleService.reexibirNoHistorico({ saleId: ctx.saleId, operadorId: ctx.gerenteId });
  assert.equal(reexibir.ok, true);
  assert.equal(ctx.db.prepare('SELECT oculta_historico FROM sales WHERE id = ?').get(ctx.saleId).oculta_historico, 0);
});

test('excluirDoHistorico funciona pra suporte, igual admin', () => {
  const ctx = abrirVendaFinalizada(freshTestDb());
  const suporteId = createSuporteUser(ctx.db);
  const result = saleService.excluirDoHistorico({ saleId: ctx.saleId, operadorId: suporteId });
  assert.equal(result.ok, true);
});
