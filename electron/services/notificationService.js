const { Notification } = require('electron');

// Em memória, por processo — reinicia a cada abertura do app. Evita
// notificar o mesmo produto repetidamente a cada venda enquanto ele
// continuar abaixo do mínimo; só avisa de novo se ele voltar a subir
// (reabastecimento) e cair outra vez.
const jaNotificados = new Set();

function notifyLowStock(product, estoqueAtual) {
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

module.exports = { notifyLowStock };
