const { getDb } = require('../db/database');

function getSummary({ locationId, dataInicio, dataFim }) {
  const db = getDb();

  const totais = db.prepare(
    `SELECT COUNT(*) as totalVendas, COALESCE(SUM(total - desconto - desconto_gerente), 0) as totalFaturado
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND date(finalizada_em) BETWEEN date(?) AND date(?)`
  ).get(locationId, dataInicio, dataFim);

  const vendasPorDia = db.prepare(
    `SELECT date(finalizada_em) as dia, COALESCE(SUM(total - desconto - desconto_gerente), 0) as total
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND date(finalizada_em) BETWEEN date(?) AND date(?)
     GROUP BY dia ORDER BY dia`
  ).all(locationId, dataInicio, dataFim);

  const topProdutos = db.prepare(
    `SELECT p.nome, SUM(si.quantidade) as quantidade, SUM(si.quantidade * si.preco_unitario) as valorTotal
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND date(s.finalizada_em) BETWEEN date(?) AND date(?)
     GROUP BY si.product_id
     ORDER BY quantidade DESC
     LIMIT 8`
  ).all(locationId, dataInicio, dataFim);

  const devolucoes = db.prepare(
    `SELECT COUNT(*) as total, COALESCE(SUM(valor_devolvido), 0) as valor
     FROM returns WHERE location_id = ? AND date(criado_em) BETWEEN date(?) AND date(?)`
  ).get(locationId, dataInicio, dataFim);

  // Lucro estimado — usa o CUSTO ATUAL do produto (products.custo), não
  // o custo histórico de quando a venda aconteceu (o sistema não guarda
  // isso por item de venda). Se o custo de um produto mudou desde a
  // venda, o número fica impreciso — daí "estimado" no nome, de propósito.
  const margem = db.prepare(
    `SELECT
       COALESCE(SUM(si.quantidade * si.preco_unitario), 0) as valorVendido,
       COALESCE(SUM(si.quantidade * p.custo), 0) as custoEstimado
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND date(s.finalizada_em) BETWEEN date(?) AND date(?)`
  ).get(locationId, dataInicio, dataFim);

  const margemPorProduto = db.prepare(
    `SELECT p.nome,
       SUM(si.quantidade) as quantidade,
       SUM(si.quantidade * si.preco_unitario) as valorVendido,
       SUM(si.quantidade * p.custo) as custoEstimado
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND date(s.finalizada_em) BETWEEN date(?) AND date(?)
     GROUP BY si.product_id
     HAVING valorVendido > 0
     ORDER BY (valorVendido - custoEstimado) DESC
     LIMIT 8`
  ).all(locationId, dataInicio, dataFim);

  return {
    totalVendas: totais.totalVendas,
    totalFaturado: totais.totalFaturado,
    vendasPorDia,
    topProdutos,
    devolucoes,
    lucroBrutoEstimado: margem.valorVendido - margem.custoEstimado,
    margemPorProduto: margemPorProduto.map((p) => ({
      ...p,
      lucro: p.valorVendido - p.custoEstimado,
      margemPercentual: p.valorVendido > 0 ? ((p.valorVendido - p.custoEstimado) / p.valorVendido) * 100 : 0,
    })),
  };
}

/**
 * Produtos com estoque (vale a pena vender) mas sem nenhuma venda nos
 * últimos X dias — ajuda a achar o que está encalhado, diferente do
 * alerta de validade (que só avisa quando já está perto de vencer).
 */
function listStaleProducts({ locationId, dias = 30 }) {
  const db = getDb();
  return db.prepare(
    `SELECT p.id, p.nome, p.categoria, p.preco,
       COALESCE(SUM(sm.quantidade), 0) as estoque_atual,
       MAX(CASE WHEN sm.tipo = 'venda' THEN sm.criado_em END) as ultima_venda_em
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     WHERE p.ativo = 1
     GROUP BY p.id
     HAVING estoque_atual > 0
       AND (ultima_venda_em IS NULL OR ultima_venda_em < datetime(NOW_SYNCED(), '-' || ? || ' days'))
     ORDER BY ultima_venda_em ASC NULLS FIRST, p.nome`
  ).all(locationId, dias);
}

/** Total vendido por operador num período — pra calcular comissão ou
 * gorjeta. Só conta vendas finalizadas (não abertas nem canceladas). */
function getSalesByOperator({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  return db.prepare(
    `SELECT u.nome as operador, COUNT(*) as total_vendas, COALESCE(SUM(s.total), 0) as total_vendido
     FROM sales s JOIN users u ON u.id = s.operador_id
     WHERE s.location_id = ? AND s.status = 'finalizada'
       AND date(COALESCE(s.finalizada_em, s.criado_em)) BETWEEN date(?) AND date(?)
     GROUP BY s.operador_id ORDER BY total_vendido DESC`
  ).all(locationId, dataInicio, dataFim);
}

module.exports = { getSummary, listStaleProducts, getSalesByOperator };
