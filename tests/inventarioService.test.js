const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const inv = require('../electron/services/inventarioService');

function estoque(db, productId) {
  return db.prepare('SELECT COALESCE(SUM(quantidade), 0) q FROM stock_movements WHERE product_id = ?').get(productId).q;
}
function vendaDuranteContagem(db, { productId, locationId, operadorId, quantidade }) {
  db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id) VALUES (?, ?, ?, 'venda', ?, ?, 'pdv')`)
    .run(randomUUID(), productId, locationId, -quantidade, operadorId);
}

function base() {
  const c = freshTestDb();
  const arroz = createProduct(c.db, { nome: 'Arroz', custo: 20, categoria: 'Mercearia' });
  const feijao = createProduct(c.db, { nome: 'Feijão', custo: 7, categoria: 'Mercearia' });
  const sabao = createProduct(c.db, { nome: 'Sabão', custo: 3, categoria: 'Limpeza' });
  c.db.prepare(`UPDATE products SET codigo_barras = '7890000000011' WHERE id = ?`).run(arroz);
  createProduct(c.db, { nome: 'Frete', tipo: 'servico' });
  addStock(c.db, { productId: arroz, locationId: c.locationId, quantidade: 10, operadorId: c.gerenteId });
  addStock(c.db, { productId: feijao, locationId: c.locationId, quantidade: 5, operadorId: c.gerenteId });
  addStock(c.db, { productId: sabao, locationId: c.locationId, quantidade: 8, operadorId: c.gerenteId });
  return { ...c, arroz, feijao, sabao };
}

test('abrir: um item por produto (sem serviço), categoria filtra, só uma aberta por vez', () => {
  const { locationId, gerenteId } = base();
  const r = inv.abrir({ locationId, operadorId: gerenteId, categoria: 'Mercearia' });
  assert.equal(r.ok, true);
  assert.equal(r.produtos, 2);
  assert.match(inv.abrir({ locationId, operadorId: gerenteId }).error, /já existe a contagem nº 1 aberta/i);
  inv.cancelar({ countId: r.id, operadorId: gerenteId });
  assert.match(inv.abrir({ locationId, operadorId: gerenteId, categoria: 'Nada' }).error, /Nenhum produto ativo nesta categoria/);
});

test('contagem cega esconde o saldo do sistema até fechar', () => {
  const { locationId, gerenteId } = base();
  const { id } = inv.abrir({ locationId, operadorId: gerenteId, cega: true });
  assert.ok(inv.obter({ id }).itens.every((i) => i.qtd_sistema === null));
  inv.cancelar({ countId: id, operadorId: gerenteId });
  const { id: id2 } = inv.abrir({ locationId, operadorId: gerenteId, cega: false });
  assert.ok(inv.obter({ id: id2 }).itens.some((i) => i.qtd_sistema === 10));
});

test('fechar: ajusta a diferença descontando o que vendeu durante a contagem; não contado fica', () => {
  const { db, locationId, gerenteId, arroz, feijao, sabao } = base();
  const { id } = inv.abrir({ locationId, operadorId: gerenteId });
  vendaDuranteContagem(db, { productId: arroz, locationId, operadorId: gerenteId, quantidade: 3 }); // vendeu 3 depois da foto
  // Contou arroz pelo leitor, caixa por caixa: 4 + 2 = 6 (esperado 7 -> falta 1).
  assert.equal(inv.registrarContagem({ countId: id, codigo: '7890000000011', quantidade: 4, modo: 'somar', operadorId: gerenteId }).qtdContada, 4);
  assert.equal(inv.registrarContagem({ countId: id, codigo: '7890000000011', quantidade: 2, modo: 'somar', operadorId: gerenteId }).qtdContada, 6);
  inv.registrarContagem({ countId: id, productId: feijao, quantidade: 7, operadorId: gerenteId }); // sobra 2
  assert.match(inv.registrarContagem({ countId: id, codigo: '999', quantidade: 1 }).error, /Nenhum produto/);
  assert.equal(inv.registrarContagem({ countId: id, productId: arroz, quantidade: -1 }).ok, false);

  const r = inv.fechar({ countId: id, operadorId: gerenteId, deviceId: 'd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.ajustes, 2);
  assert.equal(r.perdas, -20);
  assert.equal(r.sobras, 14);
  assert.equal(estoque(db, arroz), 6);
  assert.equal(estoque(db, feijao), 7);
  assert.equal(estoque(db, sabao), 8, 'não contado não mexe');
  const fechado = inv.obter({ id });
  assert.equal(fechado.status, 'fechada');
  assert.equal(fechado.itens.find((i) => i.product_id === arroz).qtd_esperada, 7);
  assert.equal(fechado.resumo.perdas, -20);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE tipo_evento = 'inventario_fechado'`).get());
  assert.equal(inv.registrarContagem({ countId: id, productId: arroz, quantidade: 1 }).ok, false);
});

test('fechar com "zerar não contados" baixa o que não foi encontrado', () => {
  const { db, locationId, gerenteId, arroz, sabao } = base();
  const { id } = inv.abrir({ locationId, operadorId: gerenteId });
  inv.registrarContagem({ countId: id, productId: arroz, quantidade: 10, operadorId: gerenteId });
  const r = inv.fechar({ countId: id, operadorId: gerenteId, deviceId: 'd', zerarNaoContados: true });
  assert.equal(r.ajustes, 2);
  assert.equal(estoque(db, sabao), 0);
  assert.equal(estoque(db, arroz), 10);
});

test('fechar sem nada contado recusa; cancelar não mexe no estoque', () => {
  const { db, locationId, gerenteId, arroz } = base();
  const { id } = inv.abrir({ locationId, operadorId: gerenteId });
  assert.match(inv.fechar({ countId: id, operadorId: gerenteId, deviceId: 'd' }).error, /Nenhum produto foi contado/);
  inv.registrarContagem({ countId: id, productId: arroz, quantidade: 1, operadorId: gerenteId });
  assert.equal(inv.cancelar({ countId: id, operadorId: gerenteId }).ok, true);
  assert.equal(estoque(db, arroz), 10);
  assert.equal(inv.listar({ locationId })[0].status, 'cancelada');
});

test('kardex: saldo corrido, período com saldo anterior e histórico de custo', () => {
  const { db, locationId, gerenteId, arroz } = base();
  db.prepare(`UPDATE stock_movements SET criado_em = '2026-09-01 12:00:00' WHERE product_id = ?`).run(arroz);
  db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, criado_em) VALUES (?, ?, ?, 'venda', -4, ?, 'd', '2026-09-10 12:00:00')`).run(randomUUID(), arroz, locationId, gerenteId);
  db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, criado_em) VALUES (?, ?, ?, 'entrada', 6, ?, 'd', '2026-09-12 12:00:00')`).run(randomUUID(), arroz, locationId, gerenteId);
  const todo = inv.kardex({ productId: arroz, locationId });
  assert.deepEqual(todo.movimentos.map((m) => m.saldo), [10, 6, 12]);
  const periodo = inv.kardex({ productId: arroz, locationId, dataInicio: '2026-09-05', dataFim: '2026-09-30' });
  assert.equal(periodo.saldoAnterior, 10);
  assert.deepEqual([periodo.entradas, periodo.saidas, periodo.saldoFinal], [6, 4, 12]);
  assert.equal(periodo.movimentos[0].tipoRotulo, 'Venda');
});
