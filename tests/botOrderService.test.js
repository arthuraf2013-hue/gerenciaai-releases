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

test('concluir um pedido de retirada gera uma venda de verdade (Histórico + estoque)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Dipirona 500mg', preco: 12.5, categoria: 'Analgésicos' });
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const criado = botOrderService.createOrder({
    locationId, clienteNome: 'Maria', clienteTelefone: '5511999998888',
    tipoEntrega: 'retirada', origem: 'whatsapp_bot', operadorId: adminId,
    itens: [{ productId: produtoId, quantidade: 2, precoUnitario: 12.5 }],
  });
  assert.equal(criado.ok, true);

  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'em_separacao', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'pronto', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'concluido', operadorId: adminId });

  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(criado.id);
  assert.ok(pedido.sale_id, 'pedido concluído deveria ter gerado uma venda (sale_id preenchido)');
  assert.equal(pedido.delivery_id, null, 'retirada não deveria criar uma entrega');

  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(pedido.sale_id);
  assert.equal(venda.status, 'finalizada');
  assert.equal(venda.total, 25); // 12.5 x 2

  const pagamento = db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(pedido.sale_id);
  assert.equal(pagamento.valor, 25);

  const movimento = db.prepare("SELECT * FROM stock_movements WHERE sale_id = ?").get(pedido.sale_id);
  assert.equal(movimento.quantidade, -2); // debitou o estoque

  // Idempotência: concluir de novo (ex: chamada duplicada) não cria uma segunda venda.
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'concluido', operadorId: adminId });
  const totalVendas = db.prepare('SELECT COUNT(*) as n FROM sales').get().n;
  assert.equal(totalVendas, 1);
});

test('concluir um pedido de entrega também cria a entrega correspondente', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Xarope', preco: 20, categoria: 'Gripe' });
  addStock(db, { productId: produtoId, locationId, quantidade: 5, operadorId: adminId });

  const criado = botOrderService.createOrder({
    locationId, clienteNome: 'João', clienteTelefone: '5511988887777',
    tipoEntrega: 'entrega', endereco: 'Rua das Flores, 123', origem: 'manual', operadorId: adminId,
    itens: [{ productId: produtoId, quantidade: 1, precoUnitario: 20 }],
  });

  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'em_separacao', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'pronto', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'concluido', operadorId: adminId });

  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(criado.id);
  assert.ok(pedido.sale_id);
  assert.ok(pedido.delivery_id, 'entrega deveria criar um registro em deliveries');

  const entrega = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(pedido.delivery_id);
  assert.equal(entrega.sale_id, pedido.sale_id);
  assert.equal(entrega.endereco, 'Rua das Flores, 123');
});

test('taxa de entrega: modo fixa aplica sempre o valor configurado; modo personalizada fica em branco até o atendente definir', () => {
  const { locationId } = freshTestDb();

  botOrderService.updateConfig({ taxaEntregaModo: 'fixa', taxaEntregaFixa: 6 });
  const fixa = botOrderService.createOrder({
    locationId, clienteNome: 'Ana', clienteTelefone: '5511900000001', tipoEntrega: 'entrega', endereco: 'Rua A',
    itens: [{ descricaoLivre: 'Item' }],
  });
  assert.equal(fixa.taxaEntrega, 6);

  botOrderService.updateConfig({ taxaEntregaModo: 'personalizada' });
  const personalizada = botOrderService.createOrder({
    locationId, clienteNome: 'Bia', clienteTelefone: '5511900000002', tipoEntrega: 'entrega', endereco: 'Rua B',
    itens: [{ descricaoLivre: 'Item' }],
  });
  assert.equal(personalizada.taxaEntrega, null);

  const resultado = botOrderService.setTaxaEntrega({ orderId: personalizada.id, taxaEntrega: 9.9 });
  assert.equal(resultado.ok, true);
  const { pedido } = botOrderService.getOrderWithItems(personalizada.id);
  assert.equal(pedido.taxa_entrega, 9.9);

  assert.equal(botOrderService.setTaxaEntrega({ orderId: fixa.id, taxaEntrega: -1 }).ok, false, 'valor negativo deveria ser recusado');
  assert.equal(botOrderService.setTaxaEntrega({ orderId: 'nao-existe', taxaEntrega: 5 }).ok, false);
});

test('taxa de entrega definida depois da conclusão também é copiada pra deliveries', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Produto Entrega', preco: 10, categoria: 'Geral' });
  addStock(db, { productId: produtoId, locationId, quantidade: 5, operadorId: adminId });
  botOrderService.updateConfig({ taxaEntregaModo: 'personalizada' });

  const criado = botOrderService.createOrder({
    locationId, clienteNome: 'Carla', clienteTelefone: '5511900000003', tipoEntrega: 'entrega', endereco: 'Rua C',
    operadorId: adminId, itens: [{ productId: produtoId, quantidade: 1, precoUnitario: 10 }],
  });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'em_separacao', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'pronto', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'concluido', operadorId: adminId });

  botOrderService.setTaxaEntrega({ orderId: criado.id, taxaEntrega: 8 });

  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(criado.id);
  const entrega = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(pedido.delivery_id);
  assert.equal(entrega.taxa_entrega, 8);
});

test('buscarPedidoEmAndamento e podeReceberModificacao seguem o pedido de entrega até ele sair pra entrega', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Produto Cutoff', preco: 10, categoria: 'Geral' });
  addStock(db, { productId: produtoId, locationId, quantidade: 5, operadorId: adminId });
  const telefone = '5511900000004';
  const deliveryService = require('../electron/services/deliveryService');

  const criado = botOrderService.createOrder({
    locationId, clienteNome: 'Duda', clienteTelefone: telefone, tipoEntrega: 'entrega', endereco: 'Rua D',
    operadorId: adminId, itens: [{ productId: produtoId, quantidade: 1, precoUnitario: 10 }],
  });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'em_separacao', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'pronto', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: criado.id, status: 'concluido', operadorId: adminId });

  let pedido = botOrderService.buscarPedidoEmAndamento({ telefone, locationId });
  assert.ok(pedido, 'ainda deveria estar "em andamento" logo após concluído (entrega pendente)');
  assert.equal(botOrderService.podeReceberModificacao(pedido), true, 'entrega ainda não saiu -- pode alterar');

  const deliveryId = pedido.delivery_id;
  deliveryService.updateDeliveryStatus({ deliveryId, status: 'em_rota' });
  pedido = botOrderService.buscarPedidoEmAndamento({ telefone, locationId });
  assert.ok(pedido, 'ainda consultável depois de sair pra entrega');
  assert.equal(botOrderService.podeReceberModificacao(pedido), false, 'já saiu pra entrega -- não pode mais alterar');

  deliveryService.updateDeliveryStatus({ deliveryId, status: 'entregue' });
  pedido = botOrderService.buscarPedidoEmAndamento({ telefone, locationId });
  assert.equal(pedido, undefined, 'depois de entregue não deveria mais contar como "em andamento"');
});

test('createOrder congela o preço atual do produto quando não vem precoUnitario explícito', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Produto Z', preco: 9.9, categoria: 'Geral' });
  addStock(db, { productId: produtoId, locationId, quantidade: 5, operadorId: adminId });

  const criado = botOrderService.createOrder({
    locationId, clienteNome: 'Ana', clienteTelefone: '5511977776666',
    tipoEntrega: 'retirada', origem: 'manual', operadorId: adminId,
    itens: [{ productId: produtoId, quantidade: 1 }], // sem precoUnitario
  });

  const item = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ?').get(criado.id);
  assert.equal(item.preco_unitario, 9.9);
});
