const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const mc = require('../electron/services/mesaCompartilhadaService');
const syncState = require('../electron/services/syncStateService');
const lanHub = require('../electron/services/lanHubService');

// A tela Mesas diz por que as mesas daqui não são as do servidor.
function trocar(obj, nome, valor, fn) {
  const o = obj[nome]; obj[nome] = valor;
  try { return fn(); } finally { obj[nome] = o; }
}

test('fora de grupo: sem_grupo', () => {
  freshTestDb();
  assert.equal(mc.situacao().motivo, 'sem_grupo');
});

test('caixa no grupo sem a rede local ligada: sem_rede_local', () => {
  const { db } = freshTestDb();
  db.prepare("UPDATE sync_state SET grupo_sincronizacao_id = 'g-sit', servidor_do_grupo = 0 WHERE id = 'default'").run();
  assert.equal(mc.situacao().motivo, 'sem_rede_local');
});

test('servidor: diz se a rede local está ligada e quais caixas estão ligados', () => {
  const { db } = freshTestDb();
  db.prepare("UPDATE sync_state SET grupo_sincronizacao_id = 'g-sit', servidor_do_grupo = 1 WHERE id = 'default'").run();
  assert.equal(syncState.ehServidorDoGrupo(), true);
  trocar(lanHub, 'status', () => ({ ligado: true, caixas: [{ nome: 'PDV2', ultimo_contato: '2026-11-20 10:00:00' }] }), () => {
    assert.deepEqual(mc.situacao(), { motivo: 'servidor', redeLocalLigada: true, caixas: [{ nome: 'PDV2', ultimoContato: '2026-11-20 10:00:00' }] });
  });
  trocar(lanHub, 'status', () => ({ ligado: false, caixas: [] }), () => {
    assert.equal(mc.situacao().redeLocalLigada, false);
  });
});
