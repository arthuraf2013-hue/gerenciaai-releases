const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const botOrderService = require('../electron/services/botOrderService');

test('getConfig começa desativado por padrão, e updateConfig liga/desliga', () => {
  freshTestDb();
  assert.equal(botOrderService.getConfig().ativo, false);

  botOrderService.updateConfig({ ativo: true });
  assert.equal(botOrderService.getConfig().ativo, true);

  botOrderService.updateConfig({ ativo: false });
  assert.equal(botOrderService.getConfig().ativo, false);
});

test('createOrder exige nome, telefone, pelo menos um item, e endereço quando é entrega', () => {
  const { locationId } = freshTestDb();

  assert.equal(
    botOrderService.createOrder({ locationId, clienteTelefone: '11999999999', itens: [{ descricaoLivre: 'Dipirona' }] }).ok,
    false, 'sem nome deveria falhar'
  );
  assert.equal(
    botOrderService.createOrder({ locationId, clienteNome: 'Ana', itens: [{ descricaoLivre: 'Dipirona' }] }).ok,
    false, 'sem telefone deveria falhar'
  );
  assert.equal(
    botOrderService.createOrder({ locationId, clienteNome: 'Ana', clienteTelefone: '11999999999', itens: [] }).ok,
    false, 'sem item deveria falhar'
  );
  assert.equal(
    botOrderService.createOrder({
      locationId, clienteNome: 'Ana', clienteTelefone: '11999999999', tipoEntrega: 'entrega',
      itens: [{ descricaoLivre: 'Dipirona' }],
    }).ok,
    false, 'entrega sem endereço deveria falhar'
  );
});

test('createOrder cria o pedido com os itens, e listOrders/getOrderWithItems devolvem certo', () => {
  const { db, locationId } = freshTestDb();
  const dipirona = createProduct(db, { nome: 'Dipirona' });
  addStock(db, { productId: dipirona, locationId, quantidade: 10, operadorId: null });

  const resultado = botOrderService.createOrder({
    locationId, clienteNome: 'Ana Souza', clienteTelefone: '11999999999', tipoEntrega: 'retirada',
    origem: 'whatsapp_bot',
    itens: [{ productId: dipirona, quantidade: 2 }, { descricaoLivre: 'Vitamina C (marca qualquer)' }],
  });
  assert.equal(resultado.ok, true);

  const lista = botOrderService.listOrders({ locationId });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].status, 'novo');
  assert.equal(lista[0].origem, 'whatsapp_bot');
  assert.equal(Number(lista[0].totalItens), 2);
  assert.equal(Number(lista[0].itensSeparados), 0);

  const detalhe = botOrderService.getOrderWithItems(resultado.id);
  assert.equal(detalhe.ok, true);
  assert.equal(detalhe.itens.length, 2);
  const itemProduto = detalhe.itens.find((i) => i.product_id === dipirona);
  assert.equal(itemProduto.produtoNome, 'Dipirona');
  assert.equal(itemProduto.estoqueAtual, 10, 'deveria trazer o estoque atual do produto no local do pedido');
  const itemLivre = detalhe.itens.find((i) => i.descricao_livre);
  assert.equal(itemLivre.descricao_livre, 'Vitamina C (marca qualquer)');
});

test('updateOrderStatus carimba separado_em/concluido_em uma única vez, e não deixa status inválido', () => {
  const { locationId, adminId, gerenteId } = freshTestDb();
  const { id } = botOrderService.createOrder({
    locationId, clienteNome: 'Ana', clienteTelefone: '11999999999',
    itens: [{ descricaoLivre: 'Dipirona' }],
  });

  assert.equal(botOrderService.updateOrderStatus({ orderId: id, status: 'nao-existe' }).ok, false);

  botOrderService.updateOrderStatus({ orderId: id, status: 'em_separacao', operadorId: adminId });
  const { pedido: p1 } = botOrderService.getOrderWithItems(id);
  assert.equal(p1.status, 'em_separacao');
  assert.equal(p1.separado_por, adminId);
  assert.ok(p1.separado_em);

  // Muda pra outro operador começar a separação de novo -- não deveria
  // roubar a autoria nem recarimbar o horário original.
  botOrderService.updateOrderStatus({ orderId: id, status: 'em_separacao', operadorId: gerenteId });
  const { pedido: p2 } = botOrderService.getOrderWithItems(id);
  assert.equal(p2.separado_por, adminId, 'não deveria trocar quem já começou a separar');
  assert.equal(p2.separado_em, p1.separado_em, 'não deveria recarimbar o horário');

  botOrderService.updateOrderStatus({ orderId: id, status: 'concluido' });
  const { pedido: p3 } = botOrderService.getOrderWithItems(id);
  assert.equal(p3.status, 'concluido');
  assert.ok(p3.concluido_em);
});

test('updateItemStatus marca separado/indisponível, e listInStockByCategory só traz quem tem estoque', () => {
  const { db, locationId } = freshTestDb();
  const dipirona = createProduct(db, { nome: 'Dipirona' });
  const paracetamol = createProduct(db, { nome: 'Paracetamol' });
  db.prepare('UPDATE products SET categoria = ? WHERE id IN (?, ?)').run('Analgésicos', dipirona, paracetamol);
  addStock(db, { productId: dipirona, locationId, quantidade: 5, operadorId: null });
  // paracetamol fica sem estoque de propósito

  const semEstoque = botOrderService.listInStockByCategory({ locationId, categoria: 'Analgésicos' });
  assert.equal(semEstoque.length, 1);
  assert.equal(semEstoque[0].nome, 'Dipirona');

  const { id } = botOrderService.createOrder({
    locationId, clienteNome: 'Ana', clienteTelefone: '11999999999',
    itens: [{ productId: dipirona, quantidade: 1 }],
  });
  const { itens } = botOrderService.getOrderWithItems(id);

  assert.equal(botOrderService.updateItemStatus({ itemId: 'nao-existe', status: 'separado' }).ok, false);
  assert.equal(botOrderService.updateItemStatus({ itemId: itens[0].id, status: 'status-invalido' }).ok, false);

  const resultado = botOrderService.updateItemStatus({ itemId: itens[0].id, status: 'indisponivel', observacao: 'acabou na prateleira' });
  assert.equal(resultado.ok, true);

  const { itens: itensAtualizados } = botOrderService.getOrderWithItems(id);
  assert.equal(itensAtualizados[0].status_separacao, 'indisponivel');
  assert.equal(itensAtualizados[0].observacao, 'acabou na prateleira');
});

test('listActiveOrders só traz pedidos ainda na fila (não concluído nem cancelado)', () => {
  const { locationId } = freshTestDb();

  const criar = (clienteNome) => botOrderService.createOrder({
    locationId, clienteNome, clienteTelefone: '11999999999',
    itens: [{ descricaoLivre: 'Item qualquer' }],
  }).id;

  const novoId = criar('Novo');
  const emSeparacaoId = criar('Em Separação');
  const prontoId = criar('Pronto');
  const concluidoId = criar('Concluído');
  const canceladoId = criar('Cancelado');

  botOrderService.updateOrderStatus({ orderId: emSeparacaoId, status: 'em_separacao' });
  botOrderService.updateOrderStatus({ orderId: prontoId, status: 'em_separacao' });
  botOrderService.updateOrderStatus({ orderId: prontoId, status: 'pronto' });
  botOrderService.updateOrderStatus({ orderId: concluidoId, status: 'em_separacao' });
  botOrderService.updateOrderStatus({ orderId: concluidoId, status: 'pronto' });
  botOrderService.updateOrderStatus({ orderId: concluidoId, status: 'concluido' });
  botOrderService.updateOrderStatus({ orderId: canceladoId, status: 'cancelado' });

  const ativos = botOrderService.listActiveOrders({ locationId });
  // Ordem exata não importa aqui (empate de timestamp é possível já
  // que os pedidos são criados no mesmo segundo) -- só que sejam
  // exatamente esses três, nem mais nem menos.
  assert.deepEqual(ativos.map((p) => p.cliente_nome).sort(), ['Em Separação', 'Novo', 'Pronto']);
  assert.deepEqual(ativos.map((p) => p.id).sort(), [novoId, emSeparacaoId, prontoId].sort());
});
