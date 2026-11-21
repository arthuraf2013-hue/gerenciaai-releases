const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };
const chamada = require('../electron/services/chamadaService');

// Trava de publicação: uma saída antecipada (desligado, sem mudança) não pode
// deixar a trava presa com o resultado velho -- senão o painel nunca mais publica.
test('painel de senhas: depois de "desligado", ligar volta a publicar (a trava não fica presa)', async () => {
  const ctx = freshTestDb();
  const r1 = await chamada.publicarSeMudou();
  assert.equal(r1.motivo, 'desligado');
  ctx.db.prepare("UPDATE chamada_config SET ativa = 1, painel_token = 'abcdefabcdefabcdefabcdef' WHERE id = 'default'").run();
  await new Promise((r) => setTimeout(r, 250)); // um "pendente" agendado termina
  const r2 = await chamada.publicarSeMudou();
  assert.notEqual(r2.motivo, 'desligado', 'tentou publicar de novo (aqui falha por falta de rede, como esperado)');
  assert.equal(r2.motivo, 'erro');
});
