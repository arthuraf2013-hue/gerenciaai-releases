const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function list({ query } = {}) {
  const db = getDb();
  if (query) {
    return db.prepare(
      `SELECT * FROM suppliers WHERE ativo = 1 AND nome LIKE ? ORDER BY nome`
    ).all(`%${query}%`);
  }
  return db.prepare('SELECT * FROM suppliers WHERE ativo = 1 ORDER BY nome').all();
}

function upsert(supplier) {
  if (!supplier.nome?.trim()) return { ok: false, error: 'Informe o nome do fornecedor.' };
  const db = getDb();
  const id = supplier.id || randomUUID();
  db.prepare(
    `INSERT INTO suppliers (id, nome, cnpj_cpf, telefone, email) VALUES (@id, @nome, @cnpjCpf, @telefone, @email)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, cnpj_cpf=excluded.cnpj_cpf, telefone=excluded.telefone, email=excluded.email`
  ).run({ id, nome: supplier.nome.trim(), cnpjCpf: supplier.cnpjCpf || null, telefone: supplier.telefone || null, email: supplier.email || null });
  return { ok: true, id };
}

/**
 * Sugestão de reposição — sem IA, só estatística simples: calcula a
 * velocidade média de venda dos últimos 30 dias (unidades/dia) e sugere
 * comprar o suficiente para cobrir os próximos 30 dias, descontando o
 * que já tem em estoque. Só entram produtos com estoque no ou abaixo
 * do mínimo configurado — não sugere repor o que não precisa.
 */
function suggestPurchases({ locationId }) {
  const db = getDb();
  const produtos = db.prepare(
    `SELECT p.id, p.sku, p.nome, p.estoque_minimo, p.fornecedor_id, s.nome as fornecedor_nome,
       COALESCE(SUM(sm.quantidade), 0) as estoque_atual
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     LEFT JOIN suppliers s ON s.id = p.fornecedor_id
     WHERE p.ativo = 1
     GROUP BY p.id
     HAVING estoque_atual <= p.estoque_minimo`
  ).all(locationId);

  return produtos.map((p) => {
    const vendidoUltimos30Dias = db.prepare(
      `SELECT COALESCE(SUM(-quantidade), 0) as total FROM stock_movements
       WHERE product_id = ? AND location_id = ? AND tipo = 'venda' AND criado_em >= datetime(NOW_SYNCED(), '-30 days')`
    ).get(p.id, locationId).total;

    const velocidadeDiaria = vendidoUltimos30Dias / 30;
    const sugestao = Math.max(
      p.estoque_minimo - p.estoque_atual, // pelo menos cobrir o mínimo
      Math.ceil(velocidadeDiaria * 30 - p.estoque_atual) // ou cobrir 30 dias de venda
    );

    return {
      ...p,
      vendidoUltimos30Dias,
      velocidadeDiaria: Number(velocidadeDiaria.toFixed(2)),
      quantidadeSugerida: Math.max(0, sugestao),
    };
  }).sort((a, b) => b.quantidadeSugerida - a.quantidadeSugerida);
}

module.exports = { list, upsert, suggestPurchases };
