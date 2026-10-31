const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const Database = require('better-sqlite3');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const { montarNfeXml } = require('./helpers/nfeXml');
const timeService = require('../electron/services/timeService');
const { setDbForTesting, migrateColumnsIfNeeded } = require('../electron/db/database');

// ---------- banco de quem já usa o app ----------

test('banco antigo (sem as colunas e tabelas do ERP) abre com o schema novo e migra sem perder nada', () => {
  // O arquivo é CRLF no Windows; as comparações abaixo são por linha.
  const schemaNovo = fs.readFileSync(path.join(__dirname, '../electron/db/schema.sql'), 'utf-8').replace(/\r\n/g, '\n');
  // Monta o schema "de antes do ERP": sem os blocos de tabelas do ERP e
  // sem as colunas que o ERP acrescentou em tabelas antigas.
  const inicioBloco = schemaNovo.indexOf('-- ERP, Fase 1 -- custo médio');
  const ultimaLinha = 'CREATE INDEX IF NOT EXISTS idx_inventory_count_items_count';
  const fimBloco = schemaNovo.indexOf(ultimaLinha);
  assert.ok(inicioBloco > 0 && fimBloco > inicioBloco);
  let schemaAntigo = schemaNovo.slice(0, schemaNovo.lastIndexOf('-- =====', inicioBloco))
    + schemaNovo.slice(schemaNovo.indexOf('\n', fimBloco) + 1);
  const semColunas = (sql, tabela, colunas) => {
    const ini = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tabela} (`);
    const fim = sql.indexOf('\n);', ini) + 3;
    assert.ok(ini >= 0 && fim > ini, tabela);
    let bloco = sql.slice(ini, fim);
    for (const c of colunas) assert.match(bloco, new RegExp(`\\n\\s+${c}\\s`), `${tabela}.${c}`);
    bloco = bloco.split('\n').filter((l) => !colunas.some((c) => new RegExp(`^\\s+${c}\\s`).test(l))).join('\n');
    bloco = bloco.replace(/,(\s*(?:--[^\n]*\n\s*)*)\);$/, '$1);'); // a última coluna não termina em vírgula
    return sql.slice(0, ini) + bloco + sql.slice(fim);
  };
  schemaAntigo = semColunas(schemaAntigo, 'modulos_pagos_state', ['erp_compras', 'erp_financeiro', 'erp_estoque', 'erp_fiscal']);
  schemaAntigo = semColunas(schemaAntigo, 'expenses', ['nfe_entrada_id', 'recorrencia_id', 'competencia']);
  schemaAntigo = semColunas(schemaAntigo, 'sale_items', ['custo_unitario']);

  const db = new Database(':memory:');
  db.function('NOW_SYNCED', () => timeService.nowSyncedUTCString());
  db.exec(schemaAntigo);
  const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(!colunas('expenses').includes('nfe_entrada_id'), 'simulou o banco antigo');
  assert.ok(!colunas('sale_items').includes('custo_unitario'));
  assert.ok(!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'nfe_entradas'`).get());
  assert.ok(!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'inventory_counts'`).get());
  db.prepare(`INSERT INTO locations (id, nome) VALUES ('l1', 'Loja')`).run();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES ('u1', 'Dono', 'admin', 'x')`).run();
  db.prepare(`INSERT INTO expenses (id, categoria, descricao, valor, location_id, operador_id) VALUES ('e1', 'aluguel', 'Aluguel', 900, 'l1', 'u1')`).run();
  db.prepare(`INSERT INTO products (id, nome, preco, custo) VALUES ('p1', 'Produto', 10, 4)`).run();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id) VALUES ('s1', 'l1', 'u1')`).run();
  db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES ('i1', 's1', 'p1', 1, 10)`).run();

  // Ordem real da abertura (getDb): schema.sql inteiro ANTES da migração.
  // Sem rede de segurança aqui de propósito: o schema não pode citar coluna nova.
  assert.doesNotThrow(() => db.exec(schemaNovo));
  migrateColumnsIfNeeded(db);

  assert.ok(colunas('expenses').includes('nfe_entrada_id'));
  assert.ok(colunas('expenses').includes('competencia'));
  assert.ok(colunas('modulos_pagos_state').includes('erp_compras'));
  assert.ok(colunas('modulos_pagos_state').includes('erp_fiscal'));
  assert.ok(colunas('sale_items').includes('custo_unitario'));
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_sale_items_custo'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_expenses_recorrencia_competencia'`).get());
  // Item antigo fica sem custo (NULL = venda de antes); item novo ganha o custo da hora.
  assert.equal(db.prepare(`SELECT custo_unitario FROM sale_items WHERE id = 'i1'`).get().custo_unitario, null);
  db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES ('i2', 's1', 'p1', 1, 10)`).run();
  assert.equal(db.prepare(`SELECT custo_unitario FROM sale_items WHERE id = 'i2'`).get().custo_unitario, 4);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_expenses_nfe_entrada'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_nfe_entradas_chave_ativa'`).get());
  assert.equal(db.prepare(`SELECT valor FROM expenses WHERE id = 'e1'`).get().valor, 900);
  // Rodar de novo (próxima abertura) não quebra.
  assert.doesNotThrow(() => { db.exec(schemaNovo); migrateColumnsIfNeeded(db); });
  setDbForTesting(new Database(':memory:')); // devolve um banco limpo pros próximos testes
});

// ---------- IPC: papel e licença do módulo ----------

const canais = new Map();
const electronFalso = {
  ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [global.__xmlTeste] }) },
  BrowserWindow: { getFocusedWindow: () => null },
  shell: { openPath: async () => '', openExternal: async () => {} },
  app: { getVersion: () => '0.0.0-teste', getPath: () => require('os').tmpdir() },
};
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronFalso;
  return loadOriginal.call(this, request, parent, isMain);
};
const { registerIpcHandlers } = require('../electron/ipc/handlers');
const sessionService = require('../electron/services/sessionService');
registerIpcHandlers();
Module._load = loadOriginal;

const chamar = (canal, payload, id) => canais.get(canal)({ sender: { id } }, payload);

test('operador não abre pedido de compra, nota de entrada nem histórico de custo', async () => {
  const { operadorId } = freshTestDb();
  sessionService.iniciarSessao(11, { id: operadorId, nome: 'Op', role: 'operador' });
  for (const canal of ['purchaseOrder:list', 'purchaseOrder:save', 'nfeEntrada:list', 'nfeEntrada:confirmar', 'nfeEntrada:estornar', 'custoMedio:historico']) {
    const r = await chamar(canal, {}, 11);
    assert.equal(r.ok, false, canal);
    assert.match(r.error, /permissão/, canal);
  }
});

test('módulo ERP — Compras confirmado desligado: recusa pedido e nota; custo médio continua', async () => {
  const { db, gerenteId } = freshTestDb();
  sessionService.iniciarSessao(12, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  db.prepare(`INSERT INTO modulos_pagos_state (id, cliente_id, erp_compras, ja_sincronizado) VALUES ('default', 'c1', 0, 1)`).run();
  assert.equal((await chamar('erp:status', undefined, 12)).compras, false);
  for (const canal of ['purchaseOrder:list', 'nfeEntrada:list', 'nfeEntrada:importarXml']) {
    const r = await chamar(canal, {}, 12);
    assert.equal(r.ok, false, canal);
    assert.equal(r.moduloInativo, true, canal);
  }
  const hist = await chamar('custoMedio:historico', { productId: createProduct(db) }, 12);
  assert.deepEqual(hist, []);

  db.prepare(`UPDATE modulos_pagos_state SET erp_compras = 1`).run();
  assert.equal((await chamar('erp:status', undefined, 12)).compras, true);
  assert.ok(Array.isArray(await chamar('purchaseOrder:list', {}, 12)));
});

test('importar XML pelo IPC: o caminho vem do diálogo, o operador vem da sessão', async () => {
  const { db, locationId, gerenteId, operadorId } = freshTestDb();
  sessionService.iniciarSessao(13, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const arquivo = path.join(require('os').tmpdir(), `nfe-teste-${process.pid}.xml`);
  fs.writeFileSync(arquivo, montarNfeXml({ itens: [{ codigo: 'A', descricao: 'ITEM A', qCom: 1, vUnCom: 3, vProd: 3 }] }).xml);
  global.__xmlTeste = arquivo;
  try {
    const r = await chamar('nfeEntrada:importarXml', { locationId, operadorId }, 13);
    assert.equal(r.ok, true, r.error);
    assert.equal(db.prepare('SELECT operador_id FROM nfe_entradas WHERE id = ?').get(r.id).operador_id, gerenteId);
  } finally {
    fs.unlinkSync(arquivo);
  }
});
