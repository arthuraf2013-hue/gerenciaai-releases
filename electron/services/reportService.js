const XLSX = require('xlsx');
const { listSalesByRange } = require('./saleService');

const STATUS_LABEL = { aberta: 'Em aberto', finalizada: 'Finalizada', cancelada: 'Cancelada' };

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

module.exports = { exportSalesReport };
