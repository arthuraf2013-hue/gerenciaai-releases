const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * PIX ANTECIPADO no pedido do site / QR (vitrine com "pedidos direto no
 * sistema"). O cliente escolhe "pagar agora com Pix": o pedido entra na
 * Separação como "esperando o Pix", esta máquina gera a cobrança pela conta
 * do Pix automático (pixAutomaticoService: mesmo provedor e token) e a página
 * do cliente mostra o QR. Pago, o pedido é ACEITO SOZINHO (senha + cozinha) --
 * não é trote. Não pago no prazo, o pedido é cancelado.
 *
 * Ainda não existe venda quando o cliente paga (a venda nasce na conclusão
 * do pedido, botOrderService.converterEmVendaSeAplicavel): por isso a
 * cobrança mora em `vitrine_pix_cobrancas` (uma por pedido), e a conversão
 * lança o pagamento como Pix dinâmico (`detalhes.pixAutomatico`, tPag 17 na
 * NFC-e).
 *
 * Garantias (iguais às do Pix automático do caixa):
 *  - uma cobrança por pedido (índice único); pago vira pago uma vez só, na
 *    MESMA transação que marca o pedido;
 *  - pago depois do pedido cancelado não some: vira 'estornar' + Auditoria
 *    (devolver pelo Mercado Pago);
 *  - token nunca sai do processo principal.
 */

const VALIDADE_MIN = 30; // o Mercado Pago não aceita Pix com menos de 30 min
const INTERVALO_MIN_CONSULTA_MS = 2500;

function arred2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }
function pix() { return require('./pixAutomaticoService'); }

/** A loja pode oferecer "pagar agora com Pix"? (Pix automático ligado e com token.) */
function disponivel() {
  try {
    const c = pix().getConfig();
    return !!(c.ativo && c.temToken && c.emailPagador);
  } catch {
    return false;
  }
}

function totalDoPedido(db, botOrderId) {
  return arred2(db.prepare(
    `SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS t FROM bot_order_items WHERE bot_order_id = ? AND product_id IS NOT NULL`
  ).get(botOrderId).t);
}

function getDoPedido(botOrderId) {
  return getDb().prepare('SELECT * FROM vitrine_pix_cobrancas WHERE bot_order_id = ?').get(botOrderId) || null;
}

/** O que a página do cliente vê (nunca o token nem o id do provedor). */
function paraPagina(row) {
  if (!row) return null;
  return {
    status: row.status === 'estornar' ? 'pago' : row.status,
    valor: row.valor,
    copiaECola: row.status === 'pendente' ? row.copia_e_cola : null,
    expiraEm: row.expira_em,
  };
}

/** Gera a cobrança do pedido (idempotente: devolve a que já existe). */
async function criarParaPedido({ botOrderId, agoraMs = Date.now() }) {
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(botOrderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  const ja = getDoPedido(botOrderId);
  if (ja && ja.status !== 'erro') return { ok: true, cobranca: ja };
  if (!disponivel()) return { ok: false, error: 'A loja não está aceitando Pix pelo site agora.' };
  const valor = totalDoPedido(db, botOrderId);
  if (!(valor >= 0.01)) return { ok: false, error: 'Pedido sem valor a cobrar.' };

  const config = pix().getConfig();
  const id = ja?.id || randomUUID();
  const expiraEmMs = agoraMs + VALIDADE_MIN * 60000;
  if (ja) {
    db.prepare(`UPDATE vitrine_pix_cobrancas SET status = 'criando', erro = NULL, valor = ?, expira_em = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`)
      .run(valor, new Date(expiraEmMs).toISOString(), id);
  } else {
    db.prepare(
      `INSERT INTO vitrine_pix_cobrancas (id, bot_order_id, provedor, valor, status, expira_em) VALUES (?, ?, ?, ?, 'criando', ?)`
    ).run(id, botOrderId, config.provedor, valor, new Date(expiraEmMs).toISOString());
  }
  db.prepare(`UPDATE bot_orders SET pagamento_online = 'aguardando' WHERE id = ?`).run(botOrderId);
  try {
    const nomeLoja = (() => { try { return require('./fiscalService').getNomeNegocio() || 'Loja'; } catch { return 'Loja'; } })();
    const r = await pix().provedor(config.provedor).criar({
      token: pix().tokenGuardado(), valor, descricao: `${nomeLoja} - pedido pelo site`, referencia: id, idempotencia: id,
      expiraEmMs, emailPagador: config.emailPagador,
    });
    db.prepare(`UPDATE vitrine_pix_cobrancas SET provedor_id = ?, copia_e_cola = ?, status = 'pendente', atualizado_em = NOW_SYNCED() WHERE id = ?`)
      .run(r.provedorId, r.copiaECola, id);
    return { ok: true, cobranca: getDoPedido(botOrderId) };
  } catch (err) {
    db.prepare(`UPDATE vitrine_pix_cobrancas SET status = 'erro', erro = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(String(err.message).slice(0, 300), id);
    // Sem QR o cliente não tem como pagar: o pedido segue como "pagar no balcão".
    db.prepare(`UPDATE bot_orders SET pagamento_online = '' WHERE id = ?`).run(botOrderId);
    return { ok: false, error: err.message };
  }
}

/** Pago: marca a cobrança e o pedido na mesma transação; aceita o pedido. */
function registrarPago(id, { valorPago = null } = {}) {
  const db = getDb();
  const res = db.transaction(() => {
    const row = db.prepare('SELECT * FROM vitrine_pix_cobrancas WHERE id = ?').get(id);
    if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
    if (['pago', 'estornar'].includes(row.status)) return { ok: true, jaRegistrado: true, row };
    const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(row.bot_order_id);
    const valor = arred2(Number(valorPago) > 0 ? Number(valorPago) : row.valor);
    if (!pedido || pedido.status === 'cancelado') {
      db.prepare(`UPDATE vitrine_pix_cobrancas SET status = 'estornar', valor_pago = ?, pago_em = NOW_SYNCED(), atualizado_em = NOW_SYNCED() WHERE id = ?`).run(valor, id);
      require('./authService').registrarEventoAuditoria({
        tipoEvento: 'pix_recebido_sem_venda', solicitanteId: null,
        motivo: `Pix de R$ ${valor.toFixed(2).replace('.', ',')} do pedido do site ${pedido ? `de ${pedido.cliente_nome}` : ''} pago depois do pedido cancelado (cobrança ${row.provedor_id || id}). Devolva pelo Mercado Pago.`,
      });
      return { ok: true, row: db.prepare('SELECT * FROM vitrine_pix_cobrancas WHERE id = ?').get(id), semPedido: true };
    }
    db.prepare(`UPDATE vitrine_pix_cobrancas SET status = 'pago', valor_pago = ?, pago_em = NOW_SYNCED(), atualizado_em = NOW_SYNCED() WHERE id = ?`).run(valor, id);
    db.prepare(`UPDATE bot_orders SET pagamento_online = 'pago' WHERE id = ?`).run(row.bot_order_id);
    return { ok: true, row: db.prepare('SELECT * FROM vitrine_pix_cobrancas WHERE id = ?').get(id), pedido };
  })();
  if (res.ok && res.pedido && !res.jaRegistrado) {
    // Pago = não é trote: aceita sozinho (senha + comanda na cozinha).
    if (res.pedido.status === 'novo') {
      const r = require('./botOrderService').updateOrderStatus({ orderId: res.pedido.id, status: 'em_separacao', operadorId: null });
      if (!r.ok) console.error('[vitrinePix] aceitar pedido pago:', r.error);
    } else {
      try { require('./vitrinePedidoService').publicarEtapa(res.pedido.id).catch(() => {}); } catch { /* acompanhamento é extra */ }
    }
    try {
      require('./notificationService').notifyNewVitrineOrder({
        nome: res.pedido.cliente_nome, itens: null, total: res.row.valor_pago, tipo: res.pedido.tipo_entrega, modo: res.pedido.consumo_local ? 'local' : 'retirada',
        demo: false, pago: true,
      });
    } catch { /* aviso é extra */ }
  }
  return res;
}

async function consultar({ id, agoraMs = Date.now() }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM vitrine_pix_cobrancas WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
  if (row.status !== 'pendente') return { ok: true, row };
  if (row.ultima_consulta_ms && agoraMs - row.ultima_consulta_ms < INTERVALO_MIN_CONSULTA_MS) return { ok: true, row };
  db.prepare('UPDATE vitrine_pix_cobrancas SET ultima_consulta_ms = ? WHERE id = ?').run(agoraMs, id);
  const token = pix().tokenGuardado();
  if (!token) return { ok: true, row };
  let r;
  try {
    r = await pix().provedor(row.provedor).consultar({ token, provedorId: row.provedor_id });
  } catch (err) {
    return { ok: true, row, aviso: err.message };
  }
  if (r.status === 'pago') return registrarPago(id, { valorPago: r.valorPago });
  if (['cancelado', 'expirado', 'falhou', 'estornado'].includes(r.status)) {
    await encerrarSemPagamento(row, r.status === 'expirado' ? 'expirado' : 'cancelado');
  }
  return { ok: true, row: db.prepare('SELECT * FROM vitrine_pix_cobrancas WHERE id = ?').get(id) };
}

/** Pix venceu / foi cancelado sem pagar: o pedido que ainda esperava é cancelado. */
async function encerrarSemPagamento(row, status) {
  const db = getDb();
  const mudou = db.prepare(`UPDATE vitrine_pix_cobrancas SET status = ?, atualizado_em = NOW_SYNCED() WHERE id = ? AND status IN ('pendente','criando')`).run(status, row.id).changes;
  if (!mudou) return;
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(row.bot_order_id);
  if (pedido && pedido.status === 'novo' && pedido.pagamento_online === 'aguardando') {
    db.prepare(`UPDATE bot_orders SET pagamento_online = 'expirado', observacoes = TRIM(COALESCE(observacoes, '') || ' Pix não pago no prazo.') WHERE id = ?`).run(pedido.id);
    require('./botOrderService').updateOrderStatus({ orderId: pedido.id, status: 'cancelado', operadorId: null });
  }
}

/**
 * Atendente recebe no balcão em vez do Pix (cliente desistiu do Pix, QR com
 * problema): cancela a cobrança e o pedido volta a ser "pagar na retirada".
 * Se o Mercado Pago não confirmar o cancelamento, recusa -- o cliente pode
 * estar pagando agora.
 */
async function receberNoBalcao({ botOrderId }) {
  const db = getDb();
  const row = getDoPedido(botOrderId);
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(botOrderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  if (pedido.pagamento_online === 'pago') return { ok: false, error: 'Este pedido já foi pago no Pix.' };
  if (row && row.status === 'pendente') {
    const c = await consultar({ id: row.id, agoraMs: Date.now() + INTERVALO_MIN_CONSULTA_MS });
    if (c.row?.status === 'pago' || c.jaRegistrado) return { ok: false, error: 'O cliente acabou de pagar o Pix.' };
    try {
      await pix().provedor(row.provedor).cancelar({ token: pix().tokenGuardado(), provedorId: row.provedor_id });
    } catch (err) {
      return { ok: false, error: `Não consegui cancelar o Pix no Mercado Pago (${err.message}). Tente de novo em instantes.` };
    }
    db.prepare(`UPDATE vitrine_pix_cobrancas SET status = 'cancelado', atualizado_em = NOW_SYNCED() WHERE id = ? AND status = 'pendente'`).run(row.id);
  }
  db.prepare(`UPDATE bot_orders SET pagamento_online = '' WHERE id = ?`).run(botOrderId);
  try { require('./vitrinePedidoService').publicarEtapa(botOrderId).catch(() => {}); } catch { /* extra */ }
  return { ok: true };
}

/** Pedido cancelado pela loja antes do pagamento: cancela o QR no provedor. */
async function aoCancelarPedido(botOrderId) {
  const row = getDoPedido(botOrderId);
  if (!row || row.status !== 'pendente') return;
  try {
    await pix().provedor(row.provedor).cancelar({ token: pix().tokenGuardado(), provedorId: row.provedor_id });
    getDb().prepare(`UPDATE vitrine_pix_cobrancas SET status = 'cancelado', atualizado_em = NOW_SYNCED() WHERE id = ? AND status = 'pendente'`).run(row.id);
  } catch {
    // Continua 'pendente': se o cliente pagar mesmo assim, vira 'estornar'.
  }
}

/** Segundo plano: confere as pendentes e encerra as vencidas. */
async function reconciliar({ agoraMs = Date.now() } = {}) {
  const db = getDb();
  const agoraIso = new Date(agoraMs).toISOString();
  // Pendentes ainda no prazo (+ 10 min de folga: pagamento no último segundo).
  const folga = new Date(agoraMs - 10 * 60000).toISOString();
  const pendentes = db.prepare(`SELECT id FROM vitrine_pix_cobrancas WHERE status = 'pendente' AND expira_em > ? ORDER BY criado_em LIMIT 50`).all(folga);
  for (const { id } of pendentes) await consultar({ id, agoraMs }).catch(() => {});
  const vencidas = db.prepare(`SELECT * FROM vitrine_pix_cobrancas WHERE status IN ('pendente','criando') AND expira_em <= ?`).all(folga);
  for (const row of vencidas) await encerrarSemPagamento(row, 'expirado').catch(() => {});
  return { conferidas: pendentes.length, vencidas: vencidas.length, agora: agoraIso };
}

function listarParaEstornar() {
  return getDb().prepare(
    `SELECT c.id, c.valor_pago, c.provedor_id, c.pago_em, o.cliente_nome FROM vitrine_pix_cobrancas c
     LEFT JOIN bot_orders o ON o.id = c.bot_order_id WHERE c.status = 'estornar' ORDER BY c.pago_em DESC LIMIT 50`
  ).all();
}

let intervalo = null;
function iniciarConferencia() {
  if (intervalo) clearInterval(intervalo);
  intervalo = setInterval(() => {
    const tem = getDb().prepare(`SELECT 1 FROM vitrine_pix_cobrancas WHERE status IN ('pendente','criando') LIMIT 1`).get();
    if (tem) reconciliar().catch(() => {});
  }, 8000);
}

module.exports = {
  disponivel, criarParaPedido, registrarPago, consultar, receberNoBalcao, aoCancelarPedido, reconciliar,
  getDoPedido, paraPagina, totalDoPedido, listarParaEstornar, iniciarConferencia, VALIDADE_MIN,
};
