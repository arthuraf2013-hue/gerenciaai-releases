const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, addStock } = require('./helpers/testDb');
const stockService = require('../electron/services/stockService');
const productService = require('../electron/services/productService');
const saleService = require('../electron/services/saleService');

function diasAPartirDeHoje(dias) {
  return new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
}

function inserirProdutoComLote(db, { locationId, nome, preco, diasParaVencer }) {
  const id = randomUUID();
  db.prepare('INSERT INTO products (id, nome, preco, ativo) VALUES (?, ?, ?, 1)').run(id, nome, preco);
  db.prepare('INSERT INTO product_batches (id, product_id, location_id, quantidade, validade) VALUES (?, ?, ?, 10, ?)')
    .run(randomUUID(), id, locationId, diasAPartirDeHoje(diasParaVencer));
  return id;
}

test('sugere desconto pra produto vencendo em breve, ignora o que vence só daqui muito tempo', () => {
  const { db, locationId } = freshTestDb();
  const vencendoLogo = inserirProdutoComLote(db, { locationId, nome: 'Pão Francês', preco: 10, diasParaVencer: 1 });
  inserirProdutoComLote(db, { locationId, nome: 'Farinha', preco: 15, diasParaVencer: 30 });

  const sugestoes = stockService.sugestoesDescontoValidade({ locationId });
  assert.equal(sugestoes.length, 1);
  assert.equal(sugestoes[0].id, vencendoLogo);
  assert.equal(sugestoes[0].precoSugerido, 7); // 30% off de 10
});

test('não sugere de novo produto que já está com desconto ativo', () => {
  const { db, locationId } = freshTestDb();
  const produtoId = inserirProdutoComLote(db, { locationId, nome: 'Pão Francês', preco: 10, diasParaVencer: 1 });

  productService.aplicarDescontoValidade({ productId: produtoId, precoPromocional: 7, validoAte: diasAPartirDeHoje(1) });

  const sugestoes = stockService.sugestoesDescontoValidade({ locationId });
  assert.equal(sugestoes.length, 0);
});

test('recusa aplicar desconto sem preço válido ou sem data', () => {
  const { db, locationId } = freshTestDb();
  const produtoId = inserirProdutoComLote(db, { locationId, nome: 'Pão', preco: 10, diasParaVencer: 1 });

  assert.equal(productService.aplicarDescontoValidade({ productId: produtoId, precoPromocional: 0, validoAte: diasAPartirDeHoje(1) }).ok, false);
  assert.equal(productService.aplicarDescontoValidade({ productId: produtoId, precoPromocional: 7, validoAte: null }).ok, false);
});

test('venda no PDV cobra o preço promocional de verdade enquanto a promoção estiver válida', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = inserirProdutoComLote(db, { locationId, nome: 'Pão Francês', preco: 10, diasParaVencer: 1 });
  productService.aplicarDescontoValidade({ productId: produtoId, precoPromocional: 7, validoAte: diasAPartirDeHoje(1) });
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const saleId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES (?, ?, ?, 'aberta', 0)`).run(saleId, locationId, adminId);
  const resultado = saleService.addItem({ saleId, productId: produtoId, locationId, quantidade: 2, operadorId: adminId, deviceId: 'device-teste' });

  assert.equal(resultado.ok, true);
  assert.equal(resultado.precoUnitario, 7, 'o preço unitário retornado pra exibir na tela deve ser o promocional');
  const total = db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId).total;
  assert.equal(total, 14, '2 unidades a R$7 = R$14, não o preço cheio');
});

test('promoção vencida não é mais usada — venda volta a cobrar o preço normal', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = randomUUID();
  db.prepare('INSERT INTO products (id, nome, preco, ativo, preco_promocional, promocao_valida_ate) VALUES (?, ?, ?, 1, ?, ?)')
    .run(produtoId, 'Produto Vencido', 10, 7, diasAPartirDeHoje(-1)); // promoção já venceu ontem
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const saleId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES (?, ?, ?, 'aberta', 0)`).run(saleId, locationId, adminId);
  const resultado = saleService.addItem({ saleId, productId: produtoId, locationId, quantidade: 1, operadorId: adminId, deviceId: 'device-teste' });

  assert.equal(resultado.precoUnitario, 10, 'promoção vencida não deveria mais ser aplicada');
});

test('removerDescontoValidade limpa a promoção, produto volta pro preço normal', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = inserirProdutoComLote(db, { locationId, nome: 'Pão Francês', preco: 10, diasParaVencer: 1 });
  productService.aplicarDescontoValidade({ productId: produtoId, precoPromocional: 7, validoAte: diasAPartirDeHoje(1) });

  productService.removerDescontoValidade(produtoId);
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const saleId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES (?, ?, ?, 'aberta', 0)`).run(saleId, locationId, adminId);
  const resultado = saleService.addItem({ saleId, productId: produtoId, locationId, quantidade: 1, operadorId: adminId, deviceId: 'device-teste' });
  assert.equal(resultado.precoUnitario, 10);
});
