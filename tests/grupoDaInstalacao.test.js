const test = require('node:test');
const assert = require('node:assert/strict');

// O grupo de sincronização desta máquina vem do documento da instalação
// (Central). Sem chegar à nuvem, o SDK do Firebase mostra um documento "de
// mentira" só com os campos que o ping gravou (testado no SDK de verdade:
// disableNetwork + setDoc merge -> onSnapshot e getDoc devolvem
// { ultimoPing, versaoApp }, fromCache=true). Isso tirava a máquina do grupo
// ("Sincronização não configurada") e, quando o documento de verdade
// voltava, ela entrava de novo relendo o catálogo e reenviando todo o
// histórico de vendas.

let aoMudar = null;
let snapDoGetDoc = null;
const gravacoes = [];
require.cache[require.resolve('firebase/firestore')] = {
  id: 'firebase/firestore', loaded: true,
  exports: {
    getFirestore: () => ({}),
    doc: (_db, col, id) => `${col}/${id}`,
    serverTimestamp: () => 'TS',
    onSnapshot: (ref, ok) => { if (String(ref).startsWith('installations/')) aoMudar = ok; return () => {}; },
    getDoc: async () => snapDoGetDoc,
    setDoc: async (ref, dados, opcoes) => { gravacoes.push({ ref, dados, opcoes }); },
  },
};

require.cache[require.resolve('electron')] = {
  id: 'electron', loaded: true, exports: { app: { getVersion: () => '1.0.33', getPath: () => require('os').tmpdir() } },
};
require('../electron/services/testeGratisService').maquinaHash = async () => null;
require('../electron/services/metricsService').getMetricasAgregadas = () => ({});

const { freshTestDb } = require('./helpers/testDb');
const pdvRegistryService = require('../electron/services/pdvRegistryService');
pdvRegistryService.getOrCreateDeviceUid = () => 'maquina-grupo-1';

// Efeitos de entrar/sair do grupo: conta quantas vezes "entrou" de novo.
const efeitos = { religou: 0, historico: 0 };
require('../electron/services/productSyncService').iniciarEscutaProdutos = () => { efeitos.religou++; };
require('../electron/services/salesSyncService').pushTodoOHistorico = async () => { efeitos.historico++; return true; };
require('../electron/services/stockSyncService').pushEstoqueInicial = async () => {};
require('../electron/services/userSyncService').iniciar = () => {};
require('../electron/services/grupoTransporteService').reavaliar = async () => {};

const syncState = require('../electron/services/syncStateService');
const licenseService = require('../electron/services/licenseService');

const DOC_COMPLETO = { ativo: true, bloqueioImediato: false, clienteId: 'cli-1', grupoSincronizacaoId: 'grupo-A', servidorDoGrupo: true };
const snap = (dados, { fromCache = false } = {}) => ({
  exists: () => dados !== null, data: () => dados, metadata: { fromCache, hasPendingWrites: fromCache },
});

function comecarNoGrupo() {
  freshTestDb();
  efeitos.religou = 0; efeitos.historico = 0;
  syncState.aplicarGrupoDaInstalacao(DOC_COMPLETO);
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A');
  efeitos.religou = 0; efeitos.historico = 0;
}

test('documento sem o campo do grupo não tira a máquina do grupo; null da Central tira', () => {
  comecarNoGrupo();
  syncState.aplicarGrupoDaInstalacao({ ultimoPing: 1, versaoApp: '1.0.32' });
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A');
  assert.equal(syncState.ehServidorDoGrupo(), true);
  assert.deepEqual(efeitos, { religou: 0, historico: 0 }, 'nada relido nem reenviado');

  // Só o grupo veio (sem servidorDoGrupo): continua servidor do mesmo grupo
  syncState.aplicarGrupoDaInstalacao({ grupoSincronizacaoId: 'grupo-A' });
  assert.equal(syncState.ehServidorDoGrupo(), true);

  // Central desvinculou (grava null de propósito)
  syncState.aplicarGrupoDaInstalacao({ grupoSincronizacaoId: null, servidorDoGrupo: false });
  assert.equal(syncState.getGrupoSincronizacaoId(), null);
});

test('escuta: o documento "de mentira" do SDK (sem servidor) é ignorado; o do servidor vale', () => {
  comecarNoGrupo();
  licenseService.iniciarEscutaTempoReal();
  assert.equal(typeof aoMudar, 'function');

  aoMudar(snap({ ultimoPing: 1, versaoApp: '1.0.32' }, { fromCache: true }));
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A', 'continua no grupo');
  assert.deepEqual(efeitos, { religou: 0, historico: 0 });

  // O de verdade chega: mesmo grupo, nada relido nem reenviado
  aoMudar(snap({ ...DOC_COMPLETO, ultimoPing: 1 }));
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A');
  assert.deepEqual(efeitos, { religou: 0, historico: 0 });

  // Mudança real da Central chega pela escuta
  aoMudar(snap({ ...DOC_COMPLETO, grupoSincronizacaoId: 'grupo-B', servidorDoGrupo: false }));
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-B');
  assert.equal(syncState.ehServidorDoGrupo(), false);
});

test('checkLicense sem servidor (cópia da memória do SDK): não aplica nem cria documento por cima', async () => {
  comecarNoGrupo();
  gravacoes.length = 0;
  snapDoGetDoc = snap({ ultimoPing: 1 }, { fromCache: true });
  await licenseService.checkLicense();
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A');
  snapDoGetDoc = snap(null, { fromCache: true });
  await licenseService.checkLicense();
  assert.equal(gravacoes.length, 0, 'não recriou o documento da instalação');
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A');
});
