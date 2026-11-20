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
let aoErrar = null;
let escutasAbertas = 0;
let snapDoGetDoc = null;
const gravacoes = [];
require.cache[require.resolve('firebase/firestore')] = {
  id: 'firebase/firestore', loaded: true,
  exports: {
    getFirestore: () => ({}),
    doc: (_db, col, id) => `${col}/${id}`,
    serverTimestamp: () => 'TS',
    onSnapshot: (ref, ok, erro) => { if (String(ref).startsWith('installations/')) { aoMudar = ok; aoErrar = erro; escutasAbertas++; } return () => {}; },
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
let ultimoPushHistorico = null;
require('../electron/services/salesSyncService').pushTodoOHistorico = async (op) => { efeitos.historico++; ultimoPushHistorico = op || {}; return true; };
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

// ------------------------------------------------------------------
// Grupo que sumiu daqui volta sozinho (sem Firebase), pelo rastro local.

const { getDb } = require('../electron/db/database');
const sumirGrupo = () => getDb().prepare(`UPDATE sync_state SET grupo_sincronizacao_id = NULL, servidor_do_grupo = 0 WHERE id = 'default'`).run();
const estado = () => getDb().prepare(`SELECT * FROM sync_state WHERE id = 'default'`).get();

test('grupo apagado pelo bug antigo volta ao abrir: caixa pareado pela rede local', () => {
  freshTestDb();
  getDb().prepare(`INSERT INTO lan_cliente (id, grupo_id, hub_install_id, hub_nome, chave, enderecos) VALUES ('default', 'grupo-loja-1', 'hub-1', 'PDV1', 'k', '[]')`).run();
  assert.equal(syncState.getGrupoSincronizacaoId(), null);
  const r = syncState.recuperarGrupoLocal();
  assert.equal(r.origem, 'rede_local_caixa');
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-loja-1');
  assert.equal(syncState.ehServidorDoGrupo(), false);
  assert.equal(estado().grupo_recuperado, 1);
});

test('servidor da loja: volta como servidor (rastro do hub)', () => {
  freshTestDb();
  getDb().prepare(`INSERT INTO lan_meta (chave, valor) VALUES ('hub_grupo', 'grupo-loja-1')`).run();
  syncState.recuperarGrupoLocal();
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-loja-1');
  assert.equal(syncState.ehServidorDoGrupo(), true);
});

test('sem rede local: volta pelo catálogo já casado com o grupo', () => {
  freshTestDb();
  const ins = getDb().prepare(`INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id) VALUES ('produtos', ?, ?, ?)`);
  ins.run('p1', 'grupo-velho-9', 'd1');
  ins.run('p1', 'grupo-loja-1', 'd2'); ins.run('p2', 'grupo-loja-1', 'd3');
  assert.equal(syncState.recuperarGrupoLocal().grupoId, 'grupo-loja-1');
});

test('último grupo confirmado pela Central vale primeiro; tirada de propósito pela Central não volta', () => {
  comecarNoGrupo(); // Central confirmou grupo-A, servidor
  getDb().prepare(`INSERT INTO lan_cliente (id, grupo_id, hub_install_id, hub_nome, chave, enderecos) VALUES ('default', 'outro-grupo', 'h', 'x', 'k', '[]')`).run();
  sumirGrupo();
  syncState.recuperarGrupoLocal();
  assert.equal(syncState.getGrupoSincronizacaoId(), 'grupo-A');
  assert.equal(syncState.ehServidorDoGrupo(), true);

  // Central desvinculou: não volta mais sozinha
  syncState.aplicarGrupoDaInstalacao({ grupoSincronizacaoId: null, servidorDoGrupo: false });
  assert.equal(syncState.recuperarGrupoLocal(), null);
  assert.equal(syncState.getGrupoSincronizacaoId(), null);
});

test('sem rastro nenhum: continua sem grupo (precisa da Central)', () => {
  freshTestDb();
  assert.equal(syncState.recuperarGrupoLocal(), null);
  assert.equal(syncState.getGrupoSincronizacaoId(), null);
});

test('voltar ao MESMO grupo não reenvia todo o histórico, só o que falta', () => {
  comecarNoGrupo();
  sumirGrupo();
  syncState.aplicarGrupoDaInstalacao(DOC_COMPLETO);
  assert.equal(efeitos.historico, 1);
  assert.equal(ultimoPushHistorico.apenasPendentes, true);
  // Grupo novo de verdade: manda tudo
  syncState.aplicarGrupoDaInstalacao({ grupoSincronizacaoId: 'grupo-Z', servidorDoGrupo: false });
  assert.notEqual(ultimoPushHistorico.apenasPendentes, true);
});

test('escuta da instalação que dá erro (sem cota) religa sozinha', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  freshTestDb();
  licenseService.iniciarEscutaTempoReal();
  const antes = escutasAbertas;
  aoErrar({ code: 'resource-exhausted', message: 'Quota exceeded.' });
  t.mock.timers.tick(29 * 60 * 1000);
  assert.equal(escutasAbertas, antes, 'sem cota: espera 30 min');
  t.mock.timers.tick(60 * 1000);
  assert.equal(escutasAbertas, antes + 1, 'religou');
  aoErrar({ code: 'unavailable', message: 'offline' });
  t.mock.timers.tick(2 * 60 * 1000);
  assert.equal(escutasAbertas, antes + 2, 'erro comum: religa em 2 min');
});
