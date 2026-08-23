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

// ---------- Lembrete automático "1h antes" pelo chatbot ----------

test('findPendingLembrete só pega agendamentos entre 55 e 65 minutos no futuro, agendados e sem lembrete já mandado', () => {
  const { locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const agora = '2026-08-15 09:00:00';

  const dentroDaJanela = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'A', clienteTelefoneAvulso: '111', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', operadorId: adminId,
  }).id; // +60min
  const cedoDemais = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'B', clienteTelefoneAvulso: '222', servico: 'Corte', dataHoraInicio: '2026-08-15 12:00:00', operadorId: adminId,
  }).id; // +180min
  const tardeDemais = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'C', clienteTelefoneAvulso: '333', servico: 'Corte', dataHoraInicio: '2026-08-15 09:10:00', operadorId: adminId,
  }).id; // +10min
  const jaMandado = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'D', clienteTelefoneAvulso: '444', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', operadorId: adminId,
  }).id;
  appointmentService.marcarLembreteEnviado(jaMandado);

  const pendentes = appointmentService.findPendingLembrete(agora).map((a) => a.id);
  assert.deepEqual(pendentes, [dentroDaJanela]);
  assert.equal(pendentes.includes(cedoDemais), false);
  assert.equal(pendentes.includes(tardeDemais), false);
  assert.equal(pendentes.includes(jaMandado), false);
});

test('marcarLembreteEnviado marca a data sem mudar o status do agendamento', () => {
  const { locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const { id } = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'A', clienteTelefoneAvulso: '111', servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', operadorId: adminId,
  });
  appointmentService.marcarLembreteEnviado(id);

  const [agendamento] = appointmentService.listAppointments({ locationId });
  assert.equal(agendamento.status, 'agendado', 'não deve mudar o status, só marcar quando o lembrete saiu');
  assert.notEqual(agendamento.lembrete_enviado_em, null);
});

test('findAguardandoConfirmacaoByTelefone acha agendamento avulso e o de cliente cadastrado, casando telefone normalizado', () => {
  const { db, locationId, adminId } = freshTestDb();
  const profId = criarProfissional();

  const avulso = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'Zeca', clienteTelefoneAvulso: '(11) 98888-7777',
    servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', operadorId: adminId,
  });
  appointmentService.marcarLembreteEnviado(avulso.id);

  // Telefone digitado com formatação -- mas createAppointment normaliza
  // pra só dígitos (ver comentário na função), então bate com o telefone
  // "cru" que chega do WhatsApp (só dígitos) na busca abaixo.
  const encontrado = appointmentService.findAguardandoConfirmacaoByTelefone('11988887777');
  assert.ok(encontrado);
  assert.equal(encontrado.id, avulso.id);
  assert.equal(encontrado.clienteNome, 'Zeca');

  // Cliente CADASTRADO (customer_id, sem avulso) -- mesma busca também
  // deve funcionar via COALESCE(customer.telefone, ...).
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Marina', '11977776666');
  const cadastrado = appointmentService.createAppointment({
    locationId, professionalId: profId, customerId: clienteId, servico: 'Escova', dataHoraInicio: '2026-08-15 11:00:00', operadorId: adminId,
  });
  appointmentService.marcarLembreteEnviado(cadastrado.id);
  const encontradoCadastrado = appointmentService.findAguardandoConfirmacaoByTelefone('11977776666');
  assert.ok(encontradoCadastrado);
  assert.equal(encontradoCadastrado.id, cadastrado.id);
  assert.equal(encontradoCadastrado.clienteNome, 'Marina');
});

test('findAguardandoConfirmacaoByTelefone não acha nada sem lembrete mandado, e nada pra outro telefone', () => {
  const { locationId, adminId } = freshTestDb();
  const profId = criarProfissional();
  const { id } = appointmentService.createAppointment({
    locationId, professionalId: profId, clienteNomeAvulso: 'A', clienteTelefoneAvulso: '5511900009999',
    servico: 'Corte', dataHoraInicio: '2026-08-15 10:00:00', operadorId: adminId,
  });

  assert.equal(appointmentService.findAguardandoConfirmacaoByTelefone('5511900009999'), null, 'lembrete ainda não foi mandado');

  appointmentService.marcarLembreteEnviado(id);
  assert.equal(appointmentService.findAguardandoConfirmacaoByTelefone('5511900001234'), null, 'telefone diferente não deveria achar nada');
  assert.equal(appointmentService.findAguardandoConfirmacaoByTelefone(''), null);
});
