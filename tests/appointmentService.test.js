const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const appointmentService = require('../electron/services/appointmentService');

function criarProfissional(nome = 'Ana') {
  return appointmentService.upsertProfessional({ nome }).id;
}

test('agenda um horário livre com sucesso', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const r = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'Cliente A',
    servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId,
  });
  assert.equal(r.ok, true);
});

test('recusa agendar em cima de um horário já ocupado (sobreposição parcial)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'A', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });

  const r = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'B', servico: 'Escova', dataHoraInicio: '2026-08-15 10:30:00', duracaoMinutos: 60, operadorId: adminId });
  assert.equal(r.ok, false);
  assert.ok(r.conflitos.length > 0);
});

test('permite agendar exatamente no minuto em que o outro termina (sem sobrepor)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'A', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });

  const r = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'B', servico: 'Escova', dataHoraInicio: '2026-08-15 11:00:00', duracaoMinutos: 60, operadorId: adminId });
  assert.equal(r.ok, true, 'começar exatamente quando o outro termina não é conflito');
});

test('sobreposição envolvendo dois agendamentos vizinhos ao mesmo tempo é recusada', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'A', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'B', servico: 'Manicure', dataHoraInicio: '2026-08-15 09:00:00', duracaoMinutos: 45, operadorId: adminId });

  const r = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'C', servico: 'Coloração', dataHoraInicio: '2026-08-15 09:30:00', duracaoMinutos: 60, operadorId: adminId });
  assert.equal(r.ok, false);
});

test('mesmo horário em profissionais DIFERENTES não conflita', () => {
  const { db, locationId, adminId } = freshTestDb();
  const prof1 = criarProfissional('Ana');
  const prof2 = criarProfissional('Bia');
  appointmentService.createAppointment({ locationId, professionalId: prof1, clienteNomeAvulso: 'A', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });

  const r = appointmentService.createAppointment({ locationId, professionalId: prof2, clienteNomeAvulso: 'B', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });
  assert.equal(r.ok, true, 'profissionais diferentes podem atender no mesmo horário');
});

test('cancelar um agendamento libera o horário pra outro', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const r1 = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'A', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });

  appointmentService.updateAppointmentStatus({ appointmentId: r1.id, status: 'cancelado' });

  const r2 = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'B', servico: 'Escova', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });
  assert.equal(r2.ok, true, 'cancelado não deveria mais ocupar o horário');
});

test('reagendar respeita conflito, mas ignora o próprio agendamento na checagem', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const r1 = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'A', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'B', servico: 'Escova', dataHoraInicio: '2026-08-15 14:00:00', duracaoMinutos: 60, operadorId: adminId });

  // reagendar pra dentro do horário do B -- deveria recusar
  const falhou = appointmentService.rescheduleAppointment({ appointmentId: r1.id, dataHoraInicio: '2026-08-15 14:30:00', duracaoMinutos: 60 });
  assert.equal(falhou.ok, false);

  // reagendar pro MESMO horário que já está (não deveria "conflitar consigo mesmo")
  const mesmoHorario = appointmentService.rescheduleAppointment({ appointmentId: r1.id, dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60 });
  assert.equal(mesmoHorario.ok, true);
});

test('recusa criar agendamento sem cliente (nem cadastrado, nem avulso)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const r = appointmentService.createAppointment({ locationId, professionalId: profId, servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', operadorId: adminId });
  assert.equal(r.ok, false);
});

test('listAppointments filtra por dia e traz nome do profissional e do cliente juntos', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional('Ana');
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'Cliente Avulso', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', duracaoMinutos: 60, operadorId: adminId });
  appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'Outro Dia', servico: 'Corte', dataHoraInicio: '2026-08-16 10:00:00', duracaoMinutos: 60, operadorId: adminId });

  const doDia15 = appointmentService.listAppointments({ locationId, data: '2026-08-15' });
  assert.equal(doDia15.length, 1);
  assert.equal(doDia15[0].profissionalNome, 'Ana');
  assert.equal(doDia15[0].clienteNome, 'Cliente Avulso');
});

test('montarLinkConfirmacao usa a hora exata que foi digitada, sem deslocar fuso', () => {
  const { db, locationId, adminId } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Maria Cliente', '81988887777');
  const profId = criarProfissional('Ana');
  const r = appointmentService.createAppointment({ locationId, professionalId: profId, customerId: clienteId, servico: 'Corte', dataHoraInicio: '2026-08-15 08:00:00', duracaoMinutos: 60, operadorId: adminId });

  const link = appointmentService.montarLinkConfirmacao(r.id);
  assert.equal(link.ok, true);
  assert.match(link.mensagem, /08:00/);
  assert.match(link.mensagem, /15\/08\/2026/);
  assert.match(link.mensagem, /Maria/);
  assert.match(link.mensagem, /Ana/);
});

test('montarLinkConfirmacao recusa sem telefone de contato', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const r = appointmentService.createAppointment({ locationId, professionalId: profId, clienteNomeAvulso: 'Sem Telefone', servico: 'Corte', dataHoraInicio: '2026-08-15 08:00:00', operadorId: adminId });

  const link = appointmentService.montarLinkConfirmacao(r.id);
  assert.equal(link.ok, false);
});
