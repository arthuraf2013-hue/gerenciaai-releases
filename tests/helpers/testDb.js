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

/** Cria (e devolve o id de) um usuário 'suporte' extra no banco de teste —
 * separado de freshTestDb() pra não mudar a contagem/lista padrão de
 * usuários em cima da qual centenas de testes já existentes contam. */
function createSuporteUser(db, { nome = 'Suporte Teste', pin = '9999' } = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, 'suporte', ?)`)
    .run(id, nome, bcrypt.hashSync(pin, 10));
  return id;
}

function createProduct(db, { nome = 'Produto Teste', preco = 10, custo = 0, estoqueMinimo = 5, categoria = null, tipo = 'produto' } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO products (id, nome, preco, custo, estoque_minimo, unidade, categoria, tipo) VALUES (?, ?, ?, ?, ?, 'un', ?, ?)`
  ).run(id, nome, preco, custo, estoqueMinimo, categoria, tipo);
  return id;
}

function addStock(db, { productId, locationId, quantidade, operadorId }) {
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id)
     VALUES (?, ?, ?, 'entrada', ?, ?, 'device-teste')`
  ).run(randomUUID(), productId, locationId, quantidade, operadorId);
}

module.exports = { freshTestDb, createProduct, addStock, createSuporteUser };

/** Venda já finalizada, gravada direto (sem passar pelo PDV), pra testes
 * de relatório: `finalizadaEm` em UTC 'AAAA-MM-DD HH:MM:SS'. */
function createFinalizedSale(db, { locationId, operadorId, finalizadaEm, itens, pagamentos, desconto = 0, taxaServico = 0 }) {
  const id = randomUUID();
  const total = itens.reduce((s, i) => s + i.quantidade * i.preco, 0);
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, desconto, taxa_servico_percentual, criado_em, finalizada_em)
     VALUES (?, ?, ?, 'finalizada', ?, ?, ?, ?, ?)`
  ).run(id, locationId, operadorId, total, desconto, taxaServico, finalizadaEm, finalizadaEm);
  for (const i of itens) {
    db.prepare('INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, i.productId, i.quantidade, i.preco, finalizadaEm);
  }
  for (const [metodo, valor] of pagamentos) {
    db.prepare('INSERT INTO payments (id, sale_id, metodo, valor, criado_em) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), id, metodo, valor, finalizadaEm);
  }
  return id;
}

module.exports.createFinalizedSale = createFinalizedSale;
