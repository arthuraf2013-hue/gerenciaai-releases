const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const { atualizarCheckOrigemParaIncluirAppGarcom } = require('../electron/db/database');

// Mesmo raciocínio de migracaoRoleGarcom.test.js: simula uma instalação já
// existente (bot_orders criado antes de 'app_garcom' existir) e confere que
// o rename-into-place preserva dados e mantém o FK de bot_order_items ->
// bot_orders íntegro -- o risco concreto desse tipo de migração.
test('atualizarCheckOrigemParaIncluirAppGarcom preserva dados e mantém FK de bot_order_items íntegro', () => {
  const { db, locationId, adminId } = freshTestDb();

  // Recria bot_orders com o CHECK de antes (sem 'app_garcom'), simulando
  // o estado de um banco de cliente já em produção.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE bot_orders_antigo (
      id                TEXT PRIMARY KEY,
      location_id       TEXT NOT NULL REFERENCES locations(id),
      customer_id       TEXT REFERENCES customers(id),
      cliente_nome      TEXT NOT NULL,
      cliente_telefone  TEXT NOT NULL,
      tipo_entrega      TEXT NOT NULL DEFAULT 'retirada' CHECK (tipo_entrega IN ('retirada','entrega')),
      endereco          TEXT,
      status            TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo','em_separacao','pronto','concluido','cancelado')),
      origem            TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('whatsapp_bot','manual')),
      observacoes       TEXT,
      mesa_numero       TEXT,
      taxa_entrega      REAL,
      separado_por      TEXT REFERENCES users(id),
      delivery_id       TEXT REFERENCES deliveries(id),
      sale_id           TEXT REFERENCES sales(id),
      satisfacao_solicitada_em TEXT,
      nota_satisfacao          INTEGER CHECK (nota_satisfacao IS NULL OR nota_satisfacao BETWEEN 1 AND 5),
      comentario_satisfacao    TEXT,
      criado_em         TEXT NOT NULL DEFAULT (NOW_SYNCED()),
      separado_em       TEXT,
      concluido_em      TEXT
    );
  `);
  db.exec(`
    INSERT INTO bot_orders_antigo SELECT * FROM bot_orders;
  `);
  db.exec(`DROP TABLE bot_orders;`);
  db.exec(`ALTER TABLE bot_orders_antigo RENAME TO bot_orders;`);
  db.pragma('foreign_keys = ON');

  // Confirma que de fato simulamos o estado antigo.
  const pedidoId = randomUUID();
  db.prepare(
    `INSERT INTO bot_orders (id, location_id, cliente_nome, cliente_telefone, status, origem)
     VALUES (?, ?, 'Cliente Teste', '11999999999', 'novo', 'manual')`
  ).run(pedidoId, locationId);
  assert.throws(() => {
    db.prepare(`UPDATE bot_orders SET origem = 'app_garcom' WHERE id = ?`).run(pedidoId);
  }, /CHECK constraint failed/);

  // Um item vinculado -- pra confirmar que o FK bot_order_items ->
  // bot_orders continua íntegro depois da migração.
  const itemId = randomUUID();
  db.prepare(
    `INSERT INTO bot_order_items (id, bot_order_id, descricao_livre, quantidade) VALUES (?, ?, 'Item avulso', 2)`
  ).run(itemId, pedidoId);

  atualizarCheckOrigemParaIncluirAppGarcom(db);

  // Dados antigos preservados.
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(pedidoId);
  assert.equal(pedido.cliente_nome, 'Cliente Teste');
  assert.equal(pedido.origem, 'manual');

  // Agora aceita 'app_garcom'.
  assert.doesNotThrow(() => {
    db.prepare(`UPDATE bot_orders SET origem = 'app_garcom' WHERE id = ?`).run(pedidoId);
  });
  assert.equal(db.prepare('SELECT origem FROM bot_orders WHERE id = ?').get(pedidoId).origem, 'app_garcom');

  // FK continua íntegro (join resolve normalmente).
  const itemComPedido = db.prepare(
    `SELECT bi.id, bo.cliente_nome FROM bot_order_items bi JOIN bot_orders bo ON bo.id = bi.bot_order_id WHERE bi.id = ?`
  ).get(itemId);
  assert.ok(itemComPedido);
  assert.equal(itemComPedido.cliente_nome, 'Cliente Teste');

  // Índices recriados (a query abaixo só funciona bem com o índice, mas
  // o objetivo real aqui é só confirmar que criar o índice de novo não
  // lança erro por já existir).
  assert.doesNotThrow(() => {
    db.prepare(`SELECT * FROM bot_orders WHERE location_id = ?`).all(locationId);
  });

  // Rodar de novo é no-op (já migrado) e não derruba nada.
  assert.doesNotThrow(() => atualizarCheckOrigemParaIncluirAppGarcom(db));
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM bot_orders').get().c, 1);
});
