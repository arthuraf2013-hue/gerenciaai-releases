const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function requireManagerOrAdmin(requestingUserId) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) {
    return { ok: false, error: 'Apenas um gerente ou administrador pode gerenciar usuários.' };
  }
  return { ok: true, requestingRole: user.role };
}

function listAll(requestingUserId) {
  const guard = requireManagerOrAdmin(requestingUserId);
  if (!guard.ok) return guard;
  const db = getDb();
  const users = db.prepare('SELECT id, nome, role, ativo, criado_em FROM users ORDER BY nome').all();
  return { ok: true, users };
}

function create(requestingUserId, { nome, role, pin }) {
  const guard = requireManagerOrAdmin(requestingUserId);
  if (!guard.ok) return guard;

  if (!nome || !nome.trim()) return { ok: false, error: 'Informe o nome.' };
  if (!['operador', 'gerente', 'admin', 'garcom', 'suporte'].includes(role)) return { ok: false, error: 'Papel inválido.' };
  if (guard.requestingRole === 'gerente' && (role === 'admin' || role === 'suporte')) {
    return { ok: false, error: 'Um gerente não pode criar um administrador ou usuário de suporte — peça pra um administrador fazer isso.' };
  }
  if (!pin || String(pin).length < 4) return { ok: false, error: 'PIN precisa ter ao menos 4 dígitos.' };

  const db = getDb();
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, ?, ?)')
    .run(id, nome.trim(), role, bcrypt.hashSync(String(pin), 10));
  return { ok: true, id };
}

function setActive(requestingUserId, { userId, ativo }) {
  const guard = requireManagerOrAdmin(requestingUserId);
  if (!guard.ok) return guard;
  if (userId === requestingUserId && !ativo) return { ok: false, error: 'Você não pode desativar seu próprio usuário.' };

  const db = getDb();
  if (guard.requestingRole === 'gerente') {
    const alvo = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (alvo?.role === 'admin' || alvo?.role === 'suporte') return { ok: false, error: 'Um gerente não pode alterar um administrador ou usuário de suporte.' };
  }
  db.prepare('UPDATE users SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, userId);
  return { ok: true };
}

function resetPin(requestingUserId, { userId, novoPin }) {
  const guard = requireManagerOrAdmin(requestingUserId);
  if (!guard.ok) return guard;
  if (!novoPin || String(novoPin).length < 4) return { ok: false, error: 'PIN precisa ter ao menos 4 dígitos.' };

  const db = getDb();
  if (guard.requestingRole === 'gerente') {
    const alvo = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (alvo?.role === 'admin' || alvo?.role === 'suporte') return { ok: false, error: 'Um gerente não pode alterar um administrador ou usuário de suporte.' };
  }
  // pin_temporario = 1 força a pessoa a trocar de novo no próximo login —
  // mesmo tratamento de segurança de um PIN novo, já que o admin sabe
  // esse valor temporariamente.
  db.prepare('UPDATE users SET pin_hash = ?, pin_temporario = 1, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?')
    .run(bcrypt.hashSync(String(novoPin), 10), userId);
  return { ok: true };
}

module.exports = { listAll, create, setActive, resetPin };
