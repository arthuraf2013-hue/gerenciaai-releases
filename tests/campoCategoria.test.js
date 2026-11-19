const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Campo de categoria do cadastro de produto (src/components/common/CampoCategoria.jsx):
// a busca e a escolha da categoria existente ficam em src/utils/categorias.js.
const util = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'utils', 'categorias.js')).href);

const CATS = [
  { nome: 'Bebidas', totalProdutos: 12 },
  { nome: 'Açaí', totalProdutos: 3 },
  { nome: 'Bebidas quentes', totalProdutos: 0 },
  { nome: 'Lanches', totalProdutos: 8 },
  { nome: 'Sobremesas', totalProdutos: 1 },
  { nome: '', totalProdutos: 2 },
  null,
];

test('categoria: sem texto mostra todas em ordem alfabética (ignora nome vazio)', async () => {
  const { filtrarCategorias } = await util();
  assert.deepEqual(filtrarCategorias('', CATS).map((c) => c.nome), ['Açaí', 'Bebidas', 'Bebidas quentes', 'Lanches', 'Sobremesas']);
});

test('categoria: busca sem acento e sem maiúscula; começa-com antes de contém', async () => {
  const { filtrarCategorias } = await util();
  assert.deepEqual(filtrarCategorias('acai', CATS).map((c) => c.nome), ['Açaí']);
  assert.deepEqual(filtrarCategorias('  BEB ', CATS).map((c) => c.nome), ['Bebidas', 'Bebidas quentes']);
  // "es" começa nenhuma; contém em Bebidas quentes, Lanches e Sobremesas
  assert.deepEqual(filtrarCategorias('es', CATS).map((c) => c.nome), ['Bebidas quentes', 'Lanches', 'Sobremesas']);
  assert.deepEqual(filtrarCategorias('sobre', [{ nome: 'Tem sobremesa' }, { nome: 'Sobremesas' }]).map((c) => c.nome), ['Sobremesas', 'Tem sobremesa']);
  assert.deepEqual(filtrarCategorias('pizza', CATS), []);
});

test('categoria: "bebidas" é a "Bebidas" que já existe -- não oferece criar repetida', async () => {
  const { categoriaEquivalente, ehCategoriaNova } = await util();
  assert.equal(categoriaEquivalente('bebidas', CATS).nome, 'Bebidas');
  assert.equal(categoriaEquivalente('  ACAÍ ', CATS).nome, 'Açaí');
  assert.equal(categoriaEquivalente('Bebidas  quentes', CATS).nome, 'Bebidas quentes');
  assert.equal(categoriaEquivalente('Bebida', CATS), null);
  assert.equal(ehCategoriaNova('bebidas', CATS), false);
  assert.equal(ehCategoriaNova('Bebida', CATS), true, 'parecida não é igual: pode criar');
  assert.equal(ehCategoriaNova('   ', CATS), false);
  assert.equal(ehCategoriaNova('Pizzas', []), true);
  assert.equal(categoriaEquivalente('x', undefined), null);
});

test('categoria: quantidade de produtos na lista', async () => {
  const { textoQuantidadeProdutos } = await util();
  assert.equal(textoQuantidadeProdutos(0), 'sem produtos');
  assert.equal(textoQuantidadeProdutos(1), '1 produto');
  assert.equal(textoQuantidadeProdutos(12), '12 produtos');
  assert.equal(textoQuantidadeProdutos(undefined), 'sem produtos');
});
