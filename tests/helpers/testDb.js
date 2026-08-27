const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { setDbForTesting } = require('../../electron/db/database');

/** Cria um banco novo em memória e devolve helpers prontos para os testes:
 * um local, um admin (PIN "0000") e um gerente (PIN "1234"), já criados. */
function freshTestDb() {
  const db = new Database(':memory:');
  setDbForTesting(db);

  const locationId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

  const adminId = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get().id;

  const gerenteId = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Gerente Teste', 'gerente', ?)`)
    .run(gerenteId, bcrypt.hashSync('1234', 10));

  const operadorId = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Operador Teste', 'operador', ?)`)
    .run(operadorId, bcrypt.hashSync('5678', 10));

  return { db, locationId, adminId, gerenteId, operadorId };
}

function createProduct(db, { nome = 'Produto Teste', preco = 10, estoqueMinimo = 5, categoria = null, tipo = 'produto' } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO products (id, nome, preco, estoque_minimo, unidade, categoria, tipo) VALUES (?, ?, ?, ?, 'un', ?, ?)`
  ).run(id, nome, preco, estoqueMinimo, categoria, tipo);
  return id;
}

function addStock(db, { productId, locationId, quantidade, operadorId }) {
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id)
     VALUES (?, ?, ?, 'entrada', ?, ?, 'device-teste')`
  ).run(randomUUID(), productId, locationId, quantidade, operadorId);
}

module.exports = { freshTestDb, createProduct, addStock };
