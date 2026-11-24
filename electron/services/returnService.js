const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { authorizeManagerOverride } = require('./authService');
const timeService = require('./timeService');

/** Vendas finalizadas recentes (últimos 60 dias) — para localizar a venda a devolver. */
function findFinalizedSales({ locationId, query }) {
  const db = getDb();
  const base = `SELECT s.*, u.nome as operador_nome FROM sales s JOIN users u ON u.id = s.operador_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ?`;
  // Limite calculado em JS (ver timeService.utcSqlAtras) -- função JS
  // dentro do WHERE rodava a cada linha e não usava o índice.
  const desde = require('./timeService').utcSqlAtras({ dias: 60 });

  if (!query) {
    return db.prepare(`${base} ORDER BY s.finalizada_em DESC LIMIT 50`).all(locationId, desde);
  }

  // O filtro de busca precisa entrar ANTES do LIMIT 50, não depois --
  // antes disso, a busca só considerava as 50 vendas mais recentes já
  // cortadas pelo banco, então uma venda existente porém fora dessa
  // janela simplesmente "sumia" da busca (indistinguível de "não
  // existe" pra quem está tentando devolver). LIKE aqui é
  // case-insensitive só em ASCII, mesma limitação que o
  // .toLowerCase() em JS que isso substitui já tinha.
  const termo = `%${query}%`;
  return db.prepare(
    `${base} AND (s.id LIKE ? OR u.nome LIKE ?) ORDER BY s.finalizada_em DESC LIMIT 50`
  ).all(locationId, desde, termo, termo);
}

/**
 * Fator do que o cliente PAGOU por real de item: (líquido da venda) / (soma
 * dos itens). Venda com desconto: < 1; mesa com taxa de serviço: > 1. A
 * devolução usa isso para nunca devolver mais do que foi pago (antes
 * devolvia o preço cheio do item, mesmo com desconto na venda).
 */
function fatorPago(db, saleId) {
  const sale = db.prepare('SELECT total, desconto, desconto_gerente, taxa_servico_percentual FROM sales WHERE id = ?').get(saleId);
  const itens = db.prepare('SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS t FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).t;
  if (!sale || !(itens > 0)) return { fator: 1, liquido: 0 };
  const { liquido } = require('./valoresDaVenda').valoresDaVendaFinalizada(sale);
  return { fator: Math.max(0, liquido) / itens, liquido: Math.max(0, liquido) };
}

/** Quanto de cada produto já foi devolvido nesta venda. */
function devolvidoPorProduto(db, saleId) {
  return new Map(db.prepare(
    `SELECT ri.product_id, COALESCE(SUM(ri.quantidade), 0) AS q FROM return_items ri
     JOIN returns r ON r.id = ri.return_id WHERE r.sale_id = ? GROUP BY ri.product_id`
  ).all(saleId).map((r) => [r.product_id, r.q]));
}

function getSaleItemsForReturn(saleId) {
  const db = getDb();
  const linhas = db.prepare(
    `SELECT si.*, p.nome, p.unidade
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.rowid`
  ).all(saleId);
  // A devolução é guardada por produto: o mesmo produto em duas linhas
  // aparecia com o total devolvido repetido em cada uma (e a segunda linha
  // ficava sem poder devolver). Distribui o devolvido pelas linhas, na ordem.
  const resto = devolvidoPorProduto(db, saleId);
  const { fator } = fatorPago(db, saleId);
  return linhas.map((l) => {
    const sobra = resto.get(l.product_id) || 0;
    const naLinha = Math.min(sobra, l.quantidade);
    resto.set(l.product_id, sobra - naLinha);
    return { ...l, ja_devolvido: naLinha, valor_pago_unitario: Math.round(l.preco_unitario * fator * 100) / 100 };
  });
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
  const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!venda) return { ok: false, error: 'Venda não encontrada.' };
  if (venda.status !== 'finalizada') return { ok: false, error: 'Só dá para devolver itens de venda finalizada.' };

  // Confere por PRODUTO, somando todas as linhas dele na venda e tudo que
  // está sendo pedido agora (antes: a mesma linha repetida no pedido passava
  // do vendido, e a segunda linha do mesmo produto ficava travada).
  const pedidoPorProduto = new Map();
  for (const item of itens) {
    const qtd = Number(item.quantidade);
    if (!(qtd > 0)) return { ok: false, error: 'Quantidade a devolver precisa ser maior que zero.' };

    const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ? AND cancelado = 0').get(item.saleItemId, saleId);
    if (!saleItem) return { ok: false, error: 'Item da venda não encontrado.' };
    pedidoPorProduto.set(saleItem.product_id, (pedidoPorProduto.get(saleItem.product_id) || 0) + qtd);
  }
  const jaDevolvidoPorProduto = devolvidoPorProduto(db, saleId);
  for (const [productId, pedido] of pedidoPorProduto) {
    const vendido = db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS q FROM sale_items WHERE sale_id = ? AND product_id = ? AND cancelado = 0').get(saleId, productId).q;
    const disponivelParaDevolucao = Math.round((vendido - (jaDevolvidoPorProduto.get(productId) || 0)) * 1000) / 1000;
    if (pedido > disponivelParaDevolucao + 1e-9) {
      return { ok: false, error: `Quantidade maior que o disponível para devolução (${disponivelParaDevolucao}).` };
    }
  }
  const { fator, liquido } = fatorPago(db, saleId);
  const jaDevolvidoEmReais = db.prepare('SELECT COALESCE(SUM(valor_devolvido), 0) AS v FROM returns WHERE sale_id = ?').get(saleId).v;

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
      // O que o cliente pagou por estas unidades (com o desconto e a taxa da venda).
      const valorItem = saleItem.preco_unitario * Number(item.quantidade) * fator;
      valorTotal += valorItem;

      db.prepare(
        `INSERT INTO return_items (id, return_id, product_id, quantidade, valor_unitario) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), returnId, saleItem.product_id, item.quantidade, saleItem.preco_unitario);

      // Serviço (mão de obra, taxa, consulta...) nunca teve stock_movements
      // gerado na venda original (ver saleService.addItem) — devolver o
      // valor não pode inventar uma "entrada" de estoque que não existe.
      const produtoDevolvido = db.prepare('SELECT tipo FROM products WHERE id = ?').get(saleItem.product_id);
      if (produtoDevolvido?.tipo !== 'servico') {
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, operador_id, autorizado_por_id, device_id)
           VALUES (?, ?, ?, 'entrada', ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), saleItem.product_id, locationId, Math.abs(item.quantidade), motivo || 'Devolução pós-venda', saleId, currentOperatorId, auth.autorizadoPor.id, deviceId);
      }
    }

    // Centavos, e nunca mais do que sobrou do que foi pago na venda.
    valorTotal = Math.max(0, Math.min(Math.round(valorTotal * 100) / 100, Math.round((liquido - jaDevolvidoEmReais) * 100) / 100));
    db.prepare('UPDATE returns SET valor_devolvido = ? WHERE id = ?').run(valorTotal, returnId);

    // Se a venda original teve algum valor pago em fiado, devolver um
    // item também tem que abater a dívida do cliente -- sem isso, ele
    // continua devendo o valor cheio por um item que já devolveu.
    // Cap duplo: nunca abate mais do que foi de fato devolvido agora
    // (valorTotal), nem mais do que ainda resta da dívida ESPECÍFICA
    // dessa venda (dívida original menos o que devoluções anteriores
    // dessa mesma venda já abateram) -- assim uma venda com pagamento
    // misto (parte fiado, parte dinheiro) nunca abate além do que
    // realmente entrou como fiado, mesmo com devoluções parciais em
    // mais de uma vez.
    const sale = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(saleId);
    if (sale?.customer_id) {
      const dividaOriginal = db.prepare(
        `SELECT COALESCE(SUM(valor), 0) as total FROM customer_credit_movements WHERE tipo = 'divida' AND sale_id = ?`
      ).get(saleId).total;
      if (dividaOriginal > 0) {
        const jaAbatidoPorDevolucoes = db.prepare(
          `SELECT COALESCE(SUM(valor), 0) as total FROM customer_credit_movements WHERE tipo = 'pagamento' AND sale_id = ?`
        ).get(saleId).total;
        const restanteDestaVenda = dividaOriginal - jaAbatidoPorDevolucoes;
        const abaterAgora = Math.min(valorTotal, restanteDestaVenda);
        if (abaterAgora > 0) {
          db.prepare(
            `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, motivo, operador_id)
             VALUES (?, ?, 'pagamento', ?, ?, 'Devolução de item(ns) da venda', ?)`
          ).run(randomUUID(), sale.customer_id, abaterAgora, saleId, currentOperatorId);
        }
      }
      // Pontos de fidelidade que a parte devolvida tinha dado saem do saldo.
      const customerService = require('./customerService');
      const fid = customerService.getLoyaltyConfig();
      if (fid?.ativado && fid.reais_por_ponto > 0) {
        const pontos = Math.floor(valorTotal / fid.reais_por_ponto);
        if (pontos > 0) customerService.debitarPontos(sale.customer_id, pontos);
      }
    }
  });
  tx();

  // Devolve ao contador do grupo só a variação (ver stockSyncService) --
  // nunca regrava o total.
  const stockSyncService = require('./stockSyncService');
  for (const item of itens) {
    const saleItem = db.prepare('SELECT product_id, eh_personalizado FROM sale_items WHERE id = ?').get(item.saleItemId);
    if (!saleItem?.product_id || saleItem.eh_personalizado) continue;
    const tipo = db.prepare('SELECT tipo FROM products WHERE id = ?').get(saleItem.product_id)?.tipo;
    if (tipo === 'servico') continue;
    stockSyncService.registrarDevolucaoDeVenda(saleId, saleItem.product_id, item.quantidade);
  }

  // Grupo de caixas: o histórico dos outros passa a mostrar a devolução.
  try { require('./salesSyncService').reenviarVendas([saleId]); } catch { /* ciclo de 15 min manda depois */ }
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
