const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function fotosDir() {
  const dir = path.join(app.getPath('userData'), 'fotos-produtos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function inferMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/** Copia a foto escolhida pelo usuário para a pasta de dados do app e associa ao produto. */
function setFoto(productId, sourceFilePath) {
  const db = getDb();
  const ext = path.extname(sourceFilePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return { ok: false, error: 'Formato não suportado. Envie PNG, JPG ou WEBP.' };
  }

  const destPath = path.join(fotosDir(), `${productId}${ext}`);
  fs.copyFileSync(sourceFilePath, destPath);
  db.prepare('UPDATE products SET foto_path = ? WHERE id = ?').run(destPath, productId);

  return { ok: true };
}

function removeFoto(productId) {
  const db = getDb();
  const product = db.prepare('SELECT foto_path FROM products WHERE id = ?').get(productId);
  if (product?.foto_path) fs.unlink(product.foto_path, () => {});
  db.prepare('UPDATE products SET foto_path = NULL WHERE id = ?').run(productId);
  return { ok: true };
}

/** Lê a foto do disco e devolve como data URL — evita depender de file:// no renderer. */
function getFotoDataUrl(productId) {
  const db = getDb();
  const product = db.prepare('SELECT foto_path FROM products WHERE id = ?').get(productId);
  if (!product?.foto_path || !fs.existsSync(product.foto_path)) return null;

  const buffer = fs.readFileSync(product.foto_path);
  const mime = inferMime(product.foto_path);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function findByBarcode(codigoBarras) {
  const db = getDb();
  return db.prepare('SELECT * FROM products WHERE codigo_barras = ? AND ativo = 1').get(codigoBarras);
}

function findByBalancaCode(codigoBalanca) {
  const db = getDb();
  return db.prepare('SELECT * FROM products WHERE codigo_balanca = ? AND ativo = 1').get(codigoBalanca);
}

function findBySku(sku) {
  const db = getDb();
  return db.prepare('SELECT * FROM products WHERE sku = ? AND ativo = 1').get(sku);
}

/** Remove acento pra comparar — "pão" e "pao" ficam iguais. Buscar
 * rápido no meio de uma venda não deveria depender de digitar o
 * acento certo. */
function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function list({ query, categoria, limit, offset } = {}) {
  const db = getDb();

  if (query && !categoria) {
    // Busca por nome/sku/código — insensível a acento, e ranqueada por
    // relevância (nome que COMEÇA com o termo vem primeiro, depois o
    // que contém no meio, depois match só em sku/código de barras) —
    // antes era só ordem alfabética, então um produto pouco relevante
    // podia aparecer antes de um match muito melhor.
    const queryNormalizada = normalizarTexto(query);
    const queryLower = query.toLowerCase();
    const todosAtivos = db.prepare('SELECT * FROM products WHERE ativo = 1').all();

    const comRelevancia = [];
    for (const p of todosAtivos) {
      const nomeNormalizado = normalizarTexto(p.nome);
      const idxNome = nomeNormalizado.indexOf(queryNormalizada);
      const skuMatch = p.sku && String(p.sku).toLowerCase().includes(queryLower);
      const codigoMatch = p.codigo_barras && String(p.codigo_barras).includes(query);

      if (idxNome === -1 && !skuMatch && !codigoMatch) continue;

      let relevancia;
      if (idxNome === 0) relevancia = 0; // nome começa com o termo — melhor caso
      else if (idxNome > 0) relevancia = 1; // termo aparece no meio do nome
      else relevancia = 2; // só bateu em sku/código, não no nome

      comRelevancia.push({ produto: p, relevancia, idxNome: idxNome === -1 ? 9999 : idxNome });
    }

    comRelevancia.sort((a, b) =>
      a.relevancia - b.relevancia || a.idxNome - b.idxNome || a.produto.nome.localeCompare(b.produto.nome, 'pt-BR')
    );

    let resultado = comRelevancia.map((r) => r.produto);
    if (limit) resultado = resultado.slice(offset || 0, (offset || 0) + limit);
    return resultado;
  }

  const params = [];
  let sql = 'SELECT * FROM products WHERE ativo = 1';

  if (categoria) {
    sql += ' AND categoria = ?';
    params.push(categoria);
  }

  sql += ' ORDER BY nome';

  // limit/offset são opcionais — sem eles, o comportamento é exatamente
  // o de antes (usado pela busca do PDV e pela grade de categorias, que
  // já retornam conjuntos pequenos por natureza). A tela de Produtos é
  // quem usa isso pra carregar por rolagem, evitando travar com um
  // catálogo grande.
  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
    if (offset) {
      sql += ' OFFSET ?';
      params.push(offset);
    }
  }

  return db.prepare(sql).all(...params);
}

/** Categorias distintas já cadastradas — a base dos botões no PDV. Novas
 * categorias aparecem sozinhas assim que um produto usar esse nome. */
function listCategories() {
  const db = getDb();
  return db.prepare(
    `SELECT categoria, COUNT(*) as total FROM products
     WHERE ativo = 1 AND categoria IS NOT NULL AND TRIM(categoria) != ''
     GROUP BY categoria ORDER BY categoria`
  ).all();
}

/** Total de produtos ativos que batem com o mesmo filtro do list — usado
 * pra mostrar "X produtos no total" na tela, já que a rolagem infinita
 * nunca carrega o catálogo inteiro de uma vez só. */
function count({ query, categoria } = {}) {
  const db = getDb();
  const params = [];
  let sql = 'SELECT COUNT(*) as total FROM products WHERE ativo = 1';

  if (categoria) {
    sql += ' AND categoria = ?';
    params.push(categoria);
  } else if (query) {
    sql += ' AND (nome LIKE ? OR sku LIKE ? OR codigo_barras LIKE ?)';
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  return db.prepare(sql).get(...params).total;
}

function upsert(product) {
  if (!product.nome?.trim()) return { ok: false, error: 'Informe o nome do produto.' };
  if (Number.isNaN(Number(product.preco)) || Number(product.preco) < 0) {
    return { ok: false, error: 'Preço inválido.' };
  }
  if (product.custo !== undefined && (Number.isNaN(Number(product.custo)) || Number(product.custo) < 0)) {
    return { ok: false, error: 'Custo inválido.' };
  }
  if (product.estoqueMinimo !== undefined && (Number.isNaN(Number(product.estoqueMinimo)) || Number(product.estoqueMinimo) < 0)) {
    return { ok: false, error: 'Estoque mínimo inválido.' };
  }

  const db = getDb();
  const id = product.id || randomUUID();
  const customFields = JSON.stringify(product.customFields || {});
  const precoNovo = Number(product.preco) || 0;

  // Se já existir (edição), compara com o preço anterior antes de
  // sobrescrever — só registra no histórico se o preço de venda
  // realmente mudou (não dispara em toda edição de produto).
  const existente = product.id ? db.prepare('SELECT preco FROM products WHERE id = ?').get(product.id) : null;

  db.prepare(
    `INSERT INTO products (id, sku, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, ncm, cest, cfop, cst_csosn, origem_mercadoria, custom_fields, codigo_balanca)
     VALUES (@id, @sku, @codigoBarras, @nome, @categoria, @preco, @custo, @unidade, @estoqueMinimo, @ncm, @cest, @cfop, @cstCsosn, @origemMercadoria, @customFields, @codigoBalanca)
     ON CONFLICT(id) DO UPDATE SET
       sku=excluded.sku, codigo_barras=excluded.codigo_barras, nome=excluded.nome,
       categoria=excluded.categoria, preco=excluded.preco, custo=excluded.custo,
       unidade=excluded.unidade, estoque_minimo=excluded.estoque_minimo,
       ncm=excluded.ncm, cest=excluded.cest, cfop=excluded.cfop,
       cst_csosn=excluded.cst_csosn, origem_mercadoria=excluded.origem_mercadoria,
       custom_fields=excluded.custom_fields, codigo_balanca=excluded.codigo_balanca`
  ).run({
    id,
    sku: product.sku || null,
    codigoBarras: product.codigoBarras || null,
    nome: product.nome.trim(),
    categoria: product.categoria || null,
    preco: precoNovo,
    custo: Number(product.custo) || 0,
    unidade: product.unidade || 'un',
    codigoBalanca: product.codigoBalanca || null,
    estoqueMinimo: Number(product.estoqueMinimo) || 0,
    ncm: product.ncm || null,
    cest: product.cest || null,
    cfop: product.cfop || null,
    cstCsosn: product.cstCsosn || null,
    origemMercadoria: product.origemMercadoria || '0',
    customFields,
  });

  if (existente && existente.preco !== precoNovo) {
    db.prepare(
      `INSERT INTO product_price_history (id, product_id, preco_antigo, preco_novo, operador_id) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), id, existente.preco, precoNovo, product.operadorId || null);
  }

  // Sincroniza pro grupo (se essa instalação estiver em um) — nunca
  // bloqueia o cadastro local por causa disso, roda em segundo plano.
  require('./productSyncService').pushProduct({
    id, nome: product.nome.trim(), categoria: product.categoria || null, preco: precoNovo,
    custo: Number(product.custo) || 0, unidade: product.unidade || 'un', sku: product.sku || null,
    codigoBarras: product.codigoBarras || null, ncm: product.ncm || null, cest: product.cest || null,
    cfop: product.cfop || null, cstCsosn: product.cstCsosn || null,
    origemMercadoria: product.origemMercadoria || '0', estoqueMinimo: Number(product.estoqueMinimo) || 0,
    ativo: true,
  }).catch(() => {});

  return { ok: true, id };
}

/**
 * Aplica um produto vindo da sincronização do grupo — nunca dispara
 * push de volta (senão viraria um loop entre as máquinas). Não mexe
 * em estoque nenhum — só o catálogo (nome, preço, categoria etc) é
 * compartilhado; a quantidade física continua sempre local.
 */
function aplicarProdutoSincronizado(productId, dados) {
  const db = getDb();
  const jaExiste = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);

  db.prepare(
    `INSERT INTO products (id, sku, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, ncm, cest, cfop, cst_csosn, origem_mercadoria, ativo)
     VALUES (@id, @sku, @codigoBarras, @nome, @categoria, @preco, @custo, @unidade, @estoqueMinimo, @ncm, @cest, @cfop, @cstCsosn, @origemMercadoria, @ativo)
     ON CONFLICT(id) DO UPDATE SET
       sku=excluded.sku, codigo_barras=excluded.codigo_barras, nome=excluded.nome,
       categoria=excluded.categoria, preco=excluded.preco, custo=excluded.custo,
       unidade=excluded.unidade, estoque_minimo=excluded.estoque_minimo,
       ncm=excluded.ncm, cest=excluded.cest, cfop=excluded.cfop,
       cst_csosn=excluded.cst_csosn, origem_mercadoria=excluded.origem_mercadoria, ativo=excluded.ativo`
  ).run({
    id: productId,
    sku: dados.sku || null,
    codigoBarras: dados.codigoBarras || null,
    nome: dados.nome || '(sem nome)',
    categoria: dados.categoria || null,
    preco: Number(dados.preco) || 0,
    custo: Number(dados.custo) || 0,
    unidade: dados.unidade || 'un',
    estoqueMinimo: Number(dados.estoqueMinimo) || 0,
    ncm: dados.ncm || null,
    cest: dados.cest || null,
    cfop: dados.cfop || null,
    cstCsosn: dados.cstCsosn || null,
    origemMercadoria: dados.origemMercadoria || '0',
    ativo: dados.ativo === false ? 0 : 1,
  });

  return { novo: !jaExiste };
}

/** Histórico de alteração de preço de um produto, mais recente primeiro. */
function listPriceHistory(productId) {
  const db = getDb();
  return db.prepare(
    `SELECT h.*, u.nome as operador_nome FROM product_price_history h
     LEFT JOIN users u ON u.id = h.operador_id
     WHERE h.product_id = ? ORDER BY h.criado_em DESC`
  ).all(productId);
}

/**
 * Exclusão lógica — mesmo padrão de clientes/fornecedores/usuários. Nunca
 * apaga a linha de verdade, porque vendas/movimentos de estoque antigos
 * ainda referenciam esse produto (apagar de verdade quebraria o
 * histórico). O produto só some das buscas, categorias e listagens
 * (`ativo = 1` é filtrado em todo lugar).
 */
function deactivate(productId) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return { ok: false, error: 'Produto não encontrado.' };

  const estoqueAtual = db.prepare(
    `SELECT COALESCE(SUM(quantidade), 0) as total FROM stock_movements WHERE product_id = ?`
  ).get(productId).total;

  db.prepare('UPDATE products SET ativo = 0 WHERE id = ?').run(productId);
  return { ok: true, estoqueRestante: estoqueAtual };
}

/**
 * Gera um código de barras interno pra produtos sem código de fábrica
 * (fracionados, genéricos da própria loja, etc.) — derivado do próprio
 * id do produto, então já nasce único, sem precisar checar colisão com
 * outro produto.
 */
function generateInternalBarcode(productId) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return { ok: false, error: 'Produto não encontrado.' };
  if (product.codigo_barras) return { ok: false, error: 'Este produto já tem um código de barras.' };

  const codigo = 'INT' + productId.replace(/-/g, '').slice(0, 10).toUpperCase();
  db.prepare('UPDATE products SET codigo_barras = ? WHERE id = ?').run(codigo, productId);
  return { ok: true, codigoBarras: codigo };
}

/** Pratos marcados como "disponível hoje" (campo extra do perfil
 * Restaurante) — pro cardápio do dia. Agrupa por tipo de prato (outro
 * campo extra do mesmo perfil) quando preenchido. */
function listDailyMenu() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, nome, preco, custom_fields FROM products
     WHERE ativo = 1 AND json_extract(custom_fields, '$.disponivel_hoje') = 1
     ORDER BY nome`
  ).all();
  return rows.map((r) => {
    const custom = JSON.parse(r.custom_fields || '{}');
    return { id: r.id, nome: r.nome, preco: r.preco, tipo: custom.tipo_prato || '' };
  });
}

/** Todos os pratos com tipo definido (perfil Restaurante/Padaria) —
 * usado no cardápio digital, que é o cardápio permanente (diferente do
 * "disponível hoje", que muda dia a dia). */
function listFullMenu() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, nome, preco, custom_fields FROM products
     WHERE ativo = 1 AND json_extract(custom_fields, '$.tipo_prato') IS NOT NULL
       AND json_extract(custom_fields, '$.tipo_prato') != ''
     ORDER BY nome`
  ).all();
  return rows.map((r) => {
    const custom = JSON.parse(r.custom_fields || '{}');
    return { id: r.id, nome: r.nome, preco: r.preco, tipo: custom.tipo_prato || '' };
  });
}

/**
 * Limpa o catálogo inteiro — pensado pra trocar de dado de teste (ex:
 * de farmácia pra padaria) sem carregar produto antigo junto, e sem
 * risco de colidir SKU/código de barras numa importação nova.
 *
 * Pra cada produto ativo: tenta apagar de vez (junto com histórico de
 * preço, ficha técnica, desperdício, lote e movimentação de estoque —
 * tudo isso é seguro de apagar). Se o produto já tem VENDA ou
 * DEVOLUÇÃO de verdade vinculada, o apagar é bloqueado pela própria
 * integridade do banco (chave estrangeira) — nesse caso, em vez de
 * falhar, só desativa e libera o SKU/código de barras/código de
 * balança (pra poder reimportar os mesmos códigos depois), preservando
 * o histórico intacto.
 */
function clearAllProducts() {
  const db = getDb();
  const produtos = db.prepare('SELECT id FROM products WHERE ativo = 1').all();
  let apagados = 0;
  let desativados = 0;

  const tx = db.transaction(() => {
    for (const p of produtos) {
      db.prepare('DELETE FROM product_price_history WHERE product_id = ?').run(p.id);
      db.prepare('DELETE FROM dish_ingredients WHERE product_id = ?').run(p.id);
      db.prepare('DELETE FROM waste_log WHERE product_id = ?').run(p.id);
      db.prepare('DELETE FROM product_batches WHERE product_id = ?').run(p.id);
      db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(p.id);

      try {
        db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
        apagados++;
      } catch (err) {
        // Tem venda ou devolução de verdade vinculada — a chave
        // estrangeira bloqueou o apagar. Só desativa e libera os
        // códigos, sem mexer no histórico.
        db.prepare(
          `UPDATE products SET ativo = 0, sku = NULL, codigo_barras = NULL, codigo_balanca = NULL WHERE id = ?`
        ).run(p.id);
        desativados++;
      }
    }
  });
  tx();

  return { ok: true, apagados, desativados };
}

module.exports = { findByBarcode, findByBalancaCode, findBySku, list, listCategories, count, upsert, setFoto, removeFoto, getFotoDataUrl, deactivate, generateInternalBarcode, listPriceHistory, listDailyMenu, listFullMenu, clearAllProducts, aplicarProdutoSincronizado };
