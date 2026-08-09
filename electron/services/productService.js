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
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function list({ query, categoria, limit, offset, cursorNome, cursorId } = {}) {
  const db = getDb();

  if (query && !categoria) {
    // Busca por nome — o critério principal é o nome COMEÇAR com o
    // termo digitado (ex: buscar "dipirona" acha "Dipirona 500mg",
    // "Dipirona Gotas", etc) — e SE existe pelo menos um produto
    // assim, a lista mostra só esses (ordenados por nome), sem
    // misturar com correspondências soltas no meio de outros nomes.
    // Antes, tudo entrava junto (início do nome, início de palavra no
    // meio, e até meio de palavra), e um catálogo com muitos produtos
    // do mesmo tipo (uma linha inteira de produtos com nomes
    // parecidos) enterrava o que a pessoa procurava lá embaixo, longe
    // dos 8 primeiros que a tela do PDV mostra.
    //
    // Só cai pra uma busca mais solta (início de palavra em qualquer
    // lugar do nome, depois meio de palavra) quando NENHUM produto
    // começa com o termo — pra continuar achando alguma coisa quando
    // a pessoa não lembra exatamente como o nome começa, em vez de
    // simplesmente não devolver nada.
    const queryNormalizada = normalizarTexto(query);
    const queryLower = query.toLowerCase();
    const todosAtivos = db.prepare('SELECT * FROM products WHERE ativo = 1').all();

    const comecamComOTermo = [];
    const outrosMatches = [];
    for (const p of todosAtivos) {
      const nomeNormalizado = normalizarTexto(p.nome);
      const idxNome = nomeNormalizado.indexOf(queryNormalizada);
      const skuMatch = p.sku && String(p.sku).toLowerCase().includes(queryLower);
      const codigoMatch = p.codigo_barras && String(p.codigo_barras).includes(query);

      if (idxNome === 0) {
        comecamComOTermo.push(p);
        continue;
      }
      if (idxNome === -1 && !skuMatch && !codigoMatch) continue;

      let relevancia;
      if (idxNome > 0 && nomeNormalizado[idxNome - 1] === ' ') relevancia = 1; // início de palavra no meio
      else if (idxNome > 0) relevancia = 2; // meio de palavra
      else relevancia = 3; // só sku/código
      outrosMatches.push({ produto: p, relevancia, idxNome: idxNome === -1 ? 9999 : idxNome });
    }

    let resultado;
    if (comecamComOTermo.length > 0) {
      comecamComOTermo.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      resultado = comecamComOTermo;
    } else {
      outrosMatches.sort((a, b) =>
        a.relevancia - b.relevancia || a.idxNome - b.idxNome || a.produto.nome.localeCompare(b.produto.nome, 'pt-BR')
      );
      resultado = outrosMatches.map((r) => r.produto);
    }

    if (limit) {
      // Cursor por ID em vez de offset numérico — a lista é
      // recalculada do zero a cada chamada (é uma busca por
      // relevância, não uma coluna simples do banco pra usar direto
      // num WHERE), então um offset numérico sofreria do mesmo
      // problema do catálogo geral: um produto novo cadastrado entre
      // uma página e outra da rolagem desloca as posições, repetindo
      // o último item da página anterior. Achar pelo ID do último
      // item já visto é imune a isso — sempre pega "o que vem depois
      // dele", nunca "a partir da posição N".
      if (cursorId) {
        const indiceCursor = resultado.findIndex((p) => p.id === cursorId);
        resultado = indiceCursor === -1 ? [] : resultado.slice(indiceCursor + 1, indiceCursor + 1 + limit);
      } else {
        resultado = resultado.slice(offset || 0, (offset || 0) + limit);
      }
    }
    return resultado;
  }

  const params = [];
  let sql = 'SELECT * FROM products WHERE ativo = 1';

  if (categoria) {
    sql += ' AND categoria = ?';
    params.push(categoria);
  }

  // Paginação por CURSOR (baseada no último item visto), não por
  // OFFSET (posição numérica) — offset sozinho, mesmo com desempate
  // por id na ordenação, ainda quebra quando um produto é
  // cadastrado/editado ENQUANTO a pessoa está rolando a lista: um
  // registro novo entrando ANTES da posição do offset empurra tudo
  // uma casa, fazendo a última linha da página anterior aparecer de
  // novo na página seguinte — duas linhas com a mesma "key" no React,
  // que quebra a lista de um jeito bem estranho de diagnosticar
  // (linhas antigas ficam presas na tela mesmo depois de uma busca
  // nova substituir os dados). É exatamente o "funciona quando abre,
  // para de funcionar depois de um tempo de uso" — quanto mais tempo
  // rolando, maior a chance de pegar uma modificação no meio do
  // caminho (edição de produto, sincronização de outra máquina, etc).
  // Cursor não sofre disso: sempre pede "o que vem depois do último
  // que eu vi", nunca "a partir da posição N".
  if (cursorNome !== undefined && cursorId !== undefined) {
    sql += ' AND (nome > ? OR (nome = ? AND id > ?))';
    params.push(cursorNome, cursorNome, cursorId);
  }

  sql += ' ORDER BY nome, id';

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
/** Quantos produtos ativos estão com conflito de código de barras
 * pendente de resolver — usado pro aviso no menu lateral do app. */
function countConflitosCodigoBarrasPendentes() {
  const db = getDb();
  return db.prepare(
    `SELECT COUNT(*) as total FROM products WHERE conflito_codigo_barras_pendente IS NOT NULL AND ativo = 1`
  ).get().total;
}

function count({ query, categoria } = {}) {
  const db = getDb();

  if (query && !categoria) {
    // Precisa ser exatamente a mesma lógica de list() (prioriza quem
    // começa com o termo, só cai pro resto quando não tem nenhum
    // assim) — senão a paginação da tela de Produtos "acha" que tem
    // mais resultado do que list() realmente devolve, ou o contrário.
    return list({ query }).length;
  }

  const params = [];
  let sql = 'SELECT COUNT(*) as total FROM products WHERE ativo = 1';
  if (categoria) {
    sql += ' AND categoria = ?';
    params.push(categoria);
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

  // Confere ANTES de tentar salvar se o código de barras já pertence
  // a outro produto — sem isso, o erro cru do banco (UNIQUE constraint
  // failed) vazava direto pra tela, sem dizer qual produto já usa
  // aquele código nem o que fazer a respeito.
  if (product.codigoBarras) {
    const outroComEsseCodigo = db.prepare(
      'SELECT id, nome FROM products WHERE codigo_barras = ? AND id != ? AND ativo = 1'
    ).get(product.codigoBarras, id);
    if (outroComEsseCodigo) {
      return {
        ok: false,
        error: `Esse código de barras já está cadastrado em outro produto: "${outroComEsseCodigo.nome}". Cada código só pode pertencer a um produto — ajuste o código aqui ou vá no outro produto e libere ele primeiro.`,
      };
    }
  }

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
       custom_fields=excluded.custom_fields, codigo_balanca=excluded.codigo_balanca,
       conflito_codigo_barras_pendente=NULL`
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
    `INSERT INTO products (id, sku, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, ncm, cest, cfop, cst_csosn, origem_mercadoria, ativo, conflito_codigo_barras_pendente)
     VALUES (@id, @sku, @codigoBarras, @nome, @categoria, @preco, @custo, @unidade, @estoqueMinimo, @ncm, @cest, @cfop, @cstCsosn, @origemMercadoria, @ativo, @conflitoCodigoBarrasPendente)
     ON CONFLICT(id) DO UPDATE SET
       sku=excluded.sku, codigo_barras=excluded.codigo_barras, nome=excluded.nome,
       categoria=excluded.categoria, preco=excluded.preco, custo=excluded.custo,
       unidade=excluded.unidade, estoque_minimo=excluded.estoque_minimo,
       ncm=excluded.ncm, cest=excluded.cest, cfop=excluded.cfop,
       cst_csosn=excluded.cst_csosn, origem_mercadoria=excluded.origem_mercadoria, ativo=excluded.ativo,
       conflito_codigo_barras_pendente=excluded.conflito_codigo_barras_pendente`
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
    // Só usado quando esse produto está sendo salvo SEM o código de
    // barras por causa de um conflito — guarda qual seria, pra dar pra
    // achar e resolver depois. undefined vira NULL normalmente aqui.
    conflitoCodigoBarrasPendente: dados.conflitoCodigoBarrasPendente || null,
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

  // Libera o código de barras e o SKU ao desativar — sem isso, um
  // produto excluído continua "segurando" o código pra sempre (fica
  // invisível na busca, que só mostra ativos, mas o UNIQUE constraint
  // do banco não liga pra isso e recusa qualquer outro produto tentar
  // usar o mesmo código, sem dar nenhuma pista visível do motivo).
  db.prepare('UPDATE products SET ativo = 0, codigo_barras = NULL, sku = NULL WHERE id = ?').run(productId);

  // Avisa o grupo de sincronização (se tiver) que esse produto foi
  // excluído — sem isso, a próxima sincronização podia trazer ele de
  // volta, já que a outra máquina continuaria mandando a própria
  // cópia dele sem saber que foi excluído aqui.
  try {
    require('./productSyncService').marcarProdutoExcluidoNoGrupo(productId);
  } catch (err) {
    console.error('[productService] falha ao avisar o grupo sobre produto excluído (não afeta a exclusão local):', err);
  }

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

/**
 * Acha produtos com o MESMO nome (ignorando maiúsculas/espaços nas
 * pontas) — o cenário mais comum é duas máquinas cadastrando
 * independentemente "o mesmo" produto de verdade antes de nunca
 * terem sincronizado, cada uma com seu próprio ID. Agrupa pra você
 * decidir qual manter.
 */
/**
 * Casa uma lista de candidatos (`{ nome, codigoBarras }` — pode vir de
 * uma planilha antiga ou do catálogo do grupo sincronizado, tanto faz
 * a origem) contra os produtos ATIVOS locais, por nome — usado pra
 * re-vincular código de barras que sumiu, sem nunca criar produto
 * novo. Compartilhado entre a importação de planilha e a consulta ao
 * grupo, pra não duplicar essa lógica em dois lugares.
 */
function casarCandidatosPorNome(candidatos) {
  const db = getDb();
  const produtosAtivos = db.prepare('SELECT id, nome, codigo_barras FROM products WHERE ativo = 1').all();

  const porNomeNormalizado = new Map();
  for (const p of produtosAtivos) {
    const chave = normalizarTexto(p.nome);
    if (porNomeNormalizado.has(chave)) porNomeNormalizado.set(chave, 'AMBIGUO');
    else porNomeNormalizado.set(chave, p);
  }
  const codigoJaEmUsoAtivo = new Map(produtosAtivos.filter((p) => p.codigo_barras).map((p) => [p.codigo_barras, p.nome]));

  const casados = [];
  const naoEncontrados = [];
  const ambiguos = [];
  const conflitos = [];

  for (const c of candidatos) {
    const nomeCandidato = String(c.nome || '').trim();
    const codigoCandidato = String(c.codigoBarras || '').trim();
    if (!nomeCandidato || !codigoCandidato) continue;

    const match = porNomeNormalizado.get(normalizarTexto(nomeCandidato));
    if (!match) { naoEncontrados.push({ nomePlanilha: nomeCandidato, codigoPlanilha: codigoCandidato }); continue; }
    if (match === 'AMBIGUO') { ambiguos.push({ nomePlanilha: nomeCandidato, codigoPlanilha: codigoCandidato }); continue; }

    const donoAtual = codigoJaEmUsoAtivo.get(codigoCandidato);
    if (donoAtual && donoAtual !== match.nome) {
      conflitos.push({ nomePlanilha: nomeCandidato, codigoPlanilha: codigoCandidato, jaPertenceA: donoAtual });
      continue;
    }

    if (match.codigo_barras === codigoCandidato) continue; // já está certo

    casados.push({
      productId: match.id, nomeAtual: match.nome,
      codigoBarrasAntigo: match.codigo_barras || null, codigoBarrasNovo: codigoCandidato,
    });
  }

  return { casados, naoEncontrados, ambiguos, conflitos };
}

function findDuplicateProducts() {
  const db = getDb();
  const produtos = db.prepare(
    `SELECT p.*, COALESCE(SUM(sm.quantidade), 0) as estoque_atual
     FROM products p LEFT JOIN stock_movements sm ON sm.product_id = p.id
     WHERE p.ativo = 1 GROUP BY p.id`
  ).all();

  const porNomeNormalizado = new Map();
  for (const p of produtos) {
    const chave = p.nome.trim().toUpperCase();
    if (!porNomeNormalizado.has(chave)) porNomeNormalizado.set(chave, []);
    porNomeNormalizado.get(chave).push(p);
  }

  return [...porNomeNormalizado.values()].filter((grupo) => grupo.length > 1);
}

const TABELAS_COM_PRODUCT_ID = [
  'product_price_history', 'dish_ingredients', 'waste_log',
  'product_batches', 'stock_movements', 'sale_items', 'return_items',
];

/**
 * Mescla dois produtos duplicados num só — todo o histórico
 * (vendas, movimentos de estoque, lotes, devoluções, etc) do produto
 * removido é realocado pro produto mantido, então nada se perde: o
 * estoque atual do produto mantido passa a refletir a SOMA dos dois
 * automaticamente (é a soma dos movimentos, que agora apontam todos
 * pro mesmo produto).
 *
 * Se essa instalação estiver num grupo de sincronização, avisa o
 * grupo que o produto removido não existe mais (senão a próxima
 * sincronização traria ele de volta).
 */
function mergeProducts({ manterId, removerId, currentOperatorId }) {
  const db = getDb();
  if (manterId === removerId) return { ok: false, error: 'Selecione dois produtos diferentes pra mesclar.' };

  const manter = db.prepare('SELECT * FROM products WHERE id = ?').get(manterId);
  const remover = db.prepare('SELECT * FROM products WHERE id = ?').get(removerId);
  if (!manter) return { ok: false, error: 'Produto a manter não encontrado.' };
  if (!remover) return { ok: false, error: 'Produto a remover não encontrado.' };

  const tx = db.transaction(() => {
    for (const tabela of TABELAS_COM_PRODUCT_ID) {
      db.prepare(`UPDATE ${tabela} SET product_id = ? WHERE product_id = ?`).run(manterId, removerId);
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(removerId);
  });
  tx();

  try {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso)
       VALUES (?, 'produtos_mesclados', ?, ?, 1)`
    ).run(require('crypto').randomUUID(), currentOperatorId, `Mesclado "${remover.nome}" em "${manter.nome}" — histórico realocado`);
  } catch (err) { /* auditoria não deve travar a mesclagem se falhar */ }

  try {
    require('./productSyncService').marcarProdutoExcluidoNoGrupo(removerId);
  } catch (err) {
    console.error('[productService] falha ao avisar o grupo sobre produto mesclado (não afeta a mesclagem local):', err);
  }

  return { ok: true, estoqueFinal: db.prepare('SELECT COALESCE(SUM(quantidade),0) as t FROM stock_movements WHERE product_id = ?').get(manterId).t };
}

/**
 * Alerta de margem fora do padrão — compara a margem de cada produto
 * com a média da PRÓPRIA categoria dele (não um número fixo pra todo
 * catálogo, já que categorias diferentes têm margens normais bem
 * diferentes). Pega erro de precificação — ex: custo subiu num
 * abastecimento e o preço de venda nunca foi reajustado — antes que
 * vire prejuízo acumulado sem ninguém perceber. Margem negativa
 * (vendendo abaixo do custo) sempre entra, mesmo sem categoria pra
 * comparar.
 */
function alertasDeMargem({ desvioMinimoPontos = 15 } = {}) {
  const db = getDb();
  const produtos = db.prepare(
    `SELECT id, nome, categoria, preco, custo FROM products WHERE ativo = 1 AND preco > 0 AND custo > 0`
  ).all();

  const comMargem = produtos.map((p) => ({ ...p, margem: ((p.preco - p.custo) / p.preco) * 100 }));

  const porCategoria = new Map();
  for (const p of comMargem) {
    const chave = p.categoria || '(sem categoria)';
    if (!porCategoria.has(chave)) porCategoria.set(chave, []);
    porCategoria.get(chave).push(p.margem);
  }
  const mediaPorCategoria = new Map();
  for (const [chave, margens] of porCategoria) {
    mediaPorCategoria.set(chave, margens.reduce((a, b) => a + b, 0) / margens.length);
  }

  const alertas = [];
  for (const p of comMargem) {
    const chave = p.categoria || '(sem categoria)';
    const margemNegativa = p.margem < 0;

    if (!margemNegativa) {
      // Sem pelo menos outro produto na mesma categoria pra comparar,
      // não dá pra saber se essa margem é normal ou fora do padrão.
      if (porCategoria.get(chave).length < 2) continue;
      const media = mediaPorCategoria.get(chave);
      const desvio = media - p.margem;
      if (desvio < desvioMinimoPontos) continue;
      alertas.push({
        id: p.id, nome: p.nome, categoria: p.categoria,
        margem: Number(p.margem.toFixed(1)), mediaCategoria: Number(media.toFixed(1)), margemNegativa: false,
      });
    } else {
      alertas.push({ id: p.id, nome: p.nome, categoria: p.categoria, margem: Number(p.margem.toFixed(1)), mediaCategoria: null, margemNegativa: true });
    }
  }

  return alertas.sort((a, b) => a.margem - b.margem);
}

/**
 * "Quem compra isso, compra aquilo" — olha o histórico de vendas
 * de verdade pra achar quais produtos costumam ser comprados JUNTO
 * com o produto dado, na mesma venda. Não é uma regra que alguém
 * configurou, é o comportamento real dos seus clientes. Exige pelo
 * menos 2 ocorrências juntos, pra não sugerir uma combinação que só
 * aconteceu por acaso uma vez.
 */
function findAlsoBoughtWith(productId, { limit = 3, minimoOcorrencias = 2 } = {}) {
  const db = getDb();
  return db.prepare(
    `SELECT p.id, p.nome, p.preco, COUNT(DISTINCT si1.sale_id) as vezesJuntos
     FROM sale_items si1
     JOIN sale_items si2 ON si2.sale_id = si1.sale_id AND si2.product_id != si1.product_id
     JOIN sales s ON s.id = si1.sale_id
     JOIN products p ON p.id = si2.product_id
     WHERE si1.product_id = ? AND si1.cancelado = 0 AND si2.cancelado = 0
       AND s.status = 'finalizada' AND p.ativo = 1
     GROUP BY si2.product_id
     HAVING vezesJuntos >= ?
     ORDER BY vezesJuntos DESC
     LIMIT ?`
  ).all(productId, minimoOcorrencias, limit);
}

module.exports = { findByBarcode, findByBalancaCode, findBySku, list, listCategories, count, upsert, setFoto, removeFoto, getFotoDataUrl, deactivate, generateInternalBarcode, listPriceHistory, listDailyMenu, listFullMenu, clearAllProducts, aplicarProdutoSincronizado, countConflitosCodigoBarrasPendentes, findDuplicateProducts, mergeProducts, casarCandidatosPorNome, alertasDeMargem, findAlsoBoughtWith };
