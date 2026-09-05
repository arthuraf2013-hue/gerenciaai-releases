const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const customItemService = require('./customItemService');

/**
 * Materiais da LOJA (produtos com estoque de verdade, não insumos à
 * parte) que um SERVIÇO consome por padrão — ex: um serviço de
 * coloração usa 40g de "Tintura X", produto que a loja também vende no
 * varejo. Isto é só o PADRÃO por 1 unidade do serviço; a quantidade
 * real de cada venda vira uma linha em custom_item_lines (ajustável
 * depois em Produtos > Personalizados) — ver saleService.addItem, que
 * usa gerarLinhasParaQuantidade/custoMaterialPorUnidade abaixo.
 */

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Materiais padrão cadastrados pra um serviço (products.tipo='servico'). */
function getMateriais(servicoId) {
  const db = getDb();
  return db.prepare(
    `SELECT smd.id, smd.material_id as materialId, smd.quantidade, smd.cobra_no_preco as cobraNoPreco,
            p.nome as materialNome, p.unidade as materialUnidade, p.preco as materialPreco, p.custo as materialCusto
     FROM service_material_defaults smd
     JOIN products p ON p.id = smd.material_id
     WHERE smd.servico_id = ?
     ORDER BY p.nome`
  ).all(servicoId);
}

/** Substitui a lista inteira de materiais de um serviço — mesmo padrão
 * de ingredientService.setRecipe (apaga tudo e recria, mais simples que
 * calcular um diff pra uma lista tipicamente curta). */
function setMateriais(servicoId, materiais) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM service_material_defaults WHERE servico_id = ?').run(servicoId);
    for (const m of materiais || []) {
      const quantidade = Number(m.quantidade);
      if (!(quantidade > 0) || !m.materialId) continue;
      db.prepare(
        `INSERT INTO service_material_defaults (id, servico_id, material_id, quantidade, cobra_no_preco)
         VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), servicoId, m.materialId, quantidade, m.cobraNoPreco === false ? 0 : 1);
    }
  });
  tx();
  return { ok: true };
}

/** Busca de produtos (tipo='produto' apenas — serviço não pode "usar"
 * outro serviço como material) pra preencher a busca de material no
 * cadastro do serviço. Espelha customItemService.buscarInsumosEProdutos,
 * mas restrito a produtos de verdade (com estoque). */
function buscarMateriais({ query } = {}) {
  const db = getDb();
  const termo = normalizarTexto(query);
  if (!termo) return [];

  return db.prepare(`SELECT * FROM products WHERE ativo = 1 AND tipo = 'produto'`).all()
    .filter((p) => normalizarTexto(p.nome).includes(termo))
    .slice(0, 15)
    .map((p) => ({ id: p.id, nome: p.nome, unidade: p.unidade || 'un', preco: p.preco, custo: p.custo }));
}

/** Custo por UMA unidade do serviço, somando só os materiais marcados
 * pra entrar no preço (cobra_no_preco=1). Usa o CUSTO do material (o
 * que a loja pagou) — não o preço de revenda dele — decisão explícita:
 * "preço final do serviço = mão de obra fixa + custo do material
 * usado". Reaproveita o fallback de custoUnitarioProduto (ficha técnica,
 * se o material não tiver custo cadastrado direto) por consistência com
 * o resto do sistema. */
function custoMaterialPorUnidade(servicoId) {
  const materiais = getMateriais(servicoId);
  return materiais.reduce((soma, m) => {
    if (!m.cobraNoPreco) return soma;
    const custoUnitario = m.materialCusto > 0 ? m.materialCusto : customItemService.custoUnitarioProduto(m.materialId);
    return soma + m.quantidade * custoUnitario;
  }, 0);
}

/** Gera as linhas de consumo (formato aceito por
 * customItemService.gravarEDescontarLinhas) equivalentes a vender
 * `quantidade` unidades do serviço — cada material padrão escalado pela
 * quantidade. Chamado a cada saleService.addItem pro serviço (inclusive
 * quando soma numa linha já existente no carrinho), então cada chamada
 * gera só as linhas da quantidade NOVA sendo adicionada, nunca do total
 * acumulado — evita descontar estoque em dobro. */
function gerarLinhasParaQuantidade(servicoId, quantidade) {
  const materiais = getMateriais(servicoId);
  return materiais.map((m) => ({
    tipo: 'produto',
    produtoId: m.materialId,
    modo: 'quantidade',
    quantidade: m.quantidade * quantidade,
  }));
}

module.exports = { getMateriais, setMateriais, buscarMateriais, custoMaterialPorUnidade, gerarLinhasParaQuantidade };
