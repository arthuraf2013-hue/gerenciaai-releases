const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Comissões e metas (ERP, comercial). Vendedor = usuário que registrou a
 * venda (sales.operador_id). Base da comissão = venda líquida do vendedor no
 * período: total − descontos (sem a taxa de serviço, que é do garçom/casa)
 * − devoluções das vendas dele feitas no período. Meta é por mês, da loja
 * (sem usuário) ou de cada vendedor.
 */

const arred = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const ehCompetencia = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(c || '');
const ehData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function ultimoDia(comp) {
  const [a, m] = comp.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

function regras() {
  return getDb().prepare(
    `SELECT u.id AS userId, u.nome, u.role, u.ativo, cr.percentual FROM users u LEFT JOIN commission_rules cr ON cr.user_id = u.id
     WHERE u.role != 'suporte' ORDER BY u.ativo DESC, u.nome`
  ).all();
}

function salvarRegra({ userId, percentual } = {}) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return { ok: false, error: 'Usuário não encontrado.' };
  if (percentual === null || percentual === '' || percentual === undefined) {
    db.prepare('DELETE FROM commission_rules WHERE user_id = ?').run(userId);
    return { ok: true };
  }
  const p = Number(percentual);
  if (!Number.isFinite(p) || p < 0 || p > 100) return { ok: false, error: 'Percentual entre 0 e 100.' };
  db.prepare('INSERT INTO commission_rules (user_id, percentual) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET percentual = excluded.percentual').run(userId, p);
  return { ok: true };
}

function salvarMeta({ competencia, userId, valor } = {}) {
  const db = getDb();
  if (!ehCompetencia(competencia)) return { ok: false, error: 'Mês inválido.' };
  if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return { ok: false, error: 'Usuário não encontrado.' };
  const existente = db.prepare("SELECT id FROM sales_goals WHERE competencia = ? AND COALESCE(user_id, '') = COALESCE(?, '')").get(competencia, userId || null);
  if (valor === null || valor === '' || valor === undefined) {
    if (existente) db.prepare('DELETE FROM sales_goals WHERE id = ?').run(existente.id);
    return { ok: true };
  }
  const v = Number(valor);
  if (!(v > 0)) return { ok: false, error: 'Meta precisa ser maior que zero.' };
  if (existente) db.prepare('UPDATE sales_goals SET valor = ? WHERE id = ?').run(arred(v), existente.id);
  else db.prepare('INSERT INTO sales_goals (id, competencia, user_id, valor) VALUES (?, ?, ?, ?)').run(randomUUID(), competencia, userId || null, arred(v));
  return { ok: true };
}

function vendasPorVendedor(db, locationId, de, ate) {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const vendas = db.prepare(
    `SELECT s.operador_id, COUNT(*) AS qtd, COALESCE(SUM(s.total - s.desconto - s.desconto_gerente), 0) AS liquido
     FROM sales s WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY s.operador_id`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const devolucoes = db.prepare(
    `SELECT s.operador_id, COALESCE(SUM(r.valor_devolvido), 0) AS total FROM returns r JOIN sales s ON s.id = r.sale_id
     WHERE r.location_id = ? AND r.criado_em >= ? AND r.criado_em < ? GROUP BY s.operador_id`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const dev = Object.fromEntries(devolucoes.map((d) => [d.operador_id, d.total]));
  return vendas.map((v) => ({ userId: v.operador_id, vendas: v.qtd, bruto: arred(v.liquido), devolucoes: arred(dev[v.operador_id] || 0), base: arred(v.liquido - (dev[v.operador_id] || 0)) }));
}

/** Relatório do mês: venda, comissão e meta por vendedor + meta da loja com projeção. */
function relatorio({ locationId, competencia } = {}) {
  if (!ehCompetencia(competencia)) return { ok: false, error: 'Mês inválido.' };
  const db = getDb();
  const de = `${competencia}-01`;
  const ate = `${competencia}-${String(ultimoDia(competencia)).padStart(2, '0')}`;
  const hoje = timeService.hojeLocalISO();
  const fimEfetivo = ate < hoje ? ate : hoje;
  const regrasPorUsuario = Object.fromEntries(regras().map((r) => [r.userId, r]));
  const metas = db.prepare('SELECT user_id, valor FROM sales_goals WHERE competencia = ?').all(competencia);
  const metaDe = (uid) => metas.find((m) => (m.user_id || null) === (uid || null))?.valor ?? null;
  const diasTotais = ultimoDia(competencia);
  const diasCorridos = de > hoje ? 0 : Math.min(diasTotais, Number(fimEfetivo.slice(8, 10)));
  const projetar = (v) => (diasCorridos > 0 && diasCorridos < diasTotais ? arred((v / diasCorridos) * diasTotais) : v);

  const vendedores = vendasPorVendedor(db, locationId, de, ate).map((v) => {
    const regra = regrasPorUsuario[v.userId];
    const percentual = regra?.percentual ?? null;
    const meta = metaDe(v.userId);
    return {
      ...v, nome: regra?.nome || '(usuário removido)', percentual,
      comissao: percentual === null ? null : arred(Math.max(0, v.base) * percentual / 100),
      meta, atingido: meta ? arred((v.base / meta) * 100) : null, projecao: projetar(v.base),
    };
  });
  for (const m of metas.filter((x) => x.user_id && !vendedores.some((v) => v.userId === x.user_id))) {
    const regra = regrasPorUsuario[m.user_id];
    vendedores.push({ userId: m.user_id, nome: regra?.nome || '?', vendas: 0, bruto: 0, devolucoes: 0, base: 0, percentual: regra?.percentual ?? null, comissao: regra?.percentual != null ? 0 : null, meta: m.valor, atingido: 0, projecao: 0 });
  }
  vendedores.sort((a, b) => b.base - a.base);
  const totalLoja = arred(vendedores.reduce((s, v) => s + v.base, 0));
  const metaLoja = metaDe(null);
  return {
    ok: true, competencia, diasCorridos, diasTotais,
    loja: { base: totalLoja, meta: metaLoja, atingido: metaLoja ? arred((totalLoja / metaLoja) * 100) : null, projecao: projetar(totalLoja) },
    totalComissoes: arred(vendedores.reduce((s, v) => s + (v.comissao || 0), 0)),
    vendedores,
  };
}

module.exports = { regras, salvarRegra, salvarMeta, relatorio };
