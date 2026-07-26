const XLSX = require('xlsx');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

// Ordem e nomes precisam bater com /templates/modelo_importacao_estoque.xlsx
const COLUMNS = [
  'sku', 'codigo_barras', 'nome', 'categoria', 'preco_venda', 'custo', 'unidade',
  'estoque_minimo', 'quantidade_estoque_inicial', 'lote', 'validade',
  'principio_ativo', 'controlado', 'exige_receita',
  'fornecedor', 'ncm', 'cfop', 'cst_csosn', 'origem_mercadoria',
];

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
function importFromFile(filePath, { locationId, operadorId, deviceId }) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames.includes('Modelo') ? 'Modelo' : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

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

      const customFields = {};
      if (row.lote) customFields.lote = String(row.lote);
      if (row.validade) customFields.validade = String(row.validade);
      if (row.principio_ativo) customFields.principio_ativo = String(row.principio_ativo);
      if (row.controlado !== '') customFields.controlado = parseBool(row.controlado);
      if (row.exige_receita !== '') customFields.exige_receita = parseBool(row.exige_receita);

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

      const quantidadeInicial = Number(row.quantidade_estoque_inicial || 0);
      if (quantidadeInicial > 0) {
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

  return { ok: true, report };
}

/** Exporta produtos + estoque atual por local no mesmo formato do modelo. */
function exportToFile(filePath, { locationId }) {
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
      lote: custom.lote || '',
      validade: custom.validade || '',
      principio_ativo: custom.principio_ativo || '',
      controlado: custom.controlado ? 'sim' : 'não',
      exige_receita: custom.exige_receita ? 'sim' : 'não',
      fornecedor: fornecedor || '',
      ncm: p.ncm || '',
      cfop: p.cfop || '',
      cst_csosn: p.cst_csosn || '',
      origem_mercadoria: p.origem_mercadoria || '0',
    };
  });

  const sheet = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Modelo');
  XLSX.writeFile(workbook, filePath);

  return { ok: true, total: rows.length };
}

module.exports = { importFromFile, exportToFile, COLUMNS };
