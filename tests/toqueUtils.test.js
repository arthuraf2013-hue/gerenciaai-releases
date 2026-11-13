const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

// src/utils/toque.js é ESM (renderer); empacota para CJS só no teste.
function carregar() {
  const r = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/utils/toque.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node',
  });
  const m = { exports: {} };
  new Function('module', 'exports', r.outputFiles[0].text)(m, m.exports);
  return m.exports;
}
const T = carregar();

function memoria() {
  const d = {};
  return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } };
}

test('modo toque: padrão auto, grava só valor conhecido, auto segue o ponteiro', () => {
  const m = memoria();
  assert.equal(T.lerModoToque(m), 'auto');
  T.gravarModoToque('sim', m);
  assert.equal(T.lerModoToque(m), 'sim');
  T.gravarModoToque('talvez', m);
  assert.equal(T.lerModoToque(m), 'sim');
  assert.equal(T.lerModoToque({ getItem: () => { throw new Error('bloqueado'); } }), 'auto');
  assert.equal(T.toqueAtivo('auto', true), true);
  assert.equal(T.toqueAtivo('auto', false), false);
  assert.equal(T.toqueAtivo('sim', false), true);
  assert.equal(T.toqueAtivo('nao', true), false);
});

test('teclado: primeiro número troca o valor que já estava no campo', () => {
  let e = T.iniciarTeclado('45.9');
  assert.deepEqual(e, { texto: '45,9', substituir: true });
  e = T.aplicarTecla(e, '5', { decimal: true });
  assert.deepEqual(e, { texto: '5', substituir: false });
  e = T.aplicarTecla(e, '0', { decimal: true });
  assert.equal(e.texto, '50');
  // Apagar logo ao abrir limpa tudo (não tira só o último dígito do valor velho).
  assert.equal(T.aplicarTecla(T.iniciarTeclado('12'), 'apagar').texto, '');
  assert.equal(T.iniciarTeclado('1.234,56').texto, '1.234,56');
  assert.deepEqual(T.iniciarTeclado(''), { texto: '', substituir: false });
});

test('teclado: vírgula, duas casas, zero à esquerda, limite e inteiro', () => {
  const dec = { decimal: true };
  let e = { texto: '', substituir: false };
  e = T.aplicarTecla(e, ',', dec);
  assert.equal(e.texto, '0,');
  e = T.aplicarTecla(e, ',', dec);
  assert.equal(e.texto, '0,', 'segunda vírgula é ignorada');
  for (const t of ['5', '0', '9']) e = T.aplicarTecla(e, t, dec);
  assert.equal(e.texto, '0,50', 'terceira casa decimal é ignorada');
  let kg = { texto: '0,', substituir: false };
  for (const t of ['3', '5', '0', '1']) kg = T.aplicarTecla(kg, t, { decimal: true, casas: 3 });
  assert.equal(kg.texto, '0,350', 'peso em kg vai até 3 casas');
  assert.equal(T.aplicarTecla({ texto: '0', substituir: false }, '7', dec).texto, '7');
  assert.equal(T.aplicarTecla({ texto: '0', substituir: false }, '7', {}).texto, '07', 'PIN pode começar com zero');
  assert.equal(T.aplicarTecla({ texto: '12', substituir: false }, ',', {}).texto, '12', 'campo inteiro sem vírgula');
  assert.equal(T.aplicarTecla({ texto: '1234', substituir: false }, '5', { maxLength: 4 }).texto, '1234');
  assert.equal(T.aplicarTecla({ texto: '12', substituir: false }, 'limpar').texto, '');
  assert.equal(T.aplicarTecla({ texto: '12', substituir: false }, 'apagar').texto, '1');
  assert.equal(T.aplicarTecla({ texto: '', substituir: true }, ',', dec).texto, '0,');
});

test('valor que vai para o campo: type=number usa ponto e não leva vírgula solta', () => {
  assert.equal(T.valorParaCampo('12,', 'number'), '12');
  assert.equal(T.valorParaCampo('12,5', 'number'), '12.5');
  assert.equal(T.valorParaCampo('0,', 'number'), '0');
  assert.equal(T.valorParaCampo('12,5', 'text'), '12,5');
  assert.equal(T.valorParaCampo('0042', 'password'), '0042');
});

test('quais campos ganham o teclado', () => {
  const base = { tag: 'INPUT', readOnly: false, disabled: false };
  assert.deepEqual(T.campoNumerico({ ...base, type: 'number', step: '0.01' }), { decimal: true, casas: 2 });
  assert.deepEqual(T.campoNumerico({ ...base, type: 'number', step: '0.001' }), { decimal: true, casas: 3 });
  assert.deepEqual(T.campoNumerico({ ...base, type: 'number', step: null }), { decimal: false });
  assert.deepEqual(T.campoNumerico({ ...base, type: 'number', step: '1' }), { decimal: false });
  assert.deepEqual(T.campoNumerico({ ...base, type: 'number', step: 'any' }), { decimal: true, casas: 3 });
  assert.deepEqual(T.campoNumerico({ ...base, type: 'password', inputMode: 'numeric' }), { decimal: false });
  assert.deepEqual(T.campoNumerico({ ...base, type: 'text', inputMode: 'decimal' }), { decimal: true, casas: 3 });
  assert.equal(T.campoNumerico({ ...base, type: 'text', inputMode: null }), null, 'texto comum usa o teclado do Windows');
  assert.equal(T.campoNumerico({ ...base, type: 'date' }), null);
  assert.equal(T.campoNumerico({ ...base, type: 'number', readOnly: true }), null);
  assert.equal(T.campoNumerico({ ...base, type: 'number', disabled: true }), null);
  assert.equal(T.campoNumerico({ ...base, tag: 'TEXTAREA', type: 'textarea' }), null);
});
