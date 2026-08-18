const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const reservationService = require('../electron/services/reservationService');

function criarMesa(db, locationId, numero = '1') {
  const { randomUUID } = require('crypto');
  const id = randomUUID();
  db.prepare(`INSERT INTO restaurant_tables (id, location_id, numero, status) VALUES (?, ?, ?, 'livre')`).run(id, locationId, numero);
  return id;
}

test('create recusa dados essenciais faltando', () => {
  const ctx = freshTestDb();
  assert.equal(reservationService.create({ locationId: ctx.locationId, clienteNome: '', clienteTelefone: '11999998888', pessoas: 2, dataHora: '2026-01-01 20:00:00' }).ok, false);
  assert.equal(reservationService.create({ locationId: ctx.locationId, clienteNome: 'Ana', clienteTelefone: '', pessoas: 2, dataHora: '2026-01-01 20:00:00' }).ok, false);
  assert.equal(reservationService.create({ locationId: ctx.locationId, clienteNome: 'Ana', clienteTelefone: '11999998888', pessoas: 0, dataHora: '2026-01-01 20:00:00' }).ok, false);
  assert.equal(reservationService.create({ locationId: ctx.locationId, clienteNome: 'Ana', clienteTelefone: '11999998888', pessoas: 2, dataHora: '' }).ok, false);
});

test('create normaliza o telefone (só dígitos) e cria como pendente, sem mesa', () => {
  const ctx = freshTestDb();
  const result = reservationService.create({
    locationId: ctx.locationId, clienteNome: 'Ana Souza', clienteTelefone: '(11) 99999-8888',
    pessoas: 4, dataHora: '2026-01-01 20:00:00', origem: 'whatsapp',
  });
  assert.equal(result.ok, true);

  const [reserva] = reservationService.list({ locationId: ctx.locationId });
  assert.equal(reserva.cliente_telefone, '11999998888');
  assert.equal(reserva.status, 'pendente');
  assert.equal(reserva.mesa_id, null);
  assert.equal(reserva.pessoas, 4);
});

test('linkMesa vincula uma mesa existente e unlinkMesa desvincula', () => {
  const ctx = freshTestDb();
  const mesaId = criarMesa(ctx.db, ctx.locationId);
  const { id } = reservationService.create({
    locationId: ctx.locationId, clienteNome: 'Ana', clienteTelefone: '11999998888', pessoas: 2, dataHora: '2026-01-01 20:00:00',
  });

  const link = reservationService.linkMesa({ reservationId: id, mesaId });
  assert.equal(link.ok, true);
  assert.equal(reservationService.list({ locationId: ctx.locationId })[0].mesa_id, mesaId);

  reservationService.unlinkMesa(id);
  assert.equal(reservationService.list({ locationId: ctx.locationId })[0].mesa_id, null);
});

test('linkMesa recusa quando a reserva já está cancelada', () => {
  const ctx = freshTestDb();
  const mesaId = criarMesa(ctx.db, ctx.locationId);
  const { id } = reservationService.create({
    locationId: ctx.locationId, clienteNome: 'Ana', clienteTelefone: '11999998888', pessoas: 2, dataHora: '2026-01-01 20:00:00',
  });
  reservationService.cancel(id);
  const link = reservationService.linkMesa({ reservationId: id, mesaId });
  assert.equal(link.ok, false);
});

test('listVinculadasAtivas só devolve reservas com mesa vinculada e status ativo', () => {
  const ctx = freshTestDb();
  const mesa1 = criarMesa(ctx.db, ctx.locationId, '1');
  const mesa2 = criarMesa(ctx.db, ctx.locationId, '2');

  const { id: r1 } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'A', clienteTelefone: '111', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  const { id: r2 } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'B', clienteTelefone: '222', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  const { id: r3 } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'C', clienteTelefone: '333', pessoas: 2, dataHora: '2026-01-01 20:00:00' });

  reservationService.linkMesa({ reservationId: r1, mesaId: mesa1 }); // ativa, com mesa
  reservationService.linkMesa({ reservationId: r2, mesaId: mesa2 });
  reservationService.cancel(r2); // cancelada, com mesa -- não deve aparecer
  // r3 fica sem mesa -- não deve aparecer

  const ativas = reservationService.listVinculadasAtivas(ctx.locationId);
  assert.equal(ativas.length, 1);
  assert.equal(ativas[0].id, r1);
});

test('findPendingLembrete só pega reservas entre 55 e 65 minutos no futuro, pendentes e sem lembrete já mandado', () => {
  const ctx = freshTestDb();
  const agora = '2026-01-01 19:00:00';

  const { id: dentroDaJanela } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'A', clienteTelefone: '111', pessoas: 2, dataHora: '2026-01-01 20:00:00' }); // +60min
  const { id: cedoDemais } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'B', clienteTelefone: '222', pessoas: 2, dataHora: '2026-01-01 22:00:00' }); // +180min
  const { id: tardeDemais } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'C', clienteTelefone: '333', pessoas: 2, dataHora: '2026-01-01 19:10:00' }); // +10min
  const { id: jaMandado } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'D', clienteTelefone: '444', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(jaMandado);

  const pendentes = reservationService.findPendingLembrete(agora).map((r) => r.id);
  assert.deepEqual(pendentes, [dentroDaJanela]);
  assert.equal(pendentes.includes(cedoDemais), false);
  assert.equal(pendentes.includes(tardeDemais), false);
  assert.equal(pendentes.includes(jaMandado), false);
});

test('marcarLembreteEnviado move a reserva pra aguardando_confirmacao', () => {
  const ctx = freshTestDb();
  const { id } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'A', clienteTelefone: '111', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(id);
  const reserva = reservationService.list({ locationId: ctx.locationId })[0];
  assert.equal(reserva.status, 'aguardando_confirmacao');
  assert.notEqual(reserva.lembrete_enviado_em, null);
});

test('findAguardandoConfirmacaoByTelefone acha a reserva certa e ignora as que não estão nesse status', () => {
  const ctx = freshTestDb();
  const { id: aguardando } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'A', clienteTelefone: '(11) 99999-0000', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.marcarLembreteEnviado(aguardando);
  reservationService.create({ locationId: ctx.locationId, clienteNome: 'B', clienteTelefone: '11999990000', pessoas: 2, dataHora: '2026-01-02 20:00:00' }); // mesmo telefone, ainda pendente

  const achada = reservationService.findAguardandoConfirmacaoByTelefone('11999990000');
  assert.equal(achada.id, aguardando);

  assert.equal(reservationService.findAguardandoConfirmacaoByTelefone('11900000000'), null);
});

test('confirmar marca status e confirmado_em; recusar cancela', () => {
  const ctx = freshTestDb();
  const { id: id1 } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'A', clienteTelefone: '111', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.confirmar(id1);
  const r1 = reservationService.list({ locationId: ctx.locationId }).find((r) => r.id === id1);
  assert.equal(r1.status, 'confirmada');
  assert.notEqual(r1.confirmado_em, null);

  const { id: id2 } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'B', clienteTelefone: '222', pessoas: 2, dataHora: '2026-01-01 20:00:00' });
  reservationService.recusar(id2);
  const r2 = reservationService.list({ locationId: ctx.locationId }).find((r) => r.id === id2);
  assert.equal(r2.status, 'cancelada');
});

test('marcarNaoConfirmadasVencidas só afeta reservas aguardando confirmação de mais de 2h atrás', () => {
  const ctx = freshTestDb();
  const { id: vencida } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'A', clienteTelefone: '111', pessoas: 2, dataHora: '2026-01-01 15:00:00' });
  reservationService.marcarLembreteEnviado(vencida);
  const { id: recente } = reservationService.create({ locationId: ctx.locationId, clienteNome: 'B', clienteTelefone: '222', pessoas: 2, dataHora: '2026-01-01 18:30:00' });
  reservationService.marcarLembreteEnviado(recente);

  const result = reservationService.marcarNaoConfirmadasVencidas('2026-01-01 19:00:00');
  assert.equal(result.quantidade, 1);

  const lista = reservationService.list({ locationId: ctx.locationId });
  assert.equal(lista.find((r) => r.id === vencida).status, 'nao_confirmada');
  assert.equal(lista.find((r) => r.id === recente).status, 'aguardando_confirmacao');
});
