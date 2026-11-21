// Quem lançou cada item da mesa: garçom, caixa, QR da mesa ou vitrine (nov/2026).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const esbuild = require('esbuild');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const tableService = require('../electron/services/tableService');

function mesaAberta() {
  const ctx = freshTestDb();
  const garcomId = randomUUID();
  ctx.db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Carlos', 'garcom', 'x')`).run(garcomId);
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '4' }).id;
  const cerveja = createProduct(ctx.db, { nome: 'Cerveja', preco: 12 });
  addStock(ctx.db, { productId: cerveja, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  const saleId = tableService.openTable({ tableId: mesa, locationId: ctx.locationId, operadorId: ctx.operadorId }).saleId;
  const add = (extra) => {
    const r = saleService.addItem({ saleId, productId: cerveja, locationId: ctx.locationId, quantidade: 1, deviceId: 't', ...extra });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  return { ...ctx, garcomId, saleId, add };
}

test('cada item guarda quem lançou e por onde, e só junta linha do mesmo autor', () => {
  const { saleId, add, operadorId, garcomId } = mesaAberta();
  const caixa1 = add({ operadorId });
  const caixa2 = add({ operadorId });
  assert.equal(caixa2.itemId, caixa1.itemId, 'mesmo autor e origem: soma na mesma linha');
  const celular = add({ operadorId: garcomId, origem: 'app_garcom' });
  const noPdv = add({ operadorId: garcomId });
  const qr = add({ operadorId, origem: 'qr_mesa' });
  const vitrine = add({ operadorId, origem: 'vitrine' });
  const estranho = add({ operadorId, origem: 'inventado' });
  assert.equal(new Set([caixa1.itemId, celular.itemId, noPdv.itemId, qr.itemId, vitrine.itemId]).size, 5);
  assert.equal(estranho.itemId, caixa1.itemId, 'origem desconhecida conta como lançado no computador');

  const itens = new Map(tableService.getTableCart(saleId).items.map((i) => [i.id, i]));
  assert.deepEqual(
    [caixa1, celular, noPdv, qr, vitrine].map((r) => { const i = itens.get(r.itemId); return [i.origem, i.lancadoPorNome, i.lancadoPorPapel, i.quantidade]; }),
    [
      [null, 'Operador Teste', 'operador', 3],
      ['app_garcom', 'Carlos', 'garcom', 1],
      [null, 'Carlos', 'garcom', 1],
      ['qr_mesa', 'Operador Teste', 'operador', 1],
      ['vitrine', 'Operador Teste', 'operador', 1],
    ],
  );
});

function carregarTela() {
  const r = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/components/pos/TableOrderScreen.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'empty', '.png': 'empty', '.svg': 'empty', '.mp3': 'empty', '.wav': 'empty' }, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

test('tela: rótulo ao lado do item e agrupamento por quem lançou', () => {
  const { autoriaDoItem, gruposPorAutor } = carregarTela();
  assert.equal(autoriaDoItem({ origem: 'qr_mesa', lancadoPorNome: 'Ana' }).texto, 'QR da mesa');
  assert.equal(autoriaDoItem({ origem: 'vitrine' }).texto, 'Vitrine online');
  assert.equal(autoriaDoItem({ origem: 'app_garcom', lancadoPorNome: 'Carlos', lancadoPorPapel: 'garcom' }).texto, 'Garçom Carlos (celular)');
  assert.equal(autoriaDoItem({ lancadoPorNome: 'Carlos', lancadoPorPapel: 'garcom' }).texto, 'Garçom Carlos');
  assert.deepEqual(autoriaDoItem({ lancadoPorNome: 'Ana', lancadoPorPapel: 'operador' }), { tipo: 'caixa', texto: 'Ana' });
  assert.equal(autoriaDoItem({}), null);

  const grupos = gruposPorAutor([
    { id: 1, nome: 'Cerveja', quantidade: 2, precoUnitario: 12, origem: 'app_garcom', lancadoPorNome: 'Carlos' },
    { id: 2, nome: 'Suco', quantidade: 1, precoUnitario: 8, origem: 'qr_mesa' },
    { id: 3, nome: 'Água', quantidade: 1, precoUnitario: 5, origem: 'app_garcom', lancadoPorNome: 'Carlos' },
    { id: 4, nome: 'Prato', quantidade: 1, precoUnitario: 40, cancelado: true, origem: 'qr_mesa' },
    { id: 5, nome: 'Antigo', quantidade: 1, precoUnitario: 3 },
  ]);
  assert.deepEqual(grupos.map((g) => [g.texto, g.itens.length, g.qtd, g.total]), [
    ['Garçom Carlos (celular)', 2, 3, 29],
    ['QR da mesa', 1, 1, 8],
    ['Sem registro (lançado antes da atualização)', 1, 1, 3],
  ]);
});
