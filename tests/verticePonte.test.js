const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Ponte senhas -> Vértice (src/integrations/vertice/ponteSenhas.js): manda só
// o que mudou, no formato do módulo do Vértice ({ id, number, customerName }).
const ponte = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'integrations', 'vertice', 'ponteSenhas.js')).href);
const config = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'integrations', 'vertice', 'verticeConfig.js')).href);

const lista = {
  preparando: [{ id: 's43', numero: 43, nome: 'Bruno', criadoEm: '2026-11-07 12:00:00' }],
  prontas: [{ id: 's42', numero: 42, nome: 'Ana' }],
  entregues: [{ id: 's41', numero: 41, nome: null }],
  canceladas: ['s40', 's39'],
};

test('Vértice: primeira sincronização manda tudo; depois só o que mudou', async () => {
  const { acoesParaVertice } = await ponte();
  const enviados = new Map();
  const a1 = acoesParaVertice(lista, enviados);
  assert.deepEqual(a1.map((a) => [a.tipo, a.venda.id]), [['preparing', 's43'], ['ready', 's42'], ['delivered', 's41']]);
  assert.deepEqual(a1[0].venda, { id: 's43', number: 43, customerName: 'Bruno', createdAt: '2026-11-07T12:00:00Z' });
  for (const a of a1) enviados.set(a.venda.id, a.tipo);
  assert.deepEqual(acoesParaVertice(lista, enviados), [], 'nada mudou, nada vai');
  // 43 ficou pronta; 40 tinha sido enviada e foi cancelada (39 nunca foi: não apaga à toa).
  enviados.set('s40', 'preparing');
  const a2 = acoesParaVertice({ ...lista, preparando: [], prontas: [...lista.prontas, lista.preparando[0]] }, enviados);
  assert.deepEqual(a2.map((a) => [a.tipo, a.venda.id]), [['ready', 's43'], ['cancelled', 's40']]);
});

test('Vértice: integração só liga com o projeto do Vértice configurado', async () => {
  const { verticeConfigurado } = await config();
  assert.equal(verticeConfigurado({ apiKey: '', projectId: '', appId: '' }), false);
  assert.equal(verticeConfigurado({ apiKey: 'k', projectId: 'vertice-xxxx', appId: '1:2:web:3' }), false, 'placeholder do .env.example');
  assert.equal(verticeConfigurado({ apiKey: 'k', projectId: 'vertice-vetta', appId: '1:2:web:3' }), true);
});
