const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const stockService = require('../electron/services/stockService');

function venderNosUltimosDias(db, { productId, locationId, quantidadePorDia, dias }) {
  for (let i = 0; i < dias; i++) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, device_id, criado_em)
       VALUES (?, ?, ?, 'venda', ?, 'device-teste', datetime('now', '-' || ? || ' days'))`
    ).run(randomUUID(), productId, locationId, -quantidadePorDia, i);
  }
}

test('previsaoDeRuptura pega produto de venda rápida que ainda não bateu o mínimo', () => {
  const { db, locationId, adminId } = freshTestDb();
  // Entrou 100, vende 3/dia nos últimos 30 dias -- sobra 10, acaba em ~3 dias, mesmo com mínimo configurado bem abaixo disso.
  const produtoId = createProduct(db, { nome: 'Venda Rápida', estoqueMinimo: 5 });
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id) VALUES (?, ?, ?, 'entrada', 100, ?, 'device-teste')`
  ).run(randomUUID(), produtoId, locationId, adminId);
  venderNosUltimosDias(db, { productId: produtoId, locationId, quantidadePorDia: 3, dias: 30 });

  const previsao = stockService.previsaoDeRuptura(locationId);
  assert.equal(previsao.length, 1);
  assert.equal(previsao[0].id, produtoId);
  assert.ok(previsao[0].diasRestantes <= 7);
});

test('previsaoDeRuptura ignora produto de venda lenta, mesmo com estoque parecido', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Venda Lenta', estoqueMinimo: 5 });
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id) VALUES (?, ?, ?, 'entrada', 20, ?, 'device-teste')`
  ).run(randomUUID(), produtoId, locationId, adminId);
  venderNosUltimosDias(db, { productId: produtoId, locationId, quantidadePorDia: 1, dias: 1 }); // só 1 venda no período todo

  const previsao = stockService.previsaoDeRuptura(locationId);
  assert.equal(previsao.length, 0, 'ritmo de venda baixo não deveria disparar a previsão');
});

test('previsaoDeRuptura não duplica produto que já bateu o mínimo (esse já aparece no alerta reativo)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Já Abaixo do Mínimo', estoqueMinimo: 10 });
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id) VALUES (?, ?, ?, 'entrada', 5, ?, 'device-teste')`
  ).run(randomUUID(), produtoId, locationId, adminId);
  venderNosUltimosDias(db, { productId: produtoId, locationId, quantidadePorDia: 1, dias: 3 });

  const previsao = stockService.previsaoDeRuptura(locationId);
  assert.equal(previsao.length, 0, 'produto que já está abaixo do mínimo não deveria aparecer aqui também');
});

test('previsaoDeRuptura não quebra com produto sem estoque nenhum (zero, sem venda pra calcular)', () => {
  const { db, locationId } = freshTestDb();
  createProduct(db, { nome: 'Produto Zerado', estoqueMinimo: 5 });
  // sem nenhum movimento de estoque -- estoque_atual = 0

  assert.doesNotThrow(() => stockService.previsaoDeRuptura(locationId));
  assert.equal(stockService.previsaoDeRuptura(locationId).length, 0);
});
