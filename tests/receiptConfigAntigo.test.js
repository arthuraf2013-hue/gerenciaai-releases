const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrateColumnsIfNeeded } = require('../electron/db/database');

// Banco de quem usa o app desde antes: receipt_config sem o rodapé e sem a
// impressão automática ("no such column: rodape_texto" em Configurações > Impressora).
test('receipt_config antiga ganha rodape_texto e imprimir_automatico na migração, sem perder o que já tinha', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../electron/db/schema.sql'), 'utf-8'));
  db.exec('DROP TABLE receipt_config');
  db.exec(`CREATE TABLE receipt_config (id TEXT PRIMARY KEY DEFAULT 'default', largura_mm INTEGER NOT NULL DEFAULT 80);
           INSERT INTO receipt_config (id, largura_mm) VALUES ('default', 58);`);
  assert.throws(() => db.prepare('SELECT rodape_texto FROM receipt_config').get(), /no such column: rodape_texto/);
  migrateColumnsIfNeeded(db);
  const cols = db.prepare('PRAGMA table_info(receipt_config)').all().map((c) => c.name);
  assert.ok(cols.includes('rodape_texto') && cols.includes('imprimir_automatico') && cols.includes('impressora_padrao'));
  const linha = db.prepare("SELECT largura_mm, rodape_texto, imprimir_automatico FROM receipt_config WHERE id = 'default'").get();
  assert.deepEqual({ ...linha }, { largura_mm: 58, rodape_texto: null, imprimir_automatico: 0 });
  // Rodar de novo não quebra.
  assert.doesNotThrow(() => migrateColumnsIfNeeded(db));
  db.close();
});
