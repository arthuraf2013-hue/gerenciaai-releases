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

module.exports = { notifyLowStock, notifyReservationConfirmed };
