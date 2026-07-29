const { BrowserWindow } = require('electron');
const { getDb } = require('../db/database');

function getReceiptConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM receipt_config WHERE id = ?').get('default');
}

function updateReceiptConfig({ larguraMm, rodapeTexto, imprimirAutomatico, impressoraPadrao }) {
  const db = getDb();
  const current = getReceiptConfig();
  if (larguraMm !== undefined && ![58, 80, 210].includes(Number(larguraMm))) {
    return { ok: false, error: 'Largura inválida. Use 58, 80 (térmica) ou 210 (folha A4).' };
  }
  db.prepare('UPDATE receipt_config SET largura_mm = ?, rodape_texto = ?, imprimir_automatico = ?, impressora_padrao = ? WHERE id = ?').run(
    larguraMm !== undefined ? Number(larguraMm) : current.largura_mm,
    rodapeTexto !== undefined ? (rodapeTexto || null) : current.rodape_texto,
    imprimirAutomatico !== undefined ? (imprimirAutomatico ? 1 : 0) : current.imprimir_automatico,
    impressoraPadrao !== undefined ? (impressoraPadrao || null) : current.impressora_padrao,
    'default'
  );
  return { ok: true };
}

/** Lista as impressoras instaladas no Windows, pra escolher uma como
 * padrão nas Configurações. Precisa de uma janela (mesmo invisível)
 * pra perguntar ao sistema operacional. */
async function listPrinters() {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    const impressoras = await win.webContents.getPrintersAsync();
    return impressoras.map((p) => ({ nome: p.name, padraoDoSistema: !!p.isDefault }));
  } finally {
    win.close();
  }
}

/** Monta as opções de impressão de forma consistente em todo o app —
 * se uma impressora padrão estiver configurada, imprime direto nela
 * sem abrir diálogo (mais rápido no dia a dia); senão, sempre pergunta
 * (comportamento de sempre, mais seguro como padrão). */
function opcoesDeImpressao(extras = {}) {
  const config = getReceiptConfig();
  if (config?.impressora_padrao) {
    return { silent: true, deviceName: config.impressora_padrao, ...extras };
  }
  return { silent: false, ...extras };
}

/** Página de teste simples — confirma que a impressora escolhida (ou o
 * diálogo, se nenhuma estiver configurada) está funcionando. */
function printTestPage() {
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
    h1 { font-size: 22px; }
  </style></head>
  <body>
    <h1>Teste de impressão — GerenciaAI</h1>
    <p>Se esta página saiu impressa corretamente, a impressora está configurada certinho.</p>
    <p>${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
  </body></html>`;

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
    win.webContents.print(opcoesDeImpressao(), () => win.close());
  });
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
  const printOptions = opcoesDeImpressao();
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
    win.webContents.print(opcoesDeImpressao({ pageSize: { width: 50000, height: 30000 } }), () => win.close());
  });

  return { ok: true };
}

/**
 * Comanda pra cozinha — só os itens ainda não enviados (evita reimprimir
 * o que a cozinha já está preparando quando alguém adiciona mais coisa
 * na mesa depois). Sem preço, sem forma de pagamento — só o que precisa
 * ser preparado, com letra grande pra ler rápido numa cozinha corrida.
 */
function printKitchenTicket(saleId, mesaLabel) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };

  const itens = db.prepare(
    `SELECT si.*, p.nome FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 AND si.enviado_cozinha = 0`
  ).all(saleId);

  if (itens.length === 0) return { ok: false, error: 'Nada novo pra enviar — todos os itens já foram impressos.' };

  const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linhasHtml = itens.map((i) =>
    `<div class="item"><span class="qtd">${i.quantidade}×</span> ${escapeHtml(i.nome)}
      ${i.observacao ? `<div class="obs">⚠ ${escapeHtml(i.observacao)}</div>` : ''}
    </div>`
  ).join('');

  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 3mm; }
    body { font-family: Arial, sans-serif; width: 74mm; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .info { font-size: 12px; color: #333; margin-bottom: 10px; }
    .item { font-size: 18px; font-weight: bold; padding: 6px 0; border-bottom: 1px dashed #999; }
    .qtd { display: inline-block; min-width: 32px; }
    .obs { font-size: 14px; font-weight: normal; color: #a33; margin: 3px 0 0 32px; }
  </style></head>
  <body>
    <h1>${escapeHtml(mesaLabel || 'Comanda')}</h1>
    <p class="info">${agora}</p>
    ${linhasHtml}
  </body></html>`;

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
    win.webContents.print(opcoesDeImpressao({ pageSize: { width: 80000, height: 1000000 } }), () => win.close());
  });

  const idsEnviados = itens.map((i) => i.id);
  const placeholders = idsEnviados.map(() => '?').join(',');
  db.prepare(`UPDATE sale_items SET enviado_cozinha = 1 WHERE id IN (${placeholders})`).run(...idsEnviados);

  return { ok: true, totalItens: itens.length };
}

/** Cardápio do dia — só os pratos marcados como disponíveis hoje,
 * agrupados por tipo quando esse campo estiver preenchido. */
function printDailyMenu(itens) {
  if (!itens || itens.length === 0) return { ok: false, error: 'Nenhum prato disponível hoje pra imprimir.' };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const grupos = {};
  for (const item of itens) {
    const chave = item.tipo || 'Cardápio';
    if (!grupos[chave]) grupos[chave] = [];
    grupos[chave].push(item);
  }

  const gruposHtml = Object.entries(grupos).map(([tipo, pratos]) => `
    <h2>${escapeHtml(tipo)}</h2>
    ${pratos.map((p) => `
      <div class="prato">
        <span class="nome">${escapeHtml(p.nome)}</span>
        <span class="preco">R$ ${p.preco.toFixed(2)}</span>
      </div>
    `).join('')}
  `).join('');

  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 20mm; }
    body { font-family: Georgia, serif; max-width: 500px; margin: 0 auto; }
    h1 { text-align: center; font-size: 26px; margin-bottom: 4px; }
    .data { text-align: center; color: #666; margin-bottom: 24px; }
    h2 { font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 24px; }
    .prato { display: flex; justify-content: space-between; padding: 6px 0; font-size: 16px; }
    .nome { flex: 1; }
    .preco { font-weight: bold; }
  </style></head>
  <body>
    <h1>Cardápio do dia</h1>
    <p class="data">${hoje}</p>
    ${gruposHtml}
  </body></html>`;

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
    win.webContents.print(opcoesDeImpressao(), () => win.close());
  });

  return { ok: true };
}

module.exports = { printReceipt, getReceiptConfig, updateReceiptConfig, printLabel, printKitchenTicket, printDailyMenu, listPrinters, printTestPage };
