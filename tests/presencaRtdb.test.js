const test = require('node:test');
const assert = require('node:assert/strict');

// Presença no Realtime Database contra o EMULADOR, com as regras do
// repositório (database.rules.json). Sem o emulador, pula -- igual ao
// tests/firestoreRules.test.js. Rodar:
//   firebase emulators:exec --only database --project gerenciaai-licencas \
//     "GERENCIAAI_FIREBASE_REAL=1 node --test tests/presencaRtdb.test.js"
const EMU = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PULAR = !EMU && 'defina FIREBASE_DATABASE_EMULATOR_HOST (firebase emulators:exec --only database)';
const NS = 'gerenciaai-licencas-default-rtdb';
const ler = async (caminho) => (await fetch(`http://${EMU}/${caminho}.json?ns=${NS}`)).json();
const esperar = async (cond, ms = 8000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

test('presença: conecta, marca on, anuncia o servidor e o Firebase marca off quando cai', { skip: PULAR }, async () => {
  const { freshTestDb } = require('./helpers/testDb');
  freshTestDb();
  require('../electron/services/pdvRegistryService').getOrCreateDeviceUid = () => 'maquina-presenca-01';
  require('../electron/services/licenseService').nomeDoComputador = () => 'PDV-TESTE';
  const presenca = require('../electron/services/presencaService');
  await presenca.iniciar();
  assert.ok(await esperar(() => presenca.estaConectado()), 'conectou');
  const p = await ler('presenca/maquina-presenca-01');
  assert.equal(p.on, true);
  assert.equal(p.nome, 'PDV-TESTE');
  assert.equal(typeof p.desde, 'number');

  presenca.anunciarHub('grupo-presenca-01', { hubId: 'maquina-presenca-01', nome: 'PDV-TESTE', enderecos: ['192.168.0.10:47820'] });
  assert.ok(await esperar(async () => (await ler('hubs/grupo-presenca-01'))?.enderecos?.[0] === '192.168.0.10:47820'), 'anúncio do servidor');

  const { goOffline } = require('firebase/database');
  goOffline(presenca._bancoParaTeste());
  assert.ok(await esperar(async () => (await ler('presenca/maquina-presenca-01'))?.on === false), 'caiu: on=false pelo onDisconnect');
  assert.equal(await ler('hubs/grupo-presenca-01'), null, 'anúncio some junto');
});

test('regras: campo estranho e id inválido são recusados; ler a lista inteira só com login da Central', { skip: PULAR }, async () => {
  const gravar = (caminho, corpo) => fetch(`http://${EMU}/${caminho}.json?ns=${NS}`, { method: 'PUT', body: JSON.stringify(corpo) });
  assert.equal((await gravar('presenca/maquina-presenca-02', { on: true })).status, 200);
  assert.notEqual((await gravar('presenca/maquina-presenca-02', { on: true, senha: 'x' })).status, 200);
  assert.notEqual((await gravar('presenca/a$b', { on: true })).status, 200);
  assert.notEqual((await gravar('outra-coisa/x', { a: 1 })).status, 200);
  assert.notEqual((await fetch(`http://${EMU}/presenca.json?ns=${NS}`)).status, 200, 'lista inteira sem login');
  assert.equal((await fetch(`http://${EMU}/presenca/maquina-presenca-02.json?ns=${NS}`)).status, 200, 'uma máquina: aberto (celular olha)');
});
