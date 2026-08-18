const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const STATUS_VALIDOS = ['pendente', 'aguardando_confirmacao', 'confirmada', 'cancelada', 'nao_confirmada', 'concluida'];

function normalizarTelefone(telefone) {
  return (telefone || '').replace(/\D/g, '');
}

/**
 * Cria uma reserva "solta" — sem mesa vinculada ainda (mesa_id fica
 * NULL até a equipe vincular, ver linkMesa). É o fluxo usado tanto
 * pelo chatbot do WhatsApp (origem 'whatsapp') quanto por um cadastro
 * manual na tela de Reservas (origem 'manual').
 */
function create({ locationId, clienteNome, clienteTelefone, pessoas, dataHora, origem, operadorId, observacoes }) {
  if (!locationId) return { ok: false, error: 'Local é obrigatório.' };
  if (!clienteNome?.trim()) return { ok: false, error: 'Informe o nome do cliente.' };
  const telefone = normalizarTelefone(clienteTelefone);
  if (!telefone) return { ok: false, error: 'Informe o telefone do cliente.' };
  const numPessoas = Number(pessoas);
  if (!(numPessoas > 0) || !Number.isInteger(numPessoas)) return { ok: false, error: 'Informe um número de pessoas válido.' };
  if (!dataHora) return { ok: false, error: 'Informe a data e hora da reserva.' };

  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reservations (id, location_id, cliente_nome, cliente_telefone, pessoas, data_hora, origem, operador_id, observacoes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, locationId, clienteNome.trim(), telefone, numPessoas, dataHora, origem === 'manual' ? 'manual' : 'whatsapp', operadorId || null, observacoes?.trim() || null);

  return { ok: true, id };
}

/** Lista de reservas pra tela de Reservas — junta o nome da mesa
 * vinculada (se tiver), ordenado pelo horário. Sem filtro de data por
 * padrão (mostra tudo) — a tela decide o que filtrar visualmente. */
function list({ locationId, status } = {}) {
  const db = getDb();
  let sql = `
    SELECT r.*, t.numero as mesaNumero, t.nome as mesaNome
    FROM reservations r
    LEFT JOIN restaurant_tables t ON t.id = r.mesa_id
    WHERE r.location_id = ?`;
  const params = [locationId];
  if (status) {
    sql += ' AND r.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY r.data_hora';
  return db.prepare(sql).all(...params);
}

/** Reservas ativas (pendente/aguardando confirmação/confirmada) já
 * vinculadas a uma mesa — é só isso que a tela de Mesas precisa pra
 * desenhar o indicador visual em cada mesa reservada. */
function listVinculadasAtivas(locationId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM reservations
     WHERE location_id = ? AND mesa_id IS NOT NULL
       AND status IN ('pendente', 'aguardando_confirmacao', 'confirmada')`
  ).all(locationId);
}

function linkMesa({ reservationId, mesaId }) {
  const db = getDb();
  const reserva = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
  if (!reserva) return { ok: false, error: 'Reserva não encontrada.' };
  if (['cancelada', 'nao_confirmada', 'concluida'].includes(reserva.status)) {
    return { ok: false, error: 'Essa reserva não está mais ativa.' };
  }
  const mesa = db.prepare('SELECT id FROM restaurant_tables WHERE id = ?').get(mesaId);
  if (!mesa) return { ok: false, error: 'Mesa não encontrada.' };
  db.prepare('UPDATE reservations SET mesa_id = ? WHERE id = ?').run(mesaId, reservationId);
  return { ok: true };
}

function unlinkMesa(reservationId) {
  const db = getDb();
  db.prepare('UPDATE reservations SET mesa_id = NULL WHERE id = ?').run(reservationId);
  return { ok: true };
}

function updateStatus({ reservationId, status }) {
  if (!STATUS_VALIDOS.includes(status)) return { ok: false, error: 'Status inválido.' };
  const db = getDb();
  const reserva = db.prepare('SELECT id FROM reservations WHERE id = ?').get(reservationId);
  if (!reserva) return { ok: false, error: 'Reserva não encontrada.' };
  const camposExtras = status === 'confirmada' ? ", confirmado_em = NOW_SYNCED()" : '';
  db.prepare(`UPDATE reservations SET status = ?${camposExtras} WHERE id = ?`).run(status, reservationId);
  return { ok: true };
}

function cancel(reservationId) {
  return updateStatus({ reservationId, status: 'cancelada' });
}

/**
 * Reservas que precisam do lembrete de "1h antes" mandado agora —
 * janela de 55 a 65 minutos antes do horário marcado (não é um cron
 * exato, é uma checagem periódica em main.js, então a janela cobre a
 * folga entre uma rodada e outra), ainda 'pendente' e sem lembrete já
 * mandado antes. `agoraLocalStr` é o "agora" em hora LOCAL (Brasília),
 * no mesmo formato 'YYYY-MM-DD HH:MM:SS' de `data_hora` -- passado de
 * fora (não usa datetime('now') do SQLite, que é UTC) pra bater com o
 * fuso em que `data_hora` foi digitado.
 */
function findPendingLembrete(agoraLocalStr) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM reservations
     WHERE status = 'pendente' AND lembrete_enviado_em IS NULL
       AND data_hora BETWEEN datetime(?, '+55 minutes') AND datetime(?, '+65 minutes')`
  ).all(agoraLocalStr, agoraLocalStr);
}

/** Marca o lembrete como enviado e move a reserva pra "aguardando
 * confirmação" — a partir daqui, a próxima resposta desse telefone é
 * interpretada como confirmação/recusa (ver whatsappBotHandler). */
function marcarLembreteEnviado(reservationId) {
  const db = getDb();
  db.prepare(
    `UPDATE reservations SET status = 'aguardando_confirmacao', lembrete_enviado_em = NOW_SYNCED() WHERE id = ?`
  ).run(reservationId);
  return { ok: true };
}

/** Reservas que ficaram esperando confirmação por tempo demais e o
 * cliente nunca respondeu — limpeza pra não acumular indicador
 * "aguardando" pra sempre na tela de Mesas/Reservas. `agoraLocalStr`
 * no mesmo formato de data_hora (hora local). */
function marcarNaoConfirmadasVencidas(agoraLocalStr) {
  const db = getDb();
  const result = db.prepare(
    `UPDATE reservations SET status = 'nao_confirmada'
     WHERE status = 'aguardando_confirmacao' AND datetime(?, '-2 hours') > data_hora`
  ).run(agoraLocalStr);
  return { ok: true, quantidade: result.changes };
}

/** Reserva "aguardando confirmação" mais próxima pra um telefone — é
 * assim que o chatbot decide se a próxima mensagem desse número é uma
 * resposta ao lembrete (sim/não) em vez de um pedido novo. */
function findAguardandoConfirmacaoByTelefone(telefone) {
  const db = getDb();
  const numero = normalizarTelefone(telefone);
  if (!numero) return null;
  return db.prepare(
    `SELECT * FROM reservations WHERE cliente_telefone = ? AND status = 'aguardando_confirmacao' ORDER BY data_hora LIMIT 1`
  ).get(numero) || null;
}

function confirmar(reservationId) {
  return updateStatus({ reservationId, status: 'confirmada' });
}

function recusar(reservationId) {
  return updateStatus({ reservationId, status: 'cancelada' });
}

module.exports = {
  create, list, listVinculadasAtivas, linkMesa, unlinkMesa, updateStatus, cancel,
  findPendingLembrete, marcarLembreteEnviado, marcarNaoConfirmadasVencidas,
  findAguardandoConfirmacaoByTelefone, confirmar, recusar, normalizarTelefone,
};
