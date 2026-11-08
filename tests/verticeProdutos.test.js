const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Ponte produtos -> Price do Vértice (src/integrations/vertice/ponteProdutos.js).
const ponte = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'integrations', 'vertice', 'ponteProdutos.js')).href);

test('Vértice Price: produto do caixa vira o formato do Vértice', async () => {
  const { produtoParaVertice } = await ponte();
  assert.deepEqual(
    produtoParaVertice({ id: 'p1', nome: ' Pão francês ', categoria: 'Pães', unidade: 'kg', preco: 12.9, preco_promocional: 10.9, promocao_valida_ate: '2026-11-30', ativo: 1 }, '2026-11-08'),
    { id: 'p1', name: 'Pão francês', category: 'Pães', unit: 'kg', price: 12.9, promoPrice: 10.9, promoUntil: '2026-11-30' },
  );
  // Promoção vencida, maior que o preço ou produto inativo não vão.
  assert.equal(produtoParaVertice({ id: 'p1', nome: 'A', preco: 10, preco_promocional: 8, promocao_valida_ate: '2026-11-01' }, '2026-11-08').promoPrice, null);
  assert.equal(produtoParaVertice({ id: 'p1', nome: 'A', preco: 10, preco_promocional: 12 }, '2026-11-08').promoPrice, null);
  assert.equal(produtoParaVertice({ id: 'p1', nome: 'A', preco: 10, ativo: 0 }), null);
  assert.equal(produtoParaVertice({ id: 'p1', nome: '', preco: 10 }), null);
});

test('Vértice Price: envia ao conectar e não entra em laço a cada mudança de estado', async () => {
  const { iniciarPonteProdutos } = await ponte();
  let listas = 0;
  global.window = { pdv: { products: { list: async () => { listas++; return [{ id: 'p1', nome: 'Coxinha', preco: 7.5, ativo: 1 }]; } } } };
  const subs = new Set();
  let estado = { status: 'starting' };
  const enviados = [];
  const vx = {
    isPaired: () => estado.status === 'paired',
    onState: (fn) => { subs.add(fn); fn(estado); return () => subs.delete(fn); },
    syncProducts: async (l) => { enviados.push(l); emitir({ productsSentAt: Date.now() }); return { sent: l.length }; },
  };
  const emitir = (p) => { estado = { ...estado, ...p }; subs.forEach((f) => f(estado)); };
  const parar = iniciarPonteProdutos(vx, { intervaloMs: 60_000 });
  emitir({ status: 'paired' });
  await new Promise((r) => setTimeout(r, 20));
  emitir({ pending: 1 });
  emitir({ pending: 0 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(listas, 1, 'leu o catálogo uma vez só');
  assert.deepEqual(enviados[0], [{ id: 'p1', name: 'Coxinha', category: null, unit: null, price: 7.5, promoPrice: null, promoUntil: null }]);
  parar();
  delete global.window;
});
