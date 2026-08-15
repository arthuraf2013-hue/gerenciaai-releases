const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { readSheetAsRows, writeRowsAsSheet } = require('../electron/services/xlsxHelpers');

function caminhoTemp(ext) {
  // Era um caminho fixo `/tmp/...` — funciona por acaso no Linux/Mac
  // (onde /tmp sempre existe), mas no Windows o Node interpreta
  // `/tmp/...` como uma pasta "tmp" direto na raiz do drive atual
  // (ex: D:\tmp\...), que não existe nos runners do GitHub Actions —
  // dava ENOENT ao tentar escrever o arquivo, derrubando o `npm test`
  // sempre que o release.yml rodava no Windows (metade dos releases
  // publicados falhavam por causa disso, sem relação com o código
  // sendo testado). os.tmpdir() resolve a pasta temporária certa em
  // qualquer sistema operacional.
  return path.join(os.tmpdir(), `teste-xlsx-${randomUUID()}.${ext}`);
}

test('escreve e lê uma planilha .xlsx de volta, preservando os dados', async () => {
  const caminho = caminhoTemp('xlsx');
  const linhas = [
    { nome: 'Produto A', preco: 10.5 },
    { nome: 'Produto B', preco: 22 },
  ];
  await writeRowsAsSheet(caminho, linhas, ['nome', 'preco'], 'Modelo');

  const { rows, sheetNames } = await readSheetAsRows(caminho);
  assert.equal(sheetNames[0], 'Modelo');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].nome, 'Produto A');
  assert.equal(rows[0].preco, 10.5);
  assert.equal(rows[1].nome, 'Produto B');

  fs.unlinkSync(caminho);
});

test('pula linha totalmente vazia no meio da planilha', async () => {
  const caminho = caminhoTemp('xlsx');
  await writeRowsAsSheet(caminho, [{ nome: 'A', preco: 1 }, {}, { nome: 'B', preco: 2 }], ['nome', 'preco']);

  const { rows } = await readSheetAsRows(caminho);
  assert.equal(rows.length, 2, 'linha em branco não deveria virar uma linha de dados');
  assert.equal(rows[0].nome, 'A');
  assert.equal(rows[1].nome, 'B');

  fs.unlinkSync(caminho);
});

test('lê CSV corretamente, incluindo acentos', async () => {
  const caminho = caminhoTemp('csv');
  fs.writeFileSync(caminho, 'Código,Descrição\n001,Café com Açúcar\n', 'utf-8');

  const { rows } = await readSheetAsRows(caminho);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Código'], '001');
  assert.equal(rows[0]['Descrição'], 'Café com Açúcar');

  fs.unlinkSync(caminho);
});

test('CSV com código de produto começando em zero ("001") não perde os zeros à esquerda', async () => {
  const caminho = caminhoTemp('csv');
  fs.writeFileSync(caminho, 'codigo,nome\n001,Produto A\n0123,Produto B\n', 'utf-8');

  const { rows } = await readSheetAsRows(caminho);
  assert.equal(String(rows[0].codigo), '001', 'não pode virar o número 1, perdendo os zeros');
  assert.equal(String(rows[1].codigo), '0123');

  fs.unlinkSync(caminho);
});

test('CSV com vírgula decimal brasileira ("15,35") não vira número errado sozinho', async () => {
  const caminho = caminhoTemp('csv');
  fs.writeFileSync(caminho, 'produto,preco\nCafé,"15,35"\n', 'utf-8');

  const { rows } = await readSheetAsRows(caminho);
  // Precisa continuar como texto "15,35" -- é quem chama que decide
  // converter pro formato certo (não pode virar 1535 sozinho).
  assert.equal(String(rows[0].preco), '15,35');

  fs.unlinkSync(caminho);
});

test('planilha vazia (só cabeçalho, sem nenhuma linha de dados) devolve array vazio', async () => {
  const caminho = caminhoTemp('xlsx');
  await writeRowsAsSheet(caminho, [], ['nome', 'preco']);

  const { rows } = await readSheetAsRows(caminho);
  assert.equal(rows.length, 0);

  fs.unlinkSync(caminho);
});
