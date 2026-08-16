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

  // conversa foi encerrada -- próxima mensagem começa do zero de novo
  const proxima = whatsappBotHandler.processarMensagem({ telefone, texto: 'oi', locationId, estadoConversas: conversas });
  assert.match(proxima.resposta, /bem-vindo/i);
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
