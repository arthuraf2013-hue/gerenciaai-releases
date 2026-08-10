const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

// ---------- Rotas ----------
function listRoutes() {
  const db = getDb();
  return db.prepare('SELECT * FROM delivery_routes WHERE ativo = 1 ORDER BY nome').all();
}
function upsertRoute(route) {
  if (!route.nome?.trim()) return { ok: false, error: 'Informe o nome da rota.' };
  const db = getDb();
  const id = route.id || randomUUID();
  db.prepare(
    `INSERT INTO delivery_routes (id, nome, descricao) VALUES (@id, @nome, @descricao)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, descricao=excluded.descricao`
  ).run({ id, nome: route.nome.trim(), descricao: route.descricao || null });
  return { ok: true, id };
}
function deactivateRoute(id) {
  getDb().prepare('UPDATE delivery_routes SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- Veículos ----------
function listVehicles() {
  const db = getDb();
  return db.prepare('SELECT * FROM delivery_vehicles WHERE ativo = 1 ORDER BY modelo').all();
}
function upsertVehicle(vehicle) {
  if (!vehicle.modelo?.trim() && !vehicle.placa?.trim()) return { ok: false, error: 'Informe ao menos o modelo ou a placa do veículo.' };
  const db = getDb();
  const id = vehicle.id || randomUUID();
  db.prepare(
    `INSERT INTO delivery_vehicles (id, placa, modelo, tipo) VALUES (@id, @placa, @modelo, @tipo)
     ON CONFLICT(id) DO UPDATE SET placa=excluded.placa, modelo=excluded.modelo, tipo=excluded.tipo`
  ).run({ id, placa: vehicle.placa || null, modelo: vehicle.modelo || null, tipo: vehicle.tipo || null });
  return { ok: true, id };
}
function deactivateVehicle(id) {
  getDb().prepare('UPDATE delivery_vehicles SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- Entregadores ----------
function listPersons() {
  const db = getDb();
  return db.prepare('SELECT * FROM delivery_persons WHERE ativo = 1 ORDER BY nome').all();
}
function upsertPerson(person) {
  if (!person.nome?.trim()) return { ok: false, error: 'Informe o nome do entregador.' };
  const db = getDb();
  const id = person.id || randomUUID();
  db.prepare(
    `INSERT INTO delivery_persons (id, nome, telefone) VALUES (@id, @nome, @telefone)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone`
  ).run({ id, nome: person.nome.trim(), telefone: person.telefone || null });
  return { ok: true, id };
}
function deactivatePerson(id) {
  getDb().prepare('UPDATE delivery_persons SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- Entregas ----------

/** Cria uma entrega — vinculada a uma venda quando já existir (o caso
 * mais comum), mas não é obrigatório (pedido por telefone antes de
 * virar venda registrada, por exemplo). */
function createDelivery({ locationId, saleId, customerId, endereco, taxaEntrega, observacoes, operadorId }) {
  if (!locationId) return { ok: false, error: 'Local é obrigatório.' };
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO deliveries (id, location_id, sale_id, customer_id, endereco, taxa_entrega, observacoes, operador_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`
  ).run(id, locationId, saleId || null, customerId || null, endereco || null, taxaEntrega || 0, observacoes || null, operadorId || null);
  return { ok: true, id };
}

/** Atribui rota/entregador/veículo — separado da mudança de status,
 * porque muitas vezes se sabe quem vai entregar antes de a entrega
 * sair de fato. */
function assignDelivery({ deliveryId, routeId, deliveryPersonId, vehicleId }) {
  const db = getDb();
  const entrega = db.prepare('SELECT id FROM deliveries WHERE id = ?').get(deliveryId);
  if (!entrega) return { ok: false, error: 'Entrega não encontrada.' };
  db.prepare(
    `UPDATE deliveries SET route_id = ?, delivery_person_id = ?, vehicle_id = ? WHERE id = ?`
  ).run(routeId || null, deliveryPersonId || null, vehicleId || null, deliveryId);
  return { ok: true };
}

/** Muda o status — marca automaticamente quando saiu e quando chegou,
 * pra dar noção de quanto tempo cada etapa está levando. */
function updateDeliveryStatus({ deliveryId, status }) {
  const STATUS_VALIDOS = ['pendente', 'em_rota', 'entregue', 'cancelada'];
  if (!STATUS_VALIDOS.includes(status)) return { ok: false, error: 'Status inválido.' };
  const db = getDb();
  const entrega = db.prepare('SELECT id FROM deliveries WHERE id = ?').get(deliveryId);
  if (!entrega) return { ok: false, error: 'Entrega não encontrada.' };

  const campos = { status };
  if (status === 'em_rota') campos.saiu_em = 'NOW_SYNCED()';
  if (status === 'entregue') campos.entregue_em = 'NOW_SYNCED()';

  const sets = ['status = @status'];
  if (campos.saiu_em) sets.push('saiu_em = COALESCE(saiu_em, NOW_SYNCED())');
  if (campos.entregue_em) sets.push('entregue_em = COALESCE(entregue_em, NOW_SYNCED())');

  db.prepare(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = @deliveryId`).run({ status, deliveryId });
  return { ok: true };
}

/** Fila de entregas — junta com cliente, rota, entregador e veículo
 * pra já vir pronto pra tela, sem N consultas separadas. */
function listDeliveries({ locationId, status } = {}) {
  const db = getDb();
  let sql = `
    SELECT d.*, c.nome as clienteNome, c.telefone as clienteTelefone,
      r.nome as rotaNome, p.nome as entregadorNome, p.telefone as entregadorTelefone,
      v.modelo as veiculoModelo, v.placa as veiculoPlaca
    FROM deliveries d
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN delivery_routes r ON r.id = d.route_id
    LEFT JOIN delivery_persons p ON p.id = d.delivery_person_id
    LEFT JOIN delivery_vehicles v ON v.id = d.vehicle_id
    WHERE d.location_id = ?`;
  const params = [locationId];
  if (status) {
    sql += ' AND d.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY d.criado_em DESC';
  return db.prepare(sql).all(...params);
}

/** Link de WhatsApp avisando o cliente que a entrega saiu (ou
 * chegou) — mesmo padrão wa.me já usado em recibo, reconquista de
 * cliente, e lembrete de pet. */
function montarLinkStatusEntrega(deliveryId) {
  const db = getDb();
  const entrega = db.prepare(
    `SELECT d.*, c.nome as clienteNome, c.telefone as clienteTelefone
     FROM deliveries d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`
  ).get(deliveryId);
  if (!entrega) return { ok: false, error: 'Entrega não encontrada.' };
  if (!entrega.clienteTelefone) return { ok: false, error: 'Esse cliente não tem telefone cadastrado.' };

  const primeiroNome = (entrega.clienteNome || '').trim().split(' ')[0] || 'tudo bem';
  const mensagem = entrega.status === 'entregue'
    ? `Oi, ${primeiroNome}! Seu pedido foi entregue. Qualquer coisa, é só chamar aqui! 😊`
    : `Oi, ${primeiroNome}! Seu pedido acabou de sair pra entrega. Já, já chega aí! 🛵`;

  const digitos = entrega.clienteTelefone.replace(/\D/g, '');
  const numeroLimpo = digitos.startsWith('55') ? digitos : '55' + digitos;
  const url = `https://wa.me/${numeroLimpo}?text=${encodeURIComponent(mensagem)}`;
  return { ok: true, url, mensagem };
}

module.exports = {
  listRoutes, upsertRoute, deactivateRoute,
  listVehicles, upsertVehicle, deactivateVehicle,
  listPersons, upsertPerson, deactivatePerson,
  createDelivery, assignDelivery, updateDeliveryStatus, listDeliveries, montarLinkStatusEntrega,
};
