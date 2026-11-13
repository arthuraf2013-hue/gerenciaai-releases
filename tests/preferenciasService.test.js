// Preferências de tela por usuário (menu, PDV, letra, densidade).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const prefs = require('../electron/services/preferenciasService');

test('cada usuário tem as suas preferências, mescladas por grupo', () => {
  const ctx = freshTestDb();
  assert.deepEqual(prefs.ler(ctx.operadorId), {});
  let r = prefs.gravar(ctx.operadorId, { menu: { favoritos: ['pos', 'history'] }, visual: { zoom: 1.1 } });
  assert.equal(r.ok, true);
  r = prefs.gravar(ctx.operadorId, { menu: { ocultos: ['delivery'] } });
  assert.deepEqual(r.prefs.menu, { favoritos: ['pos', 'history'], ocultos: ['delivery'] });
  assert.deepEqual(prefs.ler(ctx.operadorId).visual, { zoom: 1.1 });
  // O gerente não enxerga nem herda o do operador.
  assert.deepEqual(prefs.ler(ctx.gerenteId), {});
  // null apaga o grupo (restaurar padrão).
  prefs.gravar(ctx.operadorId, { menu: null });
  assert.equal(prefs.ler(ctx.operadorId).menu, undefined);
});

test('recusa sem usuário, formato errado e tamanho absurdo; JSON estragado volta ao padrão', () => {
  const ctx = freshTestDb();
  assert.equal(prefs.gravar(null, { a: 1 }).ok, false);
  assert.equal(prefs.gravar(ctx.operadorId, ['x']).ok, false);
  assert.equal(prefs.gravar(ctx.operadorId, { grande: 'x'.repeat(prefs.LIMITE_BYTES) }).ok, false);
  ctx.db.prepare(`INSERT INTO user_preferences (user_id, prefs_json) VALUES (?, '{quebrado')`).run(ctx.gerenteId);
  assert.deepEqual(prefs.ler(ctx.gerenteId), {});
  assert.equal(prefs.gravar(ctx.gerenteId, { visual: { zoom: 1 } }).ok, true);
});
