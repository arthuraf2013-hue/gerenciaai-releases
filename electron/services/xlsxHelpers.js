const path = require('path');
// exceljs é uma dependência pesada (só usada nas telas de import/export de
// planilha) -- carregada sob demanda aqui dentro, não no topo do arquivo,
// pra não pagar esse custo de startup em todo boot do app quando ninguém
// usou essa tela ainda (mesma convenção já usada em firebase/baileys, ver
// comentário equivalente em licenseService.js/whatsappBotService.js).

/**
 * Lê a planilha de um arquivo .xlsx ou .csv como array de objetos —
 * primeira linha vira o cabeçalho, linhas seguintes viram objetos com
 * essas chaves. Mesmo formato que XLSX.utils.sheet_to_json entregava,
 * pra não precisar reescrever a lógica que consome isso. Valor de
 * célula sempre vira string/número tal como está no arquivo — sem
 * conversão "esperta" que interpretaria "15,35" (formato brasileiro)
 * como 1535.
 */
async function readSheetAsRows(filePath, preferSheetName) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    // Sem esse `map`, o leitor de CSV do exceljs converte sozinho todo
    // valor que "parece número" — "001" vira 1 (perde os zeros à
    // esquerda, importante em código de produto) e formato brasileiro
    // de data/número pode vir interpretado errado. Devolver sempre a
    // string crua e deixar quem consome decidir a conversão certa é o
    // mesmo espírito do raw:false que o xlsx antigo usava.
    await workbook.csv.readFile(filePath, { map: (datum) => (datum === '' ? null : datum) });
  } else {
    await workbook.xlsx.readFile(filePath);
  }
  const worksheet = (preferSheetName && workbook.getWorksheet(preferSheetName)) || workbook.worksheets[0];
  if (!worksheet) return { sheetNames: [], rows: [] };

  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '').trim();
  });

  const rows = [];
  for (let r = 2; r <= worksheet.rowCount; r++) {
    const linha = worksheet.getRow(r);
    if (linha.cellCount === 0) continue; // linha totalmente vazia
    const obj = {};
    let temAlgumValor = false;
    headers.forEach((h, colNumber) => {
      if (!h) return;
      let valor = linha.getCell(colNumber).value;
      if (valor && typeof valor === 'object' && valor.result !== undefined) valor = valor.result; // célula com fórmula
      if (valor && typeof valor === 'object' && valor.text !== undefined) valor = valor.text; // rich text
      if (valor instanceof Date) valor = valor.toISOString().slice(0, 10);
      obj[h] = valor === null || valor === undefined ? '' : valor;
      if (obj[h] !== '') temAlgumValor = true;
    });
    if (temAlgumValor) rows.push(obj);
  }
  return { sheetNames: workbook.worksheets.map((w) => w.name), rows };
}

/**
 * Escreve um array de objetos como planilha — colunas na ordem de
 * `columns`, nome de aba configurável. Mesmo espírito de
 * XLSX.utils.json_to_sheet + writeFile.
 */
async function writeRowsAsSheet(filePath, rows, columns, sheetName = 'Modelo') {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  worksheet.addRow(columns);
  rows.forEach((row) => worksheet.addRow(columns.map((c) => row[c] ?? '')));
  await workbook.xlsx.writeFile(filePath);
}

/**
 * Escreve VÁRIAS abas num único arquivo .xlsx -- usado quando a
 * importação lida com mais de uma entidade no mesmo arquivo (produtos +
 * insumos + ficha técnica, ver importExportService.importFromFile).
 * Cada item de `sheets` é `{ nome, colunas, linhas }`, mesmo espírito de
 * writeRowsAsSheet (colunas na ordem dada, célula ausente vira '').
 */
async function writeWorkbookWithSheets(filePath, sheets) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  for (const { nome, colunas, linhas } of sheets) {
    const worksheet = workbook.addWorksheet(nome);
    worksheet.addRow(colunas);
    (linhas || []).forEach((linha) => worksheet.addRow(colunas.map((c) => linha[c] ?? '')));
  }
  await workbook.xlsx.writeFile(filePath);
}

module.exports = { readSheetAsRows, writeRowsAsSheet, writeWorkbookWithSheets };
