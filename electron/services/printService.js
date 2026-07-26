const { BrowserWindow } = require('electron');
const { getDb } = require('../db/database');

function getReceiptConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM receipt_config WHERE id = ?').get('default');
}

function updateReceiptConfig({ larguraMm, rodapeTexto, imprimirAutomatico }) {
  const db = getDb();
  const current = getReceiptConfig();
  if (larguraMm !== undefined && ![58, 80, 210].includes(Number(larguraMm))) {
    return { ok: false, error: 'Largura inválida. Use 58, 80 (térmica) ou 210 (folha A4).' };
  }
  db.prepare('UPDATE receipt_config SET largura_mm = ?, rodape_texto = ?, imprimir_automatico = ? WHERE id = ?').run(
    larguraMm !== undefined ? Number(larguraMm) : current.largura_mm,
    rodapeTexto !== undefined ? (rodapeTexto || null) : current.rodape_texto,
    imprimirAutomatico !== undefined ? (imprimirAutomatico ? 1 : 0) : current.imprimir_automatico,
    'default'
  );
  return { ok: true };
}

/** Fonte um pouco menor pro rolo de 58mm — cabe menos caractere por linha. */
function buildReceiptHtml(sale, items, payments, location, larguraMm, rodapeTexto) {
  const isTermica = larguraMm === 58 || larguraMm === 80;
  const fontSize = larguraMm === 58 ? 10 : isTermica ? 11 : 12;
  const larguraCss = isTermica ? `${larguraMm}mm` : '190mm';

  const linhas = items.map((i) => `
    <tr>
      <td>${i.nome}</td>
      <td style="text-align:right">${i.quantidade}</td>
      <td style="text-align:right">R$ ${i.preco_unitario.toFixed(2)}</td>
      <td style="text-align:right">R$ ${(i.preco_unitario * i.quantidade).toFixed(2)}</td>
    </tr>`).join('');

  const linhasPagamento = payments.map((p) => `<div>${p.metodo}: R$ ${p.valor.toFixed(2)}</div>`).join('');

  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    @page { size: ${isTermica ? `${larguraMm}mm auto` : 'A4'}; margin: ${isTermica ? '2mm' : '15mm'}; }
    body { font-family: 'Courier New', monospace; font-size: ${fontSize}px; width: ${larguraCss}; margin: 0 auto; padding: ${isTermica ? '4px' : '16px'}; color: #000; }
    h1 { font-size: ${fontSize + 2}px; text-align: center; margin: 0 0 4px; }
    .center { text-align: center; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 2px 0; font-size: ${fontSize - 1}px; }
    hr { border: none; border-top: 1px dashed #000; }
    .total { font-size: ${fontSize + 2}px; font-weight: bold; text-align: right; margin-top: 8px; }
  </style></head>
  <body>
    <h1>${location.nome}</h1>
    <p class="center">Venda ${sale.id.slice(0, 8)} — ${new Date(sale.finalizada_em + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
    <hr>
    <table>
      <thead><tr><th style="text-align:left">Item</th><th>Qtd</th><th>Unit.</th><th>Total</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
    <hr>
    ${sale.desconto > 0 ? `<div>Desconto fidelidade: -R$ ${sale.desconto.toFixed(2)}</div>` : ''}
    ${sale.desconto_gerente > 0 ? `<div>Desconto autorizado: -R$ ${sale.desconto_gerente.toFixed(2)}</div>` : ''}
    <div class="total">Total: R$ ${(sale.total - sale.desconto - sale.desconto_gerente).toFixed(2)}</div>
    <hr>
    ${linhasPagamento}
    <hr>
    <p class="center">${rodapeTexto || 'Obrigado pela preferência!'}</p>
  </body></html>`;
}

/** Abre uma janela oculta só com o recibo e dispara o diálogo de
 * impressão nativo do sistema — a janela fecha assim que o diálogo
 * fecha (impresso ou cancelado). Formato (térmica 58/80mm ou A4) vem de
 * Configurações → Recibo. */
function printReceipt(saleId) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };

  const items = db.prepare(
    `SELECT si.*, p.nome FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? AND si.cancelado = 0`
  ).all(saleId);
  const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);
  const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(sale.location_id);
  const { largura_mm: larguraMm, rodape_texto: rodapeTexto } = getReceiptConfig();

  const html = buildReceiptHtml(sale, items, payments, location, larguraMm, rodapeTexto);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });

  const isTermica = larguraMm === 58 || larguraMm === 80;
  const printOptions = { silent: false };
  if (isTermica) {
    // Altura generosa (rolo contínuo) — a impressora térmica corta no fim
    // do conteúdo, não numa altura de página fixa como papel comum.
    printOptions.pageSize = { width: larguraMm * 1000, height: 1000000 };
  }

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
    win.webContents.print(printOptions, () => {
      win.close();
    });
  });

  return { ok: true };
}

/**
 * Etiqueta simples com código de barras — a imagem do código já vem
 * pronta do frontend (data URL de um <canvas>, via jsbarcode), porque o
 * processo principal do Electron não tem DOM/canvas pra desenhar
 * sozinho. Aqui só monta a etiqueta e abre o diálogo de impressão.
 */
function printLabel({ nome, preco, codigoBarras, barcodeDataUrl }) {
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    @page { size: 50mm 30mm; margin: 2mm; }
    body { font-family: Arial, sans-serif; width: 46mm; margin: 0 auto; text-align: center; }
    .nome { font-size: 9px; font-weight: bold; margin: 0 0 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .preco { font-size: 11px; font-weight: bold; margin: 2px 0; }
    img { width: 100%; height: 30px; }
    .codigo { font-size: 8px; letter-spacing: 1px; margin-top: -2px; }
  </style></head>
  <body>
    <p class="nome">${nome}</p>
    <p class="preco">R$ ${preco.toFixed(2)}</p>
    <img src="${barcodeDataUrl}" alt="${codigoBarras}" />
    <p class="codigo">${codigoBarras}</p>
  </body></html>`;

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
    win.webContents.print({ silent: false, pageSize: { width: 50000, height: 30000 } }, () => win.close());
  });

  return { ok: true };
}

module.exports = { printReceipt, getReceiptConfig, updateReceiptConfig, printLabel };
