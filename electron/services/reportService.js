const XLSX = require('xlsx');
const { listSalesByRange } = require('./saleService');
const authService = require('./authService');
const supplierService = require('./supplierService');

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

module.exports = { exportSalesReport, exportAuditReport, exportPurchaseSuggestions };
