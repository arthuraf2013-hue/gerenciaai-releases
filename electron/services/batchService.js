const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Registra um lote recebido — cria a linha em product_batches (com o
 * lote/validade próprios) E o movimento de estoque 'entrada'
 * correspondente, na mesma transação. É assim que uma nota de compra
 * confirmada no módulo de abastecimento efetivamente entra no estoque.
 */
function createBatch({ productId, locationId, lote, validade, quantidade, fornecedorId, operadorId, deviceId, motivo }) {
  const db = getDb();
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return { ok: false, error: 'Quantidade precisa ser maior que zero.' };

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return { ok: false, error: 'Produto não encontrado.' };

  const batchId = randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO product_batches (id, product_id, location_id, lote, validade, quantidade, fornecedor_id, operador_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(batchId, productId, locationId, lote || null, validade || null, qtd, fornecedorId || null, operadorId);

    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id)
       VALUES (?, ?, ?, 'entrada', ?, ?, ?, ?)`
    ).run(randomUUID(), productId, locationId, qtd, motivo || 'Abastecimento — nota de compra', operadorId, deviceId);
  });
  tx();

  require('./stockSyncService').pushEstoqueProduto(productId).catch(() => {});

  return { ok: true, batchId };
}

/** Todos os lotes recebidos de um produto, mais recentes primeiro. */
function listBatchesForProduct(productId) {
  const db = getDb();
  return db.prepare(
    `SELECT b.*, s.nome as fornecedor_nome FROM product_batches b
     LEFT JOIN suppliers s ON s.id = b.fornecedor_id
     WHERE b.product_id = ? ORDER BY b.criado_em DESC`
  ).all(productId);
}

/**
 * Recomendação de venda por validade (FEFO — o que vence primeiro deve
 * ser vendido primeiro). Lista os lotes com validade cadastrada, mais
 * próximos do vencimento primeiro. Não desconta o que já foi vendido
 * (o sistema não rastreia baixa por lote específico — ver nota no
 * schema) — é uma lista de PRIORIDADE, não um saldo exato por lote.
 */
function listUpcomingExpiry({ locationId, limit = 30 }) {
  const db = getDb();
  return db.prepare(
    `SELECT b.*, p.nome as produto_nome, p.unidade, s.nome as fornecedor_nome
     FROM product_batches b
     JOIN products p ON p.id = b.product_id
     LEFT JOIN suppliers s ON s.id = b.fornecedor_id
     WHERE b.location_id = ? AND b.validade IS NOT NULL AND p.ativo = 1
     ORDER BY b.validade ASC
     LIMIT ?`
  ).all(locationId, limit);
}

/**
 * Validade "efetiva" de um produto pra fins de alerta — prioriza o lote
 * com vencimento mais próximo (se algum foi registrado via
 * abastecimento); se não houver nenhum lote registrado, cai de volta
 * pro campo antigo (custom_fields.validade), pra não quebrar produtos
 * cadastrados manualmente ou importados por planilha, que nunca passam
 * pelo módulo de abastecimento.
 */
function resolveValidadeEfetiva(productId, validadeCustomField) {
  const db = getDb();
  const proximoLote = db.prepare(
    `SELECT validade FROM product_batches WHERE product_id = ? AND validade IS NOT NULL ORDER BY validade ASC LIMIT 1`
  ).get(productId);
  return proximoLote?.validade || validadeCustomField || null;
}

module.exports = { createBatch, listBatchesForProduct, listUpcomingExpiry, resolveValidadeEfetiva };
