const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');
const timeService = require('../electron/services/timeService');

function ambiente() {
  const ctx = freshTestDb();
  const mesas = {};
  for (const n of ['3', '4', '6', '10']) mesas[n] = tableService.createTable({ locationId: ctx.locationId, numero: n }).id;
  mesas.varanda = tableService.createTable({ locationId: ctx.locationId, numero: '20', nome: 'Varanda' }).id;
  const prato = createProduct(ctx.db, { nome: 'Prato', preco: 30 });
  const suco = createProduct(ctx.db, { nome: 'Suco', preco: 10 });
  addStock(ctx.db, { productId: prato, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  addStock(ctx.db, { productId: suco, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  const abrir = (chave, pessoas) => tableService.openTable({ tableId: mesas[chave], locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas }).saleId;
  const lancar = (saleId, productId, quantidade = 1) => {
    assert.equal(saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade, operadorId: ctx.operadorId, deviceId: 'teste' }).ok, true);
    return ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY rowid DESC LIMIT 1').get(saleId).id;
  };
  const fecharConta = (saleId, chave) => {
    const { total } = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId);
    saleService.addPayment({ saleId, metodo: 'dinheiro', valor: total });
    assert.equal(saleService.finalizeSale(saleId).ok, true);
    assert.equal(tableService.releaseTable(mesas[chave]).ok, true);
  };
  const hoje = timeService.hojeLocalISO();
  const historico = () => saleService.listSalesByRange({ locationId: ctx.locationId, dataInicio: hoje, dataFim: hoje });
  const daVenda = (saleId) => historico().find((v) => v.id === saleId);
  return { ...ctx, mesas, prato, suco, abrir, lancar, fecharConta, historico, daVenda };
}

test('a venda lembra a mesa depois que a conta fecha e a mesa é liberada', () => {
  const { abrir, lancar, fecharConta, daVenda, prato, db, mesas } = ambiente();
  const saleId = abrir('6', 2);
  lancar(saleId, prato);
  fecharConta(saleId, '6');
  assert.equal(db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(mesas['6']).sale_id, null, 'a mesa foi liberada');
  assert.equal(daVenda(saleId).mesa_rotulo, 'Mesa 6');
});

test('mesas unidas: principal primeiro, unidas em ordem numérica (10 depois de 4)', () => {
  const { abrir, lancar, fecharConta, daVenda, prato, mesas, adminId } = ambiente();
  const saleId = abrir('3', 2);
  lancar(saleId, prato);
  assert.equal(tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['10'], mesas['4']], currentOperatorId: adminId }).ok, true);
  fecharConta(saleId, '10'); // fechar por uma unida também vale
  assert.equal(daVenda(saleId).mesa_rotulo, 'Mesa 3 + 4 + 10');
});

test('mesa com nome aparece pelo nome; venda de balcão fica sem mesa', () => {
  const { abrir, lancar, fecharConta, daVenda, suco, db, locationId, operadorId } = ambiente();
  const saleId = abrir('varanda', 1);
  lancar(saleId, suco);
  fecharConta(saleId, 'varanda');
  assert.equal(daVenda(saleId).mesa_rotulo, 'Varanda');

  const balcao = saleService.openSale({ locationId, operadorId }).id;
  saleService.addItem({ saleId: balcao, productId: suco, locationId, quantidade: 1, operadorId, deviceId: 'teste' });
  saleService.addPayment({ saleId: balcao, metodo: 'pix', valor: 10 });
  assert.equal(saleService.finalizeSale(balcao).ok, true);
  assert.equal(daVenda(balcao).mesa_rotulo, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_mesas WHERE sale_id = ?').get(balcao).c, 0);
});

test('detalhe da venda traz a pessoa e o nome de cada item, mesmo depois de fechada', () => {
  const { abrir, lancar, fecharConta, prato, suco, mesas } = ambiente();
  const saleId = abrir('6', 2);
  const itemAna = lancar(saleId, prato);
  const itemSemPessoa = lancar(saleId, suco, 2);
  saleService.setItemPerson({ saleItemId: itemAna, pessoaNumero: 1 });
  tableService.renomearPessoa({ tableId: mesas['6'], numero: 1, nome: 'Ana' });
  fecharConta(saleId, '6');

  const itens = saleService.getSaleItemsDetail(saleId);
  const ana = itens.find((i) => i.id === itemAna);
  assert.equal(ana.pessoa_numero, 1);
  assert.equal(ana.pessoa_nome, 'Ana');
  const outro = itens.find((i) => i.id === itemSemPessoa);
  assert.equal(outro.pessoa_numero, null);
  assert.equal(outro.pessoa_nome, null);
});

test('desocupar e juntar também deixam a mesa registrada na comanda cancelada', () => {
  const { abrir, lancar, daVenda, suco, mesas, adminId, locationId } = ambiente();
  const vazia = abrir('4', 1);
  assert.equal(tableService.desocuparMesa({ tableId: mesas['4'], locationId, currentOperatorId: adminId, deviceId: 'teste' }).ok, true);
  assert.equal(daVenda(vazia).mesa_rotulo, 'Mesa 4');

  abrir('3', 1);
  const outra = abrir('6', 1);
  lancar(outra, suco);
  assert.equal(tableService.juntarMesas({ tableId: mesas['3'], mesaIds: [mesas['6']], currentOperatorId: adminId }).ok, true);
  const cancelada = daVenda(outra);
  assert.equal(cancelada.status, 'cancelada');
  assert.equal(cancelada.mesa_rotulo, 'Mesa 6');
});

test('finalizar duas vezes não duplica a mesa registrada', () => {
  const { abrir, lancar, prato, db } = ambiente();
  const saleId = abrir('6', 1);
  lancar(saleId, prato);
  saleService.registrarMesasDaVenda(db, saleId);
  saleService.registrarMesasDaVenda(db, saleId);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_mesas WHERE sale_id = ?').get(saleId).c, 1);
});
