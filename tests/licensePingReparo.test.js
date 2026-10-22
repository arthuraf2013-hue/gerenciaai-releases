const test = require('node:test');
const assert = require('node:assert/strict');

// O ping de presença (a cada 2 min) leva installations/{id}.reparo, mas só
// quando a prontidão do reparo MUDA -- senão seria uma escrita maior a cada
// ping de cada máquina. Firestore falso via require.cache.
const gravacoes = [];
let falharGravacao = false;
require.cache[require.resolve('firebase/firestore')] = {
  id: 'firebase/firestore', loaded: true,
  exports: {
    getFirestore: () => ({}),
    doc: (_db, col, id) => `${col}/${id}`,
    serverTimestamp: () => 'TS',
    setDoc: async (ref, dados, opcoes) => {
      if (falharGravacao) throw new Error('offline');
      gravacoes.push({ ref, dados, opcoes });
    },
  },
};
const pdvRegistryService = require('../electron/services/pdvRegistryService');
pdvRegistryService.getOrCreateDeviceUid = () => 'maquina-teste-1';
const reparo = require('../electron/services/reparoInstalacaoService');
const licenseService = require('../electron/services/licenseService');

test('ping manda o reparo só quando muda, e reenvia se a gravação falhou', async () => {
  let resumo = null;
  reparo.resumoParaCentral = () => resumo;

  await licenseService.enviarPing();
  assert.equal(gravacoes.at(-1).ref, 'installations/maquina-teste-1');
  assert.equal('reparo' in gravacoes.at(-1).dados, false); // sem prontidão (não é Windows instalado): não manda

  resumo = { pronto: false, problema: 'sem_copia' };
  await licenseService.enviarPing();
  assert.deepEqual(gravacoes.at(-1).dados.reparo, { pronto: false, problema: 'sem_copia', atualizadoEm: 'TS' });
  assert.deepEqual(gravacoes.at(-1).opcoes, { merge: true });

  await licenseService.enviarPing();
  assert.equal('reparo' in gravacoes.at(-1).dados, false); // igual ao último enviado

  resumo = { pronto: true, problema: null };
  falharGravacao = true;
  await licenseService.enviarPing(); // sem internet: não conta como enviado
  falharGravacao = false;
  await licenseService.enviarPing();
  assert.equal(gravacoes.at(-1).dados.reparo.pronto, true);
});
