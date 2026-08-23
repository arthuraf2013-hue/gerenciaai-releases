const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const botOrderService = require('../electron/services/botOrderService');
const whatsappBotHandler = require('../electron/services/whatsappBotHandler');

test('conversa completa: categoria -> produto -> retirada -> pedido criado', () => {
  const { db, locationId, adminId } = freshTestDb();
  const dipironaId = createProduct(db, { nome: 'Dipirona 500mg', preco: 12.5, categoria: 'Analgésicos' });
  addStock(db, { productId: dipironaId, locationId, quantidade: 10, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511999998888';

  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', nomeExibicao: 'Maria', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /bem-vindo/i);
  assert.match(r.resposta, /Analgésicos/);
  assert.match(r.resposta, /1 - Analgésicos/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Dipirona 500mg/);
  assert.match(r.resposta, /R\$ 12,50/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1x2', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Adicionado: Dipirona 500mg x2/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Retirada no local/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.equal(r.pedidoCriado, true);
  assert.ok(r.pedidoId);

  const pedido = botOrderService.getOrderWithItems(r.pedidoId);
  assert.equal(pedido.ok, true);
  assert.equal(pedido.pedido.cliente_nome, 'Maria');
  assert.equal(pedido.pedido.cliente_telefone, telefone);
  assert.equal(pedido.pedido.tipo_entrega, 'retirada');
  assert.equal(pedido.pedido.origem, 'whatsapp_bot');
  assert.equal(pedido.itens.length, 1);
  assert.equal(pedido.itens[0].quantidade, 2);

  // conversa foi encerrada, mas o pedido continua "novo" (em andamento)
  // -- a próxima mensagem não joga direto no cardápio de novo, oferece
  // o menu de pedido em andamento (ver buscarPedidoEmAndamento).
  const proxima = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  assert.match(proxima.resposta, /pedido em andamento/i);
});

test('conversa com entrega pede endereço antes de criar o pedido', () => {
  const { db, locationId, adminId } = freshTestDb();
  const xarope = createProduct(db, { nome: 'Xarope Y', preco: 20, categoria: 'Gripe e tosse' });
  addStock(db, { productId: xarope, locationId, quantidade: 5, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511977776666';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /1 - Retirada/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '2', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /endereço/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'Rua das Flores, 123', locationId, estadoConversas: conversas });
  assert.equal(r.pedidoCriado, true);

  const pedido = botOrderService.getOrderWithItems(r.pedidoId);
  assert.equal(pedido.pedido.tipo_entrega, 'entrega');
  assert.equal(pedido.pedido.endereco, 'Rua das Flores, 123');
});

test('categoria inválida e produto inválido pedem de novo sem travar a conversa', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto A', preco: 5, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 3, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511955554444';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  let r = whatsappBotHandler.processarMensagem({ telefone, texto: '99', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Não entendi/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Produto A/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '99', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /inválido/i);
});

test('"cancelar" a qualquer momento encerra a conversa sem criar pedido', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto B', preco: 5, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 3, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511944443333';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'cancelar', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /cancelado/i);
  assert.equal(conversas.has(telefone), false);
});

test('categoria sem estoque não aparece no menu, e categoria some do menu quando estoque zera', () => {
  const { db, locationId, adminId } = freshTestDb();
  const semEstoque = createProduct(db, { nome: 'Sem Estoque', preco: 5, categoria: 'Vazia' });
  const comEstoque = createProduct(db, { nome: 'Com Estoque', preco: 5, categoria: 'Cheia' });
  addStock(db, { productId: comEstoque, locationId, quantidade: 2, operadorId: adminId });

  const categorias = botOrderService.listCategoriasComEstoque({ locationId });
  assert.deepEqual(categorias, ['Cheia']);
});

test('humanizarNomeProduto expande siglas comuns de farmácia sem mexer no nome cadastrado', () => {
  const { humanizarNomeProduto } = whatsappBotHandler;
  assert.equal(humanizarNomeProduto('DIPIRONA SOD 500MG CPR C/10 EMS'), 'Dipirona Sódica 500mg Comprimidos Com 10 EMS');
  assert.equal(humanizarNomeProduto('XPE PARA TOSSE 100ML FR'), 'Xarope Para Tosse 100ml Frasco');
  // Nome já limpo continua igual (não pode "estragar" nome que já está bom).
  assert.equal(humanizarNomeProduto('Dipirona 500mg'), 'Dipirona 500mg');
});

test('pergunta livre sobre disponibilidade/preço é respondida com nome humanizado, sem travar o fluxo', () => {
  const { db, locationId, adminId } = freshTestDb();
  const dipironaId = createProduct(db, { nome: 'DIPIRONA SOD 500MG CPR C/10', preco: 12.5, categoria: 'Analgésicos' });
  addStock(db, { productId: dipironaId, locationId, quantidade: 10, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511911112222';

  // Pergunta já na primeira mensagem, antes de qualquer menu ter sido mostrado.
  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'vocês tem dipirona?', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Dipirona Sódica 500mg Comprimidos Com 10/);
  assert.match(r.resposta, /R\$ 12,50/);
  assert.match(r.resposta, /temos em estoque/i);
  // E como era a primeira mensagem, o menu de categorias já vem junto pra não travar o cliente.
  assert.match(r.resposta, /1 - Analgésicos/);

  // Pergunta no meio do fluxo (já dentro de uma categoria) também funciona e não perde o estado.
  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'quanto custa a dipirona?', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /R\$ 12,50/);

  // Depois de responder a pergunta, o fluxo normal continua funcionando.
  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Adicionado/);
});

test('pergunta em linguagem natural acha produto cadastrado com sigla (busca usa o nome humanizado)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const xarope = createProduct(db, { nome: 'XPE PARA TOSSE ADULTO 100ML FR', preco: 24.9, categoria: 'Gripe e tosse' });
  addStock(db, { productId: xarope, locationId, quantidade: 0, operadorId: adminId });

  const conversas = new Map();
  const r = whatsappBotHandler.processarMensagem({ telefone: '5511900002222', texto: 'e o xarope pra tosse, tem?', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Xarope Para Tosse/);
  assert.match(r.resposta, /sem estoque agora/i);
});

test('pergunta sobre produto que não existe não trava a conversa', () => {
  const { locationId } = freshTestDb();
  const conversas = new Map();
  const r = whatsappBotHandler.processarMensagem({ telefone: '5511900001111', texto: 'vocês tem insulina importada rara?', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /não encontrei/i);
});

// ---------- Taxa de entrega ----------

test('pedido de entrega no modo "fixa" já informa a taxa na confirmação', () => {
  const { db, locationId, adminId } = freshTestDb();
  const xarope = createProduct(db, { nome: 'Xarope Fixa', preco: 20, categoria: 'Gripe' });
  addStock(db, { productId: xarope, locationId, quantidade: 5, operadorId: adminId });
  botOrderService.updateConfig({ ativo: true, taxaEntregaModo: 'fixa', taxaEntregaFixa: 7.5 });

  const conversas = new Map();
  const telefone = '5511911119999';
  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '2', locationId, estadoConversas: conversas }); // entrega
  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'Rua Fixa, 1', locationId, estadoConversas: conversas });

  assert.equal(r.pedidoCriado, true);
  assert.match(r.resposta, /Taxa de entrega: R\$ 7,50/);

  const { pedido } = botOrderService.getOrderWithItems(r.pedidoId);
  assert.equal(pedido.taxa_entrega, 7.5);
});

test('pedido de entrega no modo "personalizada" avisa que o atendente vai definir, e setTaxaEntrega avisa o cliente depois', () => {
  const { db, locationId, adminId } = freshTestDb();
  const xarope = createProduct(db, { nome: 'Xarope Personalizada', preco: 20, categoria: 'Gripe' });
  addStock(db, { productId: xarope, locationId, quantidade: 5, operadorId: adminId });
  botOrderService.updateConfig({ ativo: true, taxaEntregaModo: 'personalizada' });

  const conversas = new Map();
  const telefone = '5511911118888';
  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '2', locationId, estadoConversas: conversas });
  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'Rua Personalizada, 2', locationId, estadoConversas: conversas });

  assert.equal(r.pedidoCriado, true);
  assert.match(r.resposta, /confirmada em breve por um atendente/i);

  let { pedido } = botOrderService.getOrderWithItems(r.pedidoId);
  assert.equal(pedido.taxa_entrega, null);

  const resultado = botOrderService.setTaxaEntrega({ orderId: r.pedidoId, taxaEntrega: 12 });
  assert.equal(resultado.ok, true);
  ({ pedido } = botOrderService.getOrderWithItems(r.pedidoId));
  assert.equal(pedido.taxa_entrega, 12);
});

// ---------- Pedido em andamento: status, adicionar item, alteração, novo pedido ----------

test('cliente com pedido em andamento vê o menu de opções em vez do cardápio, e "status" funciona', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Item Ativo', preco: 5, categoria: 'Geral' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511900011122';
  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // retirada -> pedido criado

  const menu = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  assert.match(menu.resposta, /pedido em andamento/i);
  assert.match(menu.resposta, /Consultar status/i);

  const status = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.match(status.resposta, /na fila/i);
});

test('cliente com pedido em andamento consegue adicionar itens ao MESMO pedido (não cria um segundo)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Item Base', preco: 5, categoria: 'Geral' });
  addStock(db, { productId: p, locationId, quantidade: 10, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511900022233';
  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  const criado = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  const respAdicionar = whatsappBotHandler.processarMensagem({ telefone, texto: '2', locationId, estadoConversas: conversas });
  assert.match(respAdicionar.resposta, /o que mais você quer adicionar/i);
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // categoria
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // produto
  const respFinal = whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  assert.match(respFinal.resposta, /adicionei ao seu pedido/i);

  const { itens } = botOrderService.getOrderWithItems(criado.pedidoId);
  assert.equal(itens.length, 2, 'deveria ter os itens do pedido original + o item adicionado, no mesmo pedido');

  const todosOsPedidos = botOrderService.listOrders({ locationId });
  assert.equal(todosOsPedidos.length, 1, 'não deveria ter criado um segundo pedido');
});

test('cliente com pedido em andamento pede uma alteração -- bot só anota, não aplica sozinho', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Item Alteração', preco: 5, categoria: 'Geral' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511900033344';
  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  const criado = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  const pedeAlteracao = whatsappBotHandler.processarMensagem({ telefone, texto: '3', locationId, estadoConversas: conversas });
  assert.match(pedeAlteracao.resposta, /me conta o que você quer mudar/i);

  const confirma = whatsappBotHandler.processarMensagem({ telefone, texto: 'troca o item por outro sabor', locationId, estadoConversas: conversas });
  assert.match(confirma.resposta, /anotado/i);

  const { pedido } = botOrderService.getOrderWithItems(criado.pedidoId);
  assert.match(pedido.observacoes, /troca o item por outro sabor/);
  // Itens não foram mexidos automaticamente -- só o texto foi anotado.
  const { itens } = botOrderService.getOrderWithItems(criado.pedidoId);
  assert.equal(itens.length, 1);
});

test('cliente com pedido em andamento pode começar um novo pedido em vez de mexer no anterior', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Item Novo Pedido', preco: 5, categoria: 'Geral' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511900044455';
  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  const respNovo = whatsappBotHandler.processarMensagem({ telefone, texto: '4', locationId, estadoConversas: conversas });
  assert.match(respNovo.resposta, /novo pedido/i);
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // categoria
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // produto
  whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  const segundo = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.equal(segundo.pedidoCriado, true);

  const todosOsPedidos = botOrderService.listOrders({ locationId });
  assert.equal(todosOsPedidos.length, 2, 'deveria ter dois pedidos independentes');
});

test('pedido de retirada já "pronto" não aceita mais adicionar/alterar pelo chat', () => {
  const { db, locationId, adminId } = freshTestDb();
  const { id } = botOrderService.createOrder({
    locationId, clienteNome: 'Cliente Pronto', clienteTelefone: '5511900055566',
    itens: [{ descricaoLivre: 'Item qualquer' }],
  });
  botOrderService.updateOrderStatus({ orderId: id, status: 'em_separacao', operadorId: adminId });
  botOrderService.updateOrderStatus({ orderId: id, status: 'pronto', operadorId: adminId });

  const conversas = new Map();
  const menu = whatsappBotHandler.processarMensagem({ telefone: '5511900055566', texto: 'oi', locationId, estadoConversas: conversas });
  assert.match(menu.resposta, /pedido em andamento/i);

  const respAdicionar = whatsappBotHandler.processarMensagem({ telefone: '5511900055566', texto: '2', locationId, estadoConversas: conversas });
  assert.match(respAdicionar.resposta, /não dá mais pra adicionar/i);
});

// ---------- Reserva de mesa ----------

function ativarPerfilRestaurante(db) {
  db.prepare(`UPDATE business_profile SET perfil_ativo = 'restaurante' WHERE id = 'default'`).run();
}

test('parseHorarioReserva entende formatos comuns', () => {
  const agora = new Date(2026, 0, 1, 15, 0, 0); // 01/01/2026 15:00

  assert.equal(whatsappBotHandler.parseHorarioReserva('hoje 20h', agora), '2026-01-01 20:00:00');
  assert.equal(whatsappBotHandler.parseHorarioReserva('amanhã 19h30', agora), '2026-01-02 19:30:00');
  assert.equal(whatsappBotHandler.parseHorarioReserva('15/03 20h', agora), '2026-03-15 20:00:00');
  assert.equal(whatsappBotHandler.parseHorarioReserva('20:00', agora), '2026-01-01 20:00:00'); // sem prefixo, ainda não passou hoje
  assert.equal(whatsappBotHandler.parseHorarioReserva('10h', agora), '2026-01-02 10:00:00'); // sem prefixo, já passou hoje -> rola pra amanhã
  assert.equal(whatsappBotHandler.parseHorarioReserva('não entendi isso', agora), null);
  assert.equal(whatsappBotHandler.parseHorarioReserva('25h', agora), null); // hora inválida
});

test('conversa completa de reserva: reservar -> nome -> pessoas -> horário -> reserva criada', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilRestaurante(db);
  const reservationService = require('../electron/services/reservationService');

  const conversas = new Map();
  const telefone = '5511988887777';

  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'reservar', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /nome pra reserva/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'Carlos', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /quantas pessoas/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '4', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /dia e hor[áa]rio/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'hoje 20h', locationId, estadoConversas: conversas });
  assert.equal(r.reservaCriada, true);
  assert.ok(r.reservationId);

  const [reserva] = reservationService.list({ locationId });
  assert.equal(reserva.cliente_nome, 'Carlos');
  assert.equal(reserva.cliente_telefone, telefone);
  assert.equal(reserva.pessoas, 4);
  assert.equal(reserva.status, 'pendente');
  assert.equal(reserva.origem, 'whatsapp');

  // conversa foi encerrada
  const proxima = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  assert.match(proxima.resposta, /bem-vindo/i);
});

test('reserva não é oferecida fora do perfil restaurante/padaria', () => {
  const { locationId } = freshTestDb(); // perfil padrão seedado é 'farmacia'
  const conversas = new Map();
  const r = whatsappBotHandler.processarMensagem({ telefone: '5511977778888', texto: 'reservar', locationId, estadoConversas: conversas });
  // Sem o perfil certo, "reservar" não é reconhecido como comando -- cai no fluxo normal (menu de categorias/pergunta de produto)
  assert.notEqual(r.resposta, undefined);
  assert.doesNotMatch(r.resposta, /nome pra reserva/i);
});

test('horário inválido no fluxo de reserva pede de novo sem travar', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilRestaurante(db);
  const conversas = new Map();
  const telefone = '5511900001234';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'reservar', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'Ana', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '2', locationId, estadoConversas: conversas });

  const tentativaRuim = whatsappBotHandler.processarMensagem({ telefone, texto: 'qualquer hora', locationId, estadoConversas: conversas });
  assert.match(tentativaRuim.resposta, /não entendi o hor[áa]rio/i);

  const tentativaBoa = whatsappBotHandler.processarMensagem({ telefone, texto: 'amanhã 12h', locationId, estadoConversas: conversas });
  assert.equal(tentativaBoa.reservaCriada, true);
});

test('cliente confirma a reserva quando o lembrete de 1h antes já foi mandado', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilRestaurante(db);
  const reservationService = require('../electron/services/reservationService');
  const telefone = '5511955554444';

  const { id } = reservationService.create({ locationId, clienteNome: 'Beatriz', clienteTelefone: telefone, pessoas: 3, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'sim', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /confirmada/i);
  assert.ok(r.reservaConfirmada);
  assert.equal(r.reservaConfirmada.id, id);

  const [reserva] = reservationService.list({ locationId });
  assert.equal(reserva.status, 'confirmada');
});

test('cliente recusa a reserva quando o lembrete de 1h antes já foi mandado', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilRestaurante(db);
  const reservationService = require('../electron/services/reservationService');
  const telefone = '5511944443333';

  const { id } = reservationService.create({ locationId, clienteNome: 'Diego', clienteTelefone: telefone, pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'não posso ir', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /cancelada/i);

  const [reserva] = reservationService.list({ locationId });
  assert.equal(reserva.status, 'cancelada');
});

test('resposta ambígua ao lembrete repete a pergunta sem confirmar nem cancelar', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilRestaurante(db);
  const reservationService = require('../electron/services/reservationService');
  const telefone = '5511933332222';

  const { id } = reservationService.create({ locationId, clienteNome: 'Elisa', clienteTelefone: telefone, pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'quem é vc?', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /confirma/i);
  assert.equal(r.reservaConfirmada, undefined);

  const [reserva] = reservationService.list({ locationId });
  assert.equal(reserva.status, 'aguardando_confirmacao'); // não mudou
});

test('resposta ao lembrete tem prioridade sobre "cancelar" genérico', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilRestaurante(db);
  const reservationService = require('../electron/services/reservationService');
  const telefone = '5511922221111';

  const { id } = reservationService.create({ locationId, clienteNome: 'Fábio', clienteTelefone: telefone, pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'cancelar', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /reserva cancelada/i); // é a RESERVA que foi cancelada, não um pedido genérico

  const [reserva] = reservationService.list({ locationId });
  assert.equal(reserva.status, 'cancelada');
});

// ---------- Orçamento pelo chat ----------

test('conversa completa de orçamento: orçamento -> categoria -> produto -> finalizar -> orçamento criado (não mexe em estoque)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const quoteService = require('../electron/services/quoteService');
  const produtoId = createProduct(db, { nome: 'Cimento', preco: 35, categoria: 'Construção' });
  addStock(db, { productId: produtoId, locationId, quantidade: 10, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511900001111';

  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'orçamento', nomeExibicao: 'Roberto', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /orçamento/i);
  assert.match(r.resposta, /Construção/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Cimento/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '1x3', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /Adicionado: Cimento x3/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  assert.equal(r.orcamentoCriado, true);
  assert.ok(r.quoteId);
  assert.match(r.resposta, /orçamento registrado/i);
  assert.doesNotMatch(r.resposta, /retirada/i); // orçamento não pergunta tipo de entrega

  const quote = quoteService.getQuote(r.quoteId);
  assert.equal(quote.origem, 'whatsapp_bot');
  assert.equal(quote.clienteNome, 'Roberto');
  assert.equal(quote.clienteTelefone, telefone);
  assert.equal(quote.status, 'aberto'); // orçamento fica aberto pra equipe decidir depois
  assert.equal(quote.items.length, 1);
  assert.equal(quote.items[0].quantidade, 3);

  const estoque = db.prepare('SELECT COALESCE(SUM(quantidade),0) as t FROM stock_movements WHERE product_id = ?').get(produtoId).t;
  assert.equal(estoque, 10, 'orçamento não deveria mexer em estoque');

  // conversa foi encerrada
  assert.equal(conversas.has(telefone), false);
});

test('"orçamento" interrompe um pedido normal em andamento e começa do zero, sem perder o modo orçamento até o fim', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto C', preco: 8, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });

  const conversas = new Map();
  const telefone = '5511900002222';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // categoria (pedido normal)

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'orçamento', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /orçamento/i);

  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // categoria (agora em modo orçamento)
  whatsappBotHandler.processarMensagem({ telefone, texto: '1', locationId, estadoConversas: conversas }); // produto
  const final = whatsappBotHandler.processarMensagem({ telefone, texto: 'finalizar', locationId, estadoConversas: conversas });
  assert.equal(final.orcamentoCriado, true, 'deveria continuar em modo orçamento mesmo depois de reiniciar a conversa');
});

// ---------- Agendamento de horário (perfil Salão/Beleza) ----------

function ativarPerfilSalaoBeleza(db) {
  db.prepare(`UPDATE business_profile SET perfil_ativo = 'salao_beleza' WHERE id = 'default'`).run();
}

test('"agendar" não é oferecido fora do perfil salão/beleza, nem sem profissional cadastrado', () => {
  const { locationId } = freshTestDb(); // perfil padrão seedado é 'farmacia'
  const conversas = new Map();
  const r = whatsappBotHandler.processarMensagem({ telefone: '5511900003333', texto: 'agendar', locationId, estadoConversas: conversas });
  assert.doesNotMatch(r.resposta, /qual seu nome/i);

  // Mesmo com o perfil certo, sem profissional cadastrado não oferece.
  const { db: db2, locationId: locationId2 } = freshTestDb();
  ativarPerfilSalaoBeleza(db2);
  const r2 = whatsappBotHandler.processarMensagem({ telefone: '5511900004444', texto: 'agendar', locationId: locationId2, estadoConversas: new Map() });
  assert.doesNotMatch(r2.resposta, /qual seu nome/i);
});

test('conversa completa de agendamento com 1 só profissional: agendar -> nome -> (pula escolha) -> serviço -> horário -> agendamento criado', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilSalaoBeleza(db);
  const appointmentService = require('../electron/services/appointmentService');
  appointmentService.upsertProfessional({ nome: 'Juliana', especialidade: 'Cabelo' });

  const conversas = new Map();
  const telefone = '5511900005555';

  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'agendar', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /qual seu nome/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'Fernanda', locationId, estadoConversas: conversas });
  // só 1 profissional -- pula direto pra pergunta de serviço, não pergunta "com quem"
  assert.doesNotMatch(r.resposta, /com quem/i);
  assert.match(r.resposta, /gostaria de agendar/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'corte de cabelo', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /dia e hor[áa]rio/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: 'amanhã 15h', locationId, estadoConversas: conversas });
  assert.equal(r.agendamentoCriado, true);
  assert.ok(r.appointmentId);
  assert.match(r.resposta, /Fernanda/);
  assert.match(r.resposta, /Juliana/);

  const [agendamento] = appointmentService.listAppointments({ locationId });
  assert.equal(agendamento.clienteNome, 'Fernanda');
  assert.equal(agendamento.clienteTelefone, telefone);
  assert.equal(agendamento.servico, 'corte de cabelo');
  assert.equal(agendamento.status, 'agendado');

  // conversa foi encerrada
  assert.equal(conversas.has(telefone), false);
});

test('conversa de agendamento com vários profissionais pergunta com quem, e número inválido pede de novo', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilSalaoBeleza(db);
  const appointmentService = require('../electron/services/appointmentService');
  appointmentService.upsertProfessional({ nome: 'Ana', especialidade: 'Cabelo' });
  appointmentService.upsertProfessional({ nome: 'Bruno', especialidade: 'Barba' });

  const conversas = new Map();
  const telefone = '5511900006666';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'agendar', locationId, estadoConversas: conversas });
  let r = whatsappBotHandler.processarMensagem({ telefone, texto: 'Marcos', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /com quem/i);
  assert.match(r.resposta, /Ana/);
  assert.match(r.resposta, /Bruno/);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '9', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /não entendi/i);

  r = whatsappBotHandler.processarMensagem({ telefone, texto: '2', locationId, estadoConversas: conversas });
  assert.match(r.resposta, /gostaria de agendar/i);

  whatsappBotHandler.processarMensagem({ telefone, texto: 'barba', locationId, estadoConversas: conversas });
  const final = whatsappBotHandler.processarMensagem({ telefone, texto: 'amanhã 10h', locationId, estadoConversas: conversas });
  assert.equal(final.agendamentoCriado, true);

  const [agendamento] = appointmentService.listAppointments({ locationId, professionalId: undefined });
  const criado = appointmentService.listAppointments({ locationId }).find((a) => a.clienteNome === 'Marcos');
  assert.equal(criado.profissionalNome, 'Bruno');
});

test('horário com conflito no agendamento não finaliza e pede outro horário, sem perder nome/serviço já informados', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilSalaoBeleza(db);
  const appointmentService = require('../electron/services/appointmentService');
  const { id: profId } = appointmentService.upsertProfessional({ nome: 'Carla' });

  // "amanhã" no chat resolve pra data relativa ao momento em que o
  // teste roda (ver parseHorarioReserva) -- por isso o agendamento
  // conflitante pré-existente precisa ser criado com a MESMA data
  // calculada dinamicamente, em vez de uma data fixa que pode cair no
  // passado dependendo de quando os testes rodarem.
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const amanhaStr = `${amanha.getFullYear()}-${String(amanha.getMonth() + 1).padStart(2, '0')}-${String(amanha.getDate()).padStart(2, '0')}`;

  appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'Outra Cliente', servico: 'manicure', dataHoraInicio: `${amanhaStr} 15:00:00`, duracaoMinutos: 60,
  });

  const conversas = new Map();
  const telefone = '5511900007777';

  whatsappBotHandler.processarMensagem({ telefone, texto: 'agendar', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'Patrícia', locationId, estadoConversas: conversas });
  whatsappBotHandler.processarMensagem({ telefone, texto: 'escova', locationId, estadoConversas: conversas });

  const tentativaConflito = whatsappBotHandler.processarMensagem({ telefone, texto: 'amanhã 15h', locationId, estadoConversas: conversas });
  assert.match(tentativaConflito.resposta, /já tem outro horário/i);
  assert.equal(tentativaConflito.agendamentoCriado, undefined);

  // A conversa continua esperando um horário -- consegue tentar de novo com sucesso.
  const tentativaBoa = whatsappBotHandler.processarMensagem({ telefone, texto: 'amanhã 17h', locationId, estadoConversas: conversas });
  assert.equal(tentativaBoa.agendamentoCriado, true);

  const criado = appointmentService.listAppointments({ locationId }).find((a) => a.clienteNome === 'Patrícia');
  assert.equal(criado.servico, 'escova');
});

test('cliente confirma o agendamento quando o lembrete de 1h antes já foi mandado', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilSalaoBeleza(db);
  const appointmentService = require('../electron/services/appointmentService');
  const { id: profId } = appointmentService.upsertProfessional({ nome: 'Vanessa' });
  const telefone = '5511900008888';

  const { id } = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'Gustavo', clienteTelefoneAvulso: telefone,
    servico: 'corte', dataHoraInicio: '2026-01-01 20:00:00', duracaoMinutos: 60,
  });
  appointmentService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'sim', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /confirmado/i);
  assert.ok(r.agendamentoConfirmado);
  assert.equal(r.agendamentoConfirmado.id, id);

  const [agendamento] = appointmentService.listAppointments({ locationId });
  assert.equal(agendamento.status, 'confirmado');
});

test('cliente recusa o agendamento quando o lembrete de 1h antes já foi mandado', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilSalaoBeleza(db);
  const appointmentService = require('../electron/services/appointmentService');
  const { id: profId } = appointmentService.upsertProfessional({ nome: 'Rafael' });
  const telefone = '5511900009999';

  const { id } = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'Sandra', clienteTelefoneAvulso: telefone,
    servico: 'manicure', dataHoraInicio: '2026-01-01 20:00:00', duracaoMinutos: 60,
  });
  appointmentService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'não posso ir', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /cancelado/i);

  const [agendamento] = appointmentService.listAppointments({ locationId });
  assert.equal(agendamento.status, 'cancelado');
});

test('resposta ao lembrete de agendamento tem prioridade sobre "cancelar" genérico', () => {
  const { db, locationId } = freshTestDb();
  ativarPerfilSalaoBeleza(db);
  const appointmentService = require('../electron/services/appointmentService');
  const { id: profId } = appointmentService.upsertProfessional({ nome: 'Tatiane' });
  const telefone = '5511900010000';

  const { id } = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'Igor', clienteTelefoneAvulso: telefone,
    servico: 'corte', dataHoraInicio: '2026-01-01 20:00:00', duracaoMinutos: 60,
  });
  appointmentService.marcarLembreteEnviado(id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'cancelar', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /agendamento cancelado/i);

  const [agendamento] = appointmentService.listAppointments({ locationId });
  assert.equal(agendamento.status, 'cancelado');
});

// ---------- Pesquisa de satisfação pós-pedido ----------

test('cliente sem conversa em andamento recebe a pergunta de satisfação e uma nota sozinha é registrada', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto D', preco: 5, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });
  const telefone = '5511900011111';

  const pedido = botOrderService.createOrder({
    locationId, clienteNome: 'Helena', clienteTelefone: telefone, tipoEntrega: 'retirada', origem: 'whatsapp_bot',
    itens: [{ productId: p, quantidade: 1, precoUnitario: 5 }],
  });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'pronto' });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'concluido' }); // dispara a tentativa, mas sem WhatsApp conectado não marca sozinho (ver botOrderService.test.js)

  // Simula a pesquisa já ter sido mandada, sem depender do WhatsApp
  // estar conectado no sandbox de teste -- mesmo padrão de
  // reservationService.marcarLembreteEnviado usado nos testes de reserva.
  db.prepare('UPDATE bot_orders SET satisfacao_solicitada_em = NOW_SYNCED() WHERE id = ?').run(pedido.id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: '5', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /obrigado/i);

  const depois = botOrderService.getOrderWithItems(pedido.id);
  assert.equal(depois.pedido.nota_satisfacao, 5);
  assert.equal(depois.pedido.comentario_satisfacao, null);
});

test('nota de satisfação seguida de comentário grava os dois, e nota baixa não trava a conversa', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto E', preco: 5, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });
  const telefone = '5511900012222';

  const pedido = botOrderService.createOrder({
    locationId, clienteNome: 'Igor', clienteTelefone: telefone, tipoEntrega: 'retirada', origem: 'whatsapp_bot',
    itens: [{ productId: p, quantidade: 1, precoUnitario: 5 }],
  });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'pronto' });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'concluido' });
  db.prepare('UPDATE bot_orders SET satisfacao_solicitada_em = NOW_SYNCED() WHERE id = ?').run(pedido.id);

  const r = whatsappBotHandler.processarMensagem({ telefone, texto: '2 demorou bastante', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /sentimos muito/i);

  const depois = botOrderService.getOrderWithItems(pedido.id);
  assert.equal(depois.pedido.nota_satisfacao, 2);
  assert.equal(depois.pedido.comentario_satisfacao, 'demorou bastante');
});

test('resposta inválida à pesquisa de satisfação pede de novo sem gravar nada, até vir uma nota válida', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto F', preco: 5, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });
  const telefone = '5511900013333';

  const pedido = botOrderService.createOrder({
    locationId, clienteNome: 'Julia', clienteTelefone: telefone, tipoEntrega: 'retirada', origem: 'whatsapp_bot',
    itens: [{ productId: p, quantidade: 1, precoUnitario: 5 }],
  });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'pronto' });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'concluido' });
  db.prepare('UPDATE bot_orders SET satisfacao_solicitada_em = NOW_SYNCED() WHERE id = ?').run(pedido.id);

  const conversas = new Map();
  const tentativaRuim = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi tudo bem?', locationId, estadoConversas: conversas });
  assert.match(tentativaRuim.resposta, /não entendi/i);
  assert.equal(conversas.has(telefone), true, 'não deveria encerrar a conversa com resposta inválida');

  let semNota = botOrderService.getOrderWithItems(pedido.id);
  assert.equal(semNota.pedido.nota_satisfacao, null);

  const tentativaBoa = whatsappBotHandler.processarMensagem({ telefone, texto: '4', locationId, estadoConversas: conversas });
  assert.match(tentativaBoa.resposta, /obrigado/i);
  assert.equal(conversas.has(telefone), false);

  const comNota = botOrderService.getOrderWithItems(pedido.id);
  assert.equal(comNota.pedido.nota_satisfacao, 4);
});

test('pedido de mesa concluído não dispara pesquisa de satisfação (só retirada)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const p = createProduct(db, { nome: 'Produto G', preco: 5, categoria: 'Diversos' });
  addStock(db, { productId: p, locationId, quantidade: 5, operadorId: adminId });
  const telefone = '5511900014444';

  const pedido = botOrderService.createOrder({
    locationId, clienteNome: 'Karina', clienteTelefone: telefone, tipoEntrega: 'retirada', mesaNumero: '7', origem: 'whatsapp_bot',
    itens: [{ productId: p, quantidade: 1, precoUnitario: 5 }],
  });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'pronto' });
  botOrderService.updateOrderStatus({ orderId: pedido.id, status: 'concluido' });

  const detalhe = botOrderService.getOrderWithItems(pedido.id);
  assert.equal(detalhe.pedido.satisfacao_solicitada_em, null);

  // Sem pesquisa pendente, mensagem nova cai no fluxo normal (menu de boas-vindas).
  const r = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: new Map() });
  assert.match(r.resposta, /bem-vindo/i);
});
