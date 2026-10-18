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

// ---------------------------------------------------------------------
// Sugestão de compra: dias em falta, dia da semana e prazo do fornecedor
// ---------------------------------------------------------------------
const { randomUUID: uuidCompra } = require('crypto');
const { createProduct: criarProduto } = require('./helpers/testDb');

function movimento(db, { productId, locationId, tipo, quantidade, diasAtras, operadorId }) {
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, 'd', datetime(NOW_SYNCED(), ?))`
  ).run(uuidCompra(), productId, locationId, tipo, quantidade, operadorId, `-${diasAtras} days`);
}

test('preverDemandaDiaria: dias zerado não puxam a média pra baixo', () => {
  const dias = [];
  for (let i = 0; i < 14; i += 1) {
    const dia = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    // 7 dias vendendo 10/dia com estoque, depois 7 dias zerado
    dias.push(i < 7 ? { dia, vendido: 10, saldo: 70 - 10 * (i + 1) } : { dia, vendido: 0, saldo: 0 });
  }
  const p = supplierService.preverDemandaDiaria(dias);
  assert.equal(p.diaria, 10); // a média simples de antes daria 5
  assert.equal(p.diasZerado, 7);
});

test('preverDemandaDiaria: pesa o dia da semana quando há amostras', () => {
  const dias = [];
  for (let i = 0; i < 28; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 6 + i)); // 2026-09-06 é domingo
    dias.push({ dia: d.toISOString().slice(0, 10), vendido: d.getUTCDay() === 0 ? 40 : 10, saldo: 500 });
  }
  const p = supplierService.preverDemandaDiaria(dias);
  assert.equal(p.porDiaDaSemana[0], 40);
  assert.equal(p.porDiaDaSemana[3], 10);
  assert.equal(supplierService.demandaNosProximosDias(p, '2026-10-03', 1), 40); // amanhã é domingo
});

test('suggestPurchases inclui quem vai chegar no mínimo antes da entrega, e usa o prazo do fornecedor', () => {
  const { db, locationId, adminId } = freshTestDb();
  const f = supplierService.upsert({ nome: 'Distribuidora', prazoEntregaDias: 5 });
  assert.equal(db.prepare('SELECT prazo_entrega_dias AS p FROM suppliers WHERE id = ?').get(f.id).p, 5);
  const productId = criarProduto(db, { preco: 5, estoqueMinimo: 10 });
  db.prepare('UPDATE products SET fornecedor_id = ? WHERE id = ?').run(f.id, productId);
  movimento(db, { productId, locationId, tipo: 'entrada', quantidade: 200, diasAtras: 28, operadorId: adminId });
  for (let d = 28; d >= 1; d -= 1) movimento(db, { productId, locationId, tipo: 'venda', quantidade: -5, diasAtras: d, operadorId: adminId });
  // estoque 60, mínimo 10, vende 5/dia, entrega em 5 dias: 60 - 25 = 35 > 10 -> ainda não
  assert.equal(supplierService.suggestPurchases({ locationId }).some((s) => s.id === productId), false);
  // estoque cai pra 30: 30 - 25 = 5 <= 10 -> entra
  movimento(db, { productId, locationId, tipo: 'perda', quantidade: -30, diasAtras: 0, operadorId: adminId });
  const s = supplierService.suggestPurchases({ locationId }).find((x) => x.id === productId);
  assert.ok(s);
  assert.equal(s.velocidadeDiaria, 5);
  assert.equal(s.quantidadeSugerida, 5 * (5 + 30) - 30); // prazo + 30 dias, menos o que tem
});
