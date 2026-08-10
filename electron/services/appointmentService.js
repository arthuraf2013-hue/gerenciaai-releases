const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

// ---------- Profissionais ----------
function listProfessionals() {
  const db = getDb();
  return db.prepare('SELECT * FROM appointment_professionals WHERE ativo = 1 ORDER BY nome').all();
}
function upsertProfessional(prof) {
  if (!prof.nome?.trim()) return { ok: false, error: 'Informe o nome do profissional.' };
  const db = getDb();
  const id = prof.id || randomUUID();
  db.prepare(
    `INSERT INTO appointment_professionals (id, nome, especialidade) VALUES (@id, @nome, @especialidade)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, especialidade=excluded.especialidade`
  ).run({ id, nome: prof.nome.trim(), especialidade: prof.especialidade || null });
  return { ok: true, id };
}
function deactivateProfessional(id) {
  getDb().prepare('UPDATE appointment_professionals SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- Conflito de horário ----------

/**
 * Verifica se um horário proposto conflita com algum agendamento já
 * existente do MESMO profissional. Dois intervalos [inícioA, fimA) e
 * [inícioB, fimB) se sobrepõem quando inícioA < fimB E inícioB < fimA
 * — é a checagem clássica de sobreposição de intervalos, não dá pra
 * simplificar sem introduzir brecha (comparar só o horário de início,
 * por exemplo, deixaria passar um agendamento que começa DENTRO de
 * outro já em andamento). Cancelado não conta como ocupando horário.
 */
function checkConflito({ professionalId, dataHoraInicio, duracaoMinutos, excluirAppointmentId }) {
  const db = getDb();
  let sql = `
    SELECT * FROM appointments
    WHERE professional_id = ? AND status != 'cancelado'
      AND data_hora_inicio < datetime(?, '+' || ? || ' minutes')
      AND datetime(data_hora_inicio, '+' || duracao_minutos || ' minutes') > ?`;
  const params = [professionalId, dataHoraInicio, duracaoMinutos, dataHoraInicio];
  if (excluirAppointmentId) {
    sql += ' AND id != ?';
    params.push(excluirAppointmentId);
  }
  return db.prepare(sql).all(...params);
}

// ---------- Agendamentos ----------

function createAppointment({ locationId, professionalId, customerId, clienteNomeAvulso, clienteTelefoneAvulso, servico, dataHoraInicio, duracaoMinutos, observacoes, operadorId }) {
  if (!locationId) return { ok: false, error: 'Local é obrigatório.' };
  if (!professionalId) return { ok: false, error: 'Escolha o profissional.' };
  if (!servico?.trim()) return { ok: false, error: 'Informe o serviço.' };
  if (!dataHoraInicio) return { ok: false, error: 'Informe a data e hora.' };
  if (!customerId && !clienteNomeAvulso?.trim()) return { ok: false, error: 'Informe o cliente (cadastrado ou nome avulso).' };

  const duracao = duracaoMinutos || 60;
  const conflitos = checkConflito({ professionalId, dataHoraInicio, duracaoMinutos: duracao });
  if (conflitos.length > 0) {
    return { ok: false, error: 'Esse profissional já tem um horário marcado nesse intervalo.', conflitos };
  }

  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO appointments (id, location_id, professional_id, customer_id, cliente_nome_avulso, cliente_telefone_avulso, servico, data_hora_inicio, duracao_minutos, observacoes, operador_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, locationId, professionalId, customerId || null, clienteNomeAvulso || null, clienteTelefoneAvulso || null, servico.trim(), dataHoraInicio, duracao, observacoes || null, operadorId || null);
  return { ok: true, id };
}

/** Reagendar — muda dia/hora (e opcionalmente duração), checando
 * conflito de novo, mas ignorando ESTE MESMO agendamento na checagem
 * (senão ele sempre "conflitaria" consigo mesmo). */
function rescheduleAppointment({ appointmentId, dataHoraInicio, duracaoMinutos }) {
  const db = getDb();
  const atual = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!atual) return { ok: false, error: 'Agendamento não encontrado.' };

  const novaDuracao = duracaoMinutos || atual.duracao_minutos;
  const conflitos = checkConflito({
    professionalId: atual.professional_id, dataHoraInicio, duracaoMinutos: novaDuracao, excluirAppointmentId: appointmentId,
  });
  if (conflitos.length > 0) {
    return { ok: false, error: 'Esse profissional já tem um horário marcado nesse intervalo.', conflitos };
  }

  db.prepare('UPDATE appointments SET data_hora_inicio = ?, duracao_minutos = ? WHERE id = ?').run(dataHoraInicio, novaDuracao, appointmentId);
  return { ok: true };
}

function updateAppointmentStatus({ appointmentId, status }) {
  const STATUS_VALIDOS = ['agendado', 'confirmado', 'concluido', 'cancelado', 'faltou'];
  if (!STATUS_VALIDOS.includes(status)) return { ok: false, error: 'Status inválido.' };
  const db = getDb();
  const atual = db.prepare('SELECT id FROM appointments WHERE id = ?').get(appointmentId);
  if (!atual) return { ok: false, error: 'Agendamento não encontrado.' };
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appointmentId);
  return { ok: true };
}

/** Agenda de um dia — junta com cliente e profissional pra já vir
 * pronto pra tela, ordenado por horário. */
function listAppointments({ locationId, data, professionalId } = {}) {
  const db = getDb();
  let sql = `
    SELECT a.*, p.nome as profissionalNome,
      COALESCE(c.nome, a.cliente_nome_avulso) as clienteNome,
      COALESCE(c.telefone, a.cliente_telefone_avulso) as clienteTelefone
    FROM appointments a
    JOIN appointment_professionals p ON p.id = a.professional_id
    LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.location_id = ?`;
  const params = [locationId];
  if (data) {
    sql += ` AND date(a.data_hora_inicio) = date(?)`;
    params.push(data);
  }
  if (professionalId) {
    sql += ' AND a.professional_id = ?';
    params.push(professionalId);
  }
  sql += ' ORDER BY a.data_hora_inicio';
  return db.prepare(sql).all(...params);
}

/** Link de WhatsApp confirmando o horário marcado — mesmo padrão
 * wa.me já usado em recibo, cliente que sumiu, lembrete de pet, e
 * status de entrega. */
function montarLinkConfirmacao(appointmentId) {
  const db = getDb();
  const ag = db.prepare(
    `SELECT a.*, p.nome as profissionalNome, COALESCE(c.nome, a.cliente_nome_avulso) as clienteNome, COALESCE(c.telefone, a.cliente_telefone_avulso) as clienteTelefone
     FROM appointments a JOIN appointment_professionals p ON p.id = a.professional_id LEFT JOIN customers c ON c.id = a.customer_id
     WHERE a.id = ?`
  ).get(appointmentId);
  if (!ag) return { ok: false, error: 'Agendamento não encontrado.' };
  if (!ag.clienteTelefone) return { ok: false, error: 'Esse agendamento não tem telefone pra contato.' };

  // data_hora_inicio é gravado como hora LOCAL (Brasília) direto — é
  // hora de parede do agendamento ("10h da manhã"), não um timestamp
  // de evento de servidor. Diferente de criado_em/finalizada_em em
  // outras tabelas (que são UTC via NOW_SYNCED() e passam pela
  // correção de -3h nas consultas), aqui NÃO precisa de nenhuma
  // conversão — tratar como UTC e reconverter deslocaria a hora
  // errado.
  const [dataParte, horaParte] = ag.data_hora_inicio.split(/[ T]/);
  const [ano, mes, dia] = dataParte.split('-');
  const dataFormatada = `${dia}/${mes}/${ano}`;
  const horaFormatada = horaParte.slice(0, 5);
  const primeiroNome = (ag.clienteNome || '').trim().split(' ')[0] || 'tudo bem';

  const mensagem = `Oi, ${primeiroNome}! Confirmando seu horário de ${ag.servico} com ${ag.profissionalNome} no dia ${dataFormatada} às ${horaFormatada}. Te esperamos! 💇`;

  const digitos = ag.clienteTelefone.replace(/\D/g, '');
  const numeroLimpo = digitos.startsWith('55') ? digitos : '55' + digitos;
  const url = `https://wa.me/${numeroLimpo}?text=${encodeURIComponent(mensagem)}`;
  return { ok: true, url, mensagem };
}

module.exports = {
  listProfessionals, upsertProfessional, deactivateProfessional,
  checkConflito, createAppointment, rescheduleAppointment, updateAppointmentStatus, listAppointments, montarLinkConfirmacao,
};
