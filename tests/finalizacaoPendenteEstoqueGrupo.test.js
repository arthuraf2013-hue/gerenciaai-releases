const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const stockSyncService = require('../electron/services/stockSyncService');

/**
 * Testes de finalizeSaleComVerificacaoDeGrupo/tentarFinalizarVendasPendentesDeEstoque
 * (ver comentário completo em saleService.js). Em vez de configurar um
 * grupo de sincronização de verdade (exigiria Firestore real -- mesma
 * limitação já documentada em pairingService.test.js), substitui
 * diretamente `stockSyncService.verificarEDebitarEstoqueRemoto` por um
 * dublê controlado, exatamente o jeito que saleService já consome essa
 * função (require inline, mesmo objeto de módulo cacheado pelo Node) --
 * então o que importa pra esses testes é só o CONTRATO entre as duas
 * funções (ok/motivo/error), não a integração real com o Firestore.
 */
async function comEstoqueRemotoMockado(resultadoOuFn, fn) {
  const original = stockSyncService.verificarEDebitarEstoqueRemoto;
  stockSyncService.verificarEDebitarEstoqueRemoto = typeof resultadoOuFn === 'function'
    ? resultadoOuFn
    : async () => resultadoOuFn;
  try {
    // Precisa dar `await` aqui dentro (não só devolver a promise) --
    // sem isso o `finally` roda assim que `fn()` retorna a promise
    // (síncrono, antes dela resolver de verdade) e restaura a função
    // original ENQUANTO `fn` ainda está no meio de um laço com vários
    // `await` -- a primeira chamada vê o mock certo, mas a segunda em
    // diante já cai na implementação de verdade (que nos testes, sem
    // grupo configurado, devolve `{ ok: true }` por padrão e mascara
    // silenciosamente o resultado esperado do mock).
    return await fn();
  } finally {
    stockSyncService.verificarEDebitarEstoqueRemoto = original;
  }
}

function abrirVendaComItem(ctx, { quantidadeEstoque = 10, quantidadeVenda = 1, preco = 10 } = {}) {
  const productId = createProduct(ctx.db, { preco, estoqueMinimo: 2 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: quantidadeEstoque, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({
    saleId, productId, locationId: ctx.locationId, quantidade: quantidadeVenda,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: preco * quantidadeVenda, detalhes: {} });
  return { ...ctx, productId, saleId };
}

test('finalizeSaleComVerificacaoDeGrupo finaliza normalmente quando a checagem remota devolve ok', async () => {
  const ctx = abrirVendaComItem(freshTestDb());

  const result = await comEstoqueRemotoMockado({ ok: true }, () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));

  assert.equal(result.ok, true);
  const sale = ctx.db.prepare('SELECT status, pendente_estoque_grupo FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.status, 'finalizada');
  assert.equal(sale.pendente_estoque_grupo, 0);
});

test('falha de REDE na checagem remota marca a venda como pendente e mantém aberta (não finaliza)', async () => {
  const ctx = abrirVendaComItem(freshTestDb());

  const result = await comEstoqueRemotoMockado(
    { ok: false, motivo: 'rede', error: 'Não foi possível confirmar o estoque com o servidor do grupo agora.' },
    () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId)
  );

  assert.equal(result.ok, false);
  assert.equal(result.pendente, true);
  assert.equal(result.tentativas, 1);

  const sale = ctx.db.prepare(
    `SELECT status, pendente_estoque_grupo, pendente_estoque_tentativas, pendente_estoque_proxima_tentativa FROM sales WHERE id = ?`
  ).get(ctx.saleId);
  assert.equal(sale.status, 'aberta', 'a venda não pode se perder nem ficar travada -- continua aberta localmente');
  assert.equal(sale.pendente_estoque_grupo, 1);
  assert.equal(sale.pendente_estoque_tentativas, 1);
  assert.ok(sale.pendente_estoque_proxima_tentativa, 'precisa ter calculado quando tentar de novo');
});

test('tentativas de rede consecutivas incrementam o contador', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  const falhaRede = { ok: false, motivo: 'rede', error: 'offline' };

  await comEstoqueRemotoMockado(falhaRede, () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));
  const segunda = await comEstoqueRemotoMockado(falhaRede, () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));

  assert.equal(segunda.tentativas, 2);
  const sale = ctx.db.prepare('SELECT pendente_estoque_tentativas FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.pendente_estoque_tentativas, 2);
});

test('estoque insuficiente DE VERDADE não marca pendência -- não há por que tentar de novo sozinho', async () => {
  const ctx = abrirVendaComItem(freshTestDb());

  const result = await comEstoqueRemotoMockado(
    { ok: false, motivo: 'estoque_insuficiente', error: 'Estoque insuficiente no grupo: Produto X (pede 1, tem 0)' },
    () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId)
  );

  assert.equal(result.ok, false);
  assert.equal(result.motivo, 'estoque_insuficiente');
  assert.equal(result.pendente, undefined);

  const sale = ctx.db.prepare('SELECT status, pendente_estoque_grupo FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.status, 'aberta');
  assert.equal(sale.pendente_estoque_grupo, 0, 'sem pendência marcada -- tentar de novo sozinho não resolveria');
});

test('estoque insuficiente DE VERDADE limpa uma pendência de rede anterior (achou o conflito ao tentar de novo)', async () => {
  const ctx = abrirVendaComItem(freshTestDb());

  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));
  let sale = ctx.db.prepare('SELECT pendente_estoque_grupo FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.pendente_estoque_grupo, 1, 'pré-condição: ficou pendente depois da falha de rede');

  await comEstoqueRemotoMockado(
    { ok: false, motivo: 'estoque_insuficiente', error: 'acabou enquanto esperava' },
    () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId)
  );

  sale = ctx.db.prepare('SELECT pendente_estoque_grupo, pendente_estoque_tentativas FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.pendente_estoque_grupo, 0);
  assert.equal(sale.pendente_estoque_tentativas, 0);
});

test('tentarFinalizarVendasPendentesDeEstoque (forcar) finaliza as pendentes quando a rede volta', async () => {
  const ctx1 = abrirVendaComItem(freshTestDb());
  // Segunda venda no MESMO banco (mesma location) -- abrirVendaComItem usa
  // freshTestDb() de novo só pra ganhar os helpers prontos, mas aqui
  // precisamos continuar no banco já criado por ctx1, então monta à mão.
  const productId2 = createProduct(ctx1.db, { preco: 20, estoqueMinimo: 2 });
  addStock(ctx1.db, { productId: productId2, locationId: ctx1.locationId, quantidade: 5, operadorId: ctx1.adminId });
  const { id: saleId2 } = saleService.openSale({ locationId: ctx1.locationId, operadorId: ctx1.operadorId });
  saleService.addItem({ saleId: saleId2, productId: productId2, locationId: ctx1.locationId, quantidade: 1, operadorId: ctx1.operadorId, deviceId: 'device-teste' });
  saleService.addPayment({ saleId: saleId2, metodo: 'dinheiro', valor: 20, detalhes: {} });

  const falhaRede = { ok: false, motivo: 'rede', error: 'offline' };
  await comEstoqueRemotoMockado(falhaRede, () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx1.saleId));
  await comEstoqueRemotoMockado(falhaRede, () => saleService.finalizeSaleComVerificacaoDeGrupo(saleId2));

  const resultado = await comEstoqueRemotoMockado({ ok: true }, () =>
    saleService.tentarFinalizarVendasPendentesDeEstoque({ forcar: true }));

  assert.equal(resultado.tentadas, 2);
  assert.deepEqual(resultado.finalizadas.sort(), [ctx1.saleId, saleId2].sort());
  assert.equal(resultado.aindaPendentes.length, 0);
  assert.equal(resultado.comConflito.length, 0);

  assert.equal(ctx1.db.prepare('SELECT status FROM sales WHERE id = ?').get(ctx1.saleId).status, 'finalizada');
  assert.equal(ctx1.db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId2).status, 'finalizada');
});

test('tentarFinalizarVendasPendentesDeEstoque SEM forcar respeita o backoff -- não martela antes da hora calculada', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));
  // Backoff da 1ª tentativa é de 10s (ver BACKOFF_ESTOQUE_GRUPO_MS) -- o
  // teste roda em milissegundos, então "agora" ainda está bem antes da
  // próxima tentativa agendada.

  const resultado = await comEstoqueRemotoMockado({ ok: true }, () =>
    saleService.tentarFinalizarVendasPendentesDeEstoque({ forcar: false }));

  assert.equal(resultado.tentadas, 0, 'não deveria nem tentar -- ainda não chegou a hora do backoff');
  assert.equal(ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(ctx.saleId).status, 'aberta');
});

test('tentarFinalizarVendasPendentesDeEstoque identifica conflito real (estoque acabou enquanto esperava) sem tentar pra sempre', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));

  const resultado = await comEstoqueRemotoMockado(
    { ok: false, motivo: 'estoque_insuficiente', error: 'acabou' },
    () => saleService.tentarFinalizarVendasPendentesDeEstoque({ forcar: true })
  );

  assert.equal(resultado.finalizadas.length, 0);
  assert.equal(resultado.comConflito.length, 1);
  assert.equal(resultado.comConflito[0].id, ctx.saleId);
  // Não fica tentando pra sempre -- a pendência já foi limpa (ver teste
  // acima), então um próximo ciclo nem olha mais pra essa venda.
  const sale = ctx.db.prepare('SELECT pendente_estoque_grupo FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.pendente_estoque_grupo, 0);
});

test('getStatusPendenteEstoque devolve o estado certo (aberta+pendente, depois finalizada)', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));

  const pendente = saleService.getStatusPendenteEstoque(ctx.saleId);
  assert.equal(pendente.ok, true);
  assert.equal(pendente.status, 'aberta');
  assert.equal(pendente.pendente, true);
  assert.equal(pendente.tentativas, 1);

  await comEstoqueRemotoMockado({ ok: true }, () => saleService.tentarFinalizarVendasPendentesDeEstoque({ forcar: true }));

  const depois = saleService.getStatusPendenteEstoque(ctx.saleId);
  assert.equal(depois.status, 'finalizada');
  assert.equal(depois.pendente, false);
});

test('contarVendasPendentesDeEstoque só conta vendas abertas e pendentes deste local', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));

  // Uma segunda venda aberta normal (sem checagem de grupo nenhuma) não deveria contar.
  const { id: outraVendaAberta } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  void outraVendaAberta;

  assert.equal(saleService.contarVendasPendentesDeEstoque(ctx.locationId), 1);
});

test('listVendasPendentesDeEstoque lista as vendas em pré-finalização deste local', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));

  const lista = saleService.listVendasPendentesDeEstoque(ctx.locationId);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, ctx.saleId);
  assert.equal(lista[0].tentativas, 1);
  assert.ok(lista[0].operadorNome, 'deve trazer o nome do operador pra identificar a venda');
});

test('getOrOpenCurrentSale ignora venda pendente de confirmação de estoque -- libera um carrinho novo em vez de prender o operador na venda que está esperando', async () => {
  const ctx = abrirVendaComItem(freshTestDb());
  await comEstoqueRemotoMockado({ ok: false, motivo: 'rede', error: 'offline' }, () =>
    saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));
  let sale = ctx.db.prepare('SELECT status, pendente_estoque_grupo FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.status, 'aberta');
  assert.equal(sale.pendente_estoque_grupo, 1, 'pré-condição: a venda ficou pendente depois da falha de rede');

  const resumo = saleService.getOrOpenCurrentSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  assert.notEqual(resumo.saleId, ctx.saleId, 'não pode reabrir a venda pendente como "o carrinho atual"');
  assert.equal(resumo.resumed, false, 'deve abrir um carrinho novo e vazio, não retomar nenhum existente');
  assert.equal(resumo.items.length, 0);

  // A venda pendente continua intacta por baixo -- só deixou de ser "o
  // carrinho atual" pro operador. Ela ainda vai ser confirmada sozinha
  // em segundo plano (ver tentarFinalizarVendasPendentesDeEstoque).
  sale = ctx.db.prepare('SELECT status, pendente_estoque_grupo FROM sales WHERE id = ?').get(ctx.saleId);
  assert.equal(sale.status, 'aberta');
  assert.equal(sale.pendente_estoque_grupo, 1);
});

test('tentarFinalizarVendasPendentesDeEstoque processa uma venda por vez, na ordem de chegada -- a mais antiga nunca perde a última unidade pra uma pendência mais nova', async () => {
  const ctx = abrirVendaComItem(freshTestDb(), { quantidadeEstoque: 10, quantidadeVenda: 1, preco: 10 });
  // Segunda venda pendente do MESMO produto, criada depois da primeira.
  const { id: saleId2 } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({
    saleId: saleId2, productId: ctx.productId, locationId: ctx.locationId, quantidade: 1,
    operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  saleService.addPayment({ saleId: saleId2, metodo: 'dinheiro', valor: 10, detalhes: {} });

  const falhaRede = { ok: false, motivo: 'rede', error: 'offline' };
  await comEstoqueRemotoMockado(falhaRede, () => saleService.finalizeSaleComVerificacaoDeGrupo(ctx.saleId));
  await comEstoqueRemotoMockado(falhaRede, () => saleService.finalizeSaleComVerificacaoDeGrupo(saleId2));

  // Simula o grupo com só 1 unidade de verdade restante -- o suficiente
  // pra UMA das duas vendas pendentes, nunca as duas. Se o processamento
  // fosse paralelo (ou pegasse a venda errada primeiro), as duas
  // poderiam achar que a unidade ainda estava livre.
  let restanteNoGrupo = 1;
  const mockComEstoqueLimitado = async (itens) => {
    const pedido = itens.reduce((acc, i) => acc + i.quantidade, 0);
    if (pedido > restanteNoGrupo) return { ok: false, motivo: 'estoque_insuficiente', error: 'Estoque insuficiente no grupo.' };
    restanteNoGrupo -= pedido;
    return { ok: true };
  };

  const resultado = await comEstoqueRemotoMockado(mockComEstoqueLimitado, () =>
    saleService.tentarFinalizarVendasPendentesDeEstoque({ forcar: true }));

  assert.equal(resultado.tentadas, 2);
  // A venda criada primeiro (ctx.saleId) ganha a unidade; a criada depois
  // (saleId2) encontra o conflito real de estoque -- nunca as duas ao
  // mesmo tempo.
  assert.deepEqual(resultado.finalizadas, [ctx.saleId]);
  assert.deepEqual(resultado.comConflito.map((c) => c.id), [saleId2]);
  assert.equal(ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(ctx.saleId).status, 'finalizada');
  const sale2 = ctx.db.prepare('SELECT status, pendente_estoque_grupo FROM sales WHERE id = ?').get(saleId2);
  assert.equal(sale2.status, 'aberta', 'não finalizou, mas também não se perde -- fica aberta pro operador decidir');
  assert.equal(sale2.pendente_estoque_grupo, 0, 'conflito real -- não marca pra tentar de novo sozinho');
});
