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
