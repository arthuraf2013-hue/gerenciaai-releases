const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');
const kitchenService = require('../electron/services/kitchenService');

function ambiente() {
  const ctx = freshTestDb();
  const mesas = {};
  for (const n of ['3', '4', '5', '6']) {
    mesas[n] = tableService.createTable({ locationId: ctx.locationId, numero: n }).id;
  }
  const picanha = createProduct(ctx.db, { nome: 'Picanha', preco: 90 });
  const suco = createProduct(ctx.db, { nome: 'Suco', preco: 10 });
  addStock(ctx.db, { productId: picanha, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  addStock(ctx.db, { productId: suco, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  const abrir = (numero, pessoas) => tableService.openTable({ tableId: mesas[numero], locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas }).saleId;
  const lancar = (saleId, productId, quantidade = 1) => {
    const r = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade, operadorId: ctx.operadorId, deviceId: 'teste' });
    assert.equal(r.ok, true, r.error);
    return ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY rowid DESC LIMIT 1').get(saleId).id;
  };
  const saldo = (productId) => ctx.db.prepare('SELECT SUM(quantidade) s FROM stock_movements WHERE product_id = ?').get(productId).s;
  const mesa = (numero) => ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesas[numero]);
  return { ...ctx, mesas, picanha, suco, abrir, lancar, saldo, mesa };
}

test('juntar mesa livre: fica unida, com a mesma comanda, e abrir por ela cai na principal', () => {
  const { mesas, abrir, mesa, adminId, locationId, operadorId } = ambiente();
  const saleId = abrir('3', 2);
  const r = tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4']], currentOperatorId: adminId });
  assert.equal(r.ok, true, r.error);

  assert.equal(mesa('4').status, 'ocupada');
  assert.equal(mesa('4').sale_id, saleId);
  assert.equal(mesa('4').unida_a_mesa_id, mesas['3']);
  const aberta = tableService.openTable({ tableId: mesas['4'], locationId, operadorId });
  assert.equal(aberta.saleId, saleId);

  const lista = tableService.listTables(locationId);
  assert.equal(lista.find((t) => t.numero === '3').mesas_unidas, '4');
  assert.equal(lista.find((t) => t.numero === '4').unida_a_numero, '3');
  assert.deepEqual(tableService.getTableCart(saleId).grupo.unidas.map((m) => m.numero), ['4']);
});

test('juntar mesa ocupada: itens e pessoas com nome vêm para a principal, renumerados, sem mexer no estoque', () => {
  const { db, mesas, abrir, lancar, saldo, mesa, picanha, suco, adminId, locationId } = ambiente();
  const principal = abrir('3', 2);
  const itemAna = lancar(principal, picanha);
  saleService.setItemPerson({ saleItemId: itemAna, pessoaNumero: 1 });
  tableService.renomearPessoa({ tableId: mesas['3'], numero: 1, nome: 'Ana' });

  const outra = abrir('6', 2);
  const itemDiego = lancar(outra, suco, 2);
  saleService.setItemPerson({ saleItemId: itemDiego, pessoaNumero: 2 });
  tableService.renomearPessoa({ tableId: mesas['6'], numero: 2, nome: 'Diego' });
  const saldoAntes = [saldo(picanha), saldo(suco)];
  const movimentosAntes = db.prepare('SELECT COUNT(*) c FROM stock_movements').get().c;

  const r = tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['6']], currentOperatorId: adminId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.total, 110);

  const carrinho = tableService.getTableCart(principal);
  assert.equal(carrinho.items.length, 2);
  assert.equal(carrinho.items.find((i) => i.id === itemDiego).pessoaNumero, 4, 'Diego era a pessoa 2 da outra mesa: vira 2 + 2');
  assert.deepEqual(carrinho.pessoas, [
    { numero: 1, nome: 'Ana' }, { numero: 2, nome: null }, { numero: 3, nome: null }, { numero: 4, nome: 'Diego' },
  ]);
  assert.equal(mesa('3').pessoas, 4);

  const vendaOutra = db.prepare('SELECT status, total FROM sales WHERE id = ?').get(outra);
  assert.equal(vendaOutra.status, 'cancelada');
  assert.equal(vendaOutra.total, 0);
  assert.deepEqual([saldo(picanha), saldo(suco)], saldoAntes, 'estoque igual');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_movements').get().c, movimentosAntes, 'nenhum movimento criado nem apagado');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE tipo_evento = 'mesas_unidas'`).get().c, 1);

  // Cozinha: cada item uma vez só, com o nome da pessoa e a mesa principal.
  const fila = kitchenService.listActiveItems(locationId);
  assert.equal(fila.length, 2);
  assert.equal(fila.find((i) => i.id === itemDiego).pessoa_nome, 'Diego');
  assert.ok(fila.every((i) => i.mesa_numero === '3'));
});

test('juntar um grupo: a principal de outro grupo traz as unidas dela', () => {
  const { mesas, abrir, mesa, adminId } = ambiente();
  const principal = abrir('3', 1);
  abrir('5', 1);
  assert.equal(tableService.juntarMesas({ tableId: mesas['5'], mesaIds: [mesas['6']], currentOperatorId: adminId }).ok, true);
  const r = tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['5']], currentOperatorId: adminId });
  assert.equal(r.ok, true, r.error);
  for (const n of ['5', '6']) {
    assert.equal(mesa(n).unida_a_mesa_id, mesas['3'], `mesa ${n} aponta direto para a principal`);
    assert.equal(mesa(n).sale_id, principal);
  }
});

test('recusas: reservada, unida a outra, com pagamento, aguardando limpeza, sem mesa', () => {
  const { db, mesas, abrir, lancar, picanha, adminId } = ambiente();
  abrir('3', 1);
  tableService.markReserved(mesas['4'], '2026-11-05T20:00');
  assert.match(tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4']], currentOperatorId: adminId }).error, /reservada/);

  const outra = abrir('5', 1);
  lancar(outra, picanha);
  saleService.addPayment({ saleId: outra, metodo: 'dinheiro', valor: 10 });
  assert.match(tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['5']], currentOperatorId: adminId }).error, /pagamento/);

  abrir('6', 1);
  db.prepare(`UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL WHERE id = ?`).run(mesas['6']);
  assert.match(tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['6']], currentOperatorId: adminId }).error, /limpeza/);

  assert.match(tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [], currentOperatorId: adminId }).error, /pelo menos uma/);
  assert.match(tableService.juntarMesas({ tableId: mesas['4'], mesaIds: [mesas['3']], currentOperatorId: adminId }).error, /Abra a mesa/);
});

test('mesa unida a outra principal não entra em um segundo grupo', () => {
  const { mesas, abrir, adminId } = ambiente();
  abrir('3', 1);
  abrir('5', 1);
  tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4']], currentOperatorId: adminId });
  const r = tableService.juntarMesas({ tableId: mesas['5'], mesaIds: [mesas['4']], currentOperatorId: adminId });
  assert.equal(r.ok, false);
  assert.match(r.error, /unida a Mesa 3/);
});

test('fechar a conta por qualquer mesa do grupo libera todas; transferir fica bloqueado', () => {
  const { mesas, abrir, mesa, adminId } = ambiente();
  abrir('3', 2);
  tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4'], mesas['5']], currentOperatorId: adminId });
  assert.match(tableService.transferTable({ fromTableId: mesas['3'], toTableId: mesas['6'] }).error, /Separe/);

  assert.equal(tableService.releaseTable(mesas['5']).ok, true);
  for (const n of ['3', '4', '5']) {
    assert.equal(mesa(n).status, 'aguardando_limpeza');
    assert.equal(mesa(n).sale_id, null);
    assert.equal(mesa(n).unida_a_mesa_id, null);
  }
});

test('desocupar grupo sem consumo libera todas as mesas', () => {
  const { mesas, abrir, mesa, adminId, locationId } = ambiente();
  abrir('3', 2);
  tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4']], currentOperatorId: adminId });
  const r = tableService.desocuparMesa({ tableId: mesas['4'], locationId, currentOperatorId: adminId, deviceId: 'teste' });
  assert.equal(r.ok, true, r.error);
  assert.equal(mesa('3').status, 'livre');
  assert.equal(mesa('4').status, 'livre');
});

test('separar: a mesa sai do grupo e o consumo continua na principal', () => {
  const { db, mesas, abrir, lancar, mesa, picanha, adminId } = ambiente();
  const principal = abrir('3', 2);
  lancar(principal, picanha);
  tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4']], currentOperatorId: adminId });
  assert.equal(tableService.separarMesa({ tableId: mesas['4'], currentOperatorId: adminId }).ok, true);
  assert.equal(mesa('4').status, 'aguardando_limpeza');
  assert.equal(mesa('4').unida_a_mesa_id, null);
  assert.equal(mesa('3').status, 'ocupada');
  assert.equal(db.prepare('SELECT total FROM sales WHERE id = ?').get(principal).total, 90);
  assert.equal(tableService.separarMesa({ tableId: mesas['3'], currentOperatorId: adminId }).ok, false, 'a principal não se separa de si mesma');
});

test('pessoas: sem limite, com nome, e remover devolve os itens para não atribuído', () => {
  const { mesas, abrir, lancar, mesa, picanha, suco } = ambiente();
  const saleId = abrir('3', 2);
  for (let i = 0; i < 10; i += 1) tableService.adicionarPessoa({ tableId: mesas['3'], nome: i === 9 ? '  Fábio   Souza ' : null });
  assert.equal(mesa('3').pessoas, 12);
  const pessoas = tableService.getTableCart(saleId).pessoas;
  assert.equal(pessoas.length, 12);
  assert.equal(pessoas[11].nome, 'Fábio Souza', 'espaços normalizados');

  tableService.renomearPessoa({ tableId: mesas['3'], numero: 2, nome: 'Bruno' });
  tableService.renomearPessoa({ tableId: mesas['3'], numero: 3, nome: 'Carla' });
  const itemBruno = lancar(saleId, picanha);
  const itemCarla = lancar(saleId, suco);
  saleService.setItemPerson({ saleItemId: itemBruno, pessoaNumero: 2 });
  saleService.setItemPerson({ saleItemId: itemCarla, pessoaNumero: 3 });

  const r = tableService.removerPessoa({ tableId: mesas['3'], numero: 2 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pessoas.length, 11);
  assert.equal(r.pessoas[1].nome, 'Carla', 'Carla sobe para a pessoa 2');
  assert.equal(r.pessoas[10].nome, 'Fábio Souza');
  const itens = tableService.getTableCart(saleId).items;
  assert.equal(itens.find((i) => i.id === itemBruno).pessoaNumero, null, 'item do Bruno volta para não atribuído');
  assert.equal(itens.find((i) => i.id === itemCarla).pessoaNumero, 2);

  assert.equal(tableService.renomearPessoa({ tableId: mesas['3'], numero: 2, nome: '' }).pessoas[1].nome, null, 'nome vazio apaga o nome');
  assert.equal(tableService.renomearPessoa({ tableId: mesas['3'], numero: 99, nome: 'X' }).ok, false);
  assert.equal(tableService.renomearPessoa({ tableId: mesas['3'], numero: 1, nome: 'A'.repeat(80) }).pessoas[0].nome.length, 40);
});

test('número de pessoas não pode cair abaixo de quem já tem item ou nome', () => {
  const { mesas, abrir, lancar, picanha } = ambiente();
  const saleId = abrir('3', 5);
  const item = lancar(saleId, picanha);
  saleService.setItemPerson({ saleItemId: item, pessoaNumero: 4 });
  const r = tableService.updateTablePeople({ tableId: mesas['3'], pessoas: 2 });
  assert.equal(r.ok, false);
  assert.match(r.error, /pessoa 4/);
  assert.equal(tableService.updateTablePeople({ tableId: mesas['3'], pessoas: 4 }).ok, true);
});

test('pessoas pela mesa unida alteram a comanda da principal', () => {
  const { mesas, abrir, mesa, adminId } = ambiente();
  const saleId = abrir('3', 1);
  tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['4']], currentOperatorId: adminId });
  const r = tableService.adicionarPessoa({ tableId: mesas['4'], nome: 'Elisa' });
  assert.equal(r.ok, true, r.error);
  assert.equal(mesa('3').pessoas, 2);
  assert.equal(tableService.getTableCart(saleId).pessoas[1].nome, 'Elisa');
});

test('addItem: o mesmo produto só soma na linha da mesma pessoa', () => {
  const { db, abrir, suco, locationId, operadorId } = ambiente();
  const saleId = abrir('3', 2);
  const lancarPara = (pessoaNumero) => saleService.addItem({ saleId, productId: suco, locationId, quantidade: 1, operadorId, deviceId: 'teste', pessoaNumero });
  assert.equal(lancarPara(1).ok, true);
  assert.equal(lancarPara(2).ok, true);
  assert.equal(lancarPara(1).ok, true);
  assert.equal(lancarPara(null).ok, true);
  assert.equal(lancarPara(undefined).ok, true);
  const linhas = db.prepare('SELECT pessoa_numero, quantidade FROM sale_items WHERE sale_id = ? ORDER BY pessoa_numero').all(saleId);
  assert.deepEqual(linhas.map((l) => [l.pessoa_numero, l.quantidade]), [[null, 2], [1, 2], [2, 1]]);
  assert.equal(db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId).total, 50);
  assert.equal(lancarPara(0).ok, false, 'pessoa 0 não existe');
});
