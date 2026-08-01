const XLSX = require('xlsx');
const { listSalesByRange } = require('./saleService');
const authService = require('./authService');
const supplierService = require('./supplierService');
const wasteService = require('./wasteService');

const STATUS_LABEL = { aberta: 'Em aberto', finalizada: 'Finalizada', cancelada: 'Cancelada' };
const TIPO_EVENTO_LABEL = {
  cancelamento_item: 'Cancelamento de item',
  cancelamento_venda: 'Cancelamento de venda',
  devolucao: 'Devolução',
  desconto_manual: 'Desconto manual',
  ajuste_estoque: 'Ajuste de estoque',
};

function exportSalesReport(filePath, { locationId, dataInicio, dataFim }) {
  const sales = listSalesByRange({ locationId, dataInicio, dataFim });

  const rows = sales.map((s) => ({
    data: s.data_efetiva,
    operador: s.operador_nome,
    itens: s.total_itens,
    total: s.total,
    status: STATUS_LABEL[s.status] || s.status,
    metodos_pagamento: s.metodos_pagamento || '',
  }));

  const totalFinalizado = sales
    .filter((s) => s.status === 'finalizada')
    .reduce((acc, s) => acc + s.total, 0);

  rows.push({}); // linha em branco antes do resumo
  rows.push({ data: 'TOTAL FINALIZADO NO PERÍODO', total: totalFinalizado });

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['data', 'operador', 'itens', 'total', 'status', 'metodos_pagamento'],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Relatório de vendas');
  XLSX.writeFile(workbook, filePath);

  return { ok: true, total: sales.length, totalFinalizado };
}

/** Exporta a trilha de auditoria (cancelamentos, devoluções, descontos —
 * aprovados ou negados) num período, no mesmo formato do relatório de vendas. */
function exportAuditReport(filePath, { dataInicio, dataFim }) {
  const eventos = authService.listAuditLog({ dataInicio, dataFim });

  const rows = eventos.map((e) => ({
    data: e.criado_em,
    tipo: TIPO_EVENTO_LABEL[e.tipo_evento] || e.tipo_evento,
    solicitante: e.solicitante_nome || '',
    autorizado_por: e.autorizado_por_nome || '',
    motivo: e.motivo || '',
    resultado: e.sucesso ? 'Aprovado' : 'Negado',
  }));

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['data', 'tipo', 'solicitante', 'autorizado_por', 'motivo', 'resultado'],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Auditoria');
  XLSX.writeFile(workbook, filePath);

  return { ok: true, total: eventos.length };
}

/** Exporta a lista de compra sugerida — mesmos dados de suggestPurchases,
 * já ordenada por fornecedor, pronta pra levar/mandar pro fornecedor. */
function exportPurchaseSuggestions(filePath, { locationId }) {
  const sugestoes = supplierService.suggestPurchases({ locationId });

  const rows = [...sugestoes]
    .sort((a, b) => (a.fornecedor_nome || 'zzz').localeCompare(b.fornecedor_nome || 'zzz'))
    .map((s) => ({
      fornecedor: s.fornecedor_nome || '(sem fornecedor cadastrado)',
      produto: s.nome,
      sku: s.sku || '',
      estoque_atual: s.estoque_atual,
      estoque_minimo: s.estoque_minimo,
      venda_por_dia: s.velocidadeDiaria,
      quantidade_sugerida: s.quantidadeSugerida,
    }));

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['fornecedor', 'produto', 'sku', 'estoque_atual', 'estoque_minimo', 'venda_por_dia', 'quantidade_sugerida'],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Lista de compra');
  XLSX.writeFile(workbook, filePath);

  return { ok: true, total: rows.length };
}

function exportWasteReport(filePath, { locationId, dataInicio, dataFim }) {
  const registros = wasteService.listWaste({ locationId, dataInicio, dataFim });

  const rows = registros.map((r) => ({
    data: r.criado_em,
    tipo: r.tipo === 'prato' ? 'Prato' : 'Insumo',
    item: r.tipo === 'prato' ? r.prato_nome : r.insumo_nome,
    quantidade: r.quantidade,
    valor_perdido: r.custo_estimado,
    motivo: r.motivo || '',
    operador: r.operador_nome || '',
  }));

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['data', 'tipo', 'item', 'quantidade', 'valor_perdido', 'motivo', 'operador'],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Desperdício');
  XLSX.writeFile(workbook, filePath);

  return { ok: true, total: rows.length };
}

/**
 * Relatório de compras de um cliente específico num período — total
 * de pedidos, valor total, e os produtos comprados subclassificados
 * por categoria (quanto de cada categoria, e dentro dela, quanto de
 * cada produto).
 */
function getCustomerPurchaseReport({ customerId, dataInicio, dataFim }) {
  const db = getDb();

  const cliente = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!cliente) return { ok: false, error: 'Cliente não encontrado.' };

  const vendas = db.prepare(
    `SELECT * FROM sales WHERE customer_id = ? AND status = 'finalizada'
     AND date(finalizada_em) BETWEEN date(?) AND date(?)`
  ).all(customerId, dataInicio, dataFim);

  const totalPedidos = vendas.length;
  const totalGasto = vendas.reduce((acc, v) => acc + v.total, 0);

  let linhas = [];
  if (vendas.length > 0) {
    const placeholders = vendas.map(() => '?').join(',');
    linhas = db.prepare(
      `SELECT COALESCE(p.categoria, 'Sem categoria') as categoria, p.nome,
              SUM(si.quantidade) as quantidade, SUM(si.quantidade * si.preco_unitario) as valor
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id IN (${placeholders}) AND si.cancelado = 0
       GROUP BY p.categoria, p.nome
       ORDER BY p.categoria, valor DESC`
    ).all(...vendas.map((v) => v.id));
  }

  // Agrupa as linhas (por produto) dentro de cada categoria — a
  // subclassificação pedida.
  const categoriasMap = new Map();
  for (const linha of linhas) {
    if (!categoriasMap.has(linha.categoria)) {
      categoriasMap.set(linha.categoria, { categoria: linha.categoria, quantidadeTotal: 0, valorTotal: 0, produtos: [] });
    }
    const grupo = categoriasMap.get(linha.categoria);
    grupo.quantidadeTotal += linha.quantidade;
    grupo.valorTotal += linha.valor;
    grupo.produtos.push({ nome: linha.nome, quantidade: linha.quantidade, valor: linha.valor });
  }

  return {
    ok: true,
    cliente: { nome: cliente.nome, cpf: cliente.cpf, cnpj: cliente.cnpj },
    periodo: { dataInicio, dataFim },
    totalPedidos,
    totalGasto,
    categorias: Array.from(categoriasMap.values()).sort((a, b) => b.valorTotal - a.valorTotal),
  };
}

function exportCustomerPurchaseReport(filePath, { customerId, dataInicio, dataFim }) {
  const relatorio = getCustomerPurchaseReport({ customerId, dataInicio, dataFim });
  if (!relatorio.ok) return relatorio;

  const linhas = [];
  for (const cat of relatorio.categorias) {
    for (const p of cat.produtos) {
      linhas.push({
        cliente: relatorio.cliente.nome,
        cpf_cnpj: relatorio.cliente.cnpj || relatorio.cliente.cpf || '',
        categoria: cat.categoria,
        produto: p.nome,
        quantidade: p.quantidade,
        valor: p.valor,
      });
    }
  }
  linhas.push({
    cliente: relatorio.cliente.nome, cpf_cnpj: '', categoria: 'TOTAL', produto: '',
    quantidade: '', valor: relatorio.totalGasto,
  });

  const sheet = XLSX.utils.json_to_sheet(linhas, {
    header: ['cliente', 'cpf_cnpj', 'categoria', 'produto', 'quantidade', 'valor'],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Compras por cliente');
  XLSX.writeFile(workbook, filePath);

  return { ok: true, totalPedidos: relatorio.totalPedidos, totalGasto: relatorio.totalGasto };
}

module.exports = { exportSalesReport, exportAuditReport, exportPurchaseSuggestions, exportWasteReport, getCustomerPurchaseReport, exportCustomerPurchaseReport };
