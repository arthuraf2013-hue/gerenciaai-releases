const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const { atualizarCheckRoleParaIncluirGarcom } = require('../electron/db/database');

// Simula uma instalação já existente (banco criado antes do papel 'garcom'
// existir) e confere que a migração de recriação de tabela preserva os
// dados, passa a aceitar 'garcom', e não quebra o FK de outras tabelas
// que referenciam users(id) — o risco específico que o rename-into-place
// (criar a tabela nova num nome temporário e só renomear pra "users" no
// final) foi desenhado pra evitar.
test('atualizarCheckRoleParaIncluirGarcom preserva dados e mantém FK íntegro', () => {
  const { db, locationId, adminId, gerenteId, operadorId } = freshTestDb();

  // Recria `users` com o CHECK de antes (sem 'garcom'), pra simular o
  // estado de um banco de cliente já em produção.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users_antigo (
      id TEXT PRIMARY KEY, nome TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('operador','gerente','admin')),
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
    db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'X', 'garcom', 'hash')`).run(randomUUID());
  }, /CHECK constraint failed/);

  // Uma venda referenciando o admin -- pra confirmar que o FK
  // sales.operador_id -> users.id continua íntegro depois da migração.
  const saleId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status) VALUES (?, ?, ?, 'aberta')`)
    .run(saleId, locationId, adminId);

  atualizarCheckRoleParaIncluirGarcom(db);

  // Dados antigos preservados.
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  const gerente = db.prepare('SELECT * FROM users WHERE id = ?').get(gerenteId);
  const operador = db.prepare('SELECT * FROM users WHERE id = ?').get(operadorId);
  assert.equal(admin.role, 'admin');
  assert.equal(gerente.role, 'gerente');
  assert.equal(operador.role, 'operador');

  // Agora aceita 'garcom'.
  const garcomId = randomUUID();
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Garçom Teste', 'garcom', 'hash')`).run(garcomId);
  });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(garcomId).role, 'garcom');

  // FK continua íntegro (join resolve normalmente).
  const vendaComOperador = db.prepare(
    `SELECT s.id, u.nome FROM sales s JOIN users u ON u.id = s.operador_id WHERE s.id = ?`
  ).get(saleId);
  assert.ok(vendaComOperador);
  assert.equal(vendaComOperador.nome, admin.nome);

  // Rodar de novo é no-op (já migrado) e não derruba nada.
  assert.doesNotThrow(() => atualizarCheckRoleParaIncluirGarcom(db));
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM users').get().c, 4);
});
