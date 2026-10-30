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
  // Monta o schema "de antes": sem o bloco do ERP e sem as duas colunas novas.
  const inicioBloco = schemaNovo.indexOf('-- ERP, Fase 1 -- custo médio');
  const fimBloco = schemaNovo.indexOf('CREATE INDEX IF NOT EXISTS idx_nfe_entrada_duplicatas_entrada');
  assert.ok(inicioBloco > 0 && fimBloco > inicioBloco);
  let schemaAntigo = schemaNovo.slice(0, schemaNovo.lastIndexOf('-- =====', inicioBloco))
    + schemaNovo.slice(schemaNovo.indexOf('\n', fimBloco) + 1);
  const semColuna = (sql, trecho) => {
    assert.ok(sql.includes(trecho), trecho);
    return sql.replace(trecho, '');
  };
  schemaAntigo = semColuna(schemaAntigo, `  erp_compras       INTEGER NOT NULL DEFAULT 0,\n`);
  const trechoNovo = `criado_em       TEXT NOT NULL DEFAULT (NOW_SYNCED()),\n  -- Conta a pagar gerada por uma entrada de NF-e (uma por duplicata) --\n  -- é por aqui que o estorno da entrada acha o que cancelar. O índice\n  -- desta coluna fica em database.js (coluna nova em tabela antiga).\n  nfe_entrada_id  TEXT\n`;
  assert.ok(schemaAntigo.includes(trechoNovo));
  schemaAntigo = schemaAntigo.replace(trechoNovo, 'criado_em       TEXT NOT NULL DEFAULT (NOW_SYNCED())\n');

  const db = new Database(':memory:');
  db.function('NOW_SYNCED', () => timeService.nowSyncedUTCString());
  db.exec(schemaAntigo);
  const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(!colunas('expenses').includes('nfe_entrada_id'), 'simulou o banco antigo');
  assert.ok(!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'nfe_entradas'`).get());
  db.prepare(`INSERT INTO locations (id, nome) VALUES ('l1', 'Loja')`).run();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES ('u1', 'Dono', 'admin', 'x')`).run();
  db.prepare(`INSERT INTO expenses (id, categoria, descricao, valor, location_id, operador_id) VALUES ('e1', 'aluguel', 'Aluguel', 900, 'l1', 'u1')`).run();

  // Ordem real da abertura (getDb): schema.sql inteiro ANTES da migração.
  // Sem rede de segurança aqui de propósito: o schema não pode citar coluna nova.
  assert.doesNotThrow(() => db.exec(schemaNovo));
  migrateColumnsIfNeeded(db);

  assert.ok(colunas('expenses').includes('nfe_entrada_id'));
  assert.ok(colunas('modulos_pagos_state').includes('erp_compras'));
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
  assert.deepEqual(await chamar('erp:status', undefined, 12), { compras: false });
  for (const canal of ['purchaseOrder:list', 'nfeEntrada:list', 'nfeEntrada:importarXml']) {
    const r = await chamar(canal, {}, 12);
    assert.equal(r.ok, false, canal);
    assert.equal(r.moduloInativo, true, canal);
  }
  const hist = await chamar('custoMedio:historico', { productId: createProduct(db) }, 12);
  assert.deepEqual(hist, []);

  db.prepare(`UPDATE modulos_pagos_state SET erp_compras = 1`).run();
  assert.deepEqual(await chamar('erp:status', undefined, 12), { compras: true });
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
