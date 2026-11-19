const test = require('node:test');
const assert = require('node:assert/strict');
const rest = require('../electron/services/firestoreRestService');

const A = rest.AGORA_NO_SERVIDOR;

// Formato conferido também contra o emulador do Firestore com as regras do
// repositório (merge campo a campo, hora do servidor dentro de mapa).
test('merge pela REST: máscara com os campos folha e hora do servidor como transformação', () => {
  const e = rest.montarEscritaMesclada('projects/p/databases/(default)/documents/installations/x', {
    ultimoPing: A,
    saude: { pendenciasAltas: 1, pendencias: [{ id: 'a', quantidade: 2 }], atualizadoEm: A },
    nuvem: { escritasHoje: [], ultimaFaltaDeCotaEm: null },
    'campo-estranho': 1.5,
  });
  assert.deepEqual(e.updateMask.fieldPaths.sort(), ['`campo-estranho`', 'nuvem.escritasHoje', 'nuvem.ultimaFaltaDeCotaEm', 'saude.pendencias', 'saude.pendenciasAltas'].sort());
  assert.deepEqual(e.updateTransforms, [
    { fieldPath: 'ultimoPing', setToServerValue: 'REQUEST_TIME' },
    { fieldPath: 'saude.atualizadoEm', setToServerValue: 'REQUEST_TIME' },
  ]);
  assert.equal(e.update.fields.ultimoPing, undefined);
  assert.deepEqual(e.update.fields.saude.mapValue.fields.pendenciasAltas, { integerValue: '1' });
  assert.deepEqual(e.update.fields['campo-estranho'], { doubleValue: 1.5 });
  assert.deepEqual(e.update.fields.nuvem.mapValue.fields.ultimaFaltaDeCotaEm, { nullValue: null });
});

function respostaFalsa(status, corpo) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });
}

test('REST diz claramente o motivo: sem cota, sem documento, sem permissão, sem rede', async () => {
  const base = { projeto: 'p', apiKey: 'k', caminho: 'installations/x', dados: { ultimoPing: A } };
  assert.deepEqual(await rest.mesclar({ ...base, fetch: respostaFalsa(200, {}) }), { ok: true });
  assert.equal((await rest.mesclar({ ...base, fetch: respostaFalsa(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }) })).motivo, 'sem-cota');
  assert.equal((await rest.mesclar({ ...base, fetch: respostaFalsa(404, { error: { status: 'NOT_FOUND' } }) })).motivo, 'sem-documento');
  assert.equal((await rest.mesclar({ ...base, fetch: respostaFalsa(403, { error: { status: 'PERMISSION_DENIED' } }) })).motivo, 'sem-permissao');
  assert.equal((await rest.mesclar({ ...base, fetch: respostaFalsa(400, { error: { status: 'INVALID_ARGUMENT' } }) })).motivo, 'pedido-invalido');
  assert.equal((await rest.mesclar({ ...base, fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } })).motivo, 'sem-rede');
});

test('REST nunca fica presa: desiste no prazo', async () => {
  const vivo = setInterval(() => {}, 1000); // o relógio do prazo é unref (não segura o app aberto)
  try {
    const parada = (_url, { signal }) => new Promise((_, rejeitar) => signal.addEventListener('abort', () => rejeitar(new Error('aborted'))));
    const r = await rest.mesclar({ projeto: 'p', apiKey: 'k', caminho: 'installations/x', dados: { a: 1 }, fetch: parada, prazoMs: 30 });
    assert.equal(r.motivo, 'sem-rede');
  } finally {
    clearInterval(vivo);
  }
});

test('REST manda o pedido certo (URL, corpo, documento precisa existir)', async () => {
  let pedido = null;
  await rest.mesclar({
    projeto: 'gerenciaai-licencas', apiKey: 'chave', caminho: 'installations/abc', dados: { ultimoPing: A }, exigirExistente: true,
    fetch: async (url, opcoes) => { pedido = { url, ...opcoes, corpo: JSON.parse(opcoes.body) }; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(pedido.url, 'https://firestore.googleapis.com/v1/projects/gerenciaai-licencas/databases/(default)/documents:commit?key=chave');
  assert.equal(pedido.method, 'POST');
  assert.equal(pedido.corpo.writes[0].update.name, 'projects/gerenciaai-licencas/databases/(default)/documents/installations/abc');
  assert.deepEqual(pedido.corpo.writes[0].currentDocument, { exists: true });
});
