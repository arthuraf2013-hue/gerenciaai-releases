// Em memória, por processo — reinicia a cada abertura do app. Evita
// notificar o mesmo produto repetidamente a cada venda enquanto ele
// continuar abaixo do mínimo; só avisa de novo se ele voltar a subir
// (reabastecimento) e cair outra vez.
const jaNotificados = new Set();

function notifyLowStock(product, estoqueAtual) {
  // 'electron' carregado sob demanda -- ver comentário em attachmentService.js.
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  if (estoqueAtual > product.estoque_minimo) {
    jaNotificados.delete(product.id);
    return;
  }

  if (jaNotificados.has(product.id)) return;
  jaNotificados.add(product.id);

  const notif = new Notification({
    title: 'Estoque baixo — GerenciaAI',
    body: `${product.nome}: restam ${estoqueAtual} ${product.unidade || 'un'} (mínimo: ${product.estoque_minimo}).`,
    silent: false,
  });
  notif.show();
}

/** Dispara quando o cliente responde confirmando uma reserva pelo
 * WhatsApp — avisa quem está no balcão sem precisar ficar checando a
 * tela de Reservas o tempo todo. Só dispara uma vez por confirmação
 * (é a própria reservationService que já garante isso, mudando o
 * status pra 'confirmada' só na primeira resposta válida). */
function notifyReservationConfirmed(reserva) {
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  const notif = new Notification({
    title: 'Reserva confirmada — GerenciaAI',
    body: `${reserva.cliente_nome} confirmou a reserva de ${reserva.pessoas} pessoa(s) ${reserva.quando || ''}.`,
    silent: false,
  });
  notif.show();
}

/** Dispara quando um cliente pede uma alteração num pedido já feito,
 * pelo chat do WhatsApp (ver botOrderService.registrarSolicitacaoAlteracao)
 * -- o bot não aplica a mudança sozinho, só anota nas observações do
 * pedido; esse alerta é pra quem está no balcão perceber rápido que tem
 * uma solicitação nova esperando, sem depender de abrir a tela de
 * Separação por acaso pra notar. */
function notifyOrderChangeRequested(pedido) {
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  const notif = new Notification({
    title: 'Cliente pediu alteração — GerenciaAI',
    body: `${pedido.cliente_nome} pediu uma alteração no pedido pelo WhatsApp. Veja em Separação.`,
    silent: false,
  });
  notif.show();
}

/** Dispara quando o cliente responde a pesquisa de satisfação pós-pedido
 * com nota 1 ou 2 (ver botOrderService.registrarNotaSatisfacao) -- uma
 * avaliação ruim vale a pena alguém ver na hora, não só quando for
 * olhar relatório depois. */
function notifyLowSatisfactionRating(pedido) {
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  const comentario = pedido.comentario_satisfacao ? ` "${pedido.comentario_satisfacao}"` : '';
  const notif = new Notification({
    title: 'Avaliação baixa recebida — GerenciaAI',
    body: `${pedido.cliente_nome} deu nota ${pedido.nota_satisfacao}/5 pro pedido.${comentario}`,
    silent: false,
  });
  notif.show();
}

/** Dispara quando um orçamento é pedido pelo chatbot (ver
 * quoteService.createQuote/whatsappBotHandler.finalizarOrcamento) --
 * avisa o balcão que tem um orçamento novo esperando confirmação de
 * preço/prazo com o cliente. */
function notifyNewQuoteFromBot(quote) {
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  const nome = quote.clienteNome || quote.cliente_nome_avulso || 'Cliente do WhatsApp';
  const notif = new Notification({
    title: 'Orçamento pedido pelo WhatsApp — GerenciaAI',
    body: `${nome} pediu um orçamento pelo chatbot. Veja em Orçamentos.`,
    silent: false,
  });
  notif.show();
}

/** Dispara quando um agendamento é marcado pelo chatbot (ver
 * appointmentService.createAppointment/whatsappBotHandler.
 * finalizarAgendamento) -- mesmo princípio de notifyNewQuoteFromBot. */
function notifyNewAppointmentFromBot(agendamento) {
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  const notif = new Notification({
    title: 'Agendamento pelo WhatsApp — GerenciaAI',
    body: `${agendamento.clienteNomeAvulso} marcou ${agendamento.servico} com ${agendamento.profissionalNome}. Veja na Agenda.`,
    silent: false,
  });
  notif.show();
}

/** Dispara quando o cliente CONFIRMA um agendamento pelo lembrete de
 * "1h antes" -- mesmo princípio de notifyReservationConfirmed. */
function notifyAppointmentConfirmed(agendamento) {
  const { Notification } = require('electron');
  if (!Notification || !Notification.isSupported()) return;

  const notif = new Notification({
    title: 'Agendamento confirmado — GerenciaAI',
    body: `${agendamento.clienteNome || agendamento.cliente_nome_avulso} confirmou ${agendamento.servico}${agendamento.quando ? ' ' + agendamento.quando : ''}.`,
    silent: false,
  });
  notif.show();
}

module.exports = {
  notifyLowStock, notifyReservationConfirmed, notifyOrderChangeRequested,
  notifyLowSatisfactionRating, notifyNewQuoteFromBot, notifyNewAppointmentFromBot, notifyAppointmentConfirmed,
};
