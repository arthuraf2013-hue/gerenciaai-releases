const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const tabelas = require('./tabelasFiscais');

/**
 * Cadastro automático (ERP): produto e imposto preenchidos a partir do que
 * o sistema já sabe, sem a pessoa digitar.
 *
 *  - Produto novo direto da NF-e de compra: nome limpo, EAN da unidade,
 *    unidade e conversão da caixa, custo da nota, preço pela margem padrão,
 *    categoria e dados fiscais tirados da própria loja (produtos com o mesmo
 *    NCM) ou do CFOP do fornecedor (ST -> 5405/500 no Simples).
 *  - Ao digitar o NCM no cadastro: CFOP/CSOSN/CEST e categoria sugeridos
 *    pelo que a loja já usa para aquele NCM.
 *  - NCM pela IA para quem não tem nota: só sugestão, a pessoa confere.
 *
 * Regra de ouro (igual ao assistente fiscal): automático só PREENCHE o que
 * está vazio ou inválido; nunca troca um valor válido que alguém pôs.
 */

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const ncmValido = (v) => /^\d{8}$/.test(v || '') && v !== '00000000';
const cestValido = (v) => /^\d{7}$/.test(v || '');
const ARREDONDAMENTOS = ['x9', 'x90', 'nenhum'];

function assistente() { return require('./assistenteFiscalService'); }

function regimeDaLoja(db) {
  return db.prepare("SELECT regime_tributario FROM fiscal_config WHERE id = 'default'").get()?.regime_tributario || null;
}

// ---------- texto, unidade e preço ----------

const UNIDADES = {
  UN: 'un', UND: 'un', UNID: 'un', UNIDADE: 'un', PC: 'un', PCA: 'un', PECA: 'un', 'PÇ': 'un', 'PÇA': 'un', PAR: 'un', DZ: 'un',
  KG: 'kg', KGS: 'kg', QUILO: 'kg', G: 'g', GR: 'g', GRS: 'g', L: 'l', LT: 'l', LTS: 'l', LITRO: 'l', ML: 'ml',
  CX: 'cx', CAIXA: 'cx', PCT: 'pct', PACOTE: 'pct', FD: 'pct', FARDO: 'pct',
};
function unidadeDoApp(unidadeNota) {
  return UNIDADES[String(unidadeNota || '').trim().toUpperCase()] || 'un';
}

const SIGLAS = new Set(['UHT', 'PET', 'LED', 'USB', 'PVC', 'FPS', 'SPF', 'TV', 'DVD', 'CD', 'AA', 'AAA', 'II', 'III', 'IV']);
/**
 * "REFRIG COLA PET 2L CX C/6" -> "Refrig Cola PET 2L". Tira a embalagem de
 * compra quando o produto vai ser vendido na unidade; palavra com número
 * (2L, 500ML, C/12) fica em maiúsculas; o resto vira Capitalizado.
 */
function nomeDoProduto(descricao, { tirarEmbalagem = false } = {}) {
  let t = String(descricao || '').replace(/\s+/g, ' ').trim();
  if (tirarEmbalagem) {
    t = t.replace(/\b(CX|CAIXA|FD|FARDO|PCT|PACOTE|DP|DISPLAY|EMB)\.?\s*(C\/|COM\s*)?\s*\d+\s*(UN|UND|UNID)?\b/gi, ' ')
      .replace(/\bC\/\s*\d+\s*(UN|UND|UNID)?\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  return t.split(' ').map((p) => {
    if (/\d/.test(p) || SIGLAS.has(p.toUpperCase())) return p.toUpperCase();
    if (p.length <= 2 && /^(DE|DA|DO|E|C|S|EM|P)$/i.test(p)) return p.toLowerCase();
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }).join(' ').slice(0, 120);
}

/** Preço "de prateleira": 'x9' termina em ,x9 (9,43 -> 9,49); 'x90' em ,90. Nunca abaixo do valor. */
function arredondarPreco(valor, modo = 'x9') {
  const c = Math.round(Number(valor) * 100);
  if (!(c > 0)) return 0;
  if (modo === 'x9') return (Math.ceil((c + 1) / 10) * 10 - 1) / 100;
  if (modo === 'x90') {
    let r = Math.ceil(c / 100) * 100 - 10;
    if (r < c) r += 100;
    return r / 100;
  }
  return c / 100;
}

function precoSugerido(custo, margemPercentual, modo) {
  const m = Number(margemPercentual);
  if (!(Number(custo) > 0) || !Number.isFinite(m) || m < 0) return 0;
  return arredondarPreco(Number(custo) * (1 + m / 100), modo);
}

/** Categoria mais comum entre os produtos ativos do mesmo NCM (8 dígitos; senão os 4 primeiros). */
function categoriaPorNcm(db, ncm) {
  const n = soDigitos(ncm);
  if (!ncmValido(n)) return null;
  const consulta = (filtro, valor) => db.prepare(
    `SELECT categoria, COUNT(*) AS qtd FROM products
     WHERE ativo = 1 AND categoria IS NOT NULL AND TRIM(categoria) != '' AND ${filtro}
     GROUP BY categoria ORDER BY qtd DESC, categoria LIMIT 1`
  ).get(valor);
  return (consulta('ncm = ?', n) || consulta('substr(ncm, 1, 4) = ?', n.slice(0, 4)))?.categoria || null;
}

/**
 * Fiscal para um produto novo: 1) no Simples/MEI, o CFOP do fornecedor
 * (ST -> 5405 + 500, senão 5102 + 102); 2) o que a loja usa para o NCM.
 * Regime normal sem histórico da loja: fica vazio (o diagnóstico avisa).
 */
function fiscalSugerido(db, { ncm, cest, cfopCompra, regime, excluirId }) {
  const simples = regime === 'simples_nacional' || regime === 'mei';
  const loja = assistente().fiscalDaLoja(db, ncm, regime, excluirId);
  const cestNota = cestValido(soDigitos(cest)) ? soDigitos(cest) : null;
  // O CFOP com que o fornecedor vendeu ESTE item é a prova mais direta de ST.
  if (simples && /^\d{4}$/.test(soDigitos(cfopCompra))) {
    const st = tabelas.CFOP_COMPRA_COM_ST.has(soDigitos(cfopCompra));
    return {
      cfop: st ? '5405' : '5102', cst_csosn: st ? '500' : '102',
      cest: st ? (cestNota || loja?.cest || null) : cestNota,
      fonte: `CFOP ${cfopCompra} do fornecedor${st ? ' (com ST)' : ''}`,
    };
  }
  if (loja) return { cfop: loja.cfop, cst_csosn: loja.cst_csosn, cest: cestNota || loja.cest, fonte: `${loja.produtos} produto(s) da loja com o mesmo NCM` };
  return { cfop: null, cst_csosn: null, cest: cestNota, fonte: null };
}

/** Para o formulário de produto: o que preencher a partir do NCM digitado. */
function sugerirPorNcm({ ncm, productId } = {}) {
  const db = getDb();
  const n = soDigitos(ncm);
  if (!ncmValido(n)) return { ok: false, error: 'NCM precisa ter 8 dígitos.' };
  const regime = regimeDaLoja(db);
  const loja = assistente().fiscalDaLoja(db, n, regime, productId || null);
  const simples = regime === 'simples_nacional' || regime === 'mei';
  let fiscal = null;
  if (loja) fiscal = { cfop: loja.cfop, cstCsosn: loja.cst_csosn, cest: loja.cest, fonte: `${loja.produtos} produto(s) da loja com o mesmo NCM`, padrao: false };
  else if (simples) fiscal = { cfop: '5102', cstCsosn: '102', cest: null, fonte: 'padrão do Simples sem ST: confira se o produto tem ST', padrao: true };
  return { ok: true, ncm: n, fiscal, categoria: categoriaPorNcm(db, n) };
}

// ---------- produtos novos a partir da nota ----------

function configCadastro(db) {
  const c = db.prepare("SELECT margem_padrao, arredondamento_preco FROM erp_config WHERE id = 'default'").get() || {};
  return { margemPadrao: c.margem_padrao ?? null, arredondamento: ARREDONDAMENTOS.includes(c.arredondamento_preco) ? c.arredondamento_preco : 'x9' };
}

/**
 * Prévia (e, com aplicar=true, o cadastro) dos itens da nota que não casaram
 * com nenhum produto. Cada item vira um produto; se o EAN da unidade já
 * existe num produto ativo, só vincula (não duplica).
 */
function produtosDaNota({ entradaId, margemPercentual, arredondamento, categoria, aplicar = false, operadorId } = {}) {
  const db = getDb();
  const entrada = db.prepare('SELECT * FROM nfe_entradas WHERE id = ?').get(entradaId);
  if (!entrada) return { ok: false, error: 'Nota não encontrada.' };
  if (entrada.status !== 'rascunho') return { ok: false, error: 'Esta nota já foi confirmada ou estornada.' };
  const cfg = configCadastro(db);
  const margem = margemPercentual === undefined || margemPercentual === '' || margemPercentual === null ? cfg.margemPadrao : Number(margemPercentual);
  const modo = arredondamento || cfg.arredondamento;
  if (aplicar && !(Number.isFinite(margem) && margem >= 0 && margem <= 1000)) return { ok: false, error: 'Informe a margem sobre o custo (0 a 1000%).' };
  if (!ARREDONDAMENTOS.includes(modo)) return { ok: false, error: 'Arredondamento inválido.' };
  const categoriaFixa = String(categoria || '').trim() || null;

  const { parseNFeXml } = require('./nfeXmlParser');
  const nfe = require('./nfeEntradaService');
  const lida = parseNFeXml(entrada.xml);
  const extras = new Map((lida.ok ? lida.nota.itens : []).map((i) => [i.nItem, i]));
  const regime = regimeDaLoja(db);
  const itens = db.prepare('SELECT * FROM nfe_entrada_itens WHERE entrada_id = ? AND ignorar = 0 AND product_id IS NULL ORDER BY n_item').all(entradaId);

  const plano = itens.map((item) => {
    const x = extras.get(item.n_item) || {};
    const fatorCaixa = x.quantidadeTributavel > 0 && x.quantidade > 0 ? Math.round((x.quantidadeTributavel / x.quantidade) * 10000) / 10000 : 1;
    const vendeNaUnidade = fatorCaixa > 1 && x.unidadeTributavel && x.unidadeTributavel !== x.unidade;
    const fator = vendeNaUnidade ? fatorCaixa : 1;
    const ean = (vendeNaUnidade ? x.eanTributavel : (x.ean || x.eanTributavel)) || (vendeNaUnidade ? '' : item.ean) || null;
    const { custoUnitario } = nfe.calcularItem({ ...item, fator });
    const ncm = ncmValido(soDigitos(item.ncm)) ? soDigitos(item.ncm) : null;
    const fiscal = fiscalSugerido(db, { ncm, cest: item.cest, cfopCompra: item.cfop, regime });
    const existente = ean ? db.prepare('SELECT id, nome, ativo FROM products WHERE codigo_barras = ?').get(ean) : null;
    return {
      itemId: item.id, descricao: item.descricao,
      acao: existente?.ativo ? 'vincular' : 'criar',
      productIdExistente: existente?.ativo ? existente.id : null,
      nomeExistente: existente?.nome || null,
      eanEmProdutoInativo: !!(existente && !existente.ativo),
      nome: nomeDoProduto(item.descricao, { tirarEmbalagem: vendeNaUnidade }),
      codigoBarras: existente && !existente.ativo ? null : ean,
      unidade: unidadeDoApp(vendeNaUnidade ? x.unidadeTributavel : (x.unidade || item.unidade_nota)),
      fator, custo: custoUnitario,
      preco: Number.isFinite(margem) ? precoSugerido(custoUnitario, margem, modo) : null,
      categoria: categoriaFixa || categoriaPorNcm(db, ncm),
      ncm, cest: fiscal.cest, cfop: fiscal.cfop, cstCsosn: fiscal.cst_csosn, fonteFiscal: fiscal.fonte,
    };
  });
  if (!aplicar) return { ok: true, margem, arredondamento: modo, itens: plano };
  if (plano.length === 0) return { ok: true, criados: 0, vinculados: 0, avisos: [] };

  const productService = require('./productService');
  const avisos = [];
  let criados = 0;
  let vinculados = 0;
  try {
    db.transaction(() => {
      for (const p of plano) {
        let productId = p.productIdExistente;
        // Duas linhas da mesma nota com o mesmo EAN: a segunda só vincula.
        const jaCriado = p.acao === 'criar' && p.codigoBarras
          ? db.prepare('SELECT id FROM products WHERE codigo_barras = ? AND ativo = 1').get(p.codigoBarras) : null;
        if (jaCriado) { productId = jaCriado.id; p.acao = 'vincular'; }
        if (p.acao === 'criar') {
          const r = productService.upsert({
            nome: p.nome, codigoBarras: p.codigoBarras, categoria: p.categoria, preco: p.preco, custo: p.custo,
            unidade: p.unidade, estoqueMinimo: 0, ncm: p.ncm, cest: p.cest, cfop: p.cfop, cstCsosn: p.cstCsosn,
            fornecedorId: entrada.fornecedor_id || null, operadorId,
          });
          if (!r.ok) throw new Error(`"${p.descricao}": ${r.error}`);
          productId = r.id;
          criados += 1;
          if (p.eanEmProdutoInativo) avisos.push(`"${p.nome}" foi cadastrado sem código de barras: o código da nota pertence a um produto desativado.`);
          if (!p.cfop) avisos.push(`"${p.nome}" ficou sem CFOP/CSOSN: confira no Fiscal → Cadastro fiscal.`);
        } else {
          vinculados += 1;
        }
        db.prepare('UPDATE nfe_entrada_itens SET product_id = ?, fator = ? WHERE id = ?').run(productId, p.fator, p.itemId);
      }
      db.prepare("INSERT INTO erp_config (id) VALUES ('default') ON CONFLICT(id) DO NOTHING").run();
      db.prepare("UPDATE erp_config SET margem_padrao = ?, arredondamento_preco = ? WHERE id = 'default'").run(margem, modo);
      db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
        .run(randomUUID(), 'produtos_cadastrados_da_nota', operadorId || null,
          `NF-e ${entrada.numero}: ${criados} produto(s) cadastrado(s) automaticamente, ${vinculados} vinculado(s) pelo código de barras; margem ${margem}%.`);
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, criados, vinculados, avisos };
}

// ---------- NCM pela IA ----------

async function sugerirNcmComIA({ productIds, limite = 30 } = {}) {
  const db = getDb();
  const max = Math.min(Math.max(Number(limite) || 30, 1), 60);
  const lista = Array.isArray(productIds) && productIds.length
    ? productIds.slice(0, max).map((id) => db.prepare('SELECT id, nome, ncm FROM products WHERE id = ? AND ativo = 1').get(id)).filter(Boolean)
    : db.prepare(`SELECT id, nome, ncm FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') = 'produto'
                  AND (ncm IS NULL OR length(ncm) != 8 OR ncm = '00000000') ORDER BY nome LIMIT ?`).all(max);
  const alvo = lista.filter((p) => !ncmValido(soDigitos(p.ncm)));
  if (alvo.length === 0) return { ok: true, sugestoes: [] };
  const r = await require('./aiService').sugerirNcm(alvo.map((p) => ({ id: p.id, nome: p.nome })));
  if (!r.ok) return r;
  const porId = new Map(alvo.map((p) => [p.id, p]));
  const regime = regimeDaLoja(db);
  const sugestoes = [];
  for (const s of r.sugestoes) {
    const p = porId.get(s?.produtoId);
    const ncm = soDigitos(s?.ncm);
    if (!p || !ncmValido(ncm)) continue;
    const cest = cestValido(soDigitos(s.cest)) ? soDigitos(s.cest) : null;
    const loja = assistente().fiscalDaLoja(db, ncm, regime, p.id);
    sugestoes.push({
      productId: p.id, nome: p.nome, ncm, cest, descricao: String(s.descricao || '').slice(0, 120),
      confianca: ['alta', 'media', 'baixa'].includes(s.confianca) ? s.confianca : 'baixa',
      fiscalDaLoja: loja ? { cfop: loja.cfop, cstCsosn: loja.cst_csosn, produtos: loja.produtos } : null,
    });
    porId.delete(p.id);
  }
  return { ok: true, sugestoes, semSugestao: [...porId.values()].map((p) => ({ productId: p.id, nome: p.nome })) };
}

/** Grava o NCM conferido (só onde está vazio/inválido) e completa o resto pelo assistente. */
function aplicarNcm({ itens, operadorId } = {}) {
  const db = getDb();
  if (!Array.isArray(itens) || itens.length === 0) return { ok: false, error: 'Nada para aplicar.' };
  if (itens.length > 500) return { ok: false, error: 'Máximo de 500 produtos por vez.' };
  for (const i of itens) {
    if (!ncmValido(soDigitos(i?.ncm))) return { ok: false, error: `NCM inválido: ${i?.ncm}` };
    if (i.cest && !cestValido(soDigitos(i.cest))) return { ok: false, error: `CEST inválido: ${i.cest}` };
  }
  const ids = [];
  db.transaction(() => {
    for (const i of itens) {
      const p = db.prepare('SELECT id, ncm, cest FROM products WHERE id = ? AND ativo = 1').get(i.productId);
      if (!p || ncmValido(soDigitos(p.ncm))) continue;
      db.prepare('UPDATE products SET ncm = ?, cest = COALESCE(NULLIF(TRIM(cest), \'\'), ?) WHERE id = ?')
        .run(soDigitos(i.ncm), i.cest ? soDigitos(i.cest) : null, p.id);
      ids.push(p.id);
    }
    if (ids.length) {
      db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
        .run(randomUUID(), 'fiscal_ncm_aplicado', operadorId || null, `NCM conferido e gravado em ${ids.length} produto(s) (sugestão da IA).`);
    }
  })();
  // Com o NCM no lugar, o assistente completa CFOP/CSOSN pelo que a loja já usa.
  const completou = ids.length ? assistente().aplicarSugestoes({ productIds: ids, operadorId }) : { alterados: 0 };
  return { ok: true, ncmGravados: ids.length, completadosPelaLoja: completou.alterados || 0 };
}

// ---------- reajuste de preço pela margem ----------

function paraUpsert(p) {
  let customFields = {};
  try { customFields = JSON.parse(p.custom_fields || '{}') || {}; } catch { customFields = {}; }
  return {
    id: p.id, sku: p.sku, codigoBarras: p.codigo_barras, nome: p.nome, categoria: p.categoria, preco: p.preco,
    custo: p.custo, unidade: p.unidade, estoqueMinimo: p.estoque_minimo, ncm: p.ncm, cest: p.cest, cfop: p.cfop,
    cstCsosn: p.cst_csosn, origemMercadoria: p.origem_mercadoria, customFields, codigoBalanca: p.codigo_balanca,
    tipo: p.tipo, fornecedorId: p.fornecedor_id,
  };
}

/**
 * Depois de uma entrada: produtos da nota cujo preço ficou abaixo do custo
 * (médio, já recalculado) + margem padrão. Só sugere; aplicar é outra chamada.
 */
function reajustePorMargem({ entradaId, margemPercentual, arredondamento } = {}) {
  const db = getDb();
  const cfg = configCadastro(db);
  const margem = margemPercentual === undefined || margemPercentual === null || margemPercentual === '' ? cfg.margemPadrao : Number(margemPercentual);
  const modo = arredondamento || cfg.arredondamento;
  if (!(Number.isFinite(margem) && margem >= 0)) return { ok: true, margem: null, itens: [] };
  const produtos = db.prepare(
    `SELECT DISTINCT p.id, p.nome, p.preco, p.custo FROM nfe_entrada_itens i JOIN products p ON p.id = i.product_id
     WHERE i.entrada_id = ? AND i.ignorar = 0 AND p.ativo = 1`
  ).all(entradaId);
  const itens = [];
  for (const p of produtos) {
    const sugerido = precoSugerido(p.custo, margem, modo);
    if (sugerido > 0 && Number(p.preco) + 0.004 < sugerido) {
      const margemAtual = p.custo > 0 ? Math.round(((p.preco / p.custo) - 1) * 1000) / 10 : null;
      itens.push({ productId: p.id, nome: p.nome, custo: p.custo, precoAtual: p.preco, precoSugerido: sugerido, margemAtual });
    }
  }
  return { ok: true, margem, arredondamento: modo, itens };
}

/** Grava os preços escolhidos. Confere o preço anterior (alguém pode ter mudado no meio tempo). */
function aplicarReajuste({ itens, operadorId } = {}) {
  const db = getDb();
  if (!Array.isArray(itens) || itens.length === 0) return { ok: false, error: 'Nada para aplicar.' };
  const productService = require('./productService');
  let aplicados = 0;
  try {
    db.transaction(() => {
      for (const i of itens) {
        const preco = Math.round(Number(i.preco) * 100) / 100;
        if (!(preco > 0) || preco > 1e7) throw new Error('Preço inválido.');
        const p = db.prepare('SELECT * FROM products WHERE id = ? AND ativo = 1').get(i.productId);
        if (!p) continue;
        if (i.precoAnterior != null && Math.abs(Number(i.precoAnterior) - Number(p.preco)) > 0.004) {
          throw new Error(`O preço de "${p.nome}" mudou enquanto você conferia. Abra de novo.`);
        }
        const r = productService.upsert({ ...paraUpsert(p), preco, operadorId });
        if (!r.ok) throw new Error(r.error);
        aplicados += 1;
      }
      db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
        .run(randomUUID(), 'precos_reajustados_pela_margem', operadorId || null, `Preço de ${aplicados} produto(s) reajustado(s) pela margem padrão depois da entrada da nota.`);
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, aplicados };
}

module.exports = {
  reajustePorMargem, aplicarReajuste,
  nomeDoProduto, unidadeDoApp, arredondarPreco, precoSugerido, categoriaPorNcm, fiscalSugerido, sugerirPorNcm,
  produtosDaNota, sugerirNcmComIA, aplicarNcm, configCadastro, ARREDONDAMENTOS,
};
