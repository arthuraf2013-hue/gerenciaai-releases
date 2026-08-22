const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { authorizeManagerOverride } = require('./authService');
const timeService = require('./timeService');

/** Vendas finalizadas recentes (últimos 60 dias) — para localizar a venda a devolver. */
function findFinalizedSales({ locationId, query }) {
  const db = getDb();
  const sales = db.prepare(
    `SELECT s.*, u.nome as operador_nome FROM sales s JOIN users u ON u.id = s.operador_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= datetime(NOW_SYNCED(), '-60 days')
     ORDER BY s.finalizada_em DESC LIMIT 50`
  ).all(locationId);
  if (!query) return sales;
  return sales.filter((s) => s.id.includes(query) || s.operador_nome.toLowerCase().includes(query.toLowerCase()));
}

function getSaleItemsForReturn(saleId) {
  const db = getDb();
  return db.prepare(
    `SELECT si.*, p.nome, p.unidade,
       COALESCE((SELECT SUM(ri.quantidade) FROM return_items ri WHERE ri.return_id IN
         (SELECT id FROM returns WHERE sale_id = ?) AND ri.product_id = si.product_id), 0) as ja_devolvido
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0`
  ).all(saleId, saleId);
}

/**
 * Devolução de um ou mais itens de uma venda já finalizada. Exige
 * autorização de gerente (mesmo princípio do cancelamento). Gera um
 * movimento de estoque de 'entrada' para cada item devolvido — nunca
 * apaga nem edita a venda original.
 */
function createReturn({ saleId, locationId, itens, motivo, currentOperatorId, candidateManagerId, pin, deviceId }) {
  const db = getDb();

  const auth = authorizeManagerOverride({
    candidateUserId: candidateManagerId,
    pin,
    currentOperatorId,
    tipoEvento: 'devolucao',
    saleId,
    motivo,
  });
  if (!auth.ok) return auth;

  if (!itens || itens.length === 0) return { ok: false, error: 'Selecione ao menos um item para devolver.' };

  // Confere no servidor — nunca confiar só na tela — que cada quantidade
  // pedida é positiva e não passa do que ainda pode ser devolvido
  // (vendido menos o que já foi devolvido antes nessa mesma venda).
  for (const item of itens) {
    const qtd = Number(item.quantidade);
    if (!(qtd > 0)) return { ok: false, error: 'Quantidade a devolver precisa ser maior que zero.' };

    const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(item.saleItemId, saleId);
    if (!saleItem) return { ok: false, error: 'Item da venda não encontrado.' };

    const jaDevolvido = db.prepare(
      `SELECT COALESCE(SUM(ri.quantidade), 0) as total FROM return_items ri
       JOIN returns r ON r.id = ri.return_id
       WHERE r.sale_id = ? AND ri.product_id = ?`
    ).get(saleId, saleItem.product_id).total;

    const disponivelParaDevolucao = saleItem.quantidade - jaDevolvido;
    if (qtd > disponivelParaDevolucao) {
      return { ok: false, error: `Quantidade maior que o disponível para devolução (${disponivelParaDevolucao}).` };
    }
  }

  const returnId = randomUUID();
  let valorTotal = 0;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO returns (id, sale_id, location_id, operador_id, autorizado_por_id, motivo, valor_devolvido)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(returnId, saleId, locationId, currentOperatorId, auth.autorizadoPor.id, motivo || null);

    for (const item of itens) {
      const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(item.saleItemId, saleId);
      if (!saleItem) continue;
      const valorItem = saleItem.preco_unitario * item.quantidade;
      valorTotal += valorItem;

      db.prepare(
        `INSERT INTO return_items (id, return_id, product_id, quantidade, valor_unitario) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), returnId, saleItem.product_id, item.quantidade, saleItem.preco_unitario);

      db.prepare(
        `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, operador_id, autorizado_por_id, device_id)
         VALUES (?, ?, ?, 'entrada', ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), saleItem.product_id, locationId, Math.abs(item.quantidade), motivo || 'Devolução pós-venda', saleId, currentOperatorId, auth.autorizadoPor.id, deviceId);
    }

    db.prepare('UPDATE returns SET valor_devolvido = ? WHERE id = ?').run(valorTotal, returnId);
  });
  tx();

  const stockSyncService = require('./stockSyncService');
  const produtosDevolvidos = [...new Set(itens.map((item) => {
    const saleItem = db.prepare('SELECT product_id FROM sale_items WHERE id = ?').get(item.saleItemId);
    return saleItem?.product_id;
  }).filter(Boolean))];
  for (const productId of produtosDevolvidos) {
    stockSyncService.pushEstoqueProduto(productId).catch(() => {});
  }

  return { ok: true, returnId, valorDevolvido: valorTotal, autorizadoPor: auth.autorizadoPor };
}

function listReturns({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  // Sargable -- ver o mesmo comentário em dashboardService.js.
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  return db.prepare(
    `SELECT r.*, u1.nome as operador_nome, u2.nome as autorizado_por_nome
     FROM returns r
     JOIN users u1 ON u1.id = r.operador_id
     JOIN users u2 ON u2.id = r.autorizado_por_id
     WHERE r.location_id = ? AND r.criado_em >= ? AND r.criado_em < ?
     ORDER BY r.criado_em DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
}

module.exports = { findFinalizedSales, getSaleItemsForReturn, createReturn, listReturns };
