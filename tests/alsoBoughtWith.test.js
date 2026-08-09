const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const productService = require('../electron/services/productService');

function venda(db, { locationId, operadorId, produtoIds }) {
  const saleId = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, finalizada_em) VALUES (?, ?, ?, 'finalizada', 1, datetime('now'))`
  ).run(saleId, locationId, operadorId);
  produtoIds.forEach((productId) => {
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, cancelado) VALUES (?, ?, ?, 1, 5, 0)`
    ).run(randomUUID(), saleId, productId);
  });
  return saleId;
}

test('acha o produto comprado junto de verdade (padrão real), ignora coincidência de 1 vez só', () => {
  const { db, locationId, adminId } = freshTestDb();
  const dipirona = createProduct(db, { nome: 'Dipirona' });
  const protetor = createProduct(db, { nome: 'Protetor Estômago' });
  const balaSolta = createProduct(db, { nome: 'Bala Solta' });

  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, balaSolta] }); // só 1 vez -- coincidência
  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona] });

  const sugestoes = productService.findAlsoBoughtWith(dipirona);
  assert.equal(sugestoes.length, 1);
  assert.equal(sugestoes[0].id, protetor);
  assert.equal(sugestoes[0].vezesJuntos, 3);
});

test('não sugere produto de venda cancelada', () => {
  const { db, locationId, adminId } = freshTestDb();
  const dipirona = createProduct(db, { nome: 'Dipirona' });
  const protetor = createProduct(db, { nome: 'Protetor' });

  const saleId1 = venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  // marca o item do protetor da primeira venda como cancelado
  db.prepare(`UPDATE sale_items SET cancelado = 1 WHERE sale_id = ? AND product_id = ?`).run(saleId1, protetor);

  const sugestoes = productService.findAlsoBoughtWith(dipirona);
  assert.equal(sugestoes.length, 0, 'só 1 ocorrência válida (a outra foi cancelada) -- abaixo do mínimo de 2');
});

test('não sugere produto que já foi desativado', () => {
  const { db, locationId, adminId } = freshTestDb();
  const dipirona = createProduct(db, { nome: 'Dipirona' });
  const protetor = createProduct(db, { nome: 'Protetor' });

  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  venda(db, { locationId, operadorId: adminId, produtoIds: [dipirona, protetor] });
  db.prepare(`UPDATE products SET ativo = 0 WHERE id = ?`).run(protetor);

  const sugestoes = productService.findAlsoBoughtWith(dipirona);
  assert.equal(sugestoes.length, 0);
});

test('respeita o limite de quantidade pedido', () => {
  const { db, locationId, adminId } = freshTestDb();
  const principal = createProduct(db, { nome: 'Principal' });
  const parceiros = [createProduct(db, { nome: 'P1' }), createProduct(db, { nome: 'P2' }), createProduct(db, { nome: 'P3' })];

  parceiros.forEach((parceiroId) => {
    venda(db, { locationId, operadorId: adminId, produtoIds: [principal, parceiroId] });
    venda(db, { locationId, operadorId: adminId, produtoIds: [principal, parceiroId] });
  });

  const sugestoes = productService.findAlsoBoughtWith(principal, { limit: 2 });
  assert.equal(sugestoes.length, 2);
});
