const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function list({ query } = {}) {
  const db = getDb();
  // usado_em: em quantos pratos ATIVOS o insumo entra -- a tela mostra e usa
  // pra avisar antes de remover um insumo que ainda está em ficha técnica.
  let sql = `SELECT i.*,
      (SELECT COUNT(DISTINCT di.product_id) FROM dish_ingredients di
         JOIN products p ON p.id = di.product_id AND p.ativo = 1
        WHERE di.ingredient_id = i.id) AS usado_em
    FROM ingredients i WHERE i.ativo = 1`;
  const params = [];
  if (query) {
    sql += ' AND i.nome LIKE ?';
    params.push(`%${query}%`);
  }
  sql += ' ORDER BY i.nome';
  return db.prepare(sql).all(...params);
}

function upsert(ingredient) {
  if (!ingredient.nome?.trim()) return { ok: false, error: 'Informe o nome do insumo.' };
  if (Number.isNaN(Number(ingredient.custoUnitario)) || Number(ingredient.custoUnitario) < 0) {
    return { ok: false, error: 'Custo unitário inválido.' };
  }

  const db = getDb();
  const id = ingredient.id || randomUUID();

  // No UPDATE (editar um insumo já existente), estoque_atual NÃO entra
  // no SET -- editar nome/unidade/custo usava o MESMO formulário que
  // "estoque atual", e sobrescrevia o estoque de verdade (direto, sem
  // log nenhum) toda vez que alguém só queria corrigir o custo, por
  // exemplo. Ajuste de estoque de insumo agora só acontece por
  // adjustStock, que fica registrado em ingredient_stock_movements
  // (auditoria, seção 4). estoque_atual só é gravado aqui na CRIAÇÃO
  // (INSERT) de um insumo novo, como estoque inicial.
  db.prepare(
    `INSERT INTO ingredients (id, nome, unidade, custo_unitario, estoque_atual, estoque_minimo)
     VALUES (@id, @nome, @unidade, @custoUnitario, @estoqueAtual, @estoqueMinimo)
     ON CONFLICT(id) DO UPDATE SET
       nome=excluded.nome, unidade=excluded.unidade, custo_unitario=excluded.custo_unitario,
       estoque_minimo=excluded.estoque_minimo`
  ).run({
    id,
    nome: ingredient.nome.trim(),
    unidade: ingredient.unidade || 'un',
    custoUnitario: Number(ingredient.custoUnitario) || 0,
    estoqueAtual: Number(ingredient.estoqueAtual) || 0,
    estoqueMinimo: Number(ingredient.estoqueMinimo) || 0,
  });

  return { ok: true, id };
}

const TIPOS_AJUSTE_VALIDOS = ['entrada', 'ajuste', 'perda'];

/**
 * Ajuste manual de estoque de insumo (entrada de mercadoria, perda,
 * correção de inventário) — separado de upsert (que só edita
 * nome/unidade/custo/mínimo) pra sempre deixar rastro de quem mudou o
 * estoque, quando, e por quê, igual ao que já existe pra estoque de
 * PRODUTO (stockService.adjustStock). O sinal de `quantidade` vem de
 * quem chama (positivo pra somar, negativo pra subtrair).
 */
function adjustStock({ ingredientId, quantidade, tipo, motivo, operadorId }) {
  if (!TIPOS_AJUSTE_VALIDOS.includes(tipo)) {
    return { ok: false, error: `Tipo de movimento inválido. Use: ${TIPOS_AJUSTE_VALIDOS.join(', ')}.` };
  }
  const qtd = Number(quantidade);
  if (!qtd || Number.isNaN(qtd)) {
    return { ok: false, error: 'Informe uma quantidade diferente de zero.' };
  }

  const db = getDb();
  const ingrediente = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingredientId);
  if (!ingrediente) return { ok: false, error: 'Insumo não encontrado.' };

  const estoqueDepois = ingrediente.estoque_atual + qtd;
  const id = randomUUID();

  const tx = db.transaction(() => {
    db.prepare('UPDATE ingredients SET estoque_atual = ? WHERE id = ?').run(estoqueDepois, ingredientId);
    db.prepare(
      `INSERT INTO ingredient_stock_movements (id, ingredient_id, tipo, quantidade, estoque_antes, estoque_depois, motivo, operador_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ingredientId, tipo, qtd, ingrediente.estoque_atual, estoqueDepois, motivo || null, operadorId || null);
  });
  tx();

  return { ok: true, id, estoqueAtual: estoqueDepois };
}

const arred4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Compra de insumos em lote (a nota do hortifruti, a sacola do atacado):
 * cada linha vira uma ENTRADA no estoque, com rastro de quem lançou, e
 * -- se pedido -- o custo do insumo passa a ser o preço pago nesta compra
 * (valor da linha ÷ quantidade), que é o que o dono do restaurante espera:
 * "paguei mais caro no tomate, o custo do prato tem que subir junto".
 * Tudo numa transação: ou entra a compra inteira, ou nada.
 *
 * @param {{ itens: { ingredientId: string, quantidade: number, valorTotal?: number }[],
 *   atualizarCusto?: boolean, fornecedor?: string, operadorId?: string }} payload
 */
function registrarCompra({ itens, atualizarCusto = true, fornecedor, operadorId } = {}) {
  const linhas = (Array.isArray(itens) ? itens : []).filter((l) => l && l.ingredientId);
  if (linhas.length === 0) return { ok: false, error: 'Adicione pelo menos um insumo na compra.' };
  for (const l of linhas) {
    const qtd = Number(l.quantidade);
    if (!(qtd > 0)) return { ok: false, error: 'Toda linha da compra precisa de uma quantidade maior que zero.' };
    if (l.valorTotal !== undefined && l.valorTotal !== null && l.valorTotal !== ''
      && (Number.isNaN(Number(l.valorTotal)) || Number(l.valorTotal) < 0)) {
      return { ok: false, error: 'Valor pago inválido em uma das linhas.' };
    }
  }

  const db = getDb();
  const buscar = db.prepare('SELECT * FROM ingredients WHERE id = ? AND ativo = 1');
  const atualizarEstoque = db.prepare('UPDATE ingredients SET estoque_atual = ? WHERE id = ?');
  const atualizarCustoStmt = db.prepare('UPDATE ingredients SET custo_unitario = ? WHERE id = ?');
  const movimento = db.prepare(
    `INSERT INTO ingredient_stock_movements (id, ingredient_id, tipo, quantidade, estoque_antes, estoque_depois, motivo, operador_id)
     VALUES (?, ?, 'entrada', ?, ?, ?, ?, ?)`
  );
  const motivo = fornecedor && String(fornecedor).trim() ? `Compra — ${String(fornecedor).trim().slice(0, 80)}` : 'Compra';

  const resultado = [];
  try {
    db.transaction(() => {
      for (const l of linhas) {
        const ing = buscar.get(l.ingredientId);
        if (!ing) throw new Error('Um dos insumos da compra não existe mais (foi removido).');
        const qtd = Number(l.quantidade);
        const depois = arred4(ing.estoque_atual + qtd);
        atualizarEstoque.run(depois, ing.id);
        movimento.run(randomUUID(), ing.id, qtd, ing.estoque_atual, depois, motivo, operadorId || null);
        const valor = Number(l.valorTotal);
        let custoNovo = ing.custo_unitario;
        if (atualizarCusto && valor > 0) {
          custoNovo = arred4(valor / qtd);
          atualizarCustoStmt.run(custoNovo, ing.id);
        }
        resultado.push({ ingredientId: ing.id, estoqueAtual: depois, custoAntes: ing.custo_unitario, custoUnitario: custoNovo });
      }
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, itens: resultado };
}

/**
 * Conferência (contagem) de estoque dos insumos: a pessoa conta o que tem
 * na despensa e informa; a diferença para o sistema vira um AJUSTE com
 * rastro (o relatório "consumo teórico × inventário" usa esses ajustes pra
 * mostrar o que sumiu além da ficha técnica). Linha sem diferença não gera
 * movimento. Tudo numa transação.
 *
 * @param {{ itens: { ingredientId: string, contado: number }[], operadorId?: string }} payload
 */
function registrarContagem({ itens, operadorId } = {}) {
  const linhas = (Array.isArray(itens) ? itens : []).filter((l) => l && l.ingredientId && l.contado !== '' && l.contado !== null && l.contado !== undefined);
  if (linhas.length === 0) return { ok: false, error: 'Informe a quantidade contada de pelo menos um insumo.' };
  for (const l of linhas) {
    const c = Number(l.contado);
    if (Number.isNaN(c) || c < 0) return { ok: false, error: 'A quantidade contada não pode ser negativa.' };
  }

  const db = getDb();
  const buscar = db.prepare('SELECT * FROM ingredients WHERE id = ? AND ativo = 1');
  const atualizarEstoque = db.prepare('UPDATE ingredients SET estoque_atual = ? WHERE id = ?');
  const movimento = db.prepare(
    `INSERT INTO ingredient_stock_movements (id, ingredient_id, tipo, quantidade, estoque_antes, estoque_depois, motivo, operador_id)
     VALUES (?, ?, 'ajuste', ?, ?, ?, 'Conferência de estoque', ?)`
  );
  let ajustados = 0;
  let semDiferenca = 0;
  let valorDiferenca = 0;
  try {
    db.transaction(() => {
      for (const l of linhas) {
        const ing = buscar.get(l.ingredientId);
        if (!ing) throw new Error('Um dos insumos da conferência não existe mais (foi removido).');
        const contado = arred4(Number(l.contado));
        const diferenca = arred4(contado - ing.estoque_atual);
        if (diferenca === 0) { semDiferenca += 1; continue; }
        atualizarEstoque.run(contado, ing.id);
        movimento.run(randomUUID(), ing.id, diferenca, ing.estoque_atual, contado, operadorId || null);
        ajustados += 1;
        valorDiferenca += diferenca * ing.custo_unitario;
      }
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, ajustados, semDiferenca, valorDiferenca: Math.round(valorDiferenca * 100) / 100 };
}

/** Histórico de ajustes de um insumo — mais recente primeiro. */
function listStockMovements(ingredientId) {
  const db = getDb();
  // criado_em só tem precisão de segundo (NOW_SYNCED) -- dois ajustes
  // feitos em rápida sucessão (comum: entrada seguida de uma correção)
  // empatam nesse campo, deixando a ordem entre eles arbitrária. rowid
  // sempre cresce na ordem de inserção, então desempata certo sem
  // precisar de uma coluna de sequência nova.
  return db.prepare(
    `SELECT m.*, u.nome as operador_nome FROM ingredient_stock_movements m
     LEFT JOIN users u ON u.id = m.operador_id
     WHERE m.ingredient_id = ? ORDER BY m.criado_em DESC, m.rowid DESC`
  ).all(ingredientId);
}

function deactivate(id) {
  const db = getDb();
  db.prepare('UPDATE ingredients SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

/** Ficha técnica de um prato — quais insumos e quanto de cada. */
function getRecipe(productId) {
  const db = getDb();
  return db.prepare(
    `SELECT di.*, i.nome, i.unidade, i.custo_unitario
     FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
     WHERE di.product_id = ? ORDER BY i.nome`
  ).all(productId);
}

/** Substitui a ficha técnica inteira de um prato pela lista enviada —
 * mais simples do que tentar calcular diffs, e o formulário sempre
 * manda a lista completa mesmo assim. */
function setRecipe(productId, itens) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM dish_ingredients WHERE product_id = ?').run(productId);
    for (const item of itens || []) {
      if (!item.ingredientId || !item.quantidade || Number(item.quantidade) <= 0) continue;
      db.prepare(
        `INSERT INTO dish_ingredients (id, product_id, ingredient_id, quantidade) VALUES (?, ?, ?, ?)`
      ).run(randomUUID(), productId, item.ingredientId, Number(item.quantidade));
    }
  });
  tx();
  return { ok: true };
}

/** Custo calculado do prato, somando quantidade × custo unitário de
 * cada insumo da ficha técnica. Retorna 0 se não tiver ficha técnica
 * cadastrada ainda (não é erro — só não tem base pra calcular). */
function computeDishCost(productId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(di.quantidade * i.custo_unitario), 0) as custo
     FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
     WHERE di.product_id = ?`
  ).get(productId);
  return row.custo;
}

/**
 * Desconta o estoque de cada insumo da ficha técnica de um prato,
 * proporcional à quantidade vendida — chamada de DENTRO da transação
 * de saleService.addItem (mesma transação que já debita o estoque do
 * PRODUTO em si), pra manter os dois descontos atômicos: se um falhar,
 * o outro também não é gravado. Por isso não abre a própria transação
 * aqui (nested transaction não é permitido no better-sqlite3) — só usa
 * prepared statements soltos, que entram na transação de quem chamou.
 * Produto sem ficha técnica cadastrada: não faz nada (silencioso).
 * Não bloqueia a venda se o insumo não tiver estoque suficiente — só
 * desconta (podendo ficar negativo), igual a um ajuste manual de
 * estoque já permite hoje. Bloquear a venda por causa do insumo não
 * foi pedido e mudaria o fluxo do caixa.
 */
function descontarPorVenda(productId, quantidadeVendida, saleId = null) {
  const db = getDb();
  const receita = db.prepare('SELECT ingredient_id, quantidade FROM dish_ingredients WHERE product_id = ?').all(productId);
  for (const linha of receita) {
    db.prepare('UPDATE ingredients SET estoque_atual = estoque_atual - ? WHERE id = ?')
      .run(linha.quantidade * quantidadeVendida, linha.ingredient_id);
    registrarConsumo(db, linha.ingredient_id, productId, saleId, linha.quantidade * quantidadeVendida);
  }
}

// Livro do consumo TEÓRICO (pela ficha técnica) -- antes a venda só
// baixava estoque_atual, sem deixar rastro; sem isso não dá pra comparar
// o que deveria ter saído com o que o inventário mostra que saiu.
function registrarConsumo(db, ingredientId, productId, saleId, quantidade) {
  db.prepare(
    'INSERT INTO ingredient_consumo (id, ingredient_id, product_id, sale_id, quantidade) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), ingredientId, productId, saleId || null, quantidade);
}

/** Estorna (devolve) o estoque de insumos de um prato cancelado —
 * espelho exato de descontarPorVenda, chamada de dentro da mesma
 * transação de saleService.cancelSaleItem/cancelSale. */
function reverterPorVenda(productId, quantidadeCancelada, saleId = null) {
  const db = getDb();
  const receita = db.prepare('SELECT ingredient_id, quantidade FROM dish_ingredients WHERE product_id = ?').all(productId);
  for (const linha of receita) {
    db.prepare('UPDATE ingredients SET estoque_atual = estoque_atual + ? WHERE id = ?')
      .run(linha.quantidade * quantidadeCancelada, linha.ingredient_id);
    registrarConsumo(db, linha.ingredient_id, productId, saleId, -(linha.quantidade * quantidadeCancelada));
  }
}

/**
 * Consumo teórico × inventário, por insumo, num período (datas locais).
 * - consumoTeorico: o que as vendas tiraram pela ficha técnica;
 * - perdas: quebra/desperdício registrados;
 * - ajusteInventario: correções de contagem (negativo = sumiu mais do que
 *   a ficha explica: porção maior, desperdício não registrado, desvio).
 * O desvio em R$ usa o custo atual do insumo.
 */
function relatorioConsumoTeoricoVsReal({ dataInicio, dataFim }) {
  const db = getDb();
  const timeService = require('./timeService');
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  const linhas = db.prepare(
    `SELECT i.id, i.nome, i.unidade, i.custo_unitario, i.estoque_atual,
       COALESCE((SELECT SUM(c.quantidade) FROM ingredient_consumo c WHERE c.ingredient_id = i.id AND c.criado_em >= ? AND c.criado_em < ?), 0) AS consumoTeorico,
       COALESCE((SELECT SUM(m.quantidade) FROM ingredient_stock_movements m WHERE m.ingredient_id = i.id AND m.tipo = 'entrada' AND m.criado_em >= ? AND m.criado_em < ?), 0) AS entradas,
       COALESCE((SELECT SUM(-m.quantidade) FROM ingredient_stock_movements m WHERE m.ingredient_id = i.id AND m.tipo = 'perda' AND m.criado_em >= ? AND m.criado_em < ?), 0) AS perdas,
       COALESCE((SELECT SUM(m.quantidade) FROM ingredient_stock_movements m WHERE m.ingredient_id = i.id AND m.tipo = 'ajuste' AND m.criado_em >= ? AND m.criado_em < ?), 0) AS ajusteInventario
     FROM ingredients i WHERE i.ativo = 1 ORDER BY i.nome`
  ).all(inicioUtc, fimUtcExclusivo, inicioUtc, fimUtcExclusivo, inicioUtc, fimUtcExclusivo, inicioUtc, fimUtcExclusivo);
  const itens = linhas
    .filter((l) => l.consumoTeorico || l.entradas || l.perdas || l.ajusteInventario)
    .map((l) => ({
      ...l,
      custoTeorico: l.consumoTeorico * l.custo_unitario,
      custoPerdas: l.perdas * l.custo_unitario,
      custoDesvio: l.ajusteInventario * l.custo_unitario,
      desvioPercentual: l.consumoTeorico > 0 ? (-l.ajusteInventario / l.consumoTeorico) * 100 : null,
    }))
    .sort((a, b) => a.custoDesvio - b.custoDesvio);
  const totais = itens.reduce((t, l) => ({
    custoTeorico: t.custoTeorico + l.custoTeorico, custoPerdas: t.custoPerdas + l.custoPerdas, custoDesvio: t.custoDesvio + l.custoDesvio,
  }), { custoTeorico: 0, custoPerdas: 0, custoDesvio: 0 });
  return { itens, totais };
}

/**
 * Previsão de quantas porções de um prato dá pra fazer com o estoque
 * ATUAL dos insumos — cálculo direto (não é "IA" nenhuma, só divisão:
 * pra cada insumo da receita, estoque_atual / quantidade_por_porção,
 * arredondado pra baixo; o prato só pode ser feito tantas vezes quanto
 * o insumo mais escasso permitir). Sem ficha técnica: retorna null
 * (não aplicável — diferente de 0, que sugeriria estoque zerado).
 */
function preverPorcoesPossiveis(productId) {
  const db = getDb();
  const receita = db.prepare(
    `SELECT di.quantidade, i.estoque_atual FROM dish_ingredients di
     JOIN ingredients i ON i.id = di.ingredient_id WHERE di.product_id = ?`
  ).all(productId);
  if (receita.length === 0) return null;

  let porcoes = Infinity;
  for (const linha of receita) {
    if (!(linha.quantidade > 0)) continue;
    porcoes = Math.min(porcoes, Math.floor(linha.estoque_atual / linha.quantidade));
  }
  return Number.isFinite(porcoes) ? Math.max(0, porcoes) : null;
}

/** Mesma previsão, mas pra todos os produtos com ficha técnica de uma
 * vez só — evita uma chamada IPC por prato quando o Cardápio do dia
 * precisa mostrar o badge em cada um. Devolve um mapa productId -> porções. */
function preverPorcoesPossiveisTodos() {
  const db = getDb();
  const produtos = db.prepare('SELECT DISTINCT product_id FROM dish_ingredients').all();
  const resultado = {};
  for (const { product_id } of produtos) {
    resultado[product_id] = preverPorcoesPossiveis(product_id);
  }
  return resultado;
}

module.exports = {
  list, upsert, deactivate, adjustStock, listStockMovements, getRecipe, setRecipe, computeDishCost,
  registrarCompra, registrarContagem,
  descontarPorVenda, reverterPorVenda, preverPorcoesPossiveis, preverPorcoesPossiveisTodos,
  relatorioConsumoTeoricoVsReal,
};
