const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const custoMedioService = require('../electron/services/custoMedioService');
const supplyService = require('../electron/services/supplyService');

test('calcularMedio: pondera pela quantidade (10 a R$ 5 + 30 a R$ 9 = R$ 8)', () => {
  assert.equal(custoMedioService.calcularMedio({ qtdAntes: 10, custoAntes: 5, qtdEntrada: 30, custoEntrada: 9 }), 8);
});

test('calcularMedio: estoque zerado ou negativo assume o custo da entrada', () => {
  assert.equal(custoMedioService.calcularMedio({ qtdAntes: 0, custoAntes: 5, qtdEntrada: 3, custoEntrada: 7.5 }), 7.5);
  assert.equal(custoMedioService.calcularMedio({ qtdAntes: -4, custoAntes: 5, qtdEntrada: 3, custoEntrada: 7.5 }), 7.5);
});

test('calcularMedio: guarda 4 casas (dízima não vira erro acumulado de centavo)', () => {
  // (3 × 1 + 1 × 2) / 4... e (1 × 1 + 2 × 2) / 3 = 1,6666...
  assert.equal(custoMedioService.calcularMedio({ qtdAntes: 1, custoAntes: 1, qtdEntrada: 2, custoEntrada: 2 }), 1.6667);
});

test('calcularMedio recusa quantidade não positiva e custo negativo', () => {
  assert.throws(() => custoMedioService.calcularMedio({ qtdAntes: 1, custoAntes: 1, qtdEntrada: 0, custoEntrada: 2 }));
  assert.throws(() => custoMedioService.calcularMedio({ qtdAntes: 1, custoAntes: 1, qtdEntrada: 1, custoEntrada: -2 }));
});

test('calcularMedioSemEntrada desfaz exatamente a entrada quando o estoque continua lá', () => {
  const depois = custoMedioService.calcularMedio({ qtdAntes: 10, custoAntes: 5, qtdEntrada: 30, custoEntrada: 9 });
  assert.equal(custoMedioService.calcularMedioSemEntrada({ qtdAntes: 40, custoAntes: depois, qtdEstornada: 30, custoEstornado: 9 }), 5);
});

test('calcularMedioSemEntrada mantém o médio quando a conta não fecha (estoque já vendido)', () => {
  assert.equal(custoMedioService.calcularMedioSemEntrada({ qtdAntes: 30, custoAntes: 8, qtdEstornada: 30, custoEstornado: 9 }), 8);
  assert.equal(custoMedioService.calcularMedioSemEntrada({ qtdAntes: 31, custoAntes: 1, qtdEstornada: 30, custoEstornado: 9 }), 1);
});

test('registrarEntrada grava o livro e atualiza products.custo, somando o estoque de todos os locais', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const outroLocal = 'loc-2';
  db.prepare(`INSERT INTO locations (id, nome) VALUES (?, 'Depósito')`).run(outroLocal);
  const productId = createProduct(db, { custo: 4 });
  addStock(db, { productId, locationId, quantidade: 6, operadorId });
  addStock(db, { productId, locationId: outroLocal, quantidade: 4, operadorId });

  const r = custoMedioService.registrarEntrada(db, { productId, quantidade: 10, custoUnitario: 6, origem: 'nfe', origemId: 'x', operadorId });
  assert.deepEqual(r, { qtdAntes: 10, custoAntes: 4, custoDepois: 5 });
  assert.equal(db.prepare('SELECT custo FROM products WHERE id = ?').get(productId).custo, 5);
  const hist = custoMedioService.historico(productId);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].tipo, 'entrada');
  assert.equal(hist[0].custo_antes, 4);
  assert.equal(hist[0].custo_depois, 5);
  assert.equal(hist[0].operador_nome, 'Operador Teste');
});

test('Abastecimento passa a usar custo médio (antes sobrescrevia com o preço da última nota)', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const productId = createProduct(db, { custo: 10 });
  addStock(db, { productId, locationId, quantidade: 10, operadorId });

  const r = supplyService.confirmEntries({
    linhas: [{ linhaId: 'l1', productId, quantidade: 10, precoUnitario: 20, lote: 'A', validade: '2027-01-01' }],
    locationId, operadorId, deviceId: 'dev', motivo: 'Abastecimento — nota.pdf',
  });
  assert.equal(r.sucesso, 1);
  assert.equal(db.prepare('SELECT custo FROM products WHERE id = ?').get(productId).custo, 15);
  assert.equal(db.prepare('SELECT SUM(quantidade) q FROM stock_movements WHERE product_id = ?').get(productId).q, 20);
});

test('Abastecimento: linha sem preço entra no estoque e não mexe no custo', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const productId = createProduct(db, { custo: 10 });
  const r = supplyService.confirmEntries({
    linhas: [{ linhaId: 'l1', productId, quantidade: 5, precoUnitario: null }], locationId, operadorId, deviceId: 'dev',
  });
  assert.equal(r.sucesso, 1);
  assert.equal(db.prepare('SELECT custo FROM products WHERE id = ?').get(productId).custo, 10);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM product_cost_history').get().c, 0);
});

test('Abastecimento: linha recusada não deixa custo alterado nem lote pela metade', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const productId = createProduct(db, { custo: 10 });
  const r = supplyService.confirmEntries({
    linhas: [
      { linhaId: 'ok', productId, quantidade: 2, precoUnitario: 10 },
      { linhaId: 'ruim', productId: 'nao-existe', quantidade: 1, precoUnitario: 99 },
    ],
    locationId, operadorId, deviceId: 'dev',
  });
  assert.equal(r.sucesso, 1);
  assert.deepEqual(r.linhasComSucesso, ['ok']);
  assert.equal(r.erros.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM product_cost_history').get().c, 1);
});
