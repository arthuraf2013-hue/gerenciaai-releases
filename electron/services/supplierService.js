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
    `INSERT INTO suppliers (id, nome, cnpj_cpf, telefone, email, prazo_entrega_dias) VALUES (@id, @nome, @cnpjCpf, @telefone, @email, @prazo)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, cnpj_cpf=excluded.cnpj_cpf, telefone=excluded.telefone, email=excluded.email,
       prazo_entrega_dias=excluded.prazo_entrega_dias`
  ).run({
    id, nome: supplier.nome.trim(), cnpjCpf: supplier.cnpjCpf || null, telefone: supplier.telefone || null, email: supplier.email || null,
    prazo: Number.isFinite(Number(supplier.prazoEntregaDias)) && supplier.prazoEntregaDias !== '' && supplier.prazoEntregaDias != null
      ? Math.max(0, Math.min(120, Math.round(Number(supplier.prazoEntregaDias)))) : null,
  });
  return { ok: true, id };
}

const JANELA_DIAS = 56; // 8 semanas: dá 8 amostras de cada dia da semana
const CICLO_DIAS = 30;   // mesma cobertura de antes: comprar pra ~30 dias

/**
 * Demanda diária prevista de UM produto a partir do histórico diário.
 * Sem IA, mas sem os dois erros da média simples de antes:
 *  - dia em que o produto estava ZERADO não conta como "vendeu 0" (puxava
 *    a média pra baixo e o sistema sugeria comprar menos justamente do
 *    que mais falta);
 *  - dia da semana pesa (padaria vende mais no domingo, bar na sexta),
 *    quando há amostras suficientes daquele dia.
 * @param {{dia: string, vendido: number, saldo: number}[]} dias  um item por
 *   dia da janela, do mais antigo pro mais novo; `saldo` = estoque no FIM do dia.
 * @returns {{diaria: number, diasComEstoque: number, diasZerado: number, porDiaDaSemana: number[]}}
 */
function preverDemandaDiaria(dias) {
  const somaDow = Array(7).fill(0);
  const nDow = Array(7).fill(0);
  let total = 0;
  let disponiveis = 0;
  let zerados = 0;
  for (let i = 0; i < dias.length; i += 1) {
    const d = dias[i];
    const saldoInicio = d.saldo + d.vendido; // antes das vendas do dia (aprox.: ignora entradas do dia)
    const tinhaEstoque = d.vendido > 0 || saldoInicio > 0;
    if (!tinhaEstoque) { zerados += 1; continue; }
    const dow = new Date(`${d.dia}T12:00:00Z`).getUTCDay();
    somaDow[dow] += d.vendido; nDow[dow] += 1;
    total += d.vendido; disponiveis += 1;
  }
  const media = disponiveis ? total / disponiveis : 0;
  const porDiaDaSemana = somaDow.map((s, i) => (nDow[i] >= 2 ? s / nDow[i] : media));
  return { diaria: media, diasComEstoque: disponiveis, diasZerado: zerados, porDiaDaSemana };
}

/** Quanto deve vender nos próximos N dias, respeitando o dia da semana. */
function demandaNosProximosDias(previsao, hojeISO, nDias) {
  let soma = 0;
  const base = new Date(`${hojeISO}T12:00:00Z`);
  for (let i = 1; i <= nDias; i += 1) {
    const d = new Date(base.getTime() + i * 86400000);
    soma += previsao.porDiaDaSemana[d.getUTCDay()];
  }
  return soma;
}

/**
 * Sugestão de reposição. Entra quem já está no mínimo OU vai chegar nele
 * antes da mercadoria chegar (prazo de entrega do fornecedor). Quantidade
 * = venda prevista no prazo + 30 dias, sem deixar de cobrir o mínimo.
 */
function suggestPurchases({ locationId }) {
  const db = getDb();
  const timeService = require('./timeService');
  const hoje = timeService.hojeLocalISO();
  // Estoque de todos numa consulta agregada só (uma subconsulta por
  // produto custava ~2 s numa loja de 8.000 produtos -- bench/medir.js).
  const estoque = new Map(db.prepare(
    'SELECT product_id, SUM(quantidade) AS total FROM stock_movements WHERE location_id = ? GROUP BY product_id'
  ).all(locationId).map((l) => [l.product_id, l.total]));
  const produtos = db.prepare(
    `SELECT p.id, p.sku, p.nome, p.estoque_minimo, p.fornecedor_id, s.nome as fornecedor_nome,
       COALESCE(s.prazo_entrega_dias, 0) as prazo_entrega_dias
     FROM products p
     LEFT JOIN suppliers s ON s.id = p.fornecedor_id
     WHERE p.ativo = 1 AND COALESCE(p.tipo, 'produto') != 'servico'`
  ).all().map((p) => ({ ...p, estoque_atual: estoque.get(p.id) || 0 }));
  if (produtos.length === 0) return [];

  // UMA consulta pro histórico de todos (antes: uma por produto).
  const porProduto = new Map();
  for (const l of db.prepare(
    `SELECT product_id, date(criado_em, '-3 hours') AS dia,
       SUM(CASE WHEN tipo = 'venda' THEN -quantidade ELSE 0 END) AS vendido,
       SUM(quantidade) AS liquido
     FROM stock_movements
     -- tipo IN (todos do CHECK) faz o SQLite usar o índice
     -- (location_id, tipo, criado_em) em vez de varrer o ano inteiro.
     WHERE location_id = ? AND tipo IN ('venda','entrada','ajuste','perda','estorno') AND criado_em >= ?
     GROUP BY product_id, dia`
  ).all(locationId, timeService.utcSqlAtras({ dias: JANELA_DIAS + 1 }))) {
    if (!porProduto.has(l.product_id)) porProduto.set(l.product_id, new Map());
    porProduto.get(l.product_id).set(l.dia, l);
  }

  // Janela termina ONTEM: hoje ainda está pela metade e contaria como dia
  // fraco de venda.
  const diasDaJanela = [];
  for (let i = JANELA_DIAS; i >= 1; i -= 1) {
    const d = new Date(new Date(`${hoje}T12:00:00Z`).getTime() - i * 86400000);
    diasDaJanela.push(d.toISOString().slice(0, 10));
  }

  const sugestoes = [];
  for (const p of produtos) {
    const mov = porProduto.get(p.id) || new Map();
    // Reconstrói o saldo no fim de cada dia andando pra trás a partir de hoje.
    const dias = [];
    let saldoFim = p.estoque_atual - (mov.get(hoje)?.liquido || 0); // saldo no fim de ontem
    for (let i = diasDaJanela.length - 1; i >= 0; i -= 1) {
      const dia = diasDaJanela[i];
      const m = mov.get(dia);
      dias.unshift({ dia, vendido: m ? Math.max(0, m.vendido) : 0, saldo: saldoFim });
      saldoFim -= m ? m.liquido : 0;
    }
    const previsao = preverDemandaDiaria(dias);
    const prazo = Math.max(0, Number(p.prazo_entrega_dias) || 0);
    const vendaNoPrazo = demandaNosProximosDias(previsao, hoje, prazo);
    const vaiFaltar = p.estoque_atual <= p.estoque_minimo || (p.estoque_atual - vendaNoPrazo) <= p.estoque_minimo;
    if (!vaiFaltar) continue;
    const vendaNaCobertura = demandaNosProximosDias(previsao, hoje, prazo + CICLO_DIAS);
    const sugestao = Math.max(p.estoque_minimo - p.estoque_atual, Math.ceil(vendaNaCobertura - p.estoque_atual));
    sugestoes.push({
      ...p,
      vendidoUltimos30Dias: dias.slice(-30).reduce((a, d) => a + d.vendido, 0),
      velocidadeDiaria: Number(previsao.diaria.toFixed(2)),
      diasZeradoNaJanela: previsao.diasZerado,
      quantidadeSugerida: Math.max(0, sugestao),
    });
  }
  return sugestoes.sort((a, b) => b.quantidadeSugerida - a.quantidadeSugerida);
}

/** A coluna 'ativo' sempre existiu no schema, mas nada em supplierService
 * a desligava -- um fornecedor descontinuado ficava pra sempre na lista
 * de cadastro, sem forma de sair de lá (auditoria, seção 3). Mesmo
 * padrão de "desativar" usado no resto do app (ex: productService,
 * ingredientService): nunca apaga a linha, só some da lista ativa --
 * produtos que já referenciam esse fornecedor continuam funcionando.
 */
function deactivate(id) {
  const db = getDb();
  db.prepare('UPDATE suppliers SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = { list, upsert, deactivate, suggestPurchases, preverDemandaDiaria, demandaNosProximosDias };
