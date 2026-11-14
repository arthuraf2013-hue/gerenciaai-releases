const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const servico = require('../electron/services/tecladoSistemaService');

// src/utils/tecladoSistema.js é ESM (renderer); empacota para CJS só no teste.
function carregar() {
  const r = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/utils/tecladoSistema.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node',
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}
const { campoDeTexto, quantoRolar, toqueDeDedo } = carregar();

function campo(tagName, attrs = {}, extra = {}) {
  return {
    tagName, disabled: false, readOnly: false, dataset: {}, isContentEditable: false,
    type: attrs.type || 'text',
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    ...extra,
  };
}

test('campo de texto chama o teclado do Windows; número, PIN e botão não', () => {
  assert.equal(campoDeTexto(campo('INPUT')), true);
  assert.equal(campoDeTexto(campo('INPUT', { type: 'email' })), true);
  assert.equal(campoDeTexto(campo('INPUT', { type: 'search' })), true);
  assert.equal(campoDeTexto(campo('TEXTAREA')), true);
  assert.equal(campoDeTexto(campo('DIV', {}, { isContentEditable: true })), true);
  // números: o nosso teclado numérico
  assert.equal(campoDeTexto(campo('INPUT', { type: 'number' })), false);
  assert.equal(campoDeTexto(campo('INPUT', { type: 'text', inputmode: 'decimal' })), false);
  assert.equal(campoDeTexto(campo('INPUT', { type: 'password', inputmode: 'numeric' })), false);
  assert.equal(campoDeTexto(campo('INPUT', { type: 'tel' })), false);
  // já tem teclado na tela / pediu para não ter
  assert.equal(campoDeTexto(campo('INPUT', { inputmode: 'none' })), false);
  assert.equal(campoDeTexto(campo('INPUT', {}, { dataset: { semTeclado: '' } })), false);
  // não dá para digitar
  assert.equal(campoDeTexto(campo('INPUT', {}, { readOnly: true })), false);
  assert.equal(campoDeTexto(campo('INPUT', {}, { disabled: true })), false);
  assert.equal(campoDeTexto(campo('INPUT', { type: 'checkbox' })), false);
  assert.equal(campoDeTexto(campo('SELECT')), false);
  assert.equal(campoDeTexto(campo('BUTTON')), false);
  assert.equal(campoDeTexto(null), false);
});

test('só dedo ou caneta chamam o teclado; mouse não', () => {
  assert.equal(toqueDeDedo('touch'), true);
  assert.equal(toqueDeDedo('pen'), true);
  assert.equal(toqueDeDedo('mouse'), false);
});

test('rola o campo só o necessário para sair de baixo do teclado', () => {
  // janela 690 de altura, teclado cobre 300 embaixo: visível até 390 (-16 de folga = 374)
  assert.equal(quantoRolar({ top: 100, bottom: 140 }, 690, 300), 0);
  assert.equal(quantoRolar({ top: 500, bottom: 540 }, 690, 300), 166);
  assert.equal(quantoRolar({ top: 500, bottom: 540 }, 690, 0), 0);
  // campo alto: não rola a ponto de sumir o topo dele
  assert.equal(quantoRolar({ top: 60, bottom: 600 }, 690, 300), 44);
});

test('lê a posição do teclado que o Windows devolve', () => {
  assert.deepEqual(servico.lerArea('R 0,478,1024,768'), { x: 0, y: 478, width: 1024, height: 290 });
  assert.deepEqual(servico.lerArea('R 0,0,0,0'), { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(servico.lerArea('R '), null);
  assert.equal(servico.lerArea('lixo'), null);
});

test('quanto da janela o teclado cobre', () => {
  const janela = { x: 0, y: 31, width: 1024, height: 689 }; // 1024x768 maximizada
  assert.equal(servico.alturaCoberta(janela, { x: 0, y: 478, width: 1024, height: 290 }), 242);
  assert.equal(servico.alturaCoberta(janela, { x: 0, y: 0, width: 0, height: 0 }), 0);
  // teclado em outro monitor
  assert.equal(servico.alturaCoberta(janela, { x: 1100, y: 478, width: 800, height: 290 }), 0);
  // teclado flutuando no meio: tudo dali para baixo conta como coberto
  assert.equal(servico.alturaCoberta(janela, { x: 300, y: 400, width: 400, height: 200 }), 320);
});

test('fora do Windows não faz nada (e ação desconhecida é recusada)', async () => {
  if (process.platform !== 'win32') {
    assert.deepEqual(await servico.executar('mostrar', '/tmp'), { ok: true, suportado: false, area: null });
  }
  assert.equal((await servico.executar('rm -rf', '/tmp')).ok, false);
});

test('o script do PowerShell é só ASCII e conhece as três ações', () => {
  assert.equal(/^[\x00-\x7f]*$/.test(servico.SCRIPT), true);
  for (const acao of ["'mostrar'", "'esconder'", "'sair'"]) assert.ok(servico.SCRIPT.includes(acao), acao);
  assert.ok(!servico.SCRIPT.includes('${'), 'nada interpolado do JS dentro do script');
});
