const path = require('path');
const XLSX = require('xlsx');
const aiService = require('./aiService');
const batchService = require('./batchService');
const { getDb } = require('../db/database');

const ALIASES = {
  codigo: ['codigo', 'cod', 'codprod', 'codproduto', 'cod.prod', 'codigoproduto'],
  descricao: ['descricao', 'produto', 'item', 'nome', 'descricaoproduto'],
  marca: ['marca', 'fabricante'],
  quantidade: ['quantidade', 'qtd', 'qtde', 'quant'],
  precoUnitario: ['precounit', 'precounitario', 'valorunitario', 'precounit.', 'vlunit', 'unitario'],
  desconto: ['desconto', 'desc', 'desc.'],
  precoTotal: ['precototal', 'valortotal', 'total', 'precototal.', 'vltotal'],
};

function normalizarCabecalho(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Nota de compra brasileira usa vírgula decimal (ex: "15,35"). Sem isso,
 * o parser padrão do SheetJS interpreta errado e "15,35" vira 1535 —
 * 100x o valor real. Aceita os dois formatos: se tiver vírgula, assume
 * brasileiro (ponto = milhar); senão, trata como já estiver em ponto. */
function parseNumeroBR(valor) {
  if (valor === '' || valor === null || valor === undefined) return 0;
  if (typeof valor === 'number') return valor;
  let texto = String(valor).trim();
  if (texto.includes(',')) {
    texto = texto.replace(/\./g, '').replace(',', '.');
  }
  const numero = Number(texto);
  return Number.isNaN(numero) ? 0 : numero;
}

function encontrarCampo(cabecalhosNormalizados, aliases) {
  return cabecalhosNormalizados.find((c) => aliases.includes(c.normalizado))?.original;
}

/** Lê um CSV/Excel estruturado — sem IA, direto, tolerante a nomes de
 * coluna diferentes entre distribuidoras (compara sem acento/maiúscula). */
function parseCsvOuExcel(filePath) {
  // codepage 65001 = UTF-8 — sem isso, CSVs com acento (muito comuns:
  // "Código", "Descrição", "Preço") vêm corrompidos na leitura.
  const workbook = XLSX.readFile(filePath, { codepage: 65001 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // raw: false devolve o texto tal como está na célula, sem o SheetJS
  // tentar "adivinhar" e converter pra número sozinho — é exatamente essa
  // conversão automática que lia "15,35" (formato brasileiro) como 1535.
  // O parseNumeroBR abaixo faz a conversão certa, entendendo vírgula
  // decimal.
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (rows.length === 0) return { ok: false, error: 'Planilha vazia ou em formato não reconhecido.' };

  const cabecalhos = Object.keys(rows[0]).map((original) => ({ original, normalizado: normalizarCabecalho(original) }));
  const campo = {};
  for (const [chave, aliases] of Object.entries(ALIASES)) {
    campo[chave] = encontrarCampo(cabecalhos, aliases);
  }
  if (!campo.descricao) {
    return { ok: false, error: 'Não encontrei uma coluna de descrição/produto na planilha. Confira o cabeçalho.' };
  }

  const itens = rows.map((row) => ({
    codigo: campo.codigo ? String(row[campo.codigo] ?? '') : '',
    descricao: String(row[campo.descricao] ?? ''),
    marca: campo.marca ? String(row[campo.marca] ?? '') : '',
    quantidade: campo.quantidade ? parseNumeroBR(row[campo.quantidade]) : 0,
    precoUnitario: campo.precoUnitario ? parseNumeroBR(row[campo.precoUnitario]) : 0,
    desconto: campo.desconto ? parseNumeroBR(row[campo.desconto]) : 0,
    precoTotal: campo.precoTotal ? parseNumeroBR(row[campo.precoTotal]) : 0,
  })).filter((i) => i.descricao.trim() !== '');

  return { ok: true, data: { fornecedor: '', data: '', numeroNota: '', valorTotal: 0, itens } };
}

/**
 * Lê uma nota de compra pra abastecimento de estoque — roteia por
 * extensão: CSV/Excel usa parser estruturado (sem gastar IA, mais
 * confiável pra dado tabular de verdade); PDF/foto usa a IA (Gemini,
 * que já lida nativamente com PDF e imagem, incluindo fotos tiradas
 * com celular, tortas ou com anotação a mão por cima).
 */
async function extractFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.csv', '.xlsx', '.xls'].includes(ext)) {
    try {
      return parseCsvOuExcel(filePath);
    } catch (err) {
      return { ok: false, error: `Falha ao ler a planilha: ${err.message}` };
    }
  }
  if (['.pdf', '.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return aiService.extractPurchaseInvoice(filePath);
  }
  return { ok: false, error: 'Formato não suportado. Envie PDF, imagem (JPG/PNG) ou planilha (CSV/Excel).' };
}

/**
 * Confirma a entrada de mercadoria — recebe as linhas já revisadas
 * (produto já escolhido/casado, lote e validade preenchidos por quem
 * está conferindo a mercadoria física) e cria um lote por linha.
 */
function confirmEntries({ linhas, locationId, operadorId, deviceId, motivo }) {
  const db = getDb();
  const resultados = { sucesso: 0, erros: [], linhasComSucesso: [] };

  linhas.forEach((linha, i) => {
    const result = batchService.createBatch({
      productId: linha.productId,
      locationId,
      lote: linha.lote,
      validade: linha.validade,
      quantidade: linha.quantidade,
      fornecedorId: linha.fornecedorId,
      operadorId,
      deviceId,
      motivo,
    });
    if (result.ok) {
      resultados.sucesso += 1;
      resultados.linhasComSucesso.push(linha.linhaId);
      // Atualiza o custo do produto pro preço unitário da nota — só se
      // veio um valor de verdade (nem toda nota traz preço por item).
      if (linha.precoUnitario > 0) {
        db.prepare('UPDATE products SET custo = ? WHERE id = ?').run(linha.precoUnitario, linha.productId);
      }
    } else {
      resultados.erros.push({ linha: i + 1, linhaId: linha.linhaId, erro: result.error });
    }
  });
  return { ok: true, ...resultados };
}

/**
 * Rascunho da leitura em andamento — salva a cada mudança, carrega ao
 * abrir a tela. Sem isso, trocar de aba no meio da conferência perdia
 * tudo que a IA já tinha extraído da nota.
 */
function getDraft() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM supply_draft WHERE id = ?').get('default');
  if (!row) return null;
  return {
    arquivoNome: row.arquivo_nome,
    fornecedorId: row.fornecedor_id,
    linhas: JSON.parse(row.linhas_json || '[]'),
  };
}

function saveDraft({ arquivoNome, fornecedorId, linhas }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO supply_draft (id, arquivo_nome, fornecedor_id, linhas_json, atualizado_em)
     VALUES ('default', ?, ?, ?, NOW_SYNCED())
     ON CONFLICT(id) DO UPDATE SET arquivo_nome=excluded.arquivo_nome, fornecedor_id=excluded.fornecedor_id,
       linhas_json=excluded.linhas_json, atualizado_em=excluded.atualizado_em`
  ).run(arquivoNome || null, fornecedorId || null, JSON.stringify(linhas || []));
  return { ok: true };
}

function clearDraft() {
  const db = getDb();
  db.prepare('DELETE FROM supply_draft WHERE id = ?').run('default');
  return { ok: true };
}

module.exports = { extractFromFile, confirmEntries, getDraft, saveDraft, clearDraft };
