const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const supplierService = require('../electron/services/supplierService');
const productService = require('../electron/services/productService');

test('upsert recusa fornecedor sem nome', () => {
  freshTestDb();
  const resultado = supplierService.upsert({ cnpjCpf: '12345678900' });
  assert.equal(resultado.ok, false);
});

test('upsert cria e list devolve só fornecedores ativos', () => {
  freshTestDb();
  const a = supplierService.upsert({ nome: 'Fornecedor A' });
  const b = supplierService.upsert({ nome: 'Fornecedor B' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const lista = supplierService.list();
  assert.equal(lista.length, 2);
});

/**
 * A coluna 'ativo' sempre existiu no schema, mas nada em supplierService
 * a desligava -- um fornecedor descontinuado ficava pra sempre na lista
 * (auditoria, seção 3, "sem função de desativar apesar da coluna ativo
 * existir").
 */
test('deactivate some da lista ativa sem apagar a linha nem quebrar produtos vinculados', () => {
  const { db } = freshTestDb();
  const fornecedor = supplierService.upsert({ nome: 'Fornecedor a Descontinuar' });
  const produto = productService.upsert({ nome: 'Produto Vinculado', preco: 10, fornecedorId: fornecedor.id });
  assert.equal(produto.ok, true);

  const desativado = supplierService.deactivate(fornecedor.id);
  assert.equal(desativado.ok, true);

  assert.ok(!supplierService.list().some((s) => s.id === fornecedor.id), 'não deveria aparecer mais na lista ativa');

  const linhaAinda = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(fornecedor.id);
  assert.ok(linhaAinda, 'a linha do fornecedor continua existindo (nunca apaga)');
  assert.equal(linhaAinda.ativo, 0);

  const produtoAinda = db.prepare('SELECT fornecedor_id FROM products WHERE id = ?').get(produto.id);
  assert.equal(produtoAinda.fornecedor_id, fornecedor.id, 'o produto continua referenciando o fornecedor desativado');
});
