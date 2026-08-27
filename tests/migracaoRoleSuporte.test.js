const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const { atualizarCheckRoleParaIncluirSuporte } = require('../electron/db/database');

// Mesmo raciocínio de tests/migracaoRoleGarcom.test.js, agora pro papel
// 'suporte' -- simula uma instalação já existente (banco criado antes do
// papel 'suporte' existir, mas já com 'garcom') e confere que a migração
// de recriação de tabela preserva os dados, passa a aceitar 'suporte', e
// não quebra o FK de outras tabelas que referenciam users(id).
test('atualizarCheckRoleParaIncluirSuporte preserva dados e mantém FK íntegro', () => {
  const { db, locationId, adminId, gerenteId, operadorId } = freshTestDb();

  // Recria `users` com o CHECK de antes (sem 'suporte'), pra simular o
  // estado de um banco de cliente já em produção.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users_antigo (
      id TEXT PRIMARY KEY, nome TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('operador','gerente','admin','garcom')),
      pin_hash TEXT NOT NULL, pin_temporario INTEGER DEFAULT 0,
      tentativas_falhas INTEGER NOT NULL DEFAULT 0, bloqueado_ate TEXT,
      ativo INTEGER DEFAULT 1, criado_em TEXT NOT NULL DEFAULT (NOW_SYNCED())
    );
  `);
  db.exec(`
    INSERT INTO users_antigo (id, nome, role, pin_hash, pin_temporario, tentativas_falhas, bloqueado_ate, ativo, criado_em)
    SELECT id, nome, role, pin_hash, pin_temporario, tentativas_falhas, bloqueado_ate, ativo, criado_em FROM users;
  `);
  db.exec(`DROP TABLE users;`);
  db.exec(`ALTER TABLE users_antigo RENAME TO users;`);
  db.pragma('foreign_keys = ON');

  // Confirma que de fato simulamos o estado antigo.
  assert.throws(() => {
    db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'X', 'suporte', 'hash')`).run(randomUUID());
  }, /CHECK constraint failed/);

  // Uma venda referenciando o admin -- pra confirmar que o FK
  // sales.operador_id -> users.id continua íntegro depois da migração.
  const saleId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status) VALUES (?, ?, ?, 'aberta')`)
    .run(saleId, locationId, adminId);

  atualizarCheckRoleParaIncluirSuporte(db);

  // Dados antigos preservados.
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  const gerente = db.prepare('SELECT * FROM users WHERE id = ?').get(gerenteId);
  const operador = db.prepare('SELECT * FROM users WHERE id = ?').get(operadorId);
  assert.equal(admin.role, 'admin');
  assert.equal(gerente.role, 'gerente');
  assert.equal(operador.role, 'operador');

  // Agora aceita 'suporte'.
  const suporteId = randomUUID();
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Suporte Teste', 'suporte', 'hash')`).run(suporteId);
  });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(suporteId).role, 'suporte');

  // Continua aceitando 'garcom' (migração anterior não foi desfeita).
  const garcomId = randomUUID();
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Garçom Teste', 'garcom', 'hash')`).run(garcomId);
  });

  // FK continua íntegro (join resolve normalmente).
  const vendaComOperador = db.prepare(
    `SELECT s.id, u.nome FROM sales s JOIN users u ON u.id = s.operador_id WHERE s.id = ?`
  ).get(saleId);
  assert.ok(vendaComOperador);
  assert.equal(vendaComOperador.nome, admin.nome);

  // Rodar de novo é no-op (já migrado) e não derruba nada.
  assert.doesNotThrow(() => atualizarCheckRoleParaIncluirSuporte(db));
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM users').get().c, 5);
});
