const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { precoEfetivo } = require('./productService');

const STATUS_PEDIDO_VALIDOS = ['novo', 'em_separacao', 'pronto', 'concluido', 'cancelado'];
const STATUS_ITEM_VALIDOS = ['pendente', 'separado', 'indisponivel', 'substituido'];
// "Na fila" pra fins do contador/balão na barra lateral -- concluído e
// cancelado já saíram da fila, não contam mais.
const STATUS_ATIVOS = ['novo', 'em_separacao', 'pronto'];

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
function createOrder({ locationId, customerId, clienteNome, clienteTelefone, tipoEntrega, endereco, observacoes, origem, itens, operadorId, mesaNumero }) {
  if (!locationId) return { ok: false, error: 'Local é obrigatório.' };
  if (!clienteNome?.trim()) return { ok: false, error: 'Informe o nome do cliente.' };
  if (!clienteTelefone?.trim()) return { ok: false, error: 'Informe o telefone do cliente.' };
  // Pedido de mesa (cliente já sentado, pediu via QR code — ver
  // whatsappBotHandler.js) não tem retirada/entrega de verdade; usa
  // 'retirada' só como preenchimento do CHECK do schema (ver comentário
  // de mesa_numero em schema.sql) -- o que de fato distingue esse tipo
  // de pedido é mesaNumero estar preenchido.
  const tipo = mesaNumero ? 'retirada' : (tipoEntrega === 'entrega' ? 'entrega' : 'retirada');
  if (!mesaNumero && tipo === 'entrega' && !endereco?.trim()) return { ok: false, error: 'Informe o endereço de entrega.' };
  const itensValidos = (Array.isArray(itens) ? itens : []).filter((it) => it.productId || it.descricaoLivre?.trim());
  if (itensValidos.length === 0) return { ok: false, error: 'O pedido precisa de pelo menos um item.' };

  const db = getDb();
  const id = randomUUID();
  const inserirPedido = db.prepare(
    `INSERT INTO bot_orders (id, location_id, customer_id, cliente_nome, cliente_telefone, tipo_entrega, endereco, observacoes, origem, status, mesa_numero)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo', ?)`
  );
  const inserirItem = db.prepare(
    `INSERT INTO bot_order_items (id, bot_order_id, product_id, descricao_livre, quantidade, observacao, preco_unitario)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const buscarProduto = db.prepare('SELECT * FROM products WHERE id = ?');

  const transacao = db.transaction(() => {
    inserirPedido.run(
      id, locationId, customerId || null, clienteNome.trim(), clienteTelefone.trim(),
      tipo, tipo === 'entrega' ? endereco.trim() : null, observacoes || null,
      origem === 'whatsapp_bot' ? 'whatsapp_bot' : 'manual',
      mesaNumero ? String(mesaNumero).trim() : null
    );
    for (const item of itensValidos) {
      // Congela o preço que foi mostrado ao cliente agora, na criação
      // do pedido -- se não veio explícito (quem chamou não sabia o
      // preço), cai pro preço efetivo atual do produto como melhor
      // esforço. Isso é o que vira sale_items.preco_unitario quando o
      // pedido for convertido em venda de verdade na conclusão (ver
      // updateOrderStatus) -- sem isso, o valor da venda saía zerado.
      let preco = item.precoUnitario != null ? Number(item.precoUnitario) : null;
      if (preco == null && item.productId) {
        const produto = buscarProduto.get(item.productId);
        if (produto) preco = precoEfetivo(produto);
      }
      inserirItem.run(
        randomUUID(), id, item.productId || null, item.descricaoLivre || null,
        Number(item.quantidade) > 0 ? Number(item.quantidade) : 1, item.observacao || null,
        preco
      );
    }
  });
  transacao();
  return { ok: true, id, operadorId };
}

/** Converte um pedido em venda de verdade (entra no Histórico, debita
 * estoque, e -- se for entrega -- cria a entrega correspondente pra
 * aparecer na tela de Entregas) assim que ele é concluído. Sem isso, o
 * pedido nunca virava faturamento nenhum -- ficava só marcado
 * "concluído" no bot_orders sem nenhum rastro em sales/estoque. Idempotente:
 * se o pedido já tem sale_id (já foi convertido antes), não faz nada de
 * novo -- protege contra duplicar a venda se updateOrderStatus for
 * chamado duas vezes pro mesmo pedido.
 *
 * Limitação conhecida: item sem product_id (descrição livre, quando
 * quem lançou o pedido não achou o produto exato no catálogo) não vira
 * linha de venda -- sale_items exige um produto de verdade (não dá pra
 * debitar estoque nem faturar algo que não está cadastrado). Esse tipo
 * de item continua visível no pedido em si, só não soma no total da
 * venda gerada.
 */
function converterEmVendaSeAplicavel({ orderId, operadorId }) {
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido || pedido.sale_id) return;

  const itens = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ?').all(orderId);
  const itensComProduto = itens.filter((i) => i.product_id);
  if (itensComProduto.length === 0) return;

  const operadorVenda = operadorId || pedido.separado_por;
  if (!operadorVenda) return; // não deveria acontecer (em_separacao já grava separado_por), mas nunca deixa a venda sem operador

  const saleId = randomUUID();
  const transacao = db.transaction(() => {
    db.prepare(
      `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em)
       VALUES (?, ?, ?, ?, 'finalizada', 0, NOW_SYNCED())`
    ).run(saleId, pedido.location_id, operadorVenda, pedido.customer_id || null);

    let total = 0;
    for (const item of itensComProduto) {
      const preco = item.preco_unitario != null ? item.preco_unitario : 0;
      const saleItemId = randomUUID();
      db.prepare(
        `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?, ?)`
      ).run(saleItemId, saleId, item.product_id, item.quantidade, preco);
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, sale_id, sale_item_id, operador_id, device_id)
         VALUES (?, ?, ?, 'venda', ?, ?, ?, ?, ?)`
      ).run(randomUUID(), item.product_id, pedido.location_id, -Math.abs(item.quantidade), saleId, saleItemId, operadorVenda, 'bot_orders');
      total += preco * item.quantidade;
    }
    db.prepare('UPDATE sales SET total = ? WHERE id = ?').run(total, saleId);

    // Pagamento coletado na retirada/entrega -- não dá pra saber o
    // método exato por aqui (dinheiro, pix, cartão na maquininha do
    // entregador...), então registra como valor recebido sem detalhar
    // o método. Quem quiser reclassificar o método de pagamento pode
    // editar na tela de Histórico depois.
    db.prepare(
      `INSERT INTO payments (id, sale_id, metodo, valor, detalhes) VALUES (?, ?, 'outro', ?, ?)`
    ).run(randomUUID(), saleId, total, JSON.stringify({ origem: 'pedido_separacao', observacao: 'Coletado na retirada/entrega' }));

    db.prepare('UPDATE bot_orders SET sale_id = ? WHERE id = ?').run(saleId, orderId);

    if (pedido.tipo_entrega === 'entrega') {
      const deliveryId = randomUUID();
      db.prepare(
        `INSERT INTO deliveries (id, location_id, sale_id, customer_id, endereco, cliente_nome, cliente_telefone, operador_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`
      ).run(
        deliveryId, pedido.location_id, saleId, pedido.customer_id || null, pedido.endereco,
        // Nome/telefone digitados (ou vindos do WhatsApp) no próprio
        // pedido -- copiados pra entrega igual o endereço, já que a
        // grande maioria desses clientes ainda não tem customer_id
        // (cadastro formal) nesse momento. Ver comentário na coluna em
        // schema.sql.
        pedido.cliente_nome, pedido.cliente_telefone, operadorVenda,
      );
      db.prepare('UPDATE bot_orders SET delivery_id = ? WHERE id = ?').run(deliveryId, orderId);
    }
  });
  transacao();
  return saleId;
}

/**
 * "Conclui" um pedido de mesa (mesa_numero preenchido) lançando os
 * itens DIRETO na comanda real da mesa, em vez de virar uma venda
 * avulsa nova como acontece com pedidos de retirada/entrega (ver
 * converterEmVendaSeAplicavel) — o cliente já está sentado ali, então
 * o pedido feito pelo QR code precisa somar na MESMA conta que o
 * garçom eventualmente fecha, não gerar uma venda paralela.
 *
 * Se a mesa ainda estiver livre (cliente sentou e já pediu pelo QR
 * antes de qualquer atendente abrir a mesa manualmente), abre ela
 * sozinha aqui. Idempotente como converterEmVendaSeAplicavel: se o
 * pedido já tem sale_id, não faz nada de novo.
 *
 * Limitação conhecida (mesma de converterEmVendaSeAplicavel): item sem
 * product_id (descrição livre) não entra na comanda — sale_items exige
 * um produto de verdade.
 */
function lancarPedidoNaMesa({ orderId, operadorId, deviceId }) {
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  if (!pedido.mesa_numero) return { ok: false, error: 'Esse pedido não é de mesa.' };
  if (pedido.sale_id) return { ok: true, saleId: pedido.sale_id }; // já lançado antes -- não duplica

  const table = db.prepare('SELECT * FROM restaurant_tables WHERE location_id = ? AND numero = ?')
    .get(pedido.location_id, pedido.mesa_numero);
  if (!table) return { ok: false, error: `Mesa ${pedido.mesa_numero} não existe mais.` };

  const tableService = require('./tableService');
  const saleService = require('./saleService');
  const { ok: abriuOk, saleId, error: erroAbrir } = tableService.openTable({
    tableId: table.id, locationId: pedido.location_id, operadorId, pessoas: table.pessoas,
  });
  if (!abriuOk) return { ok: false, error: erroAbrir };

  const itens = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ?').all(orderId);
  const itensComProduto = itens.filter((i) => i.product_id);
  // Agrupa o lançamento de todos os itens numa única transação --
  // saleService.addItem já é transacional por si só (vira um SAVEPOINT
  // aninhado aqui dentro, o better-sqlite3 suporta isso naturalmente),
  // mas sem esse agrupamento cada item era um commit separado no WAL; um
  // pedido de mesa com vários itens fazia a comanda demorar bem mais pra
  // lançar do que precisava. Mesmo comportamento de antes: um item sem
  // estoque só loga o erro e não interrompe os demais (nada aqui lança
  // exceção, então a transação sempre chega ao fim e comita normalmente).
  const lancarItens = db.transaction(() => {
    for (const item of itensComProduto) {
      const resultado = saleService.addItem({
        saleId, productId: item.product_id, locationId: pedido.location_id,
        quantidade: item.quantidade, operadorId, deviceId,
      });
      if (!resultado.ok) {
        console.error('[botOrderService] item do pedido de mesa não entrou na comanda', item.id, resultado.error);
      }
    }
  });
  lancarItens();

  db.prepare(
    `UPDATE bot_orders SET status = 'concluido', sale_id = ?, separado_por = COALESCE(separado_por, ?), concluido_em = COALESCE(concluido_em, NOW_SYNCED()) WHERE id = ?`
  ).run(saleId, operadorId, orderId);

  return { ok: true, saleId };
}

/** Fila de pedidos — já vem com a contagem de itens/itens separados
 * pronta pra tela, sem N consultas por linha. */
function listOrders({ locationId, status } = {}) {
  const db = getDb();
  let sql = `
    SELECT o.*,
      COUNT(i.id) as totalItens,
      SUM(CASE WHEN i.status_separacao = 'separado' THEN 1 ELSE 0 END) as itensSeparados,
      COALESCE(SUM(i.preco_unitario * i.quantidade), 0) as valorTotal
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

/** Pedidos ainda "na fila" (não concluídos nem cancelados) — usado só
 * pro contador/balão que aparece do lado de "Separação" na barra
 * lateral, fora da tela de verdade. Bem enxuto de propósito (não traz
 * itens nem estoque) porque é só uma consulta rápida — quem quiser
 * realmente mexer no pedido precisa abrir a aba "Separação". */
function listActiveOrders({ locationId }) {
  const db = getDb();
  const placeholders = STATUS_ATIVOS.map(() => '?').join(',');
  return db.prepare(
    `SELECT id, cliente_nome, tipo_entrega, status, criado_em
     FROM bot_orders
     WHERE location_id = ? AND status IN (${placeholders})
     ORDER BY criado_em ASC`
  ).all(locationId, ...STATUS_ATIVOS);
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

  const valorTotal = itens.reduce((soma, i) => soma + (i.preco_unitario || 0) * i.quantidade, 0);

  return { ok: true, pedido: { ...pedido, valorTotal }, itens };
}

/** Avisa o cliente pelo WhatsApp quando o pedido fica pronto -- pra
 * retirada, que já pode vir buscar; pra entrega, que já vai sair (o
 * aviso de "saiu de fato" é separado, ver deliveryService.
 * notificarSaidaParaEntrega, disparado só quando a entrega em si muda
 * pra "em_rota"). Silenciosa quando não dá pra mandar (bot
 * desconectado, sem telefone) -- quem chama trata como
 * fogo-e-esquece. */
async function notificarPedidoPronto(pedido) {
  const whatsappBotService = require('./whatsappBotService');
  if (whatsappBotService.getStatus().status !== 'conectado') return;
  if (!pedido.cliente_telefone) return;

  const primeiroNome = (pedido.cliente_nome || '').trim().split(' ')[0] || 'tudo bem';
  const texto = pedido.tipo_entrega === 'entrega'
    ? `Oi, ${primeiroNome}! Seu pedido está pronto e já vai sair pra entrega. 📦`
    : `Oi, ${primeiroNome}! Seu pedido já está pronto pra retirada. Te esperamos! 😊`;

  const resultado = await whatsappBotService.enviarMensagem({ telefone: pedido.cliente_telefone, texto });
  if (!resultado.ok) {
    console.error('[botOrderService] falha ao enviar aviso de pedido pronto', pedido.id, resultado.error);
  }
}

/** Muda o status do pedido — carimba automaticamente quando começou a
 * separação e quando foi concluído (mesma ideia do `saiu_em`/
 * `entregue_em` em deliveries). */
function updateOrderStatus({ orderId, status, operadorId }) {
  if (!STATUS_PEDIDO_VALIDOS.includes(status)) return { ok: false, error: 'Status inválido.' };
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };

  const sets = ['status = @status'];
  if (status === 'em_separacao') {
    sets.push('separado_por = COALESCE(separado_por, @operadorId)');
    sets.push('separado_em = COALESCE(separado_em, NOW_SYNCED())');
  }
  if (status === 'concluido') sets.push('concluido_em = COALESCE(concluido_em, NOW_SYNCED())');

  db.prepare(`UPDATE bot_orders SET ${sets.join(', ')} WHERE id = @orderId`)
    .run({ orderId, status, operadorId: operadorId || null });

  if (status === 'pronto' && !pedido.mesa_numero) {
    // Fogo-e-esquece -- mesmo princípio do bloco de conversão em venda
    // logo abaixo: nunca deixa a mudança de status em si falhar por
    // causa do aviso. Pedido de mesa nunca passa por "pronto" (ver
    // SepararPedidoModal), então nem tenta.
    notificarPedidoPronto(pedido).catch((err) => {
      console.error('[botOrderService] falha ao notificar pedido pronto', orderId, err);
    });
  }

  if (status === 'concluido') {
    try {
      converterEmVendaSeAplicavel({ orderId, operadorId });
    } catch (err) {
      // Nunca deixa a mudança de status em si falhar por causa disso --
      // mas isso não pode ficar em silêncio: se a venda não foi criada,
      // o pedido "concluído" não vai aparecer no faturamento, e isso
      // precisa ficar visível em algum lugar pra alguém investigar.
      console.error('[botOrderService] falha ao converter pedido em venda', orderId, err);
    }
  }

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

/** Categorias que têm pelo menos um produto ativo com estoque > 0 no
 * local — é a partir dessa lista (sempre em ordem alfabética, sempre
 * recalculada na hora) que o bot do WhatsApp monta o menu numerado
 * ("1 - Analgésicos", "2 - ..."). Categoria sem nenhum item disponível
 * não aparece — não faz sentido oferecer uma opção vazia pro cliente. */
function listCategoriasComEstoque({ locationId }) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.categoria as categoria
     FROM products p
     JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     WHERE p.ativo = 1 AND p.categoria IS NOT NULL AND TRIM(p.categoria) != ''
     GROUP BY p.categoria
     HAVING SUM(sm.quantidade) > 0
     ORDER BY p.categoria COLLATE NOCASE`
  ).all(locationId);
  return rows.map((r) => r.categoria);
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

/** Todos os produtos ativos do local, com estoque atual calculado --
 * inclusive os sem estoque (ao contrário de listInStockByCategory).
 * Usado pelo bot do WhatsApp pra responder perguntas livres tipo
 * "vocês tem dipirona?" (o próprio whatsappBotHandler faz a busca por
 * texto em cima dessa lista, porque só ele conhece as abreviações de
 * nome pra "traduzir" antes de comparar -- ver humanizarNomeProduto). */
function listarAtivosParaBusca({ locationId }) {
  const db = getDb();
  return db.prepare(
    `SELECT p.id, p.nome, p.preco, p.categoria,
       COALESCE(SUM(sm.quantidade), 0) as estoqueAtual
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     WHERE p.ativo = 1
     GROUP BY p.id`
  ).all(locationId);
}

module.exports = {
  getConfig, updateConfig,
  createOrder, listOrders, listActiveOrders, getOrderWithItems, updateOrderStatus, updateItemStatus,
  listCategoriasComEstoque, listInStockByCategory, listarAtivosParaBusca, lancarPedidoNaMesa,
};
