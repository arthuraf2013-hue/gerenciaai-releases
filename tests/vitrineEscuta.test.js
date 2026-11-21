const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };
const vitrine = require('../electron/services/vitrineService');
const pedidos = require('../electron/services/vitrinePedidoService');

// A escuta de pedidos do Firestore que dá erro morre e não volta sozinha:
// o app tem de perceber e ligar de novo (antes, os pedidos paravam até reiniciar).
test('escuta de pedidos: erro do Firestore -> religa sozinha depois de alguns segundos', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = freshTestDb();
  vitrine.getConfig();
  ctx.db.prepare("UPDATE vitrine_config SET slug = 'bar-teste', ativa = 1, pedidos_online = 1 WHERE id = 'default'").run();
  const escutas = [];
  pedidos._definirNuvemParaTeste({
    firestore: {}, installId: 'maquina-1',
    collection: () => ({}), query: () => ({}), where: () => ({}),
    onSnapshot: (_q, aoMudar, aoErrar) => { const e = { aoMudar, aoErrar, parada: false }; escutas.push(e); return () => { e.parada = true; }; },
  });
  t.after(() => { pedidos._definirNuvemParaTeste(null); ctx.db.prepare("UPDATE vitrine_config SET ativa = 0 WHERE id = 'default'").run(); pedidos.atualizarEscuta(); });

  pedidos.atualizarEscuta();
  assert.equal(escutas.length, 1);
  assert.equal(pedidos.statusDaEscuta().escutando, true);
  escutas[0].aoMudar({ docChanges: () => [] });
  assert.ok(pedidos.statusDaEscuta().ultimaRespostaEm);

  escutas[0].aoErrar(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
  let s = pedidos.statusDaEscuta();
  assert.equal(s.escutando, false, 'não finge que está escutando');
  assert.equal(s.reconectando, true);
  assert.equal(s.ultimoErro, 'permission-denied');
  pedidos.atualizarEscuta(); // chamada no meio não duplica
  assert.equal(escutas.length, 2, 'atualizarEscuta liga de novo na hora (estava parada)');

  // Segundo erro: espera e religa pelo relógio.
  escutas[1].aoErrar(new Error('unavailable'));
  assert.equal(escutas.length, 2);
  t.mock.timers.tick(60000);
  assert.equal(escutas.length, 3, 'religou pelo relógio');
  escutas[2].aoMudar({ docChanges: () => [] });
  s = pedidos.statusDaEscuta();
  assert.equal(s.escutando, true);
  assert.equal(s.ultimoErro, null);
});
