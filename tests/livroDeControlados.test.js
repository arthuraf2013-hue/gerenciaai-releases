const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const fiscalService = require('../electron/services/fiscalService');

function inserirProdutoComCampos(db, { nome, preco, customFields }) {
  const id = randomUUID();
  db.prepare('INSERT INTO products (id, nome, preco, custom_fields, ativo) VALUES (?, ?, ?, ?, 1)').run(id, nome, preco, JSON.stringify(customFields || {}));
  return id;
}

function venderProduto(db, { locationId, operadorId, customerId, productId, quantidade = 1, cancelado = 0 }) {
  const saleId = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em) VALUES (?, ?, ?, ?, 'finalizada', 10, datetime('now'))`
  ).run(saleId, locationId, operadorId, customerId || null);
  db.prepare(
    `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, cancelado) VALUES (?, ?, ?, ?, 10, ?)`
  ).run(randomUUID(), saleId, productId, quantidade, cancelado);
  return saleId;
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

test('pega venda de produto marcado como controlado, com cliente e princípio ativo', () => {
  const { db, locationId, adminId } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, cpf) VALUES (?, ?, ?)').run(clienteId, 'Maria Cliente', '12345678900');
  const controladoId = inserirProdutoComCampos(db, { nome: 'Rivotril 2mg', preco: 20, customFields: { controlado: true, principio_ativo: 'Clonazepam' } });

  venderProduto(db, { locationId, operadorId: adminId, customerId: clienteId, productId: controladoId });

  const livro = fiscalService.livroDeControlados({ locationId, dataInicio: hoje(), dataFim: hoje() });
  assert.equal(livro.length, 1);
  assert.equal(livro[0].produtoNome, 'Rivotril 2mg');
  assert.equal(livro[0].principioAtivo, 'Clonazepam');
  assert.equal(livro[0].clienteNome, 'Maria Cliente');
  assert.equal(livro[0].clienteCpf, '12345678900');
});

test('ignora produto que não é marcado como controlado', () => {
  const { db, locationId, adminId } = freshTestDb();
  const naoControladoId = inserirProdutoComCampos(db, { nome: 'Dipirona', preco: 5, customFields: { controlado: false } });
  venderProduto(db, { locationId, operadorId: adminId, productId: naoControladoId });

  const livro = fiscalService.livroDeControlados({ locationId, dataInicio: hoje(), dataFim: hoje() });
  assert.equal(livro.length, 0);
});

test('ignora item cancelado, mesmo sendo controlado', () => {
  const { db, locationId, adminId } = freshTestDb();
  const controladoId = inserirProdutoComCampos(db, { nome: 'Rivotril', preco: 20, customFields: { controlado: true } });
  venderProduto(db, { locationId, operadorId: adminId, productId: controladoId, cancelado: 1 });

  const livro = fiscalService.livroDeControlados({ locationId, dataInicio: hoje(), dataFim: hoje() });
  assert.equal(livro.length, 0);
});

test('funciona sem cliente vinculado à venda', () => {
  const { db, locationId, adminId } = freshTestDb();
  const controladoId = inserirProdutoComCampos(db, { nome: 'Rivotril', preco: 20, customFields: { controlado: true } });
  venderProduto(db, { locationId, operadorId: adminId, productId: controladoId });

  const livro = fiscalService.livroDeControlados({ locationId, dataInicio: hoje(), dataFim: hoje() });
  assert.equal(livro.length, 1);
  assert.equal(livro[0].clienteNome, null);
});
