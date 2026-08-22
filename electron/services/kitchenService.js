const { getDb } = require('../db/database');

/**
 * Painel de Cozinha (KDS) — mostra numa tela (tablet/monitor na
 * cozinha) os itens que ainda precisam ser preparados, em vez de
 * depender só da comanda impressa em papel (ver printService.
 * printKitchenTicket, que continua existindo — os dois convivem: quem
 * não tiver tela na cozinha continua imprimindo normalmente).
 *
 * Usa a coluna sale_items.status_preparo (ver comentário dela em
 * schema.sql), separada de enviado_cozinha (que só controla a
 * impressão em papel) — então isso funciona independente de a comanda
 * ter sido impressa ou não.
 */

const STATUS_VALIDOS = ['pendente', 'preparando', 'pronto'];

/** Itens ainda em aberto (pendente/preparando) de vendas não
 * finalizadas — a "fila" da cozinha. Uma vez marcado "pronto", o item
 * some da lista sozinho (quem está atendendo já vai levar pra mesa);
 * não existe um status "entregue" separado. */
function listActiveItems(locationId) {
  const db = getDb();
  return db.prepare(
    `SELECT si.id, si.sale_id, si.quantidade, si.observacao, si.status_preparo, si.criado_em, si.pessoa_numero,
            COALESCE(si.nome_personalizado, p.nome) as nome,
            rt.numero as mesa_numero, rt.nome as mesa_nome
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     LEFT JOIN restaurant_tables rt ON rt.sale_id = s.id
     WHERE s.location_id = ? AND s.status = 'aberta' AND si.cancelado = 0
       AND si.status_preparo IN ('pendente', 'preparando')
     ORDER BY si.criado_em ASC`
  ).all(locationId);
}

/** Muda o status de um item (pendente → preparando → pronto). Não
 * mexe em nada de estoque/fiscal — é só o estado de preparo, puramente
 * operacional da cozinha. */
function updateItemStatus({ itemId, status }) {
  if (!STATUS_VALIDOS.includes(status)) {
    return { ok: false, error: `Status inválido. Use: ${STATUS_VALIDOS.join(', ')}.` };
  }
  const db = getDb();
  const result = db.prepare(
    `UPDATE sale_items SET status_preparo = ? WHERE id = ? AND cancelado = 0`
  ).run(status, itemId);
  if (result.changes === 0) return { ok: false, error: 'Item não encontrado (ou já cancelado).' };
  return { ok: true };
}

module.exports = { listActiveItems, updateItemStatus };
