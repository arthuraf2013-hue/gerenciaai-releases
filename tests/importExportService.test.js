const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const { writeRowsAsSheet, writeWorkbookWithSheets } = require('../electron/services/xlsxHelpers');
const importExportService = require('../electron/services/importExportService');
const ingredientService = require('../electron/services/ingredientService');
const saleService = require('../electron/services/saleService');

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

// ---------- Campos extras genéricos (todos os perfis, não só farmácia) ----------

test('importFromFile grava campos extras de QUALQUER perfil nativo, não só os de farmácia', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeRowsAsSheet(
    caminho,
    [
      // Petshop
      { sku: 'PET-1', nome: 'Ração Cão Adulto', preco_venda: 89.9, especie_animal: 'cão', peso_volume: '15kg', exige_receita_veterinaria: 'não' },
      // Restaurante
      { sku: 'PRT-1', nome: 'Risoto de Camarão', preco_venda: 59.9, tipo_prato: 'Prato principal', tempo_preparo: 25, disponivel_hoje: 'sim' },
      // Ótica
      { sku: 'OTC-1', nome: 'Lente Multifocal', preco_venda: 450, grau: '-2.00', tipo_lente: 'multifocal' },
    ],
    importExportService.COLUMNS,
    'Modelo'
  );

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.ok, true);
  assert.equal(resultado.report.importados, 3);

  const { getDb } = require('../electron/db/database');
  const db = getDb();

  const pet = JSON.parse(db.prepare('SELECT custom_fields FROM products WHERE sku = ?').get('PET-1').custom_fields);
  assert.equal(pet.especie_animal, 'cão');
  assert.equal(pet.peso_volume, '15kg');
  assert.equal(pet.exige_receita_veterinaria, false);

  const prato = JSON.parse(db.prepare('SELECT custom_fields FROM products WHERE sku = ?').get('PRT-1').custom_fields);
  assert.equal(prato.tipo_prato, 'Prato principal');
  assert.equal(prato.tempo_preparo, '25');
  assert.equal(prato.disponivel_hoje, true);

  const otica = JSON.parse(db.prepare('SELECT custom_fields FROM products WHERE sku = ?').get('OTC-1').custom_fields);
  assert.equal(otica.grau, '-2.00');
  assert.equal(otica.tipo_lente, 'multifocal');
  // Campo de outro perfil (farmácia) não veio preenchido -- não deveria
  // aparecer no JSON de um produto de ótica.
  assert.equal(otica.lote, undefined);

  fs.unlinkSync(caminho);
});

test('campo booleano de qualquer perfil sem valor na planilha grava "false" (não fica ausente do custom_fields)', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeRowsAsSheet(
    caminho,
    [{ sku: 'ARM-1', nome: 'Arroz 5kg', preco_venda: 24.9 }], // sem preencher nenhum campo extra
    importExportService.COLUMNS,
    'Modelo'
  );

  await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });

  const { getDb } = require('../electron/db/database');
  const custom = JSON.parse(getDb().prepare('SELECT custom_fields FROM products WHERE sku = ?').get('ARM-1').custom_fields);
  assert.equal(custom.perecivel, false, 'booleano ausente deveria gravar false, igual ao comportamento já existente pra controlado/exige_receita');
  assert.equal(custom.peso_liquido, undefined, 'campo de texto vazio não deveria aparecer no JSON');

  fs.unlinkSync(caminho);
});

// ---------- Aba opcional "Insumos" ----------

test('aba "Insumos" cadastra insumos novos e atualiza os existentes (upsert por nome)', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeWorkbookWithSheets(caminho, [
    { nome: 'Modelo', colunas: importExportService.COLUMNS, linhas: [{ sku: 'X1', nome: 'Produto X', preco_venda: 10 }] },
    {
      nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS,
      linhas: [
        { nome: 'Farinha de Trigo', unidade: 'kg', custo_unitario: 5.5, estoque_atual: 20, estoque_minimo: 5 },
        { nome: 'Camarão', unidade: 'kg', custo_unitario: 45, estoque_atual: 10, estoque_minimo: 2 },
      ],
    },
  ]);

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.ok, true);
  assert.ok(resultado.report.insumos, 'deveria ter processado a aba Insumos');
  assert.equal(resultado.report.insumos.importados, 2);
  assert.equal(resultado.report.insumos.atualizados, 0);

  const lista = ingredientService.list();
  const farinha = lista.find((i) => i.nome === 'Farinha de Trigo');
  assert.ok(farinha);
  assert.equal(farinha.custo_unitario, 5.5);
  assert.equal(farinha.estoque_atual, 20);

  fs.unlinkSync(caminho);
});

test('reimportar a aba "Insumos" não reseta o estoque já consumido em vendas — só atualiza custo/unidade/mínimo', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeWorkbookWithSheets(caminho, [
    { nome: 'Modelo', colunas: importExportService.COLUMNS, linhas: [{ sku: 'X2', nome: 'Produto Y', preco_venda: 10 }] },
    { nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS, linhas: [{ nome: 'Óleo de Soja', unidade: 'l', custo_unitario: 8, estoque_atual: 30, estoque_minimo: 5 }] },
  ]);

  await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  const antes = ingredientService.list().find((i) => i.nome === 'Óleo de Soja');
  assert.equal(antes.estoque_atual, 30);

  // Simula consumo real (venda) baixando o estoque do insumo -- se a
  // reimportação resetasse pro valor da planilha, essa baixa seria
  // perdida silenciosamente.
  const { getDb } = require('../electron/db/database');
  getDb().prepare('UPDATE ingredients SET estoque_atual = estoque_atual - 12 WHERE id = ?').run(antes.id);

  // Reimporta a MESMA planilha (ex: corrigindo o custo unitário) --
  // muda só o custo desta vez, pra simular a edição real que motivaria
  // reimportar.
  const caminho2 = caminhoTemp();
  await writeWorkbookWithSheets(caminho2, [
    { nome: 'Modelo', colunas: importExportService.COLUMNS, linhas: [{ sku: 'X2', nome: 'Produto Y', preco_venda: 10 }] },
    { nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS, linhas: [{ nome: 'Óleo de Soja', unidade: 'l', custo_unitario: 9, estoque_atual: 30, estoque_minimo: 5 }] },
  ]);
  const resultado = await importExportService.importFromFile(caminho2, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.report.insumos.atualizados, 1);

  const depois = ingredientService.list().find((i) => i.nome === 'Óleo de Soja');
  assert.equal(depois.custo_unitario, 9, 'custo deveria ter atualizado');
  assert.equal(depois.estoque_atual, 18, 'reimportar não deveria resetar o estoque já consumido (30 - 12 = 18, não voltar pra 30)');

  fs.unlinkSync(caminho);
  fs.unlinkSync(caminho2);
});

test('aba "Insumos" recusa linha sem nome ou com custo_unitario inválido, sem travar as outras linhas', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeWorkbookWithSheets(caminho, [
    { nome: 'Modelo', colunas: importExportService.COLUMNS, linhas: [{ sku: 'X3', nome: 'Produto Z', preco_venda: 10 }] },
    {
      nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS,
      linhas: [
        { nome: '', unidade: 'kg', custo_unitario: 5 },
        { nome: 'Sal', unidade: 'kg', custo_unitario: 'abc' },
        { nome: 'Açúcar', unidade: 'kg', custo_unitario: 4 },
      ],
    },
  ]);

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.report.insumos.erros.length, 2);
  assert.equal(resultado.report.insumos.importados, 1);
  assert.ok(ingredientService.list().find((i) => i.nome === 'Açúcar'));

  fs.unlinkSync(caminho);
});

// ---------- Aba opcional "Ficha Tecnica" ----------

test('aba "Ficha Tecnica" monta a receita do produto a partir de várias linhas (produto + N insumos)', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeWorkbookWithSheets(caminho, [
    { nome: 'Modelo', colunas: importExportService.COLUMNS, linhas: [{ sku: 'RIS-1', nome: 'Risoto de Camarão', preco_venda: 59.9, categoria: 'Pratos' }] },
    {
      nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS,
      linhas: [
        { nome: 'Arroz Arbóreo', unidade: 'kg', custo_unitario: 12, estoque_atual: 10 },
        { nome: 'Camarão', unidade: 'kg', custo_unitario: 45, estoque_atual: 5 },
      ],
    },
    {
      nome: 'Ficha Tecnica', colunas: importExportService.COLUNAS_FICHA_TECNICA,
      linhas: [
        { produto: 'Risoto de Camarão', insumo: 'Arroz Arbóreo', quantidade: 0.15 },
        { sku_produto: 'RIS-1', insumo: 'Camarão', quantidade: 0.12 },
      ],
    },
  ]);

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.ok, true);
  assert.equal(resultado.report.fichaTecnica.produtosComReceita, 1);
  assert.equal(resultado.report.fichaTecnica.erros.length, 0);

  const { getDb } = require('../electron/db/database');
  const produto = getDb().prepare('SELECT id FROM products WHERE sku = ?').get('RIS-1');
  const receita = ingredientService.getRecipe(produto.id);
  assert.equal(receita.length, 2);
  assert.ok(receita.find((r) => r.nome === 'Arroz Arbóreo' && r.quantidade === 0.15));
  assert.ok(receita.find((r) => r.nome === 'Camarão' && r.quantidade === 0.12));

  fs.unlinkSync(caminho);
});

test('aba "Ficha Tecnica" reporta erro quando produto ou insumo não existem, sem criar nada sozinha', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeWorkbookWithSheets(caminho, [
    { nome: 'Modelo', colunas: importExportService.COLUMNS, linhas: [{ sku: 'PAO-1', nome: 'Pão Francês', preco_venda: 0.8, categoria: 'Padaria' }] },
    { nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS, linhas: [{ nome: 'Farinha de Trigo', unidade: 'kg', custo_unitario: 5, estoque_atual: 50 }] },
    {
      nome: 'Ficha Tecnica', colunas: importExportService.COLUNAS_FICHA_TECNICA,
      linhas: [
        { produto: 'Produto Que Não Existe', insumo: 'Farinha de Trigo', quantidade: 0.1 },
        { produto: 'Pão Francês', insumo: 'Insumo Que Não Existe', quantidade: 0.1 },
      ],
    },
  ]);

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.report.fichaTecnica.erros.length, 2);
  assert.equal(resultado.report.fichaTecnica.produtosComReceita, 0);

  const { getDb } = require('../electron/db/database');
  const produto = getDb().prepare('SELECT id FROM products WHERE sku = ?').get('PAO-1');
  assert.equal(ingredientService.getRecipe(produto.id).length, 0, 'não deveria ter criado ficha técnica nenhuma a partir de linhas com erro');

  fs.unlinkSync(caminho);
});

// ---------- Fim a fim: planilha -> venda -> insumo é descontado de verdade ----------

test('fim a fim: importar Modelo + Insumos + Ficha Tecnica e vender o prato desconta os insumos proporcionalmente', async () => {
  const { locationId, adminId } = freshTestDb();
  const caminho = caminhoTemp();
  await writeWorkbookWithSheets(caminho, [
    {
      nome: 'Modelo', colunas: importExportService.COLUMNS,
      linhas: [{ sku: 'RIS-2', nome: 'Risoto de Camarão', categoria: 'Pratos', preco_venda: 59.9, quantidade_estoque_inicial: 100, tipo_prato: 'Prato principal' }],
    },
    {
      nome: 'Insumos', colunas: importExportService.COLUNAS_INSUMOS,
      linhas: [
        { nome: 'Arroz Arbóreo', unidade: 'kg', custo_unitario: 12, estoque_atual: 10 },
        { nome: 'Camarão', unidade: 'kg', custo_unitario: 45, estoque_atual: 5 },
      ],
    },
    {
      nome: 'Ficha Tecnica', colunas: importExportService.COLUNAS_FICHA_TECNICA,
      linhas: [
        { sku_produto: 'RIS-2', insumo: 'Arroz Arbóreo', quantidade: 0.15 },
        { sku_produto: 'RIS-2', insumo: 'Camarão', quantidade: 0.12 },
      ],
    },
  ]);

  const resultado = await importExportService.importFromFile(caminho, { locationId, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(resultado.ok, true);

  const { getDb } = require('../electron/db/database');
  const db = getDb();
  const produto = db.prepare('SELECT id FROM products WHERE sku = ?').get('RIS-2');

  // Vende 3 porções do prato -- é isso que dispara
  // ingredientService.descontarPorVenda de dentro de saleService.addItem
  // (mesma transação que já baixa o estoque do PRODUTO em si).
  const { id: saleId } = saleService.openSale({ locationId, operadorId: adminId });
  const item = saleService.addItem({ saleId, productId: produto.id, locationId, quantidade: 3, operadorId: adminId, deviceId: 'dev-teste' });
  assert.equal(item.ok, true);

  const arroz = ingredientService.list().find((i) => i.nome === 'Arroz Arbóreo');
  const camarao = ingredientService.list().find((i) => i.nome === 'Camarão');
  assert.equal(arroz.estoque_atual, 10 - 0.15 * 3, 'arroz deveria ter descontado 0.15kg x 3 porções');
  assert.equal(camarao.estoque_atual, 5 - 0.12 * 3, 'camarão deveria ter descontado 0.12kg x 3 porções');

  // Cancelar o item devolve os insumos -- mesma simetria já coberta em
  // ingredientService.test.js, conferida aqui de ponta a ponta a partir
  // da planilha importada.
  const cancelado = saleService.cancelSaleItem({ saleId, saleItemId: item.itemId, locationId, currentOperatorId: adminId, deviceId: 'dev-teste' });
  assert.equal(cancelado.ok, true);
  assert.equal(ingredientService.list().find((i) => i.nome === 'Arroz Arbóreo').estoque_atual, 10, 'cancelar a venda deveria devolver o insumo integralmente');

  fs.unlinkSync(caminho);
});
