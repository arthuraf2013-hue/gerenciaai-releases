const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const MAX_TENTATIVAS = 5;
const BLOQUEIO_MINUTOS = 10;

function estaBloqueado(user) {
  if (!user.bloqueado_ate) return false;
  return new Date(user.bloqueado_ate + 'Z').getTime() > Date.now();
}

function minutosRestantes(user) {
  const ms = new Date(user.bloqueado_ate + 'Z').getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60000));
}

/** PIN errado: soma uma tentativa e bloqueia temporariamente se estourar o limite. */
function registrarTentativaFalha(db, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const tentativas = (user.tentativas_falhas || 0) + 1;

  if (tentativas >= MAX_TENTATIVAS) {
    const bloqueadoAte = new Date(Date.now() + BLOQUEIO_MINUTOS * 60000).toISOString().slice(0, 19);
    db.prepare('UPDATE users SET tentativas_falhas = 0, bloqueado_ate = ? WHERE id = ?').run(bloqueadoAte, userId);
    return `Muitas tentativas de PIN incorreto. Bloqueado por ${BLOQUEIO_MINUTOS} minutos.`;
  }

  db.prepare('UPDATE users SET tentativas_falhas = ? WHERE id = ?').run(tentativas, userId);
  return `PIN incorreto. Mais ${MAX_TENTATIVAS - tentativas} tentativa(s) antes do bloqueio temporário.`;
}

function limparTentativas(db, userId) {
  db.prepare('UPDATE users SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?').run(userId);
}

/**
 * Login de operador/gerente no início do turno.
 * Retorna dados públicos do usuário (nunca o hash do PIN).
 */
function login(userId, pin) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(userId);
  if (!user) return { ok: false, error: 'Usuário não encontrado ou inativo.' };

  if (estaBloqueado(user)) {
    return { ok: false, error: `Usuário temporariamente bloqueado. Tente novamente em ${minutosRestantes(user)} min.` };
  }

  const valid = bcrypt.compareSync(String(pin), user.pin_hash);
  if (!valid) {
    return { ok: false, error: registrarTentativaFalha(db, userId) };
  }

  limparTentativas(db, userId);
  return {
    ok: true,
    user: { id: user.id, nome: user.nome, role: user.role, pinTemporario: !!user.pin_temporario },
  };
}

/**
 * Troca o próprio PIN — exige o PIN atual para confirmar identidade.
 * Usado tanto no fluxo normal quanto para zerar pin_temporario no
 * primeiro acesso (PIN padrão "0000").
 */
function changeOwnPin(userId, pinAtual, novoPin) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(userId);
  if (!user) return { ok: false, error: 'Usuário não encontrado.' };

  if (estaBloqueado(user)) {
    return { ok: false, error: `Usuário temporariamente bloqueado. Tente novamente em ${minutosRestantes(user)} min.` };
  }

  const valid = bcrypt.compareSync(String(pinAtual), user.pin_hash);
  if (!valid) return { ok: false, error: registrarTentativaFalha(db, userId) };

  if (!novoPin || String(novoPin).length < 4) return { ok: false, error: 'O novo PIN precisa ter ao menos 4 dígitos.' };
  if (String(novoPin) === String(pinAtual)) return { ok: false, error: 'O novo PIN precisa ser diferente do atual.' };

  limparTentativas(db, userId);
  db.prepare('UPDATE users SET pin_hash = ?, pin_temporario = 0 WHERE id = ?')
    .run(bcrypt.hashSync(String(novoPin), 10), userId);
  return { ok: true };
}

function listActiveUsers({ excludeUserId } = {}) {
  const db = getDb();
  let rows = db.prepare('SELECT id, nome, role FROM users WHERE ativo = 1').all();
  if (excludeUserId) rows = rows.filter((u) => u.id !== excludeUserId);
  return rows;
}

/**
 * Regra de segurança central do sistema:
 * Um cancelamento/alteração sensível só é autorizado se:
 *   1) o usuário informado existir, estiver ativo, e tiver o PIN correto;
 *   2) o papel dele for 'gerente' ou 'admin';
 *   3) ele NÃO for a mesma pessoa que o operador logado no caixa —
 *      mesmo que o operador também tenha, por algum motivo, papel de gerente.
 *
 * Toda tentativa (aprovada ou negada) é gravada em audit_log, então
 * mesmo uma tentativa de burlar isso fica registrada com quem tentou.
 */
function authorizeManagerOverride({ candidateUserId, pin, currentOperatorId, tipoEvento, saleId, saleItemId, motivo }) {
  const db = getDb();
  const record = (sucesso, autorizadoPorId) => {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, sale_item_id, solicitante_id, autorizado_por_id, motivo, sucesso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), tipoEvento, saleId || null, saleItemId || null, currentOperatorId, autorizadoPorId || null, motivo || null, sucesso ? 1 : 0);
  };

  if (!candidateUserId || candidateUserId === currentOperatorId) {
    record(false, null);
    return { ok: false, error: 'A autorização precisa ser feita por outra pessoa, não pelo operador do caixa.' };
  }

  const candidate = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(candidateUserId);
  if (!candidate) {
    record(false, null);
    return { ok: false, error: 'Usuário autorizador não encontrado ou inativo.' };
  }

  if (!['gerente', 'admin'].includes(candidate.role)) {
    record(false, null);
    return { ok: false, error: 'Este usuário não tem permissão para autorizar cancelamentos.' };
  }

  if (estaBloqueado(candidate)) {
    record(false, null);
    return { ok: false, error: `Este usuário está temporariamente bloqueado. Tente novamente em ${minutosRestantes(candidate)} min.` };
  }

  const validPin = bcrypt.compareSync(String(pin), candidate.pin_hash);
  if (!validPin) {
    record(false, null);
    return { ok: false, error: registrarTentativaFalha(db, candidate.id) };
  }

  limparTentativas(db, candidate.id);
  record(true, candidate.id);
  return { ok: true, autorizadoPor: { id: candidate.id, nome: candidate.nome, role: candidate.role } };
}

/**
 * Trilha de auditoria — toda tentativa de cancelamento/devolução/desconto,
 * aprovada ou negada. Só admin acessa a tela que usa isso.
 */
function listAuditLog({ dataInicio, dataFim }) {
  const db = getDb();
  return db.prepare(
    `SELECT a.*, u1.nome as solicitante_nome, u2.nome as autorizado_por_nome
     FROM audit_log a
     LEFT JOIN users u1 ON u1.id = a.solicitante_id
     LEFT JOIN users u2 ON u2.id = a.autorizado_por_id
     WHERE date(a.criado_em, '-3 hours') BETWEEN date(?) AND date(?)
       -- A Auditoria é pra mostrar o que precisou de aprovação — um
       -- cancelamento antes do pagamento (ajuste normal de carrinho) ou
       -- com a exigência de senha desligada nas configurações nunca tem
       -- autorizador nem motivo, só teria poluído a lista sem servir
       -- pra fiscalização nenhuma. Continua tudo gravado em audit_log,
       -- só não aparece nessa tela.
       AND a.tipo_evento NOT IN (
         'cancelamento_item_pre_pagamento',
         'cancelamento_item_sem_autorizacao_configurada',
         'cancelamento_venda_sem_autorizacao_configurada',
         'desconto_manual_sem_autorizacao_configurada'
       )
     ORDER BY a.criado_em DESC
     LIMIT 500`
  ).all(dataInicio, dataFim);
}

function getSecurityConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM security_config WHERE id = ?').get('default');
}

function updateSecurityConfig({ exigirAutorizacaoCancelamento, exigirAutorizacaoDesconto }) {
  const db = getDb();
  const atual = getSecurityConfig();
  db.prepare('UPDATE security_config SET exigir_autorizacao_cancelamento = ?, exigir_autorizacao_desconto = ? WHERE id = ?')
    .run(
      exigirAutorizacaoCancelamento !== undefined ? (exigirAutorizacaoCancelamento ? 1 : 0) : atual.exigir_autorizacao_cancelamento,
      exigirAutorizacaoDesconto !== undefined ? (exigirAutorizacaoDesconto ? 1 : 0) : atual.exigir_autorizacao_desconto,
      'default'
    );
  return { ok: true };
}

module.exports = { login, listActiveUsers, authorizeManagerOverride, changeOwnPin, listAuditLog, getSecurityConfig, updateSecurityConfig };
