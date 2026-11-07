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
  for (const a of a1) enviados.set(a.venda.id, a.chave);
  assert.deepEqual(acoesParaVertice(lista, enviados), [], 'nada mudou, nada vai');
  // 43 ficou pronta; 40 tinha sido enviada e foi cancelada (39 nunca foi: não apaga à toa).
  enviados.set('s40', 'preparing');
  const a2 = acoesParaVertice({ ...lista, preparando: [], prontas: [...lista.prontas, lista.preparando[0]] }, enviados);
  assert.deepEqual(a2.map((a) => [a.tipo, a.venda.id]), [['ready', 's43'], ['cancelled', 's40']]);
});

test('Vértice: senha chamada de novo é reenviada (a TV repete o aviso)', async () => {
  const { acoesParaVertice } = await ponte();
  const enviados = new Map();
  const chamada1 = { prontas: [{ id: 's42', numero: 42, nome: 'Ana', chamadoEm: '2026-11-07 12:00:00', vezesChamada: 1 }] };
  const a1 = acoesParaVertice(chamada1, enviados);
  assert.deepEqual(a1.map((a) => a.tipo), ['ready']);
  enviados.set('s42', a1[0].chave);
  assert.deepEqual(acoesParaVertice(chamada1, enviados), [], 'mesma chamada, nada vai de novo');
  const chamada2 = { prontas: [{ id: 's42', numero: 42, nome: 'Ana', chamadoEm: '2026-11-07 12:20:00', vezesChamada: 2 }] };
  const a2 = acoesParaVertice(chamada2, enviados);
  assert.deepEqual(a2.map((a) => [a.tipo, a.venda.id]), [['ready', 's42']], 'chamou de novo: manda de novo');
  // A hora da chamada vai junto: a TV repete o aviso só quando ela muda.
  assert.equal(a1[0].venda.readyAt, '2026-11-07T12:00:00.001Z');
  assert.equal(a2[0].venda.readyAt, '2026-11-07T12:20:00.002Z');
  // App reaberto (cache vazio): reenvia a MESMA hora -- a TV não anuncia de novo.
  assert.equal(acoesParaVertice(chamada2, new Map())[0].venda.readyAt, '2026-11-07T12:20:00.002Z');
});

test('Vértice: "De novo" apertado duas vezes no mesmo segundo ainda conta como duas chamadas', async () => {
  const { acoesParaVertice } = await ponte();
  const enviados = new Map();
  const vez = (n) => ({ prontas: [{ id: 's7', numero: 7, chamadoEm: '2026-11-07 19:05:10', vezesChamada: n }] });
  const a1 = acoesParaVertice(vez(3), enviados);
  enviados.set('s7', a1[0].chave);
  const a2 = acoesParaVertice(vez(4), enviados);
  assert.equal(a2.length, 1, 'a segunda chamada vai para o Vértice');
  assert.notEqual(a2[0].venda.readyAt, a1[0].venda.readyAt, 'e com outra hora: a TV avisa de novo');
});

test('Vértice: módulo usa a hora da chamada no readyAt (cópia igual à do repositório do Vértice)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'integrations', 'vertice', 'verticeSync.js'), 'utf8');
  assert.match(src, /readyAt: horaDe\(sale\.readyAt\) \|\| serverTimestamp\(\)/);
});

test('Vértice: integração só liga com o projeto do Vértice configurado', async () => {
  const { verticeConfigurado } = await config();
  assert.equal(verticeConfigurado({ apiKey: '', projectId: '', appId: '' }), false);
  assert.equal(verticeConfigurado({ apiKey: 'k', projectId: 'vertice-xxxx', appId: '1:2:web:3' }), false, 'placeholder do .env.example');
  assert.equal(verticeConfigurado({ apiKey: 'k', projectId: 'vertice-vetta', appId: '1:2:web:3' }), true);
});
