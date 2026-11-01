const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Painel executivo (ERP, Fase 7): os números que o dono olha primeiro, com
 * comparação com o período anterior, curva ABC, estoque parado, clientes
 * que mais dão lucro e alertas que juntam todos os módulos. Tudo calculado
 * na hora a partir das tabelas de sempre (nada duplicado).
 */

const arred = (v, c = 2) => { const f = 10 ** c; return Math.round((Number(v) + Number.EPSILON) * f) / f; };
const ehData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dataLocal(utc) {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}
const variacao = (atual, anterior) => (anterior > 0 ? arred(((atual - anterior) / anterior) * 100, 1) : null);

function metricas(db, locationId, de, ate) {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const v = db.prepare(
    `SELECT COUNT(*) AS vendas, COALESCE(SUM((total - desconto - desconto_gerente) * (1 + taxa_servico_percentual / 100.0)), 0) AS faturamento
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);
  const cmv = db.prepare(
    `SELECT COALESCE(SUM(si.quantidade * COALESCE(si.custo_unitario, p.custo, 0)), 0) AS total, COALESCE(SUM(si.quantidade), 0) AS itens
     FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 AND s.finalizada_em >= ? AND s.finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);
  const devolucoes = db.prepare('SELECT COALESCE(SUM(valor_devolvido), 0) AS t FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ?')
    .get(locationId, inicioUtc, fimUtcExclusivo).t;
  const despesas = db.prepare(
    `SELECT COALESCE(SUM(valor), 0) AS t FROM expenses WHERE location_id = ? AND nfe_entrada_id IS NULL
       AND categoria NOT IN ('fornecedor', 'retirada_socio') AND data_pagamento >= ? AND data_pagamento < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).t;
  const faturamento = arred(v.faturamento - devolucoes);
  const lucroBruto = arred(faturamento - cmv.total);
  return {
    vendas: v.vendas, faturamento, devolucoes: arred(devolucoes), ticketMedio: v.vendas ? arred(v.faturamento / v.vendas) : 0,
    itens: arred(cmv.itens, 3), cmv: arred(cmv.total), lucroBruto, margemBruta: faturamento > 0 ? arred((lucroBruto / faturamento) * 100, 1) : null,
    despesasPagas: arred(despesas), resultadoCaixa: arred(lucroBruto - despesas),
  };
}

function curvaAbc(db, locationId, de, ate) {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const linhas = db.prepare(
    `SELECT p.id, p.nome, p.estoque_minimo, SUM(si.quantidade) AS qtd, SUM(si.quantidade * si.preco_unitario) AS receita,
       SUM(si.quantidade * (si.preco_unitario - COALESCE(si.custo_unitario, p.custo, 0))) AS lucro
     FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY p.id ORDER BY receita DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const total = linhas.reduce((s, l) => s + l.receita, 0);
  let acumulado = 0;
  return linhas.map((l) => {
    acumulado += l.receita;
    const pct = total > 0 ? (acumulado / total) * 100 : 100;
    const anterior = total > 0 ? ((acumulado - l.receita) / total) * 100 : 0;
    return {
      productId: l.id, nome: l.nome, quantidade: arred(l.qtd, 3), receita: arred(l.receita), lucro: arred(l.lucro),
      margem: l.receita > 0 ? arred((l.lucro / l.receita) * 100, 1) : null, participacao: total > 0 ? arred((l.receita / total) * 100, 1) : 0,
      classe: anterior < 80 ? 'A' : anterior < 95 ? 'B' : 'C', acumulado: arred(pct, 1), estoqueMinimo: l.estoque_minimo,
    };
  });
}

function estoqueAtual(db, locationId) {
  return new Map(db.prepare('SELECT product_id, SUM(quantidade) AS q FROM stock_movements WHERE location_id = ? GROUP BY product_id').all(locationId).map((r) => [r.product_id, r.q]));
}

function estoqueParado(db, locationId, { dias = 60, estoque } = {}) {
  const hoje = timeService.hojeLocalISO();
  const ultimas = new Map(db.prepare(
    `SELECT si.product_id, MAX(s.finalizada_em) AS ultima FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 GROUP BY si.product_id`
  ).all(locationId).map((r) => [r.product_id, r.ultima]));
  const produtos = db.prepare("SELECT id, nome, custo, criado_em FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') = 'produto'").all();
  const lista = [];
  for (const p of produtos) {
    const q = estoque.get(p.id) || 0;
    if (q <= 0) continue;
    const ultima = ultimas.get(p.id) ? dataLocal(ultimas.get(p.id)) : null;
    const desde = ultima || dataLocal(p.criado_em);
    const parado = diasEntre(desde, hoje);
    if (parado < dias) continue;
    lista.push({ productId: p.id, nome: p.nome, estoque: arred(q, 3), custo: p.custo, valorParado: arred(q * (p.custo || 0)), ultimaVenda: ultima, diasParado: parado });
  }
  return lista.sort((a, b) => b.valorParado - a.valorParado);
}

function clientesRentaveis(db, locationId, de, ate, limite = 10) {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  return db.prepare(
    `SELECT c.id, c.nome, COUNT(DISTINCT s.id) AS compras, SUM(si.quantidade * si.preco_unitario) AS receita,
       SUM(si.quantidade * (si.preco_unitario - COALESCE(si.custo_unitario, p.custo, 0))) AS lucro
     FROM sales s JOIN customers c ON c.id = s.customer_id JOIN sale_items si ON si.sale_id = s.id JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY c.id ORDER BY lucro DESC LIMIT ?`
  ).all(locationId, inicioUtc, fimUtcExclusivo, limite).map((c) => ({ customerId: c.id, nome: c.nome, compras: c.compras, receita: arred(c.receita), lucro: arred(c.lucro) }));
}

function despesasAnormais(db, locationId, hoje) {
  const mes = hoje.slice(0, 7);
  const meses = [1, 2, 3].map((n) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m - 1 - n, 1)).toISOString().slice(0, 7); });
  const porCat = db.prepare(
    `SELECT categoria, COALESCE(competencia, substr(data_vencimento, 1, 7), strftime('%Y-%m', data_pagamento, '-3 hours'), strftime('%Y-%m', criado_em, '-3 hours')) AS comp, SUM(valor) AS t
     FROM expenses WHERE location_id = ? AND nfe_entrada_id IS NULL AND categoria NOT IN ('fornecedor', 'retirada_socio') GROUP BY categoria, comp`
  ).all(locationId);
  const alertas = [];
  const categorias = [...new Set(porCat.map((r) => r.categoria))];
  for (const cat of categorias) {
    const atual = porCat.find((r) => r.categoria === cat && r.comp === mes)?.t || 0;
    const historico = meses.map((m) => porCat.find((r) => r.categoria === cat && r.comp === m)?.t || 0);
    const media = historico.reduce((s, x) => s + x, 0) / 3;
    if (historico.filter((x) => x > 0).length >= 2 && atual > media * 1.5 && atual - media > 100) {
      alertas.push({ categoria: cat, atual: arred(atual), media: arred(media) });
    }
  }
  return alertas;
}

function painel({ locationId, dataInicio, dataFim } = {}) {
  const hoje = timeService.hojeLocalISO();
  const ate = ehData(dataFim) ? dataFim : hoje;
  const de = ehData(dataInicio) ? dataInicio : `${ate.slice(0, 7)}-01`;
  if (de > ate || diasEntre(de, ate) > 366) return { ok: false, error: 'Período inválido (até 1 ano).' };
  const db = getDb();
  const dias = diasEntre(de, ate) + 1;
  const antAte = somarDias(de, -1);
  const antDe = somarDias(antAte, -(dias - 1));
  const atual = metricas(db, locationId, de, ate);
  const anterior = metricas(db, locationId, antDe, antAte);

  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const porDia = new Map();
  for (const s of db.prepare(
    `SELECT finalizada_em, (total - desconto - desconto_gerente) * (1 + taxa_servico_percentual / 100.0) AS v FROM sales
     WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).all(locationId, inicioUtc, fimUtcExclusivo)) {
    const d = dataLocal(s.finalizada_em);
    porDia.set(d, arred((porDia.get(d) || 0) + s.v));
  }
  const serie = [];
  for (let d = de; d <= ate; d = somarDias(d, 1)) serie.push({ data: d, valor: porDia.get(d) || 0 });

  const abc = curvaAbc(db, locationId, de, ate);
  const estoque = estoqueAtual(db, locationId);
  const parado = estoqueParado(db, locationId, { estoque });
  const ruptura = abc.filter((p) => p.classe === 'A' && (estoque.get(p.productId) || 0) <= (p.estoqueMinimo || 0))
    .map((p) => ({ productId: p.productId, nome: p.nome, estoque: arred(estoque.get(p.productId) || 0, 3) }));

  // Projeção do mês corrente pelo ritmo dos dias já fechados.
  const mesAtual = hoje.slice(0, 7);
  const [a, m] = mesAtual.split('-').map(Number);
  const diasNoMes = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const doMes = metricas(db, locationId, `${mesAtual}-01`, hoje);
  const diaHoje = Number(hoje.slice(8, 10));
  const projecaoMes = diaHoje > 1 ? arred((doMes.faturamento / diaHoje) * diasNoMes) : null;

  const alertas = [];
  const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  for (const d of despesasAnormais(db, locationId, hoje)) {
    alertas.push({ nivel: 'aviso', area: 'financeiro', texto: `Despesa de "${d.categoria}" neste mês (${brl(d.atual)}) está bem acima da média dos 3 meses anteriores (${brl(d.media)}).` });
  }
  const cobranca = require('./cobrancaService').relatorio({});
  if (cobranca.totalVencido > 0) alertas.push({ nivel: 'aviso', area: 'financeiro', texto: `${brl(cobranca.totalVencido)} vencidos com clientes (fiado e contas a receber).` });
  const valorParado = arred(parado.reduce((s, p) => s + p.valorParado, 0));
  if (valorParado > 0) alertas.push({ nivel: 'info', area: 'estoque', texto: `${parado.length} produto(s) sem venda há 60+ dias: ${brl(valorParado)} parados no estoque.` });
  if (ruptura.length) alertas.push({ nivel: 'critico', area: 'estoque', texto: `${ruptura.length} produto(s) da curva A no estoque mínimo ou zerado: ${ruptura.slice(0, 3).map((r) => r.nome).join(', ')}${ruptura.length > 3 ? '...' : ''}.` });
  const pendentesExtrato = db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE status = 'pendente'").get().n;
  if (pendentesExtrato) alertas.push({ nivel: 'info', area: 'financeiro', texto: `${pendentesExtrato} lançamento(s) do extrato bancário sem conciliar.` });
  const fiscal = require('./assistenteFiscalService').diagnosticoCadastro({ limite: 0, apenasContagem: true });
  if (fiscal.comProblema) alertas.push({ nivel: 'aviso', area: 'fiscal', texto: `${fiscal.comProblema} produto(s) com cadastro fiscal incompleto (risco de rejeição da NFC-e).` });
  const certificado = require('./assistenteFiscalService').avisoCertificado();
  if (certificado) alertas.push({ ...certificado, area: 'fiscal' });
  for (const a2 of require('./rhService').listar({}).alertas.filter((x) => x.nivel !== 'info')) alertas.push({ ...a2, area: 'equipe' });
  if (atual.margemBruta !== null && anterior.margemBruta !== null && atual.margemBruta < anterior.margemBruta - 5) {
    alertas.push({ nivel: 'aviso', area: 'vendas', texto: `Margem bruta caiu de ${anterior.margemBruta}% para ${atual.margemBruta}% em relação ao período anterior.` });
  }

  return {
    ok: true, de, ate, anteriorDe: antDe, anteriorAte: antAte, atual, anterior,
    variacao: {
      faturamento: variacao(atual.faturamento, anterior.faturamento), vendas: variacao(atual.vendas, anterior.vendas),
      ticketMedio: variacao(atual.ticketMedio, anterior.ticketMedio), lucroBruto: variacao(atual.lucroBruto, anterior.lucroBruto),
    },
    serie, projecaoMes, mesAtual,
    abc: abc.slice(0, 50), abcResumo: ['A', 'B', 'C'].map((c) => ({ classe: c, produtos: abc.filter((p) => p.classe === c).length, receita: arred(abc.filter((p) => p.classe === c).reduce((s, p) => s + p.receita, 0)) })),
    estoqueParado: parado.slice(0, 20), valorParado, ruptura, clientes: clientesRentaveis(db, locationId, de, ate),
    alertas: alertas.sort((x, y) => ['critico', 'aviso', 'info'].indexOf(x.nivel) - ['critico', 'aviso', 'info'].indexOf(y.nivel)),
  };
}

module.exports = { painel, curvaAbc, estoqueParado, metricas };
