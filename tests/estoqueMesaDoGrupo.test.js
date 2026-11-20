const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const stockSyncService = require('../electron/services/stockSyncService');
const estoqueServidor = require('../electron/services/estoqueServidorService');
const mesaCompartilhada = require('../electron/services/mesaCompartilhadaService');
const syncState = require('../electron/services/syncStateService');
const lanCliente = require('../electron/services/lanClienteService');

// "Mesas e estoque no servidor": o estoque que vale é o do servidor do grupo
// (contador do grupo menos as vendas abertas), para mesas e balcão.
const DEV = 'device-teste';

function cenario() {
  const { db, locationId, operadorId } = freshTestDb();
  const produto = createProduct(db, { nome: 'Brahma Latão', preco: 8 });
  const venda = saleService.openSale({ locationId, operadorId });
  return { db, locationId, operadorId, produto, saleId: venda.id };
}

function trocar(obj, nome, valor, fn) {
  const original = obj[nome];
  obj[nome] = valor;
  try { return fn(); } finally { obj[nome] = original; }
}
async function trocarAsync(obj, nome, valor, fn) {
  const original = obj[nome];
  obj[nome] = valor;
  try { return await fn(); } finally { obj[nome] = original; }
}
const comSaldoDoGrupo = (saldo, fn) => trocar(stockSyncService, 'detalheDoGrupoNoServidor', () => (saldo === null ? null : { contador: saldo, reservado: 0, saldo }), fn);

// ---------------------------------------------------------------- no servidor

test('servidor: local zerado, grupo com estoque -> lança (mesa ou balcão)', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  comSaldoDoGrupo(5, () => {
    assert.equal(saleService.addItem({ saleId, productId: produto, locationId, quantidade: 2, operadorId, deviceId: DEV }).ok, true);
  });
});

test('servidor: o grupo manda mesmo com estoque local sobrando', () => {
  const { db, locationId, operadorId, produto, saleId } = cenario();
  addStock(db, { productId: produto, locationId, quantidade: 10, operadorId });
  comSaldoDoGrupo(1, () => {
    const r = saleService.addItem({ saleId, productId: produto, locationId, quantidade: 2, operadorId, deviceId: DEV });
    assert.equal(r.ok, false);
    assert.match(r.error, /no grupo\. Disponível: 1 /);
  });
});

test('sem contador no grupo (ou fora de grupo): vale o estoque local, como sempre', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  comSaldoDoGrupo(null, () => {
    const r = saleService.addItem({ saleId, productId: produto, locationId, quantidade: 1, operadorId, deviceId: DEV });
    assert.equal(r.ok, false);
    assert.match(r.error, /^Estoque insuficiente neste computador\. Disponível: 0 /);
  });
});

test('servidor: + do carrinho também confere o grupo', () => {
  const { db, locationId, operadorId, produto, saleId } = cenario();
  addStock(db, { productId: produto, locationId, quantidade: 1, operadorId });
  assert.equal(saleService.addItem({ saleId, productId: produto, locationId, quantidade: 1, operadorId, deviceId: DEV }).ok, true);
  const item = db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(saleId);
  comSaldoDoGrupo(3, () => {
    assert.equal(saleService.ajustarQuantidadeItem({ saleId, saleItemId: item.id, delta: 1, locationId, operadorId, deviceId: DEV }).ok, true);
  });
  comSaldoDoGrupo(0, () => {
    assert.equal(saleService.ajustarQuantidadeItem({ saleId, saleItemId: item.id, delta: 1, locationId, operadorId, deviceId: DEV }).ok, false);
  });
});

test('saldo do servidor = contador do grupo menos o que está em vendas abertas lá', () => {
  const { db, locationId, operadorId, produto, saleId } = cenario();
  const outro = createProduct(db, { nome: 'Sem contador', preco: 5 });
  addStock(db, { productId: produto, locationId, quantidade: 10, operadorId });
  db.prepare(`INSERT INTO lan_estoque (grupo_id, produto_id, quantidade) VALUES ('g1', ?, 10)`).run(produto);
  saleService.addItem({ saleId, productId: produto, locationId, quantidade: 3, operadorId, deviceId: DEV });
  const saldos = stockSyncService.saldosNoServidor('g1');
  assert.equal(saldos.get(produto), 7);
  assert.equal(saldos.has(outro), false);
  assert.deepEqual([...stockSyncService.saldosNoServidor('g1', ['outro-id'])], []);
  // Item cancelado e venda finalizada não reservam mais.
  db.prepare(`UPDATE sales SET status = 'finalizada' WHERE id = ?`).run(saleId);
  assert.equal(stockSyncService.saldosNoServidor('g1').get(produto), 10);
});

// ---------------------------------------------------------------- no caixa

test('caixa: com o saldo do servidor, lança mesmo com o estoque local zerado; acima dele, bloqueia', () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  const base = { saleId, productId: produto, locationId, operadorId, deviceId: DEV, estoqueNoServidor: true };
  assert.equal(saleService.addItem({ ...base, quantidade: 2, saldoServidor: 3 }).ok, true);
  const r = saleService.addItem({ ...base, quantidade: 4, saldoServidor: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /no servidor\. Disponível: 3 /);
  // Servidor sem responder (ou produto sem contador): vende e acerta depois.
  assert.equal(saleService.addItem({ ...base, quantidade: 50, saldoServidor: null }).ok, true);
});

test('caixa: disponível = saldo do servidor menos o que já está nas vendas abertas deste caixa', async () => {
  const { locationId, operadorId, produto, saleId } = cenario();
  saleService.addItem({ saleId, productId: produto, locationId, quantidade: 2, operadorId, deviceId: DEV, estoqueNoServidor: true, saldoServidor: 9 });
  estoqueServidor.invalidar();
  await trocarAsync(syncState, 'getGrupoSincronizacaoId', () => 'g1', () =>
    trocarAsync(lanCliente, 'saldosDeEstoque', async () => ({ saldos: { [produto]: 9 } }), async () => {
      assert.equal(await estoqueServidor.saldoParaLancar(produto), 7);
      assert.equal(await estoqueServidor.saldoParaLancar('sem-contador'), null);
    }));
});

test('caixa: servidor fora do ar não trava (null) e a busca não mostra o estoque local', async () => {
  const { produto } = cenario();
  estoqueServidor.invalidar();
  await trocarAsync(syncState, 'getGrupoSincronizacaoId', () => 'g1', () =>
    trocarAsync(lanCliente, 'saldosDeEstoque', async () => { throw Object.assign(new Error('sem rede'), { rede: true }); }, () =>
      trocarAsync(mesaCompartilhada, 'ativa', () => true, async () => {
        assert.equal(await estoqueServidor.saldoParaLancar(produto), null);
        const lista = await estoqueServidor.sobreporEstoque([{ id: produto, tipo: 'produto', estoque_atual: -4 }, { id: 's', tipo: 'servico' }]);
        assert.equal(lista[0].estoque_atual, null);
        assert.deepEqual(lista[1], { id: 's', tipo: 'servico' });
      })));
});

test('caixa: busca mostra o estoque do servidor; fora do modo servidor, nada muda', async () => {
  const { produto } = cenario();
  estoqueServidor.invalidar();
  await trocarAsync(syncState, 'getGrupoSincronizacaoId', () => 'g1', () =>
    trocarAsync(lanCliente, 'saldosDeEstoque', async () => ({ saldos: { [produto]: 12 } }), async () => {
      await trocarAsync(mesaCompartilhada, 'ativa', () => true, async () => {
        const [p] = await estoqueServidor.sobreporEstoque([{ id: produto, tipo: 'produto', estoque_atual: 0 }]);
        assert.equal(p.estoque_atual, 12);
        assert.match(estoqueServidor.bloqueio().error, /feitos no computador servidor/);
      });
      await trocarAsync(mesaCompartilhada, 'ativa', () => false, async () => {
        const [p] = await estoqueServidor.sobreporEstoque([{ id: produto, tipo: 'produto', estoque_atual: 0 }]);
        assert.equal(p.estoque_atual, 0);
        assert.equal(estoqueServidor.bloqueio(), null);
      });
    }));
});

// Caixa apontado para o servidor: a tela de Alertas e o "estoque baixo" usam o saldo do servidor
// (antes liam o saldo local do caixa: zero, ou negativo pelas vendas daqui).
test('alertas de estoque: caixa com estoque no servidor usa o saldo do servidor, não o local', async () => {
  const { db, locationId, produto } = cenario();
  db.prepare('UPDATE products SET estoque_minimo = 100 WHERE id = ?').run(produto);
  const outro = createProduct(db, { nome: 'Corona', preco: 10 });
  db.prepare('UPDATE products SET estoque_minimo = 100 WHERE id = ?').run(outro);
  const perfil = { estoqueCriticoPercentual: 50 };
  const saldos = { [produto]: 500, [outro]: 3 }; // o servidor tem muito de um e quase nada do outro
  const original = syncState.getGrupoSincronizacaoId;
  syncState.getGrupoSincronizacaoId = () => 'g1';
  try {
  await trocarAsync(lanCliente, 'saldosDeEstoque', async () => ({ saldos }), async () => {
    estoqueServidor.invalidar();
    await trocarAsync(mesaCompartilhada, 'ativa', () => true, async () => {
      const alertas = await estoqueServidor.alertas(locationId, perfil);
      assert.deepEqual(alertas.map((p) => p.id), [outro], 'só o que está baixo NO SERVIDOR');
      assert.equal(alertas[0].estoque_atual, 3);
      const baixo = await estoqueServidor.estoqueBaixo(locationId);
      assert.deepEqual(baixo.map((p) => p.id), [outro]);
    });
    // Fora do modo servidor: vale o estoque local (os dois estão zerados = críticos).
    await trocarAsync(mesaCompartilhada, 'ativa', () => false, async () => {
      estoqueServidor.invalidar();
      const alertas = await estoqueServidor.alertas(locationId, perfil);
      assert.equal(alertas.length, 2);
    });
  });
  // Servidor sem responder: cai para o local (não esconde o alerta).
  await trocarAsync(lanCliente, 'saldosDeEstoque', async () => { throw Object.assign(new Error('sem rede'), { rede: true }); }, async () => {
    await trocarAsync(mesaCompartilhada, 'ativa', () => true, async () => {
      estoqueServidor.invalidar();
      assert.equal((await estoqueServidor.alertas(locationId, perfil)).length, 2);
    });
  });
  } finally { syncState.getGrupoSincronizacaoId = original; estoqueServidor.invalidar(); }
});
