const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const ax = require('../electron/services/almoxarifadoService');
const batchService = require('../electron/services/batchService');
const custoMedio = require('../electron/services/custoMedioService');
const { reverterMigracoes, aplicarMigracoes } = require('../electron/db/migracoes');
const { diasAPartirDeHojeLocalISO: emDias } = require('../electron/services/timeService');

function base() {
  const c = freshTestDb();
  const luva = createProduct(c.db, { nome: 'Luva nitrílica', custo: 2, estoqueMinimo: 50 });
  const parafuso = createProduct(c.db, { nome: 'Parafuso 6mm', custo: 0.1, estoqueMinimo: 0 });
  c.db.prepare(`UPDATE products SET codigo_barras = '7891112223334' WHERE id = ?`).run(luva);
  c.db.prepare(`UPDATE products SET sku = 'PAR-06' WHERE id = ?`).run(parafuso);
  return { ...c, luva, parafuso };
}
function lote(c, productId, { lote: l, validade, quantidade }) {
  const r = batchService.createBatch({ productId, locationId: c.locationId, lote: l, validade, quantidade, operadorId: c.gerenteId, deviceId: 'pdv' });
  assert.equal(r.ok, true, r.error);
  return r.batchId;
}
function saida(c, productId, quantidade, loteId = null) {
  c.db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, lote_id) VALUES (?, ?, ?, 'ajuste', ?, ?, 'pdv', ?)`)
    .run(randomUUID(), productId, c.locationId, -quantidade, c.gerenteId, loteId);
}

test('migração 24: cria as tabelas e o lote no movimento; o down desfaz e o up refaz', () => {
  const { db } = freshTestDb();
  const cols = () => db.prepare('PRAGMA table_info(stock_movements)').all().map((x) => x.name);
  assert.ok(cols().includes('lote_id'));
  for (const t of ['almox_enderecos', 'almox_item_endereco', 'almox_setores']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t), t);
  }
  reverterMigracoes(db, 23);
  assert.ok(!cols().includes('lote_id'));
  assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'almox_enderecos'`).get(), undefined);
  aplicarMigracoes(db);
  assert.ok(cols().includes('lote_id'));
});

test('perfil Almoxarifado existe com os campos próprios e alerta de validade', () => {
  const { db } = freshTestDb();
  const p = db.prepare(`SELECT * FROM custom_profiles WHERE id = 'almoxarifado'`).get();
  assert.equal(p.nome, 'Almoxarifado');
  assert.equal(p.alerta_validade_proxima, 1);
  assert.deepEqual(JSON.parse(p.campos_extras_json).map((c) => c.campo), ['marca', 'especificacao', 'controla_lote']);
});

test('endereço: código montado, duplicado recusado (sem diferenciar maiúsculas), rua obrigatória', () => {
  const c = base();
  assert.equal(ax.montarCodigo({ rua: ' a ', prateleira: '03', posicao: '2b' }), 'A-03-2B');
  const r = ax.salvarEndereco({ rua: 'A', prateleira: '03', posicao: '02', descricao: 'EPI', operadorId: c.gerenteId });
  assert.equal(r.ok, true);
  assert.equal(r.codigo, 'A-03-02');
  assert.match(ax.salvarEndereco({ rua: 'a', prateleira: '03', posicao: '02' }).error, /Já existe o endereço A-03-02/);
  assert.match(ax.salvarEndereco({ prateleira: '1' }).error, /rua/);
  assert.equal(ax.salvarEndereco({ id: r.id, rua: 'A', prateleira: '03', posicao: '03' }).codigo, 'A-03-03');
  assert.equal(ax.listarEnderecos()[0].codigo, 'A-03-03');
});

test('item no endereço: o primeiro vira principal, troca de principal e retirada promove o próximo', () => {
  const c = base();
  const a = ax.salvarEndereco({ rua: 'A', prateleira: '1' }).id;
  const b = ax.salvarEndereco({ rua: 'B', prateleira: '1' }).id;
  assert.equal(ax.vincularEndereco({ productId: c.luva, enderecoId: b }).ok, true);
  assert.equal(ax.vincularEndereco({ productId: c.luva, enderecoId: a }).ok, true);
  let ends = ax.enderecosDoItem({ productId: c.luva });
  assert.deepEqual(ends.map((e) => [e.codigo, e.principal]), [['B-1', 1], ['A-1', 0]]);
  ax.vincularEndereco({ productId: c.luva, enderecoId: a, principal: true });
  ends = ax.enderecosDoItem({ productId: c.luva });
  assert.deepEqual(ends.map((e) => [e.codigo, e.principal]), [['A-1', 1], ['B-1', 0]]);
  ax.desvincularEndereco({ productId: c.luva, enderecoId: a });
  assert.deepEqual(ax.enderecosDoItem({ productId: c.luva }).map((e) => [e.codigo, e.principal]), [['B-1', 1]]);
  assert.match(ax.ativarEndereco({ id: b, ativo: false }).error, /Tire os 1 item/);
  assert.equal(ax.ativarEndereco({ id: a, ativo: false }).ok, true);
  assert.match(ax.vincularEndereco({ productId: c.luva, enderecoId: a }).error, /desativado/);
});

test('setores: cria, recusa nome repetido e limite inválido, desativa', () => {
  const c = base();
  const r = ax.salvarSetor({ nome: 'Manutenção', responsavel: 'Carlos', limiteMensal: '1500.555', operadorId: c.gerenteId });
  assert.equal(r.ok, true);
  assert.equal(ax.listarSetores()[0].limite_mensal, 1500.56);
  assert.match(ax.salvarSetor({ nome: 'manutenção' }).error, /Já existe o setor/);
  assert.match(ax.salvarSetor({ nome: 'Obras', limiteMensal: -1 }).error, /Limite mensal inválido/);
  assert.equal(ax.ativarSetor({ id: r.id, ativo: false }).ok, true);
  assert.equal(ax.listarSetores().length, 0);
  assert.equal(ax.listarSetores({ incluirInativos: true }).length, 1);
});

test('lotes: ordem FEFO, situação da validade, saldo por lote e lote antigo estimado', () => {
  const c = base();
  const longe = lote(c, c.luva, { lote: 'L3', validade: emDias(200), quantidade: 30 });
  const vencido = lote(c, c.luva, { lote: 'L1', validade: emDias(-2), quantidade: 10 });
  const perto = lote(c, c.luva, { lote: 'L2', validade: emDias(10), quantidade: 20 });
  lote(c, c.luva, { lote: 'L4', validade: null, quantidade: 5 });
  saida(c, c.luva, 8, perto);
  // Lote gravado antes da migração: sem movimento ligado.
  c.db.prepare(`INSERT INTO product_batches (id, product_id, location_id, lote, validade, quantidade) VALUES (?, ?, ?, 'OLD', ?, 7)`)
    .run(randomUUID(), c.parafuso, c.locationId, emDias(400));
  const ls = ax.lotes({ locationId: c.locationId, productId: c.luva });
  assert.deepEqual(ls.map((l) => [l.lote, l.situacao, l.saldo, l.ordemFefo]), [
    ['L1', 'vencido', 10, 1], ['L2', 'vencendo', 12, 2], ['L3', 'ok', 30, 3], ['L4', 'sem_validade', 5, 4],
  ]);
  saida(c, c.luva, 10, vencido);
  assert.equal(ax.proximoLoteFefo({ productId: c.luva, locationId: c.locationId }).lote, 'L2');
  const antigo = ax.lotes({ locationId: c.locationId, productId: c.parafuso })[0];
  assert.equal(antigo.estimado, true);
  assert.equal(antigo.saldo, 7);
  assert.deepEqual(ax.lotes({ locationId: c.locationId, situacao: 'vencendo' }).map((l) => l.lote), ['L2']);
  assert.ok(longe);
});

test('itens: saldo, endereço principal, próxima validade e filtros', () => {
  const c = base();
  addStock(c.db, { productId: c.parafuso, locationId: c.locationId, quantidade: 500, operadorId: c.gerenteId });
  lote(c, c.luva, { lote: 'L1', validade: emDias(5), quantidade: 20 });
  const a = ax.salvarEndereco({ rua: 'C', prateleira: '2', posicao: '1' }).id;
  ax.vincularEndereco({ productId: c.parafuso, enderecoId: a });
  const itens = ax.listarItens({ locationId: c.locationId });
  const luva = itens.find((i) => i.id === c.luva);
  assert.equal(luva.saldo, 20);
  assert.equal(luva.abaixoMinimo, true);
  assert.equal(luva.situacaoValidade, 'vencendo');
  assert.equal(itens.find((i) => i.id === c.parafuso).endereco, 'C-2-1');
  assert.deepEqual(ax.listarItens({ locationId: c.locationId, filtro: 'sem_endereco' }).map((i) => i.nome), ['Luva nitrílica']);
  assert.deepEqual(ax.listarItens({ locationId: c.locationId, filtro: 'abaixo_minimo' }).map((i) => i.nome), ['Luva nitrílica']);
  assert.deepEqual(ax.listarItens({ locationId: c.locationId, filtro: 'vencendo' }).map((i) => i.nome), ['Luva nitrílica']);
  assert.deepEqual(ax.listarItens({ locationId: c.locationId, busca: 'c-2' }).map((i) => i.nome), ['Parafuso 6mm']);
  const p = ax.painel({ locationId: c.locationId });
  assert.deepEqual([p.itens, p.semEndereco, p.abaixoMinimo, p.lotesVencendo, p.enderecos], [2, 1, 1, 1, 1]);
});

test('kardex: cada movimento valorizado pelo custo médio vigente naquele momento', () => {
  const c = base();
  const entrar = (qtd, custo, quando) => {
    c.db.transaction(() => {
      custoMedio.registrarEntrada(c.db, { productId: c.luva, quantidade: qtd, custoUnitario: custo, origem: 'abastecimento', operadorId: c.gerenteId });
      c.db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, criado_em) VALUES (?, ?, ?, 'entrada', ?, ?, 'pdv', ?)`)
        .run(randomUUID(), c.luva, c.locationId, qtd, c.gerenteId, quando);
      c.db.prepare(`UPDATE product_cost_history SET criado_em = ? WHERE rowid = (SELECT MAX(rowid) FROM product_cost_history)`).run(quando);
    })();
  };
  entrar(10, 2, '2026-01-01 10:00:00');
  c.db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, criado_em) VALUES (?, ?, ?, 'ajuste', -4, ?, 'pdv', '2026-01-02 10:00:00')`)
    .run(randomUUID(), c.luva, c.locationId, c.gerenteId);
  entrar(6, 4, '2026-01-03 10:00:00');
  const k = ax.kardex({ productId: c.luva, locationId: c.locationId });
  assert.equal(k.ok, true, k.error);
  assert.deepEqual(k.movimentos.map((m) => [m.quantidade, m.custoMedio, m.valor, m.saldo, m.saldoValor]), [
    [10, 2, 20, 10, 20], [-4, 2, -8, 6, 12], [6, 3, 18, 12, 36],
  ]);
  assert.equal(k.valorEntradas, 38);
  assert.equal(k.valorSaidas, 8);
  assert.equal(k.saldoValor, 36);
});

test('etiquetas: código de barras ou SKU e endereço principal', () => {
  const c = base();
  const a = ax.salvarEndereco({ rua: 'D', prateleira: '4' }).id;
  ax.vincularEndereco({ productId: c.parafuso, enderecoId: a });
  const e = ax.dadosEtiquetas({ productIds: [c.luva, c.parafuso, 'inexistente'] });
  assert.deepEqual(e.map((x) => [x.nome, x.codigo, x.endereco]), [['Luva nitrílica', '7891112223334', null], ['Parafuso 6mm', 'PAR-06', 'D-4']]);
});
