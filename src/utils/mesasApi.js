// Onde a tela de mesas faz cada coisa: neste computador (window.pdv) ou,
// com a mesa compartilhada ligada, no servidor do grupo pela rede local
// (window.pdv.mesaCompartilhada.chamar -- ver mesaCompartilhadaService.js).
// Mesmos nomes e mesmas respostas nos dois casos: a tela não muda.

const CANAIS_REMOTOS = {
  table: [
    'list', 'open', 'getCart', 'markCleaned', 'markReserved', 'cancelReservation', 'transfer', 'updatePeople', 'desocupar',
    'montarLinkPedido', 'juntar', 'separar', 'adicionarPessoa', 'renomearPessoa', 'removerPessoa', 'vincularCliente',
    'create', 'createLote', 'proximoNumero', 'delete', 'reordenar',
  ],
  sale: ['addItem', 'ajustarQuantidade', 'cancelItem', 'needsManagerAuthForCancel', 'setItemNote', 'setItemPerson', 'setItemPrice'],
  print: ['kitchenTicket', 'preNota'],
  auth: ['getSecurityConfig'],
  reservation: ['listVinculadasAtivas'],
};

let remotaEmCache = null;

/** A api das mesas: local (padrão) ou a do servidor (`remota`). */
export function apiDasMesas(remota = false) {
  if (!remota) return window.pdv;
  if (remotaEmCache) return remotaEmCache;
  const api = {};
  for (const [grupo, metodos] of Object.entries(CANAIS_REMOTOS)) {
    api[grupo] = {};
    for (const m of metodos) {
      api[grupo][m] = (args = {}) => window.pdv.mesaCompartilhada.chamar({ canal: `${grupo}:${m}`, args });
    }
  }
  // Avisos de mudança chegam pelo mesmo evento (o caixa repassa os do servidor).
  api.table.onMudou = (cb) => window.pdv.table.onMudou?.(cb);
  // Liberar a mesa depois de pagar é do servidor (ao concluir); aqui não faz nada.
  api.table.release = async () => ({ ok: true });
  // Pagamento nunca é na mesa do servidor (a conta vem para cá antes).
  api.sale.getPaymentState = async () => null;
  remotaEmCache = api;
  return api;
}
