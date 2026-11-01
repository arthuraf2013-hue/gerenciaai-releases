const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Centros de custo (ERP, financeiro): agrupam despesas por área da loja
 * (ex.: "Cozinha", "Delivery", "Loja 2") para ver no DRE onde o dinheiro vai.
 * Desativar não apaga: a despesa antiga continua apontando para ele.
 */

function listar({ incluirInativos = false } = {}) {
  return getDb().prepare(`SELECT * FROM cost_centers ${incluirInativos ? '' : 'WHERE ativo = 1'} ORDER BY nome`).all();
}

function salvar({ id, nome } = {}) {
  const db = getDb();
  const n = String(nome || '').trim();
  if (!n) return { ok: false, error: 'Dê um nome ao centro de custo.' };
  if (n.length > 60) return { ok: false, error: 'Nome muito longo (máx. 60).' };
  const repetido = db.prepare('SELECT id FROM cost_centers WHERE lower(nome) = lower(?) AND id != COALESCE(?, \'\')').get(n, id || null);
  if (repetido) return { ok: false, error: 'Já existe um centro de custo com esse nome.' };
  if (id) {
    const r = db.prepare('UPDATE cost_centers SET nome = ? WHERE id = ?').run(n, id);
    return r.changes ? { ok: true, id } : { ok: false, error: 'Centro de custo não encontrado.' };
  }
  const novo = randomUUID();
  db.prepare('INSERT INTO cost_centers (id, nome) VALUES (?, ?)').run(novo, n);
  return { ok: true, id: novo };
}

function definirAtivo({ id, ativo } = {}) {
  const r = getDb().prepare('UPDATE cost_centers SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
  return r.changes ? { ok: true } : { ok: false, error: 'Centro de custo não encontrado.' };
}

/** Muda o centro de custo de uma despesa (null tira). */
function atribuir({ expenseId, centroCustoId } = {}) {
  const db = getDb();
  if (centroCustoId && !db.prepare('SELECT 1 FROM cost_centers WHERE id = ? AND ativo = 1').get(centroCustoId)) {
    return { ok: false, error: 'Centro de custo inválido.' };
  }
  const r = db.prepare('UPDATE expenses SET centro_custo_id = ? WHERE id = ?').run(centroCustoId || null, expenseId);
  return r.changes ? { ok: true } : { ok: false, error: 'Despesa não encontrada.' };
}

/**
 * Despesas do DRE por centro de custo e mês (mesma competência e mesmas
 * exclusões do DRE: compra de mercadoria e retirada do sócio ficam fora).
 */
function despesasPorCentro({ locationId, competencias } = {}) {
  const lista = (competencias || []).filter((c) => /^\d{4}-\d{2}$/.test(c));
  if (lista.length === 0 || lista.length > 24) return { ok: false, error: 'Escolha de 1 a 24 meses.' };
  const { CATEGORIAS_FORA_DO_DRE } = require('./financeiroService');
  const db = getDb();
  const linhas = db.prepare(
    `SELECT COALESCE(cc.nome, 'Sem centro de custo') AS centro, e.centro_custo_id,
       COALESCE(e.competencia, substr(e.data_vencimento, 1, 7), strftime('%Y-%m', e.data_pagamento, '-3 hours'), strftime('%Y-%m', e.criado_em, '-3 hours')) AS comp,
       SUM(e.valor) AS total
     FROM expenses e LEFT JOIN cost_centers cc ON cc.id = e.centro_custo_id
     WHERE e.location_id = ? AND e.nfe_entrada_id IS NULL AND e.categoria NOT IN (${CATEGORIAS_FORA_DO_DRE.map(() => '?').join(',')}, 'impostos')
     GROUP BY centro, e.centro_custo_id, comp`
  ).all(locationId, ...CATEGORIAS_FORA_DO_DRE);
  const centros = new Map();
  for (const l of linhas) {
    if (!lista.includes(l.comp)) continue;
    const c = centros.get(l.centro) || { centro: l.centro, centroCustoId: l.centro_custo_id, meses: Object.fromEntries(lista.map((m) => [m, 0])), total: 0 };
    c.meses[l.comp] = Math.round((c.meses[l.comp] + l.total) * 100) / 100;
    c.total = Math.round((c.total + l.total) * 100) / 100;
    centros.set(l.centro, c);
  }
  return { ok: true, competencias: lista, centros: [...centros.values()].sort((a, b) => b.total - a.total) };
}

module.exports = { listar, salvar, definirAtivo, atribuir, despesasPorCentro };
