// Pagamento individual na mesa e − / + no carrinho (nov/2026).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const tableService = require('../electron/services/tableService');
const ingredientService = require('../electron/services/ingredientService');
const { getCurrentStock } = require('../electron/services/stockService');

function carregarUtil() {
  const r = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/utils/contaPorPessoa.js')], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const m = { exports: {} };
  new Function('module', 'exports', r.outputFiles[0].text)(m, m.exports);
  return m.exports;
}
const U = carregarUtil();

test('parte de cada pessoa: proporcional, com taxa e desconto, e a soma bate com a conta', () => {
  const conta = { subtotalItens: 100, desconto: 10, taxaServicoPercentual: 10 };
  assert.equal(U.totalDaConta(conta), 99);
  const ana = U.valorDaPessoa({ ...conta, subtotalPessoa: 60 });
  const bia = U.valorDaPessoa({ ...conta, subtotalPessoa: 40 });
  assert.equal(ana, 59.4);
  assert.equal(bia, 39.6);
  assert.equal(ana + bia, 99);
  assert.equal(U.valorDaPessoa({ subtotalItens: 0, subtotalPessoa: 10 }), 0);
  assert.deepEqual(U.situacaoDaPessoa({ valor: 59.4, pago: 0 }), { estado: 'aberta', falta: 59.4 });
  assert.deepEqual(U.situacaoDaPessoa({ valor: 59.4, pago: 20 }), { estado: 'parcial', falta: 39.4 });
  assert.deepEqual(U.situacaoDaPessoa({ valor: 59.4, pago: 59.4 }), { estado: 'paga', falta: 0 });
  assert.deepEqual(U.situacaoDaPessoa({ valor: 0, pago: 0 }), { estado: 'sem-itens', falta: 0 });
});

function mesaComDuasPessoas() {
  const ctx = freshTestDb();
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '7' }).id;
  const suco = createProduct(ctx.db, { nome: 'Suco', preco: 10 });
  const prato = createProduct(ctx.db, { nome: 'Prato', preco: 40 });
  for (const p of [suco, prato]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.adminId });
  const saleId = tableService.openTable({ tableId: mesa, locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 3 }).saleId;
  const add = (productId, pessoaNumero, quantidade = 1) => {
    const r = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade, operadorId: ctx.operadorId, deviceId: 't', pessoaNumero });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  add(prato, 1); add(suco, 1); // Ana: 50
  add(prato, 2); // Bia: 40
  add(suco, 3); // Caio: 10
  return { ...ctx, mesa, saleId, suco, prato };
}

test('Ana paga a parte dela e vai embora: a mesa continua aberta e o pagamento fica com ela', () => {
  const { saleId, mesa, db } = mesaComDuasPessoas();
  const p = saleService.addPayment({ saleId, metodo: 'cartao_debito', valor: 50 });
  assert.equal(p.ok, true, p.error);
  assert.equal(saleService.marcarPagamentoPessoa({ saleId, paymentId: p.id, pessoaNumero: 1 }).ok, true);
  assert.equal(saleService.marcarPagamentoPessoa({ saleId, paymentId: p.id, pessoaNumero: 0 }).ok, false);
  assert.equal(saleService.marcarPagamentoPessoa({ saleId: 'outra', paymentId: p.id, pessoaNumero: 1 }).ok, false);

  const estado = saleService.getPaymentState(saleId);
  assert.equal(estado.status, 'aberta');
  assert.equal(estado.pagamentos[0].pessoaNumero, 1);
  const cart = tableService.getTableCart(saleId);
  assert.deepEqual(cart.pagoPorPessoa, { 1: 50 });
  assert.equal(cart.totalPago, 50);

  // Quem já pagou não sai da mesa; tirar a Bia (2) faz o Caio virar 2, e a Ana continua 1.
  assert.match(tableService.removerPessoa({ tableId: mesa, numero: 1 }).error, /já pagou/);
  assert.equal(tableService.removerPessoa({ tableId: mesa, numero: 2 }).ok, true);
  assert.deepEqual(tableService.getTableCart(saleId).pagoPorPessoa, { 1: 50 });

  // O resto da mesa fecha normal.
  assert.equal(saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 50 }).ok, true);
  assert.equal(saleService.finalizeSale(saleId).ok, true);

  // Remover um pagamento marcado tira a marca junto (sem erro de chave estrangeira).
  const ctx2 = mesaComDuasPessoas();
  const p2 = saleService.addPayment({ saleId: ctx2.saleId, metodo: 'pix', valor: 40 });
  saleService.marcarPagamentoPessoa({ saleId: ctx2.saleId, paymentId: p2.id, pessoaNumero: 2 });
  assert.equal(saleService.removePayment({ paymentId: p2.id, saleId: ctx2.saleId, currentOperatorId: ctx2.adminId,
    candidateManagerId: ctx2.gerenteId, pin: '1234', motivo: 'errou' }).ok, true);
  assert.equal(ctx2.db.prepare('SELECT COUNT(*) c FROM sale_person_payments').get().c, 0);
  assert.ok(db);
});

test('− e + no carrinho mexem no estoque e no total; diminuir depois de pagar pede o Cancelar', () => {
  const ctx = freshTestDb();
  const cafe = createProduct(ctx.db, { nome: 'Café', preco: 5 });
  addStock(ctx.db, { productId: cafe, locationId: ctx.locationId, quantidade: 3, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const a = saleService.addItem({ saleId, productId: cafe, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 't' });
  assert.equal(a.ajustavel, true);
  const base = { saleId, saleItemId: a.itemId, locationId: ctx.locationId, operadorId: ctx.operadorId, deviceId: 't' };

  assert.match(saleService.ajustarQuantidadeItem({ ...base, delta: -1 }).error, /último/);
  let r = saleService.ajustarQuantidadeItem({ ...base, delta: 1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.quantidade, 2);
  assert.equal(r.novoTotal, 10);
  assert.equal(getCurrentStock(cafe, ctx.locationId), 1);
  r = saleService.ajustarQuantidadeItem({ ...base, delta: 1 });
  assert.equal(r.quantidade, 3);
  assert.match(saleService.ajustarQuantidadeItem({ ...base, delta: 1 }).error, /Estoque insuficiente/);
  assert.equal(saleService.ajustarQuantidadeItem({ ...base, delta: 5 }).ok, false);

  r = saleService.ajustarQuantidadeItem({ ...base, delta: -1 });
  assert.equal(r.quantidade, 2);
  assert.equal(getCurrentStock(cafe, ctx.locationId), 1);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tipo_evento = 'reducao_item_pre_pagamento'").get().c, 1);

  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 5 });
  assert.match(saleService.ajustarQuantidadeItem({ ...base, delta: -1 }).error, /Cancelar/);
  assert.equal(saleService.ajustarQuantidadeItem({ ...base, delta: 1 }).ok, true, 'aumentar continua livre');
});

test('prato com ficha técnica: + baixa e − devolve os insumos; peso e item da cozinha não ajustam', () => {
  const ctx = freshTestDb();
  const prato = createProduct(ctx.db, { nome: 'Prato do dia', preco: 30, tipo: 'servico', estoqueMinimo: 0 });
  const arroz = ingredientService.upsert({ nome: 'Arroz', unidade: 'kg', custoUnitario: 6, estoqueAtual: 2 }).id;
  ingredientService.setRecipe(prato, [{ ingredientId: arroz, quantidade: 0.2 }]);
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const a = saleService.addItem({ saleId, productId: prato, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 't' });
  const base = { saleId, saleItemId: a.itemId, locationId: ctx.locationId, operadorId: ctx.operadorId, deviceId: 't' };
  const arrozAgora = () => ctx.db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(arroz).estoque_atual;
  saleService.ajustarQuantidadeItem({ ...base, delta: 1 });
  assert.ok(Math.abs(arrozAgora() - 1.6) < 1e-9);
  saleService.ajustarQuantidadeItem({ ...base, delta: -1 });
  assert.ok(Math.abs(arrozAgora() - 1.8) < 1e-9);

  ctx.db.prepare('UPDATE sale_items SET enviado_cozinha = 1 WHERE id = ?').run(a.itemId);
  assert.match(saleService.ajustarQuantidadeItem({ ...base, delta: 1 }).error, /Cancele o item/);

  const queijo = createProduct(ctx.db, { nome: 'Queijo', preco: 50 });
  ctx.db.prepare("UPDATE products SET unidade = 'kg' WHERE id = ?").run(queijo);
  addStock(ctx.db, { productId: queijo, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  const q = saleService.addItem({ saleId, productId: queijo, locationId: ctx.locationId, quantidade: 0.35, operadorId: ctx.operadorId, deviceId: 't' });
  assert.equal(q.ajustavel, false);
});
