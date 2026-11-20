const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const svc = require('../electron/services/servidorDoGrupoService');

// Escolher no app qual computador é o servidor do grupo (conta da Central).
const MAQUINAS = [
  { id: 'pdv1', nome: 'PDV1-SERVIDOR', servidor: true, estaMaquina: false },
  { id: 'pdv2', nome: 'PDV2', servidor: false, estaMaquina: true },
  { id: 'pdv3', nome: 'PDV3', servidor: false, estaMaquina: false },
];

function comLista(maquinas, fn) {
  const o = svc.listarMaquinas;
  svc.listarMaquinas = async () => ({ ok: true, grupoId: 'g1', maquinas });
  return Promise.resolve(fn()).finally(() => { svc.listarMaquinas = o; svc._definirBackendParaTeste(null); });
}

test('planejar: desmarca o servidor atual e marca o escolhido; recusa quem já é ou não é do grupo', () => {
  const p = svc.planejarTroca(MAQUINAS, 'pdv2');
  assert.equal(p.ok, true);
  assert.equal(p.alvo.id, 'pdv2');
  assert.deepEqual(p.desmarcar.map((m) => m.id), ['pdv1']);
  assert.match(svc.planejarTroca(MAQUINAS, 'pdv1').error, /já é o servidor/);
  assert.match(svc.planejarTroca(MAQUINAS, 'outro').error, /não está neste grupo/);
});

test('só admin e suporte trocam o servidor, e precisam da conta da Central', async () => {
  const { operadorId, adminId } = freshTestDb();
  assert.equal((await svc.escolherServidor({ solicitanteId: operadorId, instalacaoId: 'pdv2', email: 'a@b', senha: 'x' })).ok, false);
  assert.match((await svc.escolherServidor({ solicitanteId: adminId, instalacaoId: 'pdv2' })).error, /e-mail e a senha da Central/);
});

test('troca: grava o lote com a conta da Central e registra na Auditoria', async () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  let gravado = null;
  await comLista(MAQUINAS, async () => {
    svc._definirBackendParaTeste(async (args) => { gravado = args; });
    const r = await svc.escolherServidor({ solicitanteId: suporteId, instalacaoId: 'pdv2', email: ' central@vetta.com ', senha: 's3nha' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.servidor, 'PDV2');
    assert.deepEqual(r.antes, ['PDV1-SERVIDOR']);
  });
  assert.deepEqual(gravado, { email: ' central@vetta.com ', senha: 's3nha', desmarcar: ['pdv1'], marcar: 'pdv2' });
  const aud = db.prepare("SELECT motivo FROM audit_log WHERE tipo_evento = 'servidor_do_grupo_trocado'").get();
  assert.match(aud.motivo, /PDV2 virou o servidor do grupo \(antes: PDV1-SERVIDOR\)/);
  assert.doesNotMatch(aud.motivo, /s3nha/, 'senha nunca vai para a auditoria');
});

test('senha errada ou conta sem permissão: mensagem clara, nada registrado', async () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  await comLista(MAQUINAS, async () => {
    svc._definirBackendParaTeste(async () => { throw Object.assign(new Error('x'), { code: 'auth/invalid-credential' }); });
    assert.match((await svc.escolherServidor({ solicitanteId: suporteId, instalacaoId: 'pdv3', email: 'a@b', senha: 'x' })).error, /incorretos/);
  });
  await comLista(MAQUINAS, async () => {
    svc._definirBackendParaTeste(async () => { throw Object.assign(new Error('x'), { code: 'permission-denied' }); });
    assert.match((await svc.escolherServidor({ solicitanteId: suporteId, instalacaoId: 'pdv3', email: 'a@b', senha: 'x' })).error, /não é administradora/);
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tipo_evento = 'servidor_do_grupo_trocado'").get().c, 0);
});
