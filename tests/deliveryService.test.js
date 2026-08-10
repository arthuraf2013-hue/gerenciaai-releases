const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');
const deliveryService = require('../electron/services/deliveryService');

test('cadastra rota, veículo e entregador, e lista de volta', () => {
  const { db } = freshTestDb();
  const rota = deliveryService.upsertRoute({ nome: 'Rota Centro', descricao: 'Centro e Boa Vista' });
  const veiculo = deliveryService.upsertVehicle({ placa: 'ABC1234', modelo: 'Honda CG', tipo: 'moto' });
  const entregador = deliveryService.upsertPerson({ nome: 'Carlos', telefone: '81977776666' });

  assert.equal(rota.ok, true);
  assert.equal(veiculo.ok, true);
  assert.equal(entregador.ok, true);
  assert.equal(deliveryService.listRoutes().length, 1);
  assert.equal(deliveryService.listVehicles().length, 1);
  assert.equal(deliveryService.listPersons().length, 1);
});

test('recusa rota sem nome, e veículo sem placa nem modelo', () => {
  const { db } = freshTestDb();
  assert.equal(deliveryService.upsertRoute({ nome: '' }).ok, false);
  assert.equal(deliveryService.upsertVehicle({}).ok, false);
  assert.equal(deliveryService.upsertPerson({ nome: '' }).ok, false);
});

test('desativar rota/veículo/entregador some da listagem', () => {
  const { db } = freshTestDb();
  const rota = deliveryService.upsertRoute({ nome: 'Rota X' });
  deliveryService.deactivateRoute(rota.id);
  assert.equal(deliveryService.listRoutes().length, 0);
});

test('cria entrega, atribui rota/entregador/veículo, e tudo aparece junto na fila', () => {
  const { db, locationId } = freshTestDb();
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Maria', '81988887777');

  const rota = deliveryService.upsertRoute({ nome: 'Rota Centro' });
  const veiculo = deliveryService.upsertVehicle({ modelo: 'Honda CG' });
  const entregador = deliveryService.upsertPerson({ nome: 'Carlos' });
  const entrega = deliveryService.createDelivery({ locationId, customerId: clienteId, endereco: 'Rua Teste, 123', taxaEntrega: 5 });

  assert.equal(entrega.ok, true);
  deliveryService.assignDelivery({ deliveryId: entrega.id, routeId: rota.id, deliveryPersonId: entregador.id, vehicleId: veiculo.id });

  const fila = deliveryService.listDeliveries({ locationId });
  assert.equal(fila.length, 1);
  assert.equal(fila[0].status, 'pendente');
  assert.equal(fila[0].clienteNome, 'Maria');
  assert.equal(fila[0].rotaNome, 'Rota Centro');
  assert.equal(fila[0].entregadorNome, 'Carlos');
  assert.equal(fila[0].veiculoModelo, 'Honda CG');
});

test('mudar status pra em_rota marca saiu_em automaticamente, entregue marca entregue_em', () => {
  const { db, locationId } = freshTestDb();
  const entrega = deliveryService.createDelivery({ locationId, endereco: 'Rua Teste' });

  let atual = deliveryService.listDeliveries({ locationId })[0];
  assert.equal(atual.saiu_em, null);

  deliveryService.updateDeliveryStatus({ deliveryId: entrega.id, status: 'em_rota' });
  atual = deliveryService.listDeliveries({ locationId })[0];
  assert.equal(atual.status, 'em_rota');
  assert.ok(atual.saiu_em);
  assert.equal(atual.entregue_em, null);

  deliveryService.updateDeliveryStatus({ deliveryId: entrega.id, status: 'entregue' });
  atual = deliveryService.listDeliveries({ locationId })[0];
  assert.equal(atual.status, 'entregue');
  assert.ok(atual.entregue_em);
});

test('recusa status inválido', () => {
  const { db, locationId } = freshTestDb();
  const entrega = deliveryService.createDelivery({ locationId, endereco: 'Rua Teste' });
  const r = deliveryService.updateDeliveryStatus({ deliveryId: entrega.id, status: 'nao_existe' });
  assert.equal(r.ok, false);
});

test('listDeliveries filtra por status quando pedido', () => {
  const { db, locationId } = freshTestDb();
  const entrega1 = deliveryService.createDelivery({ locationId, endereco: 'Endereço 1' });
  const entrega2 = deliveryService.createDelivery({ locationId, endereco: 'Endereço 2' });
  deliveryService.updateDeliveryStatus({ deliveryId: entrega2.id, status: 'entregue' });

  const pendentes = deliveryService.listDeliveries({ locationId, status: 'pendente' });
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].id, entrega1.id);
});

test('montarLinkStatus muda a mensagem conforme o status atual, e recusa sem telefone', () => {
  const { db, locationId } = freshTestDb();
  const clienteComTelefone = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteComTelefone, 'Maria', '81988887777');
  const clienteSemTelefone = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, NULL)').run(clienteSemTelefone, 'Sem Telefone');

  const entregaComTelefone = deliveryService.createDelivery({ locationId, customerId: clienteComTelefone, endereco: 'Rua A' });
  deliveryService.updateDeliveryStatus({ deliveryId: entregaComTelefone.id, status: 'em_rota' });
  const linkEmRota = deliveryService.montarLinkStatusEntrega(entregaComTelefone.id);
  assert.equal(linkEmRota.ok, true);
  assert.match(linkEmRota.mensagem, /sair pra entrega/);

  deliveryService.updateDeliveryStatus({ deliveryId: entregaComTelefone.id, status: 'entregue' });
  const linkEntregue = deliveryService.montarLinkStatusEntrega(entregaComTelefone.id);
  assert.match(linkEntregue.mensagem, /foi entregue/);

  const entregaSemTelefone = deliveryService.createDelivery({ locationId, customerId: clienteSemTelefone, endereco: 'Rua B' });
  const linkSemTelefone = deliveryService.montarLinkStatusEntrega(entregaSemTelefone.id);
  assert.equal(linkSemTelefone.ok, false);
});
