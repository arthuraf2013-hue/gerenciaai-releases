const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const pedidoGarcomSyncService = require('../electron/services/pedidoGarcomSyncService');

// Só a parte local/SQLite de pedidoGarcomSyncService.js -- a escuta em si
// (iniciarEscutaPedidosGarcom) e processarPedidoRecebido dependem de
// Firestore de verdade, fora do escopo de um teste local.

function criarGarcom(db, { nome = 'Garçom Teste' } = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, 'garcom', 'hash')`).run(id, nome);
  return id;
}

test('buscarUsuarioLocalDoDispositivo acha dispositivo garçom ativo e traz nome/papel do vínculo', () => {
  const { db } = freshTestDb();
  const garcomId = criarGarcom(db, { nome: 'João' });
  db.prepare(
    `INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-garcom-1', 'garcom', ?, 1)`
  ).run(garcomId);

  const dispositivo = pedidoGarcomSyncService.buscarUsuarioLocalDoDispositivo('uid-garcom-1');
  assert.ok(dispositivo);
  assert.equal(dispositivo.vinculo_nome, 'João');
  assert.equal(dispositivo.vinculo_role, 'garcom');
});

test('buscarUsuarioLocalDoDispositivo não acha dispositivo revogado (ativo=0)', () => {
  const { db } = freshTestDb();
  const garcomId = criarGarcom(db);
  db.prepare(
    `INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-garcom-2', 'garcom', ?, 0)`
  ).run(garcomId);

  assert.equal(pedidoGarcomSyncService.buscarUsuarioLocalDoDispositivo('uid-garcom-2'), undefined);
});

test('buscarUsuarioLocalDoDispositivo não acha dispositivo do tipo consulta (só garçom lança pedido)', () => {
  const { db, adminId } = freshTestDb();
  db.prepare(
    `INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-consulta-1', 'consulta', ?, 1)`
  ).run(adminId);

  assert.equal(pedidoGarcomSyncService.buscarUsuarioLocalDoDispositivo('uid-consulta-1'), undefined);
});

test('buscarUsuarioLocalDoDispositivo devolve undefined pra uid nunca pareado', () => {
  freshTestDb();
  assert.equal(pedidoGarcomSyncService.buscarUsuarioLocalDoDispositivo('uid-nunca-existiu'), undefined);
});

test('criarPedidoLocal cria bot_orders (origem app_garcom) e bot_order_items, casando produto existente por id', () => {
  const { db, locationId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Coca-Cola', preco: 8 });

  const orderId = pedidoGarcomSyncService.criarPedidoLocal({
    locationId,
    garcomNome: 'João',
    mesaNumero: '7',
    itens: [{ productId: produtoId, quantidade: 2, precoUnitario: 8 }],
    observacoes: 'sem gelo',
  });

  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  assert.ok(pedido);
  assert.equal(pedido.origem, 'app_garcom');
  assert.equal(pedido.status, 'novo');
  assert.equal(pedido.cliente_nome, 'João');
  assert.equal(pedido.cliente_telefone, 'app-garcom');
  assert.equal(pedido.mesa_numero, '7');
  assert.equal(pedido.observacoes, 'sem gelo');

  const itens = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ?').all(orderId);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].product_id, produtoId);
  assert.equal(itens[0].descricao_livre, null);
  assert.equal(itens[0].quantidade, 2);
  assert.equal(itens[0].preco_unitario, 8);
});

test('criarPedidoLocal usa descricao_livre quando o produto não existe (ou foi desativado), sem travar o pedido', () => {
  const { db, locationId } = freshTestDb();
  const produtoDesativadoId = createProduct(db, { nome: 'Produto Descontinuado' });
  db.prepare('UPDATE products SET ativo = 0 WHERE id = ?').run(produtoDesativadoId);

  const orderId = pedidoGarcomSyncService.criarPedidoLocal({
    locationId,
    garcomNome: 'Maria',
    itens: [
      { productId: produtoDesativadoId, nome: 'Produto Descontinuado', quantidade: 1 },
      { productId: null, nome: 'Item digitado à mão', quantidade: 3 },
    ],
  });

  const itens = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ? ORDER BY descricao_livre').all(orderId);
  assert.equal(itens.length, 2);
  assert.equal(itens[0].product_id, null);
  assert.equal(itens[0].descricao_livre, 'Item digitado à mão');
  assert.equal(itens[1].product_id, null);
  assert.equal(itens[1].descricao_livre, 'Produto Descontinuado');
});

test('criarPedidoLocal sem mesa fica como pedido avulso (mesa_numero nulo), pra revisão manual na Separação', () => {
  const { db, locationId } = freshTestDb();
  const orderId = pedidoGarcomSyncService.criarPedidoLocal({
    locationId, garcomNome: 'João', itens: [{ nome: 'Item qualquer', quantidade: 1 }],
  });
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  assert.equal(pedido.mesa_numero, null);
});

test('criarPedidoLocal aceita item sem quantidade (assume 1) e sem nome (assume "Item não identificado")', () => {
  const { db, locationId } = freshTestDb();
  const orderId = pedidoGarcomSyncService.criarPedidoLocal({
    locationId, garcomNome: 'João', itens: [{ productId: null, quantidade: 'não-é-número' }],
  });
  const item = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ?').get(orderId);
  assert.equal(item.quantidade, 1);
  assert.equal(item.descricao_livre, 'Item não identificado');
});
