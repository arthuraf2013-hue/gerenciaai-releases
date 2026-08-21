const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const ingredientService = require('./ingredientService');

/**
 * "Produto personalizado" — prato/produto montado na hora (ex: pizza
 * meio-a-meio, drink combinado, porção sem medida exata) a partir de
 * insumos e/ou produtos do catálogo escolhidos ali mesmo no PDV.
 *
 * Cada venda de item personalizado usa o MESMO product_id "âncora"
 * abaixo (criado uma vez, escondido do catálogo via ativo=0) em vez de
 * virar um produto novo cadastrado — assim todo o resto do sistema
 * (recibo, comanda, histórico, sincronização) continua funcionando sem
 * precisar aceitar product_id nulo em sale_items. O nome de verdade de
 * cada venda fica em sale_items.nome_personalizado; a composição
 * (quais insumos/produtos e quanto de cada) fica em custom_item_lines.
 */
const PRODUTO_PERSONALIZADO_ID = '00000000-0000-4000-8000-000000000001';

/** Garante que o produto-âncora existe (idempotente) — chamado antes de
 * qualquer venda personalizada. ativo=0 desde a criação: reaproveita o
 * mecanismo já usado em todo o app pra esconder produto de busca/catálogo. */
function garantirProdutoPersonalizado() {
  const db = getDb();
  const existente = db.prepare('SELECT id FROM products WHERE id = ?').get(PRODUTO_PERSONALIZADO_ID);
  if (existente) return PRODUTO_PERSONALIZADO_ID;

  db.prepare(
    `INSERT INTO products (id, nome, categoria, preco, custo, unidade, ativo)
     VALUES (?, 'Produto personalizado', 'Personalizado', 0, 0, 'un', 0)`
  ).run(PRODUTO_PERSONALIZADO_ID);
  return PRODUTO_PERSONALIZADO_ID;
}

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Busca combinada de insumos + produtos do catálogo, pra preencher as
 * caixas de busca de cada linha do produto personalizado. O produto-
 * âncora nunca aparece aqui (ativo=0, igual em qualquer outra busca). */
function buscarInsumosEProdutos({ query } = {}) {
  const db = getDb();
  const termo = normalizarTexto(query);
  if (!termo) return [];

  const insumos = db.prepare('SELECT * FROM ingredients WHERE ativo = 1').all()
    .filter((i) => normalizarTexto(i.nome).includes(termo))
    .slice(0, 15)
    .map((i) => ({
      tipo: 'insumo', id: i.id, nome: i.nome, unidade: i.unidade, custoUnitario: i.custo_unitario,
    }));

  const produtos = db.prepare('SELECT * FROM products WHERE ativo = 1').all()
    .filter((p) => normalizarTexto(p.nome).includes(termo))
    .slice(0, 15)
    .map((p) => ({
      tipo: 'produto', id: p.id, nome: p.nome, unidade: p.unidade || 'un', custoUnitario: custoUnitarioProduto(p.id),
    }));

  return [...insumos, ...produtos].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Custo de UMA unidade do produto — usa o custo cadastrado nele; se
 * estiver zerado/vazio mas o produto tiver ficha técnica, usa o custo
 * calculado da ficha técnica em vez disso (mais confiável nesse caso). */
function custoUnitarioProduto(productId) {
  const db = getDb();
  const product = db.prepare('SELECT custo FROM products WHERE id = ?').get(productId);
  if (!product) return 0;
  if (product.custo > 0) return product.custo;
  return ingredientService.computeDishCost(productId);
}

/** Quantidade "equivalente" de uma linha — pro modo quantidade é o
 * valor direto; pro modo percentual (só faz sentido em linhas tipo
 * 'produto') é a fração de uma unidade inteira (50% = 0.5). */
function quantidadeEquivalente(linha) {
  if (linha.modo === 'percentual') return (Number(linha.percentual) || 0) / 100;
  return Number(linha.quantidade) || 0;
}

/** Custo estimado de uma linha (insumo ou produto), sem gravar nada —
 * usado tanto pra sugerir preço quanto internamente. */
function custoLinha(linha) {
  const qtd = quantidadeEquivalente(linha);
  if (qtd <= 0) return 0;
  if (linha.tipo === 'insumo') {
    const db = getDb();
    const ing = db.prepare('SELECT custo_unitario FROM ingredients WHERE id = ?').get(linha.insumoId);
    return qtd * (ing?.custo_unitario || 0);
  }
  return qtd * custoUnitarioProduto(linha.produtoId);
}

/** Soma o custo estimado de todas as linhas — só cálculo, não grava
 * nada. A tela sugere isso como ponto de partida pro preço (custo puro,
 * sem margem nenhuma embutida — não existe uma convenção de margem no
 * resto do app pra inventar uma aqui; o operador ajusta o valor final). */
function sugerirPreco({ linhas }) {
  const custoEstimado = (linhas || []).reduce((soma, linha) => soma + custoLinha(linha), 0);
  return { custoEstimado };
}

/**
 * Aplica UMA linha de componente ao estoque, multiplicada por `sinal`
 * (+1 desconta na venda, -1 reverte no cancelamento). Usa só prepared
 * statements soltos (sem transação própria) pra poder ser chamada de
 * dentro da transação de quem chamou (saleService), igual ao padrão já
 * usado em ingredientService.descontarPorVenda/reverterPorVenda.
 *
 * tipo='insumo': desconta direto o estoque do insumo.
 * tipo='produto': se o produto tiver ficha técnica (dish_ingredients),
 *   desconta proporcional dos INSUMOS dela (ex: pizza sabor Calabresa
 *   50% -> desconta metade de cada insumo da receita da Calabresa).
 *   Sem ficha técnica: desconta o estoque do próprio produto direto
 *   (fallback — sem isso a linha não descontaria nada de lugar nenhum).
 */
function aplicarLinha(db, linha, sinal, ctx) {
  const qtd = quantidadeEquivalente(linha) * sinal;
  if (qtd === 0) return;

  if (linha.tipo === 'insumo') {
    db.prepare('UPDATE ingredients SET estoque_atual = estoque_atual - ? WHERE id = ?').run(qtd, linha.insumoId);
    return;
  }

  // tipo === 'produto'
  const receita = db.prepare('SELECT ingredient_id, quantidade FROM dish_ingredients WHERE product_id = ?').all(linha.produtoId);
  if (receita.length > 0) {
    for (const r of receita) {
      db.prepare('UPDATE ingredients SET estoque_atual = estoque_atual - ? WHERE id = ?').run(r.quantidade * qtd, r.ingredient_id);
    }
    return;
  }

  // Sem ficha técnica: desconta o estoque do próprio produto (movimento
  // de estoque de verdade, igual uma venda normal) — precisa de
  // location_id pra saber DE ONDE descontar, já que estoque é por local.
  // qtd > 0 é desconto (venda, quantidade negativa no movimento); qtd < 0
  // é reversão (estorno, quantidade positiva) — mesma convenção de sinal
  // usada em addItem/cancelSaleItem pro produto normal.
  const movimentoQtd = -qtd;
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, sale_item_id, operador_id, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(), linha.produtoId, ctx.locationId, movimentoQtd < 0 ? 'venda' : 'estorno', movimentoQtd,
    movimentoQtd < 0 ? null : 'Estorno de item personalizado', ctx.saleId, ctx.saleItemId, ctx.operadorId, ctx.deviceId
  );
}

/** Grava as linhas de um item personalizado e já desconta o estoque de
 * todas elas — chamada de DENTRO da transação de saleService.addCustomItem. */
function gravarEDescontarLinhas(saleItemId, linhas, ctx) {
  const db = getDb();
  for (const linha of linhas) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO custom_item_lines (id, sale_item_id, tipo, insumo_id, produto_id, modo, quantidade, percentual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, saleItemId, linha.tipo,
      linha.tipo === 'insumo' ? linha.insumoId : null,
      linha.tipo === 'produto' ? linha.produtoId : null,
      linha.modo === 'percentual' ? 'percentual' : 'quantidade',
      linha.modo === 'percentual' ? null : Number(linha.quantidade) || 0,
      linha.modo === 'percentual' ? Number(linha.percentual) || 0 : null
    );
    aplicarLinha(db, linha, +1, ctx);
  }
}

/** Reverte (devolve) o estoque de todas as linhas de um item
 * personalizado cancelado — espelho de gravarEDescontarLinhas, chamada
 * de dentro da transação de saleService.cancelSaleItem/cancelSale. */
function reverterLinhasDoItem(saleItemId, ctx) {
  const db = getDb();
  const linhas = db.prepare('SELECT * FROM custom_item_lines WHERE sale_item_id = ?').all(saleItemId);
  for (const l of linhas) {
    aplicarLinha(db, {
      tipo: l.tipo, insumoId: l.insumo_id, produtoId: l.produto_id,
      modo: l.modo, quantidade: l.quantidade, percentual: l.percentual,
    }, -1, ctx);
  }
}

/** Itens personalizados recentes (janela de `dias`) que ainda podem
 * receber a quantidade final ajustada — mostrado na aba "Personalizados"
 * dentro de Produtos > Insumos. Não filtra só os "não ajustados ainda"
 * porque um ajuste pode ser corrigido de novo depois. */
function listItensParaAjuste({ locationId, dias = 7 } = {}) {
  const db = getDb();
  const itens = db.prepare(
    `SELECT si.id as sale_item_id, si.nome_personalizado, si.quantidade, si.criado_em, si.sale_id
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     WHERE si.eh_personalizado = 1 AND si.cancelado = 0 AND s.location_id = ?
       AND date(si.criado_em) >= date('now', ?)
     ORDER BY si.criado_em DESC`
  ).all(locationId, `-${Number(dias) || 7} days`);

  const linhasStmt = db.prepare(
    `SELECT cil.*, i.nome as insumo_nome, i.unidade as insumo_unidade, p.nome as produto_nome, p.unidade as produto_unidade
     FROM custom_item_lines cil
     LEFT JOIN ingredients i ON i.id = cil.insumo_id
     LEFT JOIN products p ON p.id = cil.produto_id
     WHERE cil.sale_item_id = ?`
  );

  return itens.map((item) => ({
    saleItemId: item.sale_item_id,
    nome: item.nome_personalizado,
    quantidadeVendida: item.quantidade,
    criadoEm: item.criado_em,
    saleId: item.sale_id,
    linhas: linhasStmt.all(item.sale_item_id).map((l) => ({
      id: l.id,
      tipo: l.tipo,
      nome: l.tipo === 'insumo' ? l.insumo_nome : l.produto_nome,
      unidade: l.tipo === 'insumo' ? l.insumo_unidade : (l.produto_unidade || 'un'),
      modo: l.modo,
      quantidade: l.quantidade,
      percentual: l.percentual,
      quantidadeAjustada: l.quantidade_ajustada,
      ajustadoEm: l.ajustado_em,
    })),
  }));
}

/**
 * Informa a quantidade FINAL de uma ou mais linhas de um item já
 * vendido — aplica só a diferença (delta) no estoque em vez do valor
 * inteiro de novo, usando a mesma lógica de aplicarLinha (insumo direto
 * ou receita proporcional do produto). Ex: linha estimada em 0.3kg,
 * usuário informa que na verdade foi 0.35kg -> desconta só mais 0.05kg.
 */
function ajustarLinhas({ ajustes, operadorId, locationId, deviceId }) {
  const db = getDb();
  if (!Array.isArray(ajustes) || ajustes.length === 0) return { ok: false, error: 'Nenhum ajuste informado.' };

  const tx = db.transaction(() => {
    for (const ajuste of ajustes) {
      const linha = db.prepare('SELECT * FROM custom_item_lines WHERE id = ?').get(ajuste.linhaId);
      if (!linha) continue;

      const anterior = linha.quantidade_ajustada !== null && linha.quantidade_ajustada !== undefined
        ? linha.quantidade_ajustada
        : quantidadeEquivalente({ modo: linha.modo, quantidade: linha.quantidade, percentual: linha.percentual });

      const final = Number(ajuste.quantidadeFinal);
      if (!(final >= 0)) continue;
      const delta = final - anterior;

      if (delta !== 0) {
        const saleItem = db.prepare('SELECT sale_id FROM sale_items WHERE id = ?').get(linha.sale_item_id);
        aplicarLinha(db, {
          tipo: linha.tipo, insumoId: linha.insumo_id, produtoId: linha.produto_id,
          modo: 'quantidade', quantidade: delta, percentual: null,
        }, +1, { locationId, saleId: saleItem?.sale_id, saleItemId: linha.sale_item_id, operadorId, deviceId });
      }

      db.prepare(
        `UPDATE custom_item_lines SET quantidade_ajustada = ?, ajustado_em = NOW_SYNCED(), ajustado_por_id = ? WHERE id = ?`
      ).run(final, operadorId, linha.id);
    }
  });
  tx();

  return { ok: true };
}

module.exports = {
  PRODUTO_PERSONALIZADO_ID,
  garantirProdutoPersonalizado,
  buscarInsumosEProdutos,
  sugerirPreco,
  gravarEDescontarLinhas,
  reverterLinhasDoItem,
  listItensParaAjuste,
  ajustarLinhas,
};
