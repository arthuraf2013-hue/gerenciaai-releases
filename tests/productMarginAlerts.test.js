const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const productService = require('../electron/services/productService');

function inserirProdutoComPreco(db, { nome, categoria, preco, custo }) {
  const id = randomUUID();
  db.prepare('INSERT INTO products (id, nome, categoria, preco, custo, ativo) VALUES (?, ?, ?, ?, ?, 1)').run(id, nome, categoria, preco, custo);
  return id;
}

test('pega produto com margem bem abaixo da média da própria categoria', () => {
  const { db } = freshTestDb();
  inserirProdutoComPreco(db, { nome: 'Dipirona', categoria: 'Medicamentos', preco: 10, custo: 6 }); // margem 40%
  inserirProdutoComPreco(db, { nome: 'Paracetamol', categoria: 'Medicamentos', preco: 10, custo: 5.8 }); // margem 42%
  const idMalPrecificado = inserirProdutoComPreco(db, { nome: 'Mal Precificado', categoria: 'Medicamentos', preco: 10, custo: 9 }); // margem 10%

  const alertas = productService.alertasDeMargem();
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].id, idMalPrecificado);
  assert.equal(alertas[0].margemNegativa, false);
});

test('pega produto vendendo com prejuízo mesmo sozinho na categoria (sem nada pra comparar)', () => {
  const { db } = freshTestDb();
  const idPrejuizo = inserirProdutoComPreco(db, { nome: 'No Prejuízo', categoria: 'Categoria Sozinha', preco: 10, custo: 12 }); // margem negativa

  const alertas = productService.alertasDeMargem();
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].id, idPrejuizo);
  assert.equal(alertas[0].margemNegativa, true);
});

test('não dispara alarme falso pra produto único na categoria com margem positiva', () => {
  const { db } = freshTestDb();
  inserirProdutoComPreco(db, { nome: 'Produto Sozinho', categoria: 'Categoria Única', preco: 10, custo: 8 }); // margem 20%, positiva, sem comparação possível

  const alertas = productService.alertasDeMargem();
  assert.equal(alertas.length, 0, 'sem outro produto na categoria pra comparar, não deveria disparar (só margem negativa dispara sozinha)');
});

test('não dispara pra produtos com margens parecidas dentro da mesma categoria', () => {
  const { db } = freshTestDb();
  inserirProdutoComPreco(db, { nome: 'Produto A', categoria: 'Bebidas', preco: 10, custo: 6 }); // 40%
  inserirProdutoComPreco(db, { nome: 'Produto B', categoria: 'Bebidas', preco: 10, custo: 6.5 }); // 35%
  inserirProdutoComPreco(db, { nome: 'Produto C', categoria: 'Bebidas', preco: 10, custo: 7 }); // 30%

  const alertas = productService.alertasDeMargem();
  assert.equal(alertas.length, 0, 'margens dentro do normal não deveriam disparar alerta');
});
