const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function rowToProfile(row) {
  return {
    id: row.id,
    nome: row.nome,
    camposExtras: JSON.parse(row.campos_extras_json || '[]'),
    // regrasAlerta mantido no mesmo formato que o frontend já espera
    // (era um array vindo do JSON antigo) — evita mexer no StockAlerts.jsx.
    regrasAlerta: row.alerta_validade_proxima ? ['validade_proxima'] : [],
    diasAlertaValidade: row.dias_alerta_validade,
    diasAlertaValidadeCritico: row.dias_alerta_validade_critico,
    estoqueCriticoPercentual: row.estoque_critico_percentual,
  };
}

function listAvailableProfiles() {
  const db = getDb();
  return db.prepare('SELECT * FROM custom_profiles ORDER BY nome').all().map(rowToProfile);
}

function getProfileById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_profiles WHERE id = ?').get(id);
  return row ? rowToProfile(row) : null;
}

function getActiveProfile() {
  const db = getDb();
  const row = db.prepare('SELECT perfil_ativo FROM business_profile WHERE id = ?').get('default');
  const profileId = row?.perfil_ativo || 'generico';
  return getProfileById(profileId) || getProfileById('generico') || listAvailableProfiles()[0] || null;
}

function setActiveProfile(profileId) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM custom_profiles WHERE id = ?').get(profileId);
  if (!exists) return { ok: false, error: 'Perfil não encontrado.' };
  db.prepare('UPDATE business_profile SET perfil_ativo = ? WHERE id = ?').run(profileId, 'default');
  return { ok: true };
}

function validateCamposExtras(camposExtras) {
  if (!Array.isArray(camposExtras)) return 'Campos extras inválidos.';
  for (const c of camposExtras) {
    if (!c.campo || !c.label) return 'Todo campo extra precisa de uma chave e um rótulo.';
    if (!['texto', 'numero', 'data', 'boolean'].includes(c.tipo)) return `Tipo de campo inválido: ${c.tipo}`;
  }
  return null;
}

function createProfile(payload) {
  const db = getDb();
  if (!payload.nome?.trim()) return { ok: false, error: 'Informe um nome para o perfil.' };
  const erro = validateCamposExtras(payload.camposExtras || []);
  if (erro) return { ok: false, error: erro };

  const id = randomUUID();
  db.prepare(
    `INSERT INTO custom_profiles (id, nome, campos_extras_json, alerta_validade_proxima, dias_alerta_validade, dias_alerta_validade_critico, estoque_critico_percentual)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, payload.nome.trim(), JSON.stringify(payload.camposExtras || []),
    payload.alertaValidadeProxima ? 1 : 0, payload.diasAlertaValidade || 60,
    payload.diasAlertaValidadeCritico || 7, payload.estoqueCriticoPercentual ?? 50
  );
  return { ok: true, id };
}

function updateProfile(id, payload) {
  const db = getDb();
  const current = db.prepare('SELECT * FROM custom_profiles WHERE id = ?').get(id);
  if (!current) return { ok: false, error: 'Perfil não encontrado.' };
  if (payload.camposExtras) {
    const erro = validateCamposExtras(payload.camposExtras);
    if (erro) return { ok: false, error: erro };
  }

  db.prepare(
    `UPDATE custom_profiles SET nome = ?, campos_extras_json = ?, alerta_validade_proxima = ?, dias_alerta_validade = ?,
       dias_alerta_validade_critico = ?, estoque_critico_percentual = ? WHERE id = ?`
  ).run(
    payload.nome?.trim() || current.nome,
    payload.camposExtras ? JSON.stringify(payload.camposExtras) : current.campos_extras_json,
    payload.alertaValidadeProxima !== undefined ? (payload.alertaValidadeProxima ? 1 : 0) : current.alerta_validade_proxima,
    payload.diasAlertaValidade ?? current.dias_alerta_validade,
    payload.diasAlertaValidadeCritico ?? current.dias_alerta_validade_critico,
    payload.estoqueCriticoPercentual ?? current.estoque_critico_percentual,
    id
  );
  return { ok: true };
}

function duplicateProfile(id, novoNome) {
  const db = getDb();
  const original = db.prepare('SELECT * FROM custom_profiles WHERE id = ?').get(id);
  if (!original) return { ok: false, error: 'Perfil não encontrado.' };
  return createProfile({
    nome: novoNome || `${original.nome} (cópia)`,
    camposExtras: JSON.parse(original.campos_extras_json),
    alertaValidadeProxima: !!original.alerta_validade_proxima,
    diasAlertaValidade: original.dias_alerta_validade,
    diasAlertaValidadeCritico: original.dias_alerta_validade_critico,
    estoqueCriticoPercentual: original.estoque_critico_percentual,
  });
}

function deleteProfile(id) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM custom_profiles').get().c;
  if (total <= 1) return { ok: false, error: 'Não é possível excluir o único perfil existente.' };

  const active = db.prepare('SELECT perfil_ativo FROM business_profile WHERE id = ?').get('default');
  if (active?.perfil_ativo === id) {
    return { ok: false, error: 'Este é o perfil ativo. Troque para outro perfil antes de excluir este.' };
  }

  db.prepare('DELETE FROM custom_profiles WHERE id = ?').run(id);
  return { ok: true };
}

function getSettings() {
  const db = getDb();
  return {
    location: db.prepare('SELECT * FROM locations LIMIT 1').get(),
    profile: getActiveProfile(),
  };
}

function updateLocationName(locationId, nome) {
  const db = getDb();
  db.prepare('UPDATE locations SET nome = ? WHERE id = ?').run(nome, locationId);
  return { ok: true };
}

module.exports = {
  listAvailableProfiles, getActiveProfile, setActiveProfile, createProfile, updateProfile,
  duplicateProfile, deleteProfile, getSettings, updateLocationName,
};
