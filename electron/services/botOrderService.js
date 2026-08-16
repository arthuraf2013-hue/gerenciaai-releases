const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const STATUS_PEDIDO_VALIDOS = ['novo', 'em_separacao', 'pronto', 'concluido', 'cancelado'];
const STATUS_ITEM_VALIDOS = ['pendente', 'separado', 'indisponivel', 'substituido'];

// ---------- Configuração (liga/desliga a aba "Separação") ----------
function getConfig() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM delivery_bot_config WHERE id = ?').get('default');
  return { ativo: !!(row?.ativo) };
}

function updateConfig({ ativo }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO delivery_bot_config (id, ativo) VALUES ('default', ?)
     ON CONFLICT(id) DO UPDATE SET ativo = excluded.ativo`
  ).run(ativo ? 1 : 0);
  return { ok: true };
}

// ---------- Pedidos ----------

/** Cria um pedido — hoje digitado manualmente por um funcionário
 * (pedido recebido por telefone, por exemplo); quando o bot de
 * WhatsApp entrar, ele só passa a chamar essa mesma função pra cada
 * pedido fechado com o cliente (`origem: 'whatsapp_bot'`). Não mexe
 * em estoque nem em caixa — isso só acontece quando o pedido é de
 * fato separado e vira uma venda/entrega na conclusão. */
function createOrder({ locationId, customerId, clienteNome, clienteTelefone, tipoEntrega, endereco, observacoes, origem, itens, operadorId }) {
  if (!locationId) return { ok: false, error: 'Local é obrigatório.' };
  if (!clienteNome?.trim()) return { ok: false, error: 'Informe o nome do cliente.' };
  if (!clienteTelefone?.trim()) return { ok: false, error: 'Informe o telefone do cliente.' };
  const tipo = tipoEntrega === 'entrega' ? 'entrega' : 'retirada';
  if (tipo === 'entrega' && !endereco?.trim()) return { ok: false, error: 'Informe o endereço de entrega.' };
  const itensValidos = (Array.isArray(itens) ? itens : []).filter((it) => it.productId || it.descricaoLivre?.trim());
  if (itensValidos.length === 0) return { ok: false, error: 'O pedido precisa de pelo menos um item.' };

  const db = getDb();
  const id = randomUUID();
  const inserirPedido = db.prepare(
    `INSERT INTO bot_orders (id, location_id, customer_id, cliente_nome, cliente_telefone, tipo_entrega, endereco, observacoes, origem, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo')`
  );
  const inserirItem = db.prepare(
    `INSERT INTO bot_order_items (id, bot_order_id, product_id, descricao_livre, quantidade, observacao)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const transacao = db.transaction(() => {
    inserirPedido.run(
      id, locationId, customerId || null, clienteNome.trim(), clienteTelefone.trim(),
      tipo, tipo === 'entrega' ? endereco.trim() : null, observacoes || null,
      origem === 'whatsapp_bot' ? 'whatsapp_bot' : 'manual'
    );
    for (const item of itensValidos) {
      inserirItem.run(
        randomUUID(), id, item.productId || null, item.descricaoLivre || null,
        Number(item.quantidade) > 0 ? Number(item.quantidade) : 1, item.observacao || null
      );
    }
  });
  transacao();
  return { ok: true, id, operadorId };
}

/** Fila de pedidos — já vem com a contagem de itens/itens separados
 * pronta pra tela, sem N consultas por linha. */
function listOrders({ locationId, status } = {}) {
  const db = getDb();
  let sql = `
    SELECT o.*,
      COUNT(i.id) as totalItens,
      SUM(CASE WHEN i.status_separacao = 'separado' THEN 1 ELSE 0 END) as itensSeparados
    FROM bot_orders o
    LEFT JOIN bot_order_items i ON i.bot_order_id = o.id
    WHERE o.location_id = ?`;
  const params = [locationId];
  if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }
  sql += ' GROUP BY o.id ORDER BY o.criado_em DESC';
  return db.prepare(sql).all(...params);
}

/** Detalhe de um pedido com os itens, já casados com o produto (nome,
 * estoque atual no local do pedido) quando o item tem product_id —
 * pra quem for separar já ver se tem em estoque sem sair da tela. */
function getOrderWithItems(orderId) {
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };

  const itens = db.prepare(
    `SELECT i.*, p.nome as produtoNome, p.sku as produtoSku,
       COALESCE((SELECT SUM(sm.quantidade) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.location_id = @locationId), 0) as estoqueAtual
     FROM bot_order_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.bot_order_id = @orderId`
  ).all({ locationId: pedido.location_id, orderId });

  return { ok: true, pedido, itens };
}

/** Muda o status do pedido — carimba automaticamente quando começou a
 * separação e quando foi concluído (mesma ideia do `saiu_em`/
 * `entregue_em` em deliveries). */
function updateOrderStatus({ orderId, status, operadorId }) {
  if (!STATUS_PEDIDO_VALIDOS.includes(status)) return { ok: false, error: 'Status inválido.' };
  const db = getDb();
  const pedido = db.prepare('SELECT id FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };

  const sets = ['status = @status'];
  if (status === 'em_separacao') {
    sets.push('separado_por = COALESCE(separado_por, @operadorId)');
    sets.push('separado_em = COALESCE(separado_em, NOW_SYNCED())');
  }
  if (status === 'concluido') sets.push('concluido_em = COALESCE(concluido_em, NOW_SYNCED())');

  db.prepare(`UPDATE bot_orders SET ${sets.join(', ')} WHERE id = @orderId`)
    .run({ orderId, status, operadorId: operadorId || null });
  return { ok: true };
}

/** Marca um item como separado/indisponível/substituído — feito pelo
 * funcionário conferindo o pedido fisicamente contra o estoque. */
function updateItemStatus({ itemId, status, observacao }) {
  if (!STATUS_ITEM_VALIDOS.includes(status)) return { ok: false, error: 'Status inválido.' };
  const db = getDb();
  const item = db.prepare('SELECT id FROM bot_order_items WHERE id = ?').get(itemId);
  if (!item) return { ok: false, error: 'Item não encontrado.' };
  db.prepare('UPDATE bot_order_items SET status_separacao = ?, observacao = COALESCE(?, observacao) WHERE id = ?')
    .run(status, observacao || null, itemId);
  return { ok: true };
}

/** Produtos ativos com estoque no local, filtrados por categoria — é
 * isso que o bot vai usar pra responder uma opção numerada ("1 -
 * Analgésicos") com o que realmente tem disponível. Já serve hoje
 * também pra tela de Separação sugerir produto ao montar um pedido
 * manual. Categorias ainda não têm uma ordem fixa (são listadas em
 * ordem alfabética) — quando o bot for montado de verdade, o número
 * de cada opção do menu deve ser calculado a partir dessa mesma lista
 * ordenada, gerada na hora (não guardar o número em lugar nenhum).
 */
function listInStockByCategory({ locationId, categoria }) {
  const db = getDb();
  let sql = `
    SELECT p.id, p.nome, p.sku, p.preco, p.categoria,
      COALESCE(SUM(sm.quantidade), 0) as estoqueAtual
    FROM products p
    LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
    WHERE p.ativo = 1`;
  const params = [locationId];
  if (categoria) {
    sql += ' AND p.categoria = ?';
    params.push(categoria);
  }
  sql += ' GROUP BY p.id HAVING estoqueAtual > 0 ORDER BY p.nome';
  return db.prepare(sql).all(...params);
}

module.exports = {
  getConfig, updateConfig,
  createOrder, listOrders, getOrderWithItems, updateOrderStatus, updateItemStatus,
  listInStockByCategory,
};
