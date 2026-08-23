const { readSheetAsRows, writeRowsAsSheet } = require('./xlsxHelpers');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const ingredientService = require('./ingredientService');

// Ordem e nomes precisam bater com /templates/modelo_importacao_estoque.xlsx
// (ver scripts/gerar_template_importacao.js, que GERA esse arquivo a
// partir desta mesma constante -- fonte única, pra planilha e código
// nunca ficarem dessincronizados de novo).
const COLUNAS_BASE_ANTES = [
  'sku', 'codigo_barras', 'nome', 'categoria', 'preco_venda', 'custo', 'unidade',
  'estoque_minimo', 'quantidade_estoque_inicial',
];
const COLUNAS_BASE_DEPOIS = ['fornecedor', 'ncm', 'cfop', 'cst_csosn', 'origem_mercadoria'];

/**
 * "Campos extras" de cada perfil de negócio nativo (ver
 * seedProfileIfMissing em database.js) -- cada chave aqui vira uma coluna
 * a mais na planilha e cai direto em products.custom_fields, no mesmo
 * formato que o formulário de Produto já grava manualmente (ver
 * "Campos do perfil" em ProductForm.jsx). É a união de TODOS os perfis
 * nativos numa planilha só, pra ela servir pra qualquer tipo de negócio
 * de uma vez -- uma farmácia importando não precisa se preocupar com as
 * colunas de ótica/petshop/etc., que ficam simplesmente em branco.
 *
 * Lista fixa de propósito (não é lida dinamicamente de custom_profiles):
 * o formato da planilha é um contrato versionado, documentado no arquivo
 * modelo -- se fosse montado a partir do banco, o mesmo .xlsx pronto
 * pararia de bater com uma instalação onde alguém criou/editou um perfil
 * customizado. Um perfil TOTALMENTE customizado (campo que não está
 * nesta lista) continua precisando ser preenchido na tela de Produto --
 * só os campos dos perfis nativos entram por planilha.
 */
const CAMPOS_EXTRAS_CONHECIDOS = [
  ['lote', 'texto'],                        // farmácia
  ['validade', 'data'],                     // farmácia, petshop, armazém, salão, padaria
  ['principio_ativo', 'texto'],             // farmácia
  ['controlado', 'boolean'],                // farmácia
  ['exige_receita', 'boolean'],             // farmácia
  ['especie_animal', 'texto'],              // petshop
  ['peso_volume', 'texto'],                 // petshop
  ['exige_receita_veterinaria', 'boolean'], // petshop
  ['peso_liquido', 'texto'],                // armazém/mercearia
  ['perecivel', 'boolean'],                 // armazém/mercearia
  ['uso_profissional', 'boolean'],          // salão de beleza
  ['peso_gramas', 'texto'],                 // padaria/confeitaria
  ['tamanho', 'texto'],                     // loja de roupas
  ['cor', 'texto'],                         // loja de roupas
  ['grau', 'texto'],                        // ótica
  ['tipo_lente', 'texto'],                  // ótica
  ['garantia_meses', 'numero'],             // material de construção
  ['tipo_prato', 'texto'],                  // restaurante
  ['tempo_preparo', 'numero'],              // restaurante
  ['disponivel_hoje', 'boolean'],           // restaurante
];

const COLUMNS = [
  ...COLUNAS_BASE_ANTES,
  ...CAMPOS_EXTRAS_CONHECIDOS.map(([campo]) => campo),
  ...COLUNAS_BASE_DEPOIS,
];

// Aba opcional "Insumos" -- matéria-prima usada em fichas técnicas (ver
// ingredientService.js). Separada da "Modelo" porque insumo não é
// produto: não vai pro PDV, não tem categoria nem preço de venda.
const COLUNAS_INSUMOS = ['nome', 'unidade', 'custo_unitario', 'estoque_atual', 'estoque_minimo'];

// Aba opcional "Ficha Tecnica" -- uma linha por par (produto, insumo):
// quanto daquele insumo entra em CADA unidade vendida do produto. Várias
// linhas com o mesmo produto formam a ficha técnica inteira dele (ver
// agrupamento em importarFichaTecnicaSeExistir). "sku_produto" é
// alternativa a "produto" pra casar por código quando o nome não é
// único o bastante.
const COLUNAS_FICHA_TECNICA = ['produto', 'sku_produto', 'insumo', 'quantidade'];

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  const v = String(value || '').trim().toLowerCase();
  return v === 'sim' || v === 'true' || v === '1';
}

/** Busca fornecedor por nome (exato, sem acento/caixa) ou cria um novo — mesmo espírito de "upsert" do resto do app. */
function findOrCreateSupplier(db, nomeFornecedor) {
  const nome = String(nomeFornecedor).trim();
  if (!nome) return null;
  const existing = db.prepare('SELECT id FROM suppliers WHERE LOWER(nome) = LOWER(?)').get(nome);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare('INSERT INTO suppliers (id, nome) VALUES (?, ?)').run(id, nome);
  return id;
}

/**
 * Importa produtos + estoque inicial a partir de uma planilha no formato
 * do modelo. Cada linha é upsert por sku (ou codigo_barras se sku vazio).
 * Retorna um relatório linha a linha para o usuário conferir o que entrou.
 */
async function importFromFile(filePath, { locationId, operadorId, deviceId }) {
  const { rows, sheetNames } = await readSheetAsRows(filePath, 'Modelo');

  const db = getDb();
  const report = { total: rows.length, importados: 0, atualizados: 0, erros: [] };

  const headerRow = rows[0] ? Object.keys(rows[0]) : [];
  const missing = COLUMNS.filter((c) => !headerRow.includes(c));
  if (headerRow.length > 0 && missing.length === COLUMNS.length) {
    return { ok: false, error: 'A planilha não segue o modelo esperado. Baixe o modelo em templates/modelo_importacao_estoque.xlsx e preencha a partir dele.' };
  }

  rows.forEach((row, idx) => {
    const linha = idx + 2; // +2: cabeçalho é a linha 1 no Excel
    try {
      if (!row.nome || String(row.nome).trim() === '') {
        report.erros.push({ linha, erro: 'Campo "nome" é obrigatório.' });
        return;
      }
      if (row.preco_venda === '' || row.preco_venda === undefined || isNaN(Number(row.preco_venda))) {
        report.erros.push({ linha, erro: 'Campo "preco_venda" é obrigatório e deve ser numérico.' });
        return;
      }

      const sku = String(row.sku || '').trim() || null;
      const codigoBarras = String(row.codigo_barras || '').trim() || null;

      let existing = null;
      if (sku) existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
      if (!existing && codigoBarras) existing = db.prepare('SELECT * FROM products WHERE codigo_barras = ?').get(codigoBarras);

      // Genérico pra todos os perfis nativos (ver CAMPOS_EXTRAS_CONHECIDOS)
      // -- booleano sempre grava um valor (falso quando em branco/coluna
      // ausente, mesmo critério de antes só que agora pra qualquer
      // campo booleano de qualquer perfil, não só os 2 de farmácia);
      // texto/data/número só grava se vier preenchido.
      const customFields = {};
      for (const [campo, tipo] of CAMPOS_EXTRAS_CONHECIDOS) {
        const valor = row[campo];
        if (tipo === 'boolean') {
          customFields[campo] = parseBool(valor);
        } else if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
          customFields[campo] = String(valor).trim();
        }
      }

      const fornecedorId = row.fornecedor ? findOrCreateSupplier(db, row.fornecedor) : null;

      const productId = existing ? existing.id : randomUUID();
      db.prepare(
        `INSERT INTO products (id, sku, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, custom_fields, fornecedor_id, ncm, cfop, cst_csosn, origem_mercadoria)
         VALUES (@id, @sku, @codigoBarras, @nome, @categoria, @preco, @custo, @unidade, @estoqueMinimo, @customFields, @fornecedorId, @ncm, @cfop, @cstCsosn, @origemMercadoria)
         ON CONFLICT(id) DO UPDATE SET
           sku=excluded.sku, codigo_barras=excluded.codigo_barras, nome=excluded.nome,
           categoria=excluded.categoria, preco=excluded.preco, custo=excluded.custo,
           unidade=excluded.unidade, estoque_minimo=excluded.estoque_minimo, custom_fields=excluded.custom_fields,
           fornecedor_id=excluded.fornecedor_id, ncm=excluded.ncm, cfop=excluded.cfop,
           cst_csosn=excluded.cst_csosn, origem_mercadoria=excluded.origem_mercadoria`
      ).run({
        id: productId,
        sku,
        codigoBarras,
        nome: String(row.nome).trim(),
        categoria: row.categoria ? String(row.categoria) : null,
        preco: Number(row.preco_venda),
        custo: row.custo ? Number(row.custo) : 0,
        unidade: row.unidade ? String(row.unidade) : 'un',
        estoqueMinimo: row.estoque_minimo ? Number(row.estoque_minimo) : 0,
        customFields: JSON.stringify(customFields),
        fornecedorId,
        ncm: row.ncm ? String(row.ncm) : null,
        cfop: row.cfop ? String(row.cfop) : null,
        cstCsosn: row.cst_csosn ? String(row.cst_csosn) : null,
        origemMercadoria: row.origem_mercadoria ? String(row.origem_mercadoria) : '0',
      });

      // "quantidade_estoque_inicial" só vira entrada de estoque na PRIMEIRA
      // vez que o produto é importado (produto novo). Reimportar a mesma
      // planilha depois — pra corrigir uma célula, por exemplo — é um
      // fluxo comum, e cada linha de um produto que já existe é um UPDATE
      // (upsert por sku/código de barras), não uma criação; sem essa
      // checagem, reimportar somava o "estoque inicial" de novo em cima do
      // que já tinha, inflando o saldo a cada reimportação. Reabastecimento
      // de verdade depois da importação inicial passa pela tela de
      // Abastecimento, que registra a entrada de forma explícita.
      const quantidadeInicial = Number(row.quantidade_estoque_inicial || 0);
      if (!existing && quantidadeInicial > 0) {
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id)
           VALUES (?, ?, ?, 'entrada', ?, ?, ?, ?)`
        ).run(randomUUID(), productId, locationId, quantidadeInicial, 'Importação de planilha', operadorId, deviceId);
      }

      if (existing) report.atualizados += 1; else report.importados += 1;
    } catch (err) {
      report.erros.push({ linha, erro: err.message });
    }
  });

  // Abas OPCIONAIS -- só existem/são lidas se a pessoa quiser aproveitar
  // o mesmo arquivo pra também cadastrar insumos e montar a ficha
  // técnica dos produtos que acabaram de entrar (ver COLUNAS_INSUMOS/
  // COLUNAS_FICHA_TECNICA). Uma planilha só com "Modelo" continua
  // funcionando exatamente como antes -- report.insumos/fichaTecnica
  // ficam null quando a aba não existe.
  const insumos = await importarInsumosSeExistir(filePath, sheetNames);
  const fichaTecnica = await importarFichaTecnicaSeExistir(filePath, sheetNames);

  return { ok: true, report: { ...report, insumos, fichaTecnica } };
}

/**
 * Importa a aba opcional "Insumos" (matéria-prima usada em fichas
 * técnicas, ver ingredientService.js) -- upsert por nome (case-
 * insensitive, mesmo critério de findOrCreateSupplier). `estoque_atual`
 * só é aplicado na CRIAÇÃO de um insumo novo: reimportar a planilha
 * depois (pra corrigir o custo unitário, por exemplo) não pode resetar
 * um estoque que já foi consumido de verdade em vendas desde então --
 * mesmo cuidado que "quantidade_estoque_inicial" já toma pra produtos,
 * só que aqui precisa ser feito na mão porque ingredientService.upsert
 * sempre grava o estoqueAtual que recebe (não é um histórico de
 * movimentações como stock_movements, é o valor corrente direto).
 */
async function importarInsumosSeExistir(filePath, sheetNames) {
  if (!sheetNames.includes('Insumos')) return null;
  const { rows } = await readSheetAsRows(filePath, 'Insumos');
  const db = getDb();
  const report = { total: rows.length, importados: 0, atualizados: 0, erros: [] };

  rows.forEach((row, idx) => {
    const linha = idx + 2;
    try {
      const nome = String(row.nome || '').trim();
      if (!nome) {
        report.erros.push({ linha, erro: 'Campo "nome" é obrigatório.' });
        return;
      }
      const custoUnitario = Number(row.custo_unitario);
      if (row.custo_unitario === '' || row.custo_unitario === undefined || isNaN(custoUnitario)) {
        report.erros.push({ linha, erro: 'Campo "custo_unitario" é obrigatório e deve ser numérico.' });
        return;
      }

      const existing = db.prepare('SELECT * FROM ingredients WHERE LOWER(nome) = LOWER(?)').get(nome);
      const resultado = ingredientService.upsert({
        id: existing?.id,
        nome,
        unidade: row.unidade ? String(row.unidade).trim() : (existing?.unidade || 'un'),
        custoUnitario,
        estoqueMinimo: row.estoque_minimo !== '' && row.estoque_minimo !== undefined
          ? Number(row.estoque_minimo) : (existing?.estoque_minimo || 0),
        estoqueAtual: existing ? existing.estoque_atual : Number(row.estoque_atual || 0),
      });
      if (!resultado.ok) {
        report.erros.push({ linha, erro: resultado.error });
        return;
      }
      if (existing) report.atualizados += 1; else report.importados += 1;
    } catch (err) {
      report.erros.push({ linha, erro: err.message });
    }
  });

  return report;
}

/**
 * Importa a aba opcional "Ficha Tecnica" -- cada linha liga um produto a
 * UM insumo da receita dele; várias linhas com o mesmo produto formam a
 * ficha técnica inteira (agrupadas aqui antes de chamar
 * ingredientService.setRecipe, que substitui a ficha inteira de uma vez
 * só). Produto e insumo precisam já existir (produto: nesta mesma
 * importação ou já cadastrado antes; insumo: aba "Insumos" desta mesma
 * planilha, ou já cadastrado antes) -- não cria nenhum dos dois
 * sozinho, pra não montar uma ficha técnica em cima de um nome digitado
 * errado sem ninguém perceber.
 */
async function importarFichaTecnicaSeExistir(filePath, sheetNames) {
  if (!sheetNames.includes('Ficha Tecnica')) return null;
  const { rows } = await readSheetAsRows(filePath, 'Ficha Tecnica');
  const db = getDb();
  const report = { total: rows.length, produtosComReceita: 0, erros: [] };

  const itensPorProduto = new Map(); // productId -> [{ ingredientId, quantidade }]
  rows.forEach((row, idx) => {
    const linha = idx + 2;
    try {
      const nomeProduto = String(row.produto || '').trim();
      const skuProduto = String(row.sku_produto || '').trim();
      const nomeInsumo = String(row.insumo || '').trim();
      const quantidade = Number(row.quantidade);

      if (!nomeProduto && !skuProduto) {
        report.erros.push({ linha, erro: 'Informe o produto (coluna "produto" ou "sku_produto").' });
        return;
      }
      if (!nomeInsumo) {
        report.erros.push({ linha, erro: 'Informe o insumo (coluna "insumo").' });
        return;
      }
      if (!(quantidade > 0)) {
        report.erros.push({ linha, erro: 'Campo "quantidade" precisa ser um número maior que zero.' });
        return;
      }

      const produto = skuProduto
        ? db.prepare('SELECT id FROM products WHERE sku = ?').get(skuProduto)
        : db.prepare('SELECT id FROM products WHERE LOWER(nome) = LOWER(?)').get(nomeProduto);
      if (!produto) {
        report.erros.push({ linha, erro: `Produto "${skuProduto || nomeProduto}" não encontrado -- cadastre-o na aba "Modelo" primeiro.` });
        return;
      }

      const insumo = db.prepare('SELECT id FROM ingredients WHERE LOWER(nome) = LOWER(?)').get(nomeInsumo);
      if (!insumo) {
        report.erros.push({ linha, erro: `Insumo "${nomeInsumo}" não encontrado -- cadastre-o na aba "Insumos" primeiro (nome precisa ser idêntico).` });
        return;
      }

      if (!itensPorProduto.has(produto.id)) itensPorProduto.set(produto.id, []);
      itensPorProduto.get(produto.id).push({ ingredientId: insumo.id, quantidade });
    } catch (err) {
      report.erros.push({ linha, erro: err.message });
    }
  });

  for (const [productId, itens] of itensPorProduto) {
    ingredientService.setRecipe(productId, itens);
    report.produtosComReceita += 1;
  }

  return report;
}

/** Exporta produtos + estoque atual por local no mesmo formato do modelo. */
async function exportToFile(filePath, { locationId }) {
  const db = getDb();
  const products = db.prepare('SELECT * FROM products WHERE ativo = 1 ORDER BY nome').all();

  const rows = products.map((p) => {
    const custom = JSON.parse(p.custom_fields || '{}');
    const estoqueAtual = db.prepare(
      `SELECT COALESCE(SUM(quantidade),0) as total FROM stock_movements WHERE product_id = ? AND location_id = ?`
    ).get(p.id, locationId).total;
    const fornecedor = p.fornecedor_id
      ? db.prepare('SELECT nome FROM suppliers WHERE id = ?').get(p.fornecedor_id)?.nome
      : '';

    // Genérico pra todos os perfis nativos, mesma lista de
    // CAMPOS_EXTRAS_CONHECIDOS usada na importação -- exporta o que
    // tiver em custom_fields, mesmo que o produto tenha sido cadastrado
    // sob um perfil diferente do ativo agora (ex: exportar um catálogo
    // misto depois de já ter trocado de perfil).
    const camposExtras = {};
    for (const [campo, tipo] of CAMPOS_EXTRAS_CONHECIDOS) {
      camposExtras[campo] = tipo === 'boolean' ? (custom[campo] ? 'sim' : 'não') : (custom[campo] || '');
    }

    return {
      sku: p.sku || '',
      codigo_barras: p.codigo_barras || '',
      nome: p.nome,
      categoria: p.categoria || '',
      preco_venda: p.preco,
      custo: p.custo,
      unidade: p.unidade,
      estoque_minimo: p.estoque_minimo,
      quantidade_estoque_inicial: estoqueAtual,
      ...camposExtras,
      fornecedor: fornecedor || '',
      ncm: p.ncm || '',
      cfop: p.cfop || '',
      cst_csosn: p.cst_csosn || '',
      origem_mercadoria: p.origem_mercadoria || '0',
    };
  });

  await writeRowsAsSheet(filePath, rows, COLUMNS, 'Modelo');

  return { ok: true, total: rows.length };
}

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

/** Tenta achar, entre os cabeçalhos da planilha, qual coluna é o nome
 * do produto e qual é o código de barras — aceita variações comuns,
 * já que a planilha antiga do cliente não necessariamente segue o
 * nosso modelo (pode vir de outro sistema, com nomes de coluna
 * diferentes). */
function detectarColunas(headerRow) {
  const candidatosNome = ['nome', 'produto', 'descricao', 'descrição', 'item', 'mercadoria'];
  const candidatosCodigo = ['codigo_barras', 'código_barras', 'codigo de barras', 'código de barras', 'codigobarras', 'codigo', 'código', 'barras', 'ean', 'gtin'];

  const colunaNome = headerRow.find((h) => candidatosNome.includes(normalizarTexto(h)));
  const colunaCodigo = headerRow.find((h) => candidatosCodigo.includes(normalizarTexto(h)));
  return { colunaNome, colunaCodigo };
}

/**
 * Lê uma planilha antiga (nome + código de barras) e tenta casar cada
 * linha com um produto JÁ EXISTENTE localmente, por NOME — ao
 * contrário da importação normal (que casa por sku/código de barras,
 * inútil aqui já que é justamente o código que sumiu e precisa ser
 * re-vinculado). NUNCA cria produto novo, NUNCA aplica nada sozinho —
 * só monta o relatório pra revisão, quem decide o que aceitar é
 * sempre a pessoa.
 */
async function prepararRevinculacaoDeCodigosBarras(filePath) {
  const { rows } = await readSheetAsRows(filePath);
  if (rows.length === 0) return { ok: false, error: 'A planilha está vazia.' };

  const headerRow = Object.keys(rows[0]);
  const { colunaNome, colunaCodigo } = detectarColunas(headerRow);
  if (!colunaNome || !colunaCodigo) {
    return {
      ok: false,
      error: `Não consegui identificar as colunas de nome e código de barras na planilha (cabeçalhos encontrados: ${headerRow.join(', ')}). Renomeie a coluna do nome do produto pra "nome" e a do código de barras pra "codigo_barras", ou use nomes parecidos com esses.`,
    };
  }

  const candidatos = rows.map((row) => ({ nome: row[colunaNome], codigoBarras: row[colunaCodigo] }));
  const productService = require('./productService');
  const resultado = productService.casarCandidatosPorNome(candidatos);
  return { ok: true, ...resultado, totalLinhas: rows.length };
}

/** Aplica só os casamentos que a pessoa revisou e aceitou — reconfere
 * o conflito de código de barras na hora de aplicar (pode ter mudado
 * desde a revisão, se outra máquina sincronizada mexeu em algo). */
function aplicarRevinculacaoDeCodigosBarras(casadosAceitos) {
  const db = getDb();
  const resultado = { aplicados: 0, ignoradosPorConflito: [] };
  for (const c of casadosAceitos) {
    const conflito = db.prepare('SELECT nome FROM products WHERE codigo_barras = ? AND id != ? AND ativo = 1').get(c.codigoBarrasNovo, c.productId);
    if (conflito) {
      resultado.ignoradosPorConflito.push({ nomeAtual: c.nomeAtual, jaPertenceA: conflito.nome });
      continue;
    }
    db.prepare('UPDATE products SET codigo_barras = ? WHERE id = ?').run(c.codigoBarrasNovo, c.productId);
    resultado.aplicados++;
  }
  return { ok: true, ...resultado };
}

module.exports = {
  importFromFile, exportToFile, COLUMNS, CAMPOS_EXTRAS_CONHECIDOS, COLUNAS_INSUMOS, COLUNAS_FICHA_TECNICA,
  prepararRevinculacaoDeCodigosBarras, aplicarRevinculacaoDeCodigosBarras,
};
