const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const saleService = require('./saleService');
const { precoEfetivo } = require('./productService');
const timeService = require('./timeService');

function createQuote({ locationId, customerId, operadorId, validadeDias }) {
  if (!locationId) return { ok: false, error: 'Local é obrigatório.' };
  const db = getDb();
  const id = randomUUID();
  const validadeAte = validadeDias ? timeService.diasAPartirDeHojeLocalISO(validadeDias) : null;
  db.prepare(
    `INSERT INTO quotes (id, location_id, customer_id, operador_id, validade_ate) VALUES (?, ?, ?, ?, ?)`
  ).run(id, locationId, customerId || null, operadorId || null, validadeAte);
  return { ok: true, id };
}

/** Adiciona um item ao orçamento — grava o preço ATUAL do produto
 * (incluindo promocional, se tiver um válido), mas sem tocar em
 * estoque nenhum: orçamento é só uma cotação, pode nunca virar venda. */
function addQuoteItem({ quoteId, productId, quantidade }) {
  if (!(quantidade > 0)) return { ok: false, error: 'Quantidade precisa ser maior que zero.' };
  const db = getDb();
  const quote = db.prepare('SELECT status FROM quotes WHERE id = ?').get(quoteId);
  if (!quote) return { ok: false, error: 'Orçamento não encontrado.' };
  if (quote.status !== 'aberto') return { ok: false, error: 'Esse orçamento não está mais aberto.' };

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND ativo = 1').get(productId);
  if (!product) return { ok: false, error: 'Produto não encontrado.' };

  const itemExistente = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? AND product_id = ?').get(quoteId, productId);
  if (itemExistente) {
    db.prepare('UPDATE quote_items SET quantidade = quantidade + ? WHERE id = ?').run(quantidade, itemExistente.id);
    return { ok: true, id: itemExistente.id };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO quote_items (id, quote_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?, ?)`
  ).run(id, quoteId, productId, quantidade, precoEfetivo(product));
  return { ok: true, id };
}

function removeQuoteItem(itemId) {
  getDb().prepare('DELETE FROM quote_items WHERE id = ?').run(itemId);
  return { ok: true };
}

function getQuote(quoteId) {
  const db = getDb();
  const quote = db.prepare(
    `SELECT q.*, c.nome as clienteNome FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.id = ?`
  ).get(quoteId);
  if (!quote) return null;
  const items = db.prepare(
    `SELECT qi.*, p.nome FROM quote_items qi JOIN products p ON p.id = qi.product_id WHERE qi.quote_id = ?`
  ).all(quoteId);
  const total = items.reduce((acc, i) => acc + i.quantidade * i.preco_unitario, 0);
  return { ...quote, items, total };
}

function listQuotes({ locationId, status } = {}) {
  const db = getDb();
  let sql = `
    SELECT q.*, c.nome as clienteNome,
      (SELECT COALESCE(SUM(qi.quantidade * qi.preco_unitario), 0) FROM quote_items qi WHERE qi.quote_id = q.id) as total
    FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.location_id = ?`;
  const params = [locationId];
  if (status) {
    sql += ' AND q.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY q.criado_em DESC';
  return db.prepare(sql).all(...params);
}

function cancelQuote(quoteId) {
  const db = getDb();
  const quote = db.prepare('SELECT status FROM quotes WHERE id = ?').get(quoteId);
  if (!quote) return { ok: false, error: 'Orçamento não encontrado.' };
  if (quote.status !== 'aberto') return { ok: false, error: 'Só é possível cancelar um orçamento em aberto.' };
  db.prepare(`UPDATE quotes SET status = 'cancelado' WHERE id = ?`).run(quoteId);
  return { ok: true };
}

/**
 * Converte o orçamento numa venda de verdade — só AQUI o estoque é
 * debitado (via saleService.addItem, item por item, respeitando as
 * mesmas regras de estoque disponível que uma venda normal teria).
 * Se algum item não tiver mais estoque suficiente, para e devolve o
 * erro sem deixar a venda pela metade.
 */
function convertToSale({ quoteId, operadorId, deviceId }) {
  const db = getDb();
  const quote = getQuote(quoteId);
  if (!quote) return { ok: false, error: 'Orçamento não encontrado.' };
  if (quote.status !== 'aberto') return { ok: false, error: 'Esse orçamento não está mais aberto.' };
  if (quote.items.length === 0) return { ok: false, error: 'Orçamento sem nenhum item — nada pra converter.' };

  const { id: saleId } = saleService.openSale({ locationId: quote.location_id, operadorId });

  for (const item of quote.items) {
    const resultado = saleService.addItem({
      saleId, productId: item.product_id, locationId: quote.location_id,
      quantidade: item.quantidade, operadorId, deviceId,
    });
    if (!resultado.ok) {
      // Rollback técnico direto — isso NÃO é um cancelamento decidido
      // por alguém (não deve pedir autorização de gerente), é limpeza
      // de uma venda que só existiu por um instante dentro desta
      // função, porque um item no meio do caminho não tinha mais
      // estoque suficiente. Remove tudo que já tinha sido criado pra
      // essa venda specific, sem deixar rastro nem exigir aprovação.
      db.prepare('DELETE FROM stock_movements WHERE sale_id = ?').run(saleId);
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
      db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
      return { ok: false, error: `Não foi possível converter: ${item.nome} — ${resultado.error}` };
    }
  }

  db.prepare(`UPDATE quotes SET status = 'convertido', sale_id = ?, convertido_em = NOW_SYNCED() WHERE id = ?`).run(saleId, quoteId);
  return { ok: true, saleId };
}

module.exports = { createQuote, addQuoteItem, removeQuoteItem, getQuote, listQuotes, cancelQuote, convertToSale };
