const test = require('node:test');
const assert = require('node:assert/strict');

// Ping de presença pela REST (redundância do SDK): sem cota, pausa e só
// sonda; sem rede, cai para o SDK (no máximo um ping parado na fila dele).
const gravacoesSdk = [];
let sdkTrava = false;
require.cache[require.resolve('firebase/firestore')] = {
  id: 'firebase/firestore', loaded: true,
  exports: {
    getFirestore: () => ({}),
    doc: (_db, col, id) => `${col}/${id}`,
    serverTimestamp: () => 'TS',
    setDoc: (ref, dados, opcoes) => {
      gravacoesSdk.push({ ref, dados, opcoes });
      return sdkTrava ? new Promise(() => {}) : Promise.resolve();
    },
  },
};
const pdvRegistryService = require('../electron/services/pdvRegistryService');
pdvRegistryService.getOrCreateDeviceUid = () => 'maquina-teste-2';
require('../electron/services/reparoInstalacaoService').resumoParaCentral = () => null;
require('../electron/services/saudeService').resumoParaCentral = () => ({ pendenciasAltas: 0 });
const disjuntor = require('../electron/services/nuvemDisjuntorService');
const conectividade = require('../electron/services/connectivityService');
const licenseService = require('../electron/services/licenseService');

function fetchQueResponde(status, corpo = {}) {
  const chamadas = [];
  const fn = async (url, opcoes) => { chamadas.push(JSON.parse(opcoes.body)); return { ok: status === 200, status, json: async () => corpo }; };
  fn.chamadas = chamadas;
  return fn;
}

test('ping REST ok: marca online, conta a escrita e não usa o SDK', async () => {
  disjuntor._zerarParaTeste();
  const f = fetchQueResponde(200);
  licenseService._definirFetchDoPingParaTeste(f);
  gravacoesSdk.length = 0;
  await licenseService.enviarPing();
  assert.equal(f.chamadas.length, 1);
  const escrita = f.chamadas[0].writes[0];
  assert.equal(escrita.update.name.endsWith('/installations/maquina-teste-2'), true);
  assert.deepEqual(escrita.currentDocument, { exists: true }, 'o ping não cria documento pela metade');
  assert.equal(escrita.updateTransforms[0].fieldPath, 'ultimoPing');
  assert.equal(gravacoesSdk.length, 0);
  assert.equal(conectividade.getStatus().online, true);
  assert.equal(disjuntor.escritasDeHoje().ping, 1);
});

test('ping REST sem cota (429): pausa a nuvem e os próximos pings não gastam nada', async () => {
  disjuntor._zerarParaTeste();
  const f = fetchQueResponde(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } });
  licenseService._definirFetchDoPingParaTeste(f);
  gravacoesSdk.length = 0;
  await licenseService.enviarPing();
  assert.equal(disjuntor.status().escritaPausada, true);
  assert.equal(conectividade.getStatus().online, true, 'a internet está boa, quem parou foi a cota');
  await licenseService.enviarPing();
  await licenseService.enviarPing();
  assert.equal(f.chamadas.length, 1, 'sem sonda antes de 10 min');
  assert.equal(gravacoesSdk.length, 0, 'nada vai para a fila presa do SDK');
});

test('ping REST sem rede: cai para o SDK, e nunca empilha mais de um ping preso', async () => {
  disjuntor._zerarParaTeste();
  licenseService._definirFetchDoPingParaTeste(async () => { throw new Error('ENOTFOUND'); });
  gravacoesSdk.length = 0;
  sdkTrava = false;
  await licenseService.enviarPing();
  assert.equal(gravacoesSdk.length, 1);
  assert.equal(gravacoesSdk[0].dados.ultimoPing, 'TS');
  assert.deepEqual(gravacoesSdk[0].opcoes, { merge: true });

  sdkTrava = true; // SDK sem resposta (fila presa)
  const primeiro = licenseService.enviarPing();
  await new Promise((r) => setImmediate(r));
  await licenseService.enviarPing(); // enquanto o primeiro está preso
  assert.equal(gravacoesSdk.length, 2, 'o segundo não entrou na fila do SDK');
  assert.equal(conectividade.getStatus().online, false);
  primeiro.catch(() => {});
  sdkTrava = false;
});
