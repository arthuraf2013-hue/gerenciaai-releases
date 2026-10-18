const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Todas as consultas deste arquivo filtram por um intervalo de datas
 * LOCAIS (Brasil). Antes, cada uma embrulhava a coluna em
 * `date(col, '-3 hours')` pra comparar com o intervalo pedido — o que
 * IMPEDE o SQLite de usar qualquer índice na coluna (a função esconde a
 * coluna original), forçando escanear TODA a tabela de vendas do local
 * toda vez que o Dashboard abre. Convertendo o INTERVALO pedido pros
 * limites UTC equivalentes (uma vez, em JS) em vez de converter a
 * coluna (linha por linha, no SQLite), o filtro fica sargable — ver
 * timeService.localDateRangeToUtcBounds pra mais detalhes e os índices
 * idx_sales_location_status_finalizada / idx_sales_location_data_efetiva
 * em schema.sql.
 */
function getSummary({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);

  const totais = db.prepare(
    `SELECT COUNT(*) as totalVendas, COALESCE(SUM(total - desconto - desconto_gerente), 0) as totalFaturado
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);

  // O GROUP BY continua precisando do `date(finalizada_em, '-3 hours')`
  // como RÓTULO de cada dia (isso é exibição, não filtro) — só o WHERE
  // que precisava ficar sargable.
  const vendasPorDia = db.prepare(
    `SELECT date(finalizada_em, '-3 hours') as dia, COALESCE(SUM(total - desconto - desconto_gerente), 0) as total
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?
     GROUP BY dia ORDER BY dia`
  ).all(locationId, inicioUtc, fimUtcExclusivo);

  const topProdutos = db.prepare(
    `SELECT p.nome, p.unidade, SUM(si.quantidade) as quantidade, SUM(si.quantidade * si.preco_unitario) as valorTotal
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY si.product_id
     ORDER BY quantidade DESC
     LIMIT 8`
  ).all(locationId, inicioUtc, fimUtcExclusivo);

  const devolucoes = db.prepare(
    `SELECT COUNT(*) as total, COALESCE(SUM(valor_devolvido), 0) as valor
     FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);

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
       AND s.finalizada_em >= ? AND s.finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);

  const margemPorProduto = db.prepare(
    `SELECT p.nome,
       SUM(si.quantidade) as quantidade,
       SUM(si.quantidade * si.preco_unitario) as valorVendido,
       SUM(si.quantidade * p.custo) as custoEstimado
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY si.product_id
     HAVING valorVendido > 0
     ORDER BY (valorVendido - custoEstimado) DESC
     LIMIT 8`
  ).all(locationId, inicioUtc, fimUtcExclusivo);

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
       AND (ultima_venda_em IS NULL OR ultima_venda_em < ?)
     ORDER BY ultima_venda_em ASC NULLS FIRST, p.nome`
  ).all(locationId, timeService.utcSqlAtras({ dias: Number(dias) || 0 }));
}

/** Total vendido por operador num período — pra calcular comissão ou
 * gorjeta. Só conta vendas finalizadas (não abertas nem canceladas). */
function getSalesByOperator({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  return db.prepare(
    `SELECT u.nome as operador, COUNT(*) as total_vendas, COALESCE(SUM(s.total), 0) as total_vendido
     FROM sales s JOIN users u ON u.id = s.operador_id
     WHERE s.location_id = ? AND s.status = 'finalizada'
       AND COALESCE(s.finalizada_em, s.criado_em) >= ? AND COALESCE(s.finalizada_em, s.criado_em) < ?
     GROUP BY s.operador_id ORDER BY total_vendido DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
}

/**
 * Relatório de produtos por período — nome, quantidade vendida,
 * receita, custo e lucro — e o horário do dia com mais vendas.
 * Só pra exibir na tela (nada de arquivo) — pedido explícito de poder
 * ver isso rápido sem precisar exportar planilha nenhuma.
 */
function getRelatorioProdutos({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);

  const produtos = db.prepare(
    `SELECT p.nome, p.categoria,
       SUM(si.quantidade) as quantidade,
       SUM(si.quantidade * si.preco_unitario) as receita,
       SUM(si.quantidade * COALESCE(p.custo, 0)) as custo_total,
       SUM(si.quantidade * si.preco_unitario) - SUM(si.quantidade * COALESCE(p.custo, 0)) as lucro,
       MAX(COALESCE(s.finalizada_em, s.criado_em)) as ultima_venda
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND COALESCE(s.finalizada_em, s.criado_em) >= ? AND COALESCE(s.finalizada_em, s.criado_em) < ?
     GROUP BY p.id
     ORDER BY lucro DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);

  // Horário de maior movimento — calculado no fuso de São Paulo
  // (mesmo padrão usado em todo o resto do app pra exibir horário),
  // não no fuso da máquina que roda o processo principal.
  const timestampsBrutos = db.prepare(
    `SELECT COALESCE(finalizada_em, criado_em) as quando FROM sales
     WHERE location_id = ? AND status = 'finalizada'
       AND COALESCE(finalizada_em, criado_em) >= ? AND COALESCE(finalizada_em, criado_em) < ?`
  ).all(locationId, inicioUtc, fimUtcExclusivo);

  const contagemPorHora = new Array(24).fill(0);
  const formatador = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });
  for (const row of timestampsBrutos) {
    const data = new Date(row.quando.includes('Z') ? row.quando : row.quando + 'Z');
    if (isNaN(data.getTime())) continue;
    const hora = Number(formatador.format(data)) % 24;
    contagemPorHora[hora]++;
  }
  const totalVendasNoPeriodo = timestampsBrutos.length;
  const horaDeMaiorMovimento = totalVendasNoPeriodo > 0 ? contagemPorHora.indexOf(Math.max(...contagemPorHora)) : null;

  return {
    produtos,
    horariosPorMovimento: contagemPorHora.map((qtd, hora) => ({ hora, quantidade: qtd })),
    horaDeMaiorMovimento,
    totalVendasNoPeriodo,
  };
}

/**
 * Resultado simples do período: receita (vendas finalizadas) menos
 * custo dos produtos vendidos (custo ATUAL de cadastro, mesma
 * limitação de getRelatorioProdutos) menos despesas lançadas no
 * mesmo período. Não é uma DRE contábil de verdade — não considera
 * impostos, depreciação, etc — é uma visão rápida de "como está indo
 * o negócio", pensada pra quem não tem contador acompanhando dia a
 * dia.
 */
function getResultadoSimples({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);

  const receita = db.prepare(
    `SELECT COALESCE(SUM(total - desconto - desconto_gerente), 0) as total
     FROM sales WHERE location_id = ? AND status = 'finalizada'
       AND finalizada_em >= ? AND finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).total;

  const custoProdutos = db.prepare(
    `SELECT COALESCE(SUM(si.quantidade * COALESCE(p.custo, 0)), 0) as total
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND s.finalizada_em >= ? AND s.finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).total;

  const despesas = db.prepare(
    `SELECT COALESCE(SUM(valor), 0) as total FROM expenses
     WHERE location_id = ? AND criado_em >= ? AND criado_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).total;

  const despesasPorCategoria = db.prepare(
    `SELECT categoria, COALESCE(SUM(valor), 0) as total FROM expenses
     WHERE location_id = ? AND criado_em >= ? AND criado_em < ?
     GROUP BY categoria ORDER BY total DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);

  return {
    receita, custoProdutos, despesas,
    lucroBruto: receita - custoProdutos,
    resultado: receita - custoProdutos - despesas,
    despesasPorCategoria,
  };
}

// ------------------------------------------------------------------
// "Por que o resultado mudou": período pedido x o período anterior de
// mesmo tamanho. Decomposição EXATA (as parcelas somam a variação):
//   faturado = bruto - descontos;  bruto = vendas x ticket bruto
//   Δfaturado = (Δvendas x ticket bruto anterior)     -> movimento
//             + (Δticket bruto x vendas atuais)       -> ticket
//             - Δdescontos                            -> descontos
// Sem IA: os números são calculados aqui; o texto só os descreve.
// ------------------------------------------------------------------
const FAIXAS = [
  { id: 'madrugada', rotulo: 'de madrugada', de: 0, ate: 6 },
  { id: 'manha', rotulo: 'de manhã', de: 6, ate: 12 },
  { id: 'tarde', rotulo: 'à tarde', de: 12, ate: 18 },
  { id: 'noite', rotulo: 'à noite', de: 18, ate: 24 },
];

function somarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function numerosDoPeriodo(db, locationId, dataInicio, dataFim) {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  const t = db.prepare(
    `SELECT COUNT(*) AS vendas, COALESCE(SUM(total), 0) AS bruto, COALESCE(SUM(desconto + desconto_gerente), 0) AS descontos
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);
  const porFaixa = Object.fromEntries(FAIXAS.map((f) => [f.id, 0]));
  for (const l of db.prepare(
    `SELECT CAST(strftime('%H', finalizada_em, '-3 hours') AS INTEGER) AS hora, SUM(total - desconto - desconto_gerente) AS valor
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?
     GROUP BY hora`
  ).all(locationId, inicioUtc, fimUtcExclusivo)) {
    const faixa = FAIXAS.find((f) => l.hora >= f.de && l.hora < f.ate);
    if (faixa) porFaixa[faixa.id] += l.valor;
  }
  const produtos = new Map(db.prepare(
    `SELECT si.product_id AS id, p.nome, SUM(si.quantidade * si.preco_unitario) AS valor
     FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY si.product_id`
  ).all(locationId, inicioUtc, fimUtcExclusivo).map((p) => [p.id, p]));
  const canceladas = db.prepare(
    `SELECT COUNT(*) AS c FROM sales WHERE location_id = ? AND status = 'cancelada' AND cancelada_em >= ? AND cancelada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).c;
  const devolvido = db.prepare(
    `SELECT COALESCE(SUM(valor_devolvido), 0) AS v FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).v;
  const faturado = t.bruto - t.descontos;
  return { ...t, faturado, ticketBruto: t.vendas ? t.bruto / t.vendas : 0, porFaixa, produtos, canceladas, devolvido };
}

const brl = (v) => `R$ ${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function explicarVariacao({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  const dias = Math.round((new Date(`${dataFim}T12:00:00Z`) - new Date(`${dataInicio}T12:00:00Z`)) / 86400000) + 1;
  const antInicio = somarDias(dataInicio, -dias);
  const antFim = somarDias(dataInicio, -1);
  const atual = numerosDoPeriodo(db, locationId, dataInicio, dataFim);
  const ant = numerosDoPeriodo(db, locationId, antInicio, antFim);

  const variacao = atual.faturado - ant.faturado;
  const efeitos = {
    movimento: (atual.vendas - ant.vendas) * ant.ticketBruto,
    ticket: (atual.ticketBruto - ant.ticketBruto) * atual.vendas,
    descontos: -(atual.descontos - ant.descontos),
  };
  const faixas = FAIXAS.map((f) => ({ id: f.id, rotulo: f.rotulo, variacao: atual.porFaixa[f.id] - ant.porFaixa[f.id] }))
    .filter((f) => Math.abs(f.variacao) >= 0.01).sort((a, b) => a.variacao - b.variacao);
  const ids = new Set([...atual.produtos.keys(), ...ant.produtos.keys()]);
  const produtos = [...ids].map((id) => ({
    id, nome: (atual.produtos.get(id) || ant.produtos.get(id)).nome,
    variacao: (atual.produtos.get(id)?.valor || 0) - (ant.produtos.get(id)?.valor || 0),
  })).filter((p) => Math.abs(p.variacao) >= 0.01).sort((a, b) => a.variacao - b.variacao);

  const frases = [];
  if (ant.vendas === 0 && atual.vendas === 0) {
    frases.push('Sem vendas nos dois períodos.');
  } else {
    const pct = ant.faturado ? (variacao / ant.faturado) * 100 : null;
    frases.push(`Faturamento ${variacao >= 0 ? 'subiu' : 'caiu'} ${brl(variacao)}${pct == null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1).replace('.', ',')}%)`} em relação aos ${dias} dias anteriores.`);
    const ordem = Object.entries(efeitos).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [nome, v] of ordem) {
      if (Math.abs(v) < 0.005 * Math.max(1, Math.abs(ant.faturado))) continue;
      if (nome === 'movimento') frases.push(`${v >= 0 ? '+' : '−'}${brl(v)} por ${atual.vendas >= ant.vendas ? 'mais' : 'menos'} vendas (${ant.vendas} → ${atual.vendas}).`);
      if (nome === 'ticket') frases.push(`${v >= 0 ? '+' : '−'}${brl(v)} pelo ticket médio ${atual.ticketBruto >= ant.ticketBruto ? 'maior' : 'menor'} (${brl(ant.ticketBruto)} → ${brl(atual.ticketBruto)}).`);
      if (nome === 'descontos') frases.push(`${v >= 0 ? '+' : '−'}${brl(v)} por ${v >= 0 ? 'menos' : 'mais'} desconto dado (${brl(ant.descontos)} → ${brl(atual.descontos)}).`);
    }
    const piorFaixa = faixas[0];
    if (variacao < 0 && piorFaixa && piorFaixa.variacao < 0) frases.push(`A maior queda foi ${piorFaixa.rotulo} (−${brl(piorFaixa.variacao)}).`);
    const melhorFaixa = faixas[faixas.length - 1];
    if (variacao > 0 && melhorFaixa && melhorFaixa.variacao > 0) frases.push(`O maior ganho foi ${melhorFaixa.rotulo} (+${brl(melhorFaixa.variacao)}).`);
    const piores = produtos.filter((p) => p.variacao < 0).slice(0, 3);
    if (piores.length) frases.push(`Venderam menos: ${piores.map((p) => `${p.nome} (−${brl(p.variacao)})`).join(', ')}.`);
    if (atual.canceladas > ant.canceladas + 2) frases.push(`Vendas canceladas subiram de ${ant.canceladas} para ${atual.canceladas} — vale olhar a Auditoria.`);
    if (atual.devolvido > ant.devolvido * 1.5 && atual.devolvido - ant.devolvido > 50) frases.push(`Devoluções subiram de ${brl(ant.devolvido)} para ${brl(atual.devolvido)}.`);
  }

  return {
    periodo: { dataInicio, dataFim }, anterior: { dataInicio: antInicio, dataFim: antFim },
    atual: { faturado: atual.faturado, vendas: atual.vendas, ticketBruto: atual.ticketBruto, descontos: atual.descontos, canceladas: atual.canceladas, devolvido: atual.devolvido },
    anteriorNumeros: { faturado: ant.faturado, vendas: ant.vendas, ticketBruto: ant.ticketBruto, descontos: ant.descontos, canceladas: ant.canceladas, devolvido: ant.devolvido },
    variacao, efeitos, faixas, produtosQueCairam: produtos.filter((p) => p.variacao < 0).slice(0, 5),
    produtosQueSubiram: produtos.filter((p) => p.variacao > 0).reverse().slice(0, 5), frases,
  };
}

module.exports = { getSummary, listStaleProducts, getSalesByOperator, getRelatorioProdutos, getResultadoSimples, explicarVariacao };
