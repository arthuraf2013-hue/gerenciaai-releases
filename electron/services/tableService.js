const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const saleService = require('./saleService');

/** Lista as mesas de um local, com o total atual da comanda (se ocupada). */
function listTables(locationId) {
  const db = getDb();
  return db.prepare(
    `SELECT t.*, s.total as total_atual, s.criado_em as aberta_em
     FROM restaurant_tables t
     LEFT JOIN sales s ON s.id = t.sale_id
     WHERE t.location_id = ?
     ORDER BY CAST(t.numero AS INTEGER), t.numero`
  ).all(locationId);
}

function createTable({ locationId, numero, nome }) {
  if (!numero || !String(numero).trim()) return { ok: false, error: 'Informe o número/nome da mesa.' };
  const db = getDb();
  const numeroLimpo = String(numero).trim();
  const existe = db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(locationId, numeroLimpo);
  if (existe) return { ok: false, error: 'Já existe uma mesa com esse número.' };

  const id = randomUUID();
  db.prepare(`INSERT INTO restaurant_tables (id, location_id, numero, nome, status) VALUES (?, ?, ?, ?, 'livre')`)
    .run(id, locationId, numeroLimpo, nome?.trim() || null);
  return { ok: true, id };
}

function deleteTable(tableId) {
  const db = getDb();
  const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'livre') return { ok: false, error: 'Só é possível excluir uma mesa livre.' };
  db.prepare('DELETE FROM restaurant_tables WHERE id = ?').run(tableId);
  return { ok: true };
}

/** Abre a mesa — cria uma comanda nova pra ela, ou devolve a que já
 * estava em andamento (ex: reabrir a mesma mesa depois de navegar pra
 * outra tela). Só permite abrir mesa livre ou reservada (chegou o
 * grupo que tinha reservado) — não dá pra abrir uma que ainda está
 * aguardando limpeza. */
function openTable({ tableId, locationId, operadorId, pessoas }) {
  const db = getDb();
  const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };

  if (table.status === 'ocupada' && table.sale_id) {
    return { ok: true, saleId: table.sale_id };
  }
  if (table.status === 'aguardando_limpeza') {
    return { ok: false, error: 'Essa mesa ainda está aguardando limpeza — marque como limpa antes de abrir de novo.' };
  }

  const { id: saleId } = saleService.openSale({ locationId, operadorId });
  db.prepare(`UPDATE restaurant_tables SET status = 'ocupada', sale_id = ?, pessoas = ?, reservado_para = NULL WHERE id = ?`)
    .run(saleId, pessoas ? Number(pessoas) : null, tableId);
  return { ok: true, saleId };
}

/** Devolve os itens e o total já lançados na comanda da mesa — pra
 * reconstruir o carrinho ao reabrir uma mesa que já estava ocupada. */
function getTableCart(saleId) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { items: [], total: 0 };

  const items = db.prepare(
    `SELECT si.*, p.nome FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em`
  ).all(saleId);

  return {
    total: sale.total,
    taxaServicoPercentual: sale.taxa_servico_percentual || 0,
    items: items.map((i) => ({
      id: i.id, nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario, cancelado: false,
      observacao: i.observacao || '', pessoaNumero: i.pessoa_numero || null,
    })),
  };
}

/** Libera a mesa depois que a comanda é paga — vai pra "aguardando
 * limpeza" em vez de direto pra "livre", já que normalmente alguém
 * precisa limpar a mesa antes do próximo cliente sentar. */
function releaseTable(tableId) {
  const db = getDb();
  db.prepare(`UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL WHERE id = ?`).run(tableId);
  return { ok: true };
}

/** Confirma que a mesa foi limpa — volta a ficar disponível. */
function markCleaned(tableId) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'aguardando_limpeza') return { ok: false, error: 'Essa mesa não está aguardando limpeza.' };
  db.prepare(`UPDATE restaurant_tables SET status = 'livre' WHERE id = ?`).run(tableId);
  return { ok: true };
}

/** Marca uma mesa livre como reservada — pra guardar pra um horário
 * combinado sem deixar ela disponível pra outro grupo sentar. */
function markReserved(tableId, reservadoPara) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'livre') return { ok: false, error: 'Só é possível reservar uma mesa livre.' };
  db.prepare(`UPDATE restaurant_tables SET status = 'reservada', reservado_para = ? WHERE id = ?`).run(reservadoPara || null, tableId);
  return { ok: true };
}

/** Cancela uma reserva — volta a ficar livre pra qualquer grupo. */
function cancelReservation(tableId) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'reservada') return { ok: false, error: 'Essa mesa não está reservada.' };
  db.prepare(`UPDATE restaurant_tables SET status = 'livre', reservado_para = NULL WHERE id = ?`).run(tableId);
  return { ok: true };
}

/** Transfere a comanda inteira de uma mesa ocupada pra outra mesa livre
 * — pro caso do grupo pedir pra mudar de lugar. A mesa de origem vai
 * pra "aguardando limpeza" (alguém sentou lá, precisa limpar antes do
 * próximo grupo), a de destino assume a comanda como se tivesse sido
 * aberta ali desde o início (mesmos itens, mesmo total, mesma hora de
 * abertura). */
function transferTable({ fromTableId, toTableId }) {
  const db = getDb();
  const from = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(fromTableId);
  const to = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(toTableId);
  if (!from || !to) return { ok: false, error: 'Mesa não encontrada.' };
  if (from.status !== 'ocupada' || !from.sale_id) return { ok: false, error: 'A mesa de origem não está ocupada.' };
  if (to.status !== 'livre') return { ok: false, error: 'A mesa de destino precisa estar livre.' };

  const tx = db.transaction(() => {
    db.prepare(`UPDATE restaurant_tables SET status = 'ocupada', sale_id = ?, pessoas = ? WHERE id = ?`)
      .run(from.sale_id, from.pessoas, toTableId);
    db.prepare(`UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL WHERE id = ?`)
      .run(fromTableId);
  });
  tx();

  return { ok: true, saleId: from.sale_id };
}

/** Atualiza o número de pessoas de uma mesa já ocupada — pra quando o
 * grupo cresce (chegou mais gente) ou diminui depois de já ter aberto
 * a mesa. Só funciona em mesa ocupada — pessoas é definido de novo do
 * zero toda vez que a mesa abre. */
function updateTablePeople({ tableId, pessoas }) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'ocupada') return { ok: false, error: 'Só é possível alterar o número de pessoas numa mesa ocupada.' };
  if (!pessoas || Number(pessoas) < 1) return { ok: false, error: 'Informe um número de pessoas válido.' };

  db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(Number(pessoas), tableId);
  return { ok: true };
}

module.exports = {
  listTables, createTable, deleteTable, openTable, getTableCart, releaseTable,
  markCleaned, markReserved, cancelReservation, transferTable, updateTablePeople,
};
