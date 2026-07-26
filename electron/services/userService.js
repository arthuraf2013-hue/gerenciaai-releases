const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function requireAdmin(requestingUserId) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || user.role !== 'admin') {
    return { ok: false, error: 'Apenas um administrador pode gerenciar usuários.' };
  }
  return { ok: true };
}

function listAll(requestingUserId) {
  const guard = requireAdmin(requestingUserId);
  if (!guard.ok) return guard;
  const db = getDb();
  const users = db.prepare('SELECT id, nome, role, ativo, criado_em FROM users ORDER BY nome').all();
  return { ok: true, users };
}

function create(requestingUserId, { nome, role, pin }) {
  const guard = requireAdmin(requestingUserId);
  if (!guard.ok) return guard;

  if (!nome || !nome.trim()) return { ok: false, error: 'Informe o nome.' };
  if (!['operador', 'gerente', 'admin'].includes(role)) return { ok: false, error: 'Papel inválido.' };
  if (!pin || String(pin).length < 4) return { ok: false, error: 'PIN precisa ter ao menos 4 dígitos.' };

  const db = getDb();
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, ?, ?)')
    .run(id, nome.trim(), role, bcrypt.hashSync(String(pin), 10));
  return { ok: true, id };
}

function setActive(requestingUserId, { userId, ativo }) {
  const guard = requireAdmin(requestingUserId);
  if (!guard.ok) return guard;
  if (userId === requestingUserId && !ativo) return { ok: false, error: 'Você não pode desativar seu próprio usuário.' };

  const db = getDb();
  db.prepare('UPDATE users SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, userId);
  return { ok: true };
}

function resetPin(requestingUserId, { userId, novoPin }) {
  const guard = requireAdmin(requestingUserId);
  if (!guard.ok) return guard;
  if (!novoPin || String(novoPin).length < 4) return { ok: false, error: 'PIN precisa ter ao menos 4 dígitos.' };

  const db = getDb();
  // pin_temporario = 1 força a pessoa a trocar de novo no próximo login —
  // mesmo tratamento de segurança de um PIN novo, já que o admin sabe
  // esse valor temporariamente.
  db.prepare('UPDATE users SET pin_hash = ?, pin_temporario = 1, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?')
    .run(bcrypt.hashSync(String(novoPin), 10), userId);
  return { ok: true };
}

module.exports = { listAll, create, setActive, resetPin };
