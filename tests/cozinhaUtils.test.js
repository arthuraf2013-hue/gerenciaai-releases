// Contas da cozinha (src/utils/cozinha.js, ESM do renderer): empacota com o
// esbuild do projeto para rodar aqui no node.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildSync } = require('esbuild');

const saida = buildSync({
  entryPoints: [path.join(__dirname, '../src/utils/cozinha.js')],
  bundle: true, format: 'cjs', platform: 'node', write: false,
});
const m = { exports: {} };
new Function('module', 'exports', 'require', saida.outputFiles[0].text)(m, m.exports, require);
const c = m.exports;

test('converte entre unidades da mesma família e recusa famílias diferentes', () => {
  assert.equal(c.converter(150, 'g', 'kg'), 0.15);
  assert.equal(c.converter(1.5, 'l', 'ml'), 1500);
  assert.equal(c.converter(2, 'un', 'un'), 2);
  assert.ok(Number.isNaN(c.converter(1, 'kg', 'l')));
  assert.ok(Number.isNaN(c.converter(1, 'un', 'g')));
  assert.deepEqual(c.unidadesCompativeis('kg'), ['g', 'kg']);
  assert.deepEqual(c.unidadesCompativeis('ml'), ['ml', 'l']);
  assert.deepEqual(c.unidadesCompativeis('un'), ['un']);
});

test('custo por unidade a partir do preço da embalagem', () => {
  assert.equal(c.custoPorUnidade({ valorPago: 25.9, quantidade: 5, unidadeComprada: 'kg', unidadeBase: 'kg' }), 5.18);
  // Comprou 500 g de um insumo controlado em kg: R$ 40 / 0,5 kg = R$ 80/kg.
  assert.equal(c.custoPorUnidade({ valorPago: 40, quantidade: 500, unidadeComprada: 'g', unidadeBase: 'kg' }), 80);
  assert.equal(c.custoPorUnidade({ valorPago: 10, quantidade: 0, unidadeBase: 'kg' }), null);
});

test('ficha técnica: receita inteira em g vira quantidade por porção em kg, e volta igual', () => {
  // Panela de arroz: 2 kg rende 10 porções → 0,2 kg por porção.
  assert.equal(c.quantidadePorPorcao({ quantidade: 2, unidade: 'kg', unidadeBase: 'kg', rendimento: 10 }), 0.2);
  assert.equal(c.quantidadePorPorcao({ quantidade: 150, unidade: 'g', unidadeBase: 'kg' }), 0.15);
  assert.equal(c.quantidadePorPorcao({ quantidade: '', unidade: 'g', unidadeBase: 'kg' }), null);
  assert.deepEqual(c.linhaParaTela({ quantidadePorPorcao: 0.15, unidadeBase: 'kg' }), { quantidade: 150, unidade: 'g' });
  assert.deepEqual(c.linhaParaTela({ quantidadePorPorcao: 0.2, unidadeBase: 'kg', rendimento: 10 }), { quantidade: 2, unidade: 'kg' });
  assert.deepEqual(c.linhaParaTela({ quantidadePorPorcao: 0.5, unidadeBase: 'un', rendimento: 8 }), { quantidade: 4, unidade: 'un' });
});

test('custo da porção, CMV e preço sugerido', () => {
  const linhas = [
    { quantidade: 150, unidade: 'g', unidadeBase: 'kg', custoUnitario: 6 }, // 0,90
    { quantidade: 0.25, unidade: 'kg', unidadeBase: 'kg', custoUnitario: 20 }, // 5,00
    { quantidade: '', unidade: 'g', unidadeBase: 'kg', custoUnitario: 99 }, // linha vazia: ignora
  ];
  assert.equal(c.custoDaPorcao(linhas), 5.9);
  assert.equal(c.custoDaPorcao(linhas, 2), 2.95);
  assert.deepEqual(c.avaliarCmv(9, 30), { percentual: 30, faixa: 'bom', lucro: 21 });
  assert.equal(c.avaliarCmv(11, 30).faixa, 'atencao');
  assert.equal(c.avaliarCmv(15, 30).faixa, 'alto');
  assert.equal(c.avaliarCmv(0, 30), null);
  assert.equal(c.precoSugerido(9, 30), 30.9); // 30,00 → termina em ,90 sem baixar
  assert.equal(c.precoSugerido(8.1, 30), 27.9); // 27,00 → 27,90
  assert.equal(c.precoSugerido(8.97, 30), 29.9); // 29,90 exato
  assert.equal(c.precoSugerido(0, 30), null);
});

test('situação do estoque, formatação e leitura de número brasileiro', () => {
  assert.equal(c.situacaoEstoque({ estoque_atual: 0, estoque_minimo: 2 }), 'sem');
  assert.equal(c.situacaoEstoque({ estoque_atual: 2, estoque_minimo: 2 }), 'acabando');
  assert.equal(c.situacaoEstoque({ estoque_atual: 5, estoque_minimo: 0 }), 'ok');
  assert.equal(c.formatarQuantidade(1.5, 'kg'), '1,5 kg');
  assert.equal(c.lerNumero('1,5'), 1.5);
  assert.equal(c.lerNumero('1.234,56'), 1234.56);
  assert.equal(c.lerNumero('2.5'), 2.5);
  assert.ok(Number.isNaN(c.lerNumero('abc')));
});
