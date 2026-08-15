const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const { writeRowsAsSheet } = require('../electron/services/xlsxHelpers');
const importExportService = require('../electron/services/importExportService');

function caminhoTemp() {
  // Mesmo problema do `/tmp/...` fixo já corrigido em xlsxHelpers.test.js:
  // no Windows isso vira uma pasta que não existe (`D:\tmp\...`), dando
  // ENOENT. os.tmpdir() resolve a pasta temporária certa em qualquer SO.
  return path.join(os.tmpdir(), `teste-import-${randomUUID()}.xlsx`);
}

function estoqueTotal(db, productId, locationId) {
  return db.prepare(
    `SELECT COALESCE(SUM(quantidade),0) as total FROM stock_movements WHERE product_id = ? AND location_id = ?`
  ).get(productId, locationId).total;
}

test('importFromFile dá entrada no estoque inicial na primeira importação de um produto novo', async () => {
  const { db, locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeRowsAsSheet(
    caminho,
    [{ sku: 'SKU-1', nome: 'Produto Importado', preco_venda: 10, quantidade_estoque_inicial: 5 }],
    importExportService.COLUMNS,
    'Modelo'
  );

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.ok, true);
  assert.equal(resultado.report.importados, 1);

  const produto = db.prepare('SELECT * FROM products WHERE sku = ?').get('SKU-1');
  assert.ok(produto, 'produto deveria ter sido criado');
  assert.equal(estoqueTotal(db, produto.id, locationId), 5);

  fs.unlinkSync(caminho);
});

test('reimportar a MESMA planilha (mesmo sku) NÃO soma o estoque inicial de novo — só atualiza os dados do produto', async () => {
  const { db, locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeRowsAsSheet(
    caminho,
    [{ sku: 'SKU-2', nome: 'Produto Importado', preco_venda: 10, quantidade_estoque_inicial: 8 }],
    importExportService.COLUMNS,
    'Modelo'
  );

  const primeira = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(primeira.report.importados, 1);

  const produto = db.prepare('SELECT * FROM products WHERE sku = ?').get('SKU-2');
  assert.equal(estoqueTotal(db, produto.id, locationId), 8, 'primeira importação deveria dar entrada de 8 unidades');

  // Reimporta o MESMO arquivo — simula reenviar a planilha de novo (ex:
  // pra corrigir uma célula em outra coluna). Isso é um UPDATE do produto
  // já existente, não uma criação nova.
  const segunda = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(segunda.report.atualizados, 1, 'segunda importação do mesmo sku deveria contar como atualização, não como novo produto');
  assert.equal(segunda.report.importados, 0);

  assert.equal(
    estoqueTotal(db, produto.id, locationId), 8,
    'reimportar a mesma planilha não deveria somar o estoque inicial de novo — continua 8, não 16'
  );

  fs.unlinkSync(caminho);
});
