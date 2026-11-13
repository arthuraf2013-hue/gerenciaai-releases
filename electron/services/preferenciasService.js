const { getDb } = require('../db/database');

// Preferências de tela por usuário (nov/2026): menu da esquerda montado por
// cada um, jeito do PDV (categorias, vendidos recentemente, modo foco),
// tamanho da letra, densidade e tema. O formato é do frontend
// (src/context/PreferenciasContext.jsx); aqui só se garante que é um objeto
// JSON pequeno e que cada um mexe só no seu (o handler passa o usuário da
// sessão, nunca o do payload).

const LIMITE_BYTES = 16 * 1024;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ler(userId) {
  if (!userId) return {};
  const row = getDb().prepare('SELECT prefs_json FROM user_preferences WHERE user_id = ?').get(userId);
  if (!row) return {};
  try {
    const obj = JSON.parse(row.prefs_json);
    return ehObjeto(obj) ? obj : {};
  } catch {
    return {}; // JSON estragado não pode derrubar a tela: volta ao padrão
  }
}

/** Mescla (1 nível por grupo: menu, pdv, visual...) e grava. */
function gravar(userId, mudancas) {
  if (!userId) return { ok: false, error: 'Faça login de novo.' };
  if (!ehObjeto(mudancas)) return { ok: false, error: 'Preferências inválidas.' };
  const atual = ler(userId);
  const novo = { ...atual };
  for (const [grupo, valor] of Object.entries(mudancas)) {
    if (valor === null) delete novo[grupo];
    else novo[grupo] = ehObjeto(valor) && ehObjeto(atual[grupo]) ? { ...atual[grupo], ...valor } : valor;
  }
  const json = JSON.stringify(novo);
  if (Buffer.byteLength(json) > LIMITE_BYTES) return { ok: false, error: 'Preferências grandes demais.' };
  getDb().prepare(
    `INSERT INTO user_preferences (user_id, prefs_json, atualizado_em) VALUES (?, ?, NOW_SYNCED())
     ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, atualizado_em = excluded.atualizado_em`
  ).run(userId, json);
  return { ok: true, prefs: novo };
}

module.exports = { ler, gravar, LIMITE_BYTES };
