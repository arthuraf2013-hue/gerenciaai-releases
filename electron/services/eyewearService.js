const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/** Histórico de receitas do cliente — mais recente primeiro, pra ver
 * a evolução do grau ao longo do tempo. */
function listByCustomer(customerId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM eyewear_prescriptions WHERE customer_id = ? AND ativo = 1 ORDER BY data_receita DESC, criado_em DESC`
  ).all(customerId);
}

function upsert(receita) {
  if (!receita.customerId) return { ok: false, error: 'Receita precisa estar vinculada a um cliente.' };
  const db = getDb();
  const id = receita.id || randomUUID();
  db.prepare(
    `INSERT INTO eyewear_prescriptions (
       id, customer_id, data_receita,
       od_esferico, od_cilindrico, od_eixo, od_adicao,
       oe_esferico, oe_cilindrico, oe_eixo, oe_adicao,
       distancia_pupilar, tipo_lente, observacoes
     ) VALUES (@id, @customerId, @dataReceita,
       @odEsferico, @odCilindrico, @odEixo, @odAdicao,
       @oeEsferico, @oeCilindrico, @oeEixo, @oeAdicao,
       @distanciaPupilar, @tipoLente, @observacoes)
     ON CONFLICT(id) DO UPDATE SET
       data_receita=excluded.data_receita,
       od_esferico=excluded.od_esferico, od_cilindrico=excluded.od_cilindrico, od_eixo=excluded.od_eixo, od_adicao=excluded.od_adicao,
       oe_esferico=excluded.oe_esferico, oe_cilindrico=excluded.oe_cilindrico, oe_eixo=excluded.oe_eixo, oe_adicao=excluded.oe_adicao,
       distancia_pupilar=excluded.distancia_pupilar, tipo_lente=excluded.tipo_lente, observacoes=excluded.observacoes`
  ).run({
    id, customerId: receita.customerId, dataReceita: receita.dataReceita || null,
    odEsferico: receita.odEsferico ?? null, odCilindrico: receita.odCilindrico ?? null, odEixo: receita.odEixo ?? null, odAdicao: receita.odAdicao ?? null,
    oeEsferico: receita.oeEsferico ?? null, oeCilindrico: receita.oeCilindrico ?? null, oeEixo: receita.oeEixo ?? null, oeAdicao: receita.oeAdicao ?? null,
    distanciaPupilar: receita.distanciaPupilar ?? null, tipoLente: receita.tipoLente || null, observacoes: receita.observacoes || null,
  });
  return { ok: true, id };
}

function deactivate(id) {
  getDb().prepare('UPDATE eyewear_prescriptions SET ativo = 0 WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = { listByCustomer, upsert, deactivate };
