const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const demo = require('../electron/services/vitrineDemoService');
const { CATALOGOS_DEMO } = require('../electron/services/vitrineDemoCatalogos');
const botOrderService = require('../electron/services/botOrderService');

// Publicar/escutar mexe em rede (Firestore); aqui só a parte local.
const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };

const PEDIDO_ID = 'AbCdEfGhIjKlMnOpQrSt';
const SLUG = 'demo-padaria-pao-quente-7k2f';

function lojaDemo() {
  const ctx = freshTestDb();
  demo.garantirProdutosDemo();
  const porSku = (sku) => ctx.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  return { ...ctx, porSku };
}

function pedido(ctx, extra = {}) {
  return {
    pedidoId: PEDIDO_ID, slug: SLUG, nome: 'Marcos', modo: 'retirada', pagamento: 'pix',
    itens: [{ produtoId: ctx.porSku('DEMO-PAD-01').id, quantidade: 0.5 }, { produtoId: ctx.porSku('DEMO-PAD-02').id, quantidade: 6 }],
    ...extra,
  };
}

test('produtos de demonstração: criados uma vez, com estoque, sem regravar o que já existe', () => {
  const ctx = lojaDemo();
  const total = Object.values(CATALOGOS_DEMO).reduce((s, c) => s + c.itens.length, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'DEMO-%'").get().n, total);
  const pao = ctx.porSku('DEMO-PAD-01');
  assert.equal(pao.unidade, 'kg');
  assert.equal(ctx.db.prepare('SELECT SUM(quantidade) AS q FROM stock_movements WHERE product_id = ?').get(pao.id).q, 20);
  ctx.db.prepare('UPDATE products SET preco = 18.5 WHERE id = ?').run(pao.id);
  assert.deepEqual(demo.garantirProdutosDemo(), { criados: 0 });
  assert.equal(ctx.porSku('DEMO-PAD-01').preco, 18.5, 'preço ajustado à mão continua');
  assert.equal(ctx.db.prepare('SELECT SUM(quantidade) AS q FROM stock_movements WHERE product_id = ?').get(pao.id).q, 20, 'estoque não duplica');
});

test('catálogo da demonstração: só o segmento pedido, na ordem do catálogo, sem custo nem estoque exato', () => {
  const ctx = lojaDemo();
  createProduct(ctx.db, { nome: 'Produto real da loja', preco: 10 });
  const { itens } = demo.montarCatalogoDemo('padaria');
  assert.deepEqual(itens.map((i) => i.nome), CATALOGOS_DEMO.padaria.itens.map((i) => i.nome));
  assert.deepEqual(Object.keys(itens[0]).sort(), ['categoria', 'disponibilidade', 'id', 'nome', 'preco', 'unidade']);
  assert.equal(itens[0].disponibilidade, 'disponivel');
  assert.deepEqual(demo.montarCatalogoDemo('inexistente'), { itens: [] });
});

test('itens do pedido: só produto DEMO- ativo, quantidade de 0 a 99, repetidos somados', () => {
  const ctx = lojaDemo();
  const real = createProduct(ctx.db, { nome: 'Real', preco: 5 });
  addStock(ctx.db, { productId: real, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const pao = ctx.porSku('DEMO-PAD-01').id;
  const queijo = ctx.porSku('DEMO-PAD-02').id;
  const itens = demo.itensValidosDoPedido([
    { produtoId: real, quantidade: 1 },          // produto de verdade da loja: fora
    { produtoId: pao, quantidade: 0.3333 },       // kg: 3 casas
    { produtoId: queijo, quantidade: 2.6 },       // unidade: arredonda
    { produtoId: queijo, quantidade: 1 },         // repetido: soma
    { produtoId: queijo, quantidade: -4 },
    { produtoId: queijo, quantidade: 500 },
    { produtoId: 'nao-existe', quantidade: 1 },
    'lixo', null,
  ]);
  assert.deepEqual(itens, [{ productId: pao, quantidade: 0.333 }, { productId: queijo, quantidade: 4 }]);
  assert.deepEqual(demo.itensValidosDoPedido('nada'), []);
});

test('pedido da demonstração cai na Separação com preço da loja, marcado como vitrine, e não duplica', () => {
  const ctx = lojaDemo();
  const r = demo.criarPedidoDemo(pedido(ctx, { pagamento: 'dinheiro', trocoPara: 50, observacao: 'bem\nassado' }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.total, 23.45); // 0,5 kg x 16,90 + 6 x 2,50
  const linha = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id);
  assert.equal(linha.canal, demo.CANAL);
  assert.equal(linha.canal_ref, PEDIDO_ID);
  assert.equal(linha.vitrine_slug, SLUG);
  assert.equal(linha.status, 'novo');
  assert.equal(linha.cliente_telefone, demo.TELEFONE_PEDIDO);
  assert.match(linha.observacoes, /Pagamento: Dinheiro \(troco para R\$ 50,00\)\. Obs\.: bem assado/);
  const dup = demo.criarPedidoDemo(pedido(ctx));
  assert.deepEqual([dup.ok, dup.id, dup.jaExistia], [true, r.id, true]);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM bot_orders').get().n, 1);
  // Aparece na fila da Separação.
  assert.equal(botOrderService.listActiveOrders({ locationId: ctx.locationId }).length, 1);
});

test('pedido concluído vira venda e baixa o estoque do produto de demonstração', () => {
  const ctx = lojaDemo();
  const r = demo.criarPedidoDemo(pedido(ctx));
  assert.equal(botOrderService.updateOrderStatus({ orderId: r.id, status: 'em_separacao', operadorId: ctx.gerenteId }).ok, true);
  assert.equal(botOrderService.updateOrderStatus({ orderId: r.id, status: 'concluido', operadorId: ctx.gerenteId }).ok, true);
  const linha = ctx.db.prepare('SELECT sale_id FROM bot_orders WHERE id = ?').get(r.id);
  assert.ok(linha.sale_id);
  assert.equal(ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(linha.sale_id).total, 23.45);
  const queijo = ctx.porSku('DEMO-PAD-02').id;
  assert.equal(ctx.db.prepare('SELECT SUM(quantidade) AS q FROM stock_movements WHERE product_id = ?').get(queijo).q, 34);
});

test('pedido da demonstração: recusa nome curto, entrega sem endereço, nenhum produto válido, id inválido e passa do limite', () => {
  const ctx = lojaDemo();
  assert.match(demo.criarPedidoDemo(pedido(ctx, { nome: ' a ' })).error, /nome/);
  assert.match(demo.criarPedidoDemo(pedido(ctx, { modo: 'entrega', endereco: 'Rua' })).error, /endereço/);
  assert.match(demo.criarPedidoDemo(pedido(ctx, { itens: [{ produtoId: 'x', quantidade: 1 }] })).error, /Nenhum produto/);
  assert.equal(demo.criarPedidoDemo(pedido(ctx, { pedidoId: '../x' })).ok, false);
  assert.equal(demo.criarPedidoDemo(pedido(ctx, { slug: 'Nao Vale' })).ok, false);
  const entrega = demo.criarPedidoDemo(pedido(ctx, { pedidoId: 'EntregaEntregaEntre01', modo: 'entrega', endereco: 'Rua das Flores, 10' }));
  assert.equal(entrega.ok, true, entrega.error);
  assert.equal(ctx.db.prepare('SELECT endereco FROM bot_orders WHERE id = ?').get(entrega.id).endereco, 'Rua das Flores, 10');

  for (let i = 1; i < demo.LIMITE_PEDIDOS_POR_DEMO; i++) {
    assert.equal(demo.criarPedidoDemo(pedido(ctx, { pedidoId: `Limite${String(i).padStart(14, '0')}` })).ok, true);
  }
  const passou = demo.criarPedidoDemo(pedido(ctx, { pedidoId: 'LimiteLimiteLimite99' }));
  assert.equal(passou.ok, false);
  assert.match(passou.error, /máximo/);
  // Outra demonstração tem o próprio limite.
  assert.equal(demo.criarPedidoDemo(pedido(ctx, { pedidoId: 'OutraDemoOutraDemo01', slug: 'demo-outra-loja-ab12' })).ok, true);
});

test('situação da demonstração: só aberta, desta máquina, dentro do prazo', () => {
  const agora = Date.parse('2026-11-02T12:00:00Z');
  const ts = (ms) => ({ toMillis: () => ms });
  const base = { installId: 'pc-1', ativa: true, demo: { segmento: 'padaria', nomeLoja: 'X', expiraEm: ts(agora + 3600000) } };
  assert.equal(demo.situacaoDaDemo(base, 'pc-1', agora), 'aberta');
  assert.equal(demo.situacaoDaDemo(base, 'pc-2', agora), 'inexistente');
  assert.equal(demo.situacaoDaDemo({ ...base, demo: undefined }, 'pc-1', agora), 'inexistente');
  assert.equal(demo.situacaoDaDemo(null, 'pc-1', agora), 'inexistente');
  assert.equal(demo.situacaoDaDemo({ ...base, ativa: false }, 'pc-1', agora), 'encerrada');
  assert.equal(demo.situacaoDaDemo({ ...base, demo: { ...base.demo, expiraEm: ts(agora - 1) } }, 'pc-1', agora), 'expirada');
  assert.equal(demo.situacaoDaDemo({ ...base, demo: { ...base.demo, expiraEm: 'amanhã' } }, 'pc-1', agora), 'expirada');
});

test('máquina que não é de demonstração não cria produto nem escuta pedido', async () => {
  freshTestDb();
  demo.aplicarDaInstalacao({ maquinaDemo: false });
  demo.aplicarDaInstalacao({});
  const r = await demo.listarDemos();
  assert.equal(r.maquinaDemo, false);
  assert.deepEqual(r.demos, []);
});

test('página: documento do pedido no formato que as regras aceitam (só id e quantidade, nunca preço)', async () => {
  const util = await import(pathToFileURL(path.join(__dirname, '..', 'pwa-mobile', 'loja-util.js')).href);
  const itens = [{ id: 'p1', nome: 'Pão', preco: 16.9, quantidade: 0.5, unidade: 'kg' }, { id: 'p2', nome: 'Queijo', preco: 2.5, quantidade: 6 }];
  const retirada = util.montarPedidoDemo({ slug: SLUG, itens, nome: '  Ana  ', modo: 'retirada', endereco: 'ignorado', pagamento: 'pix', trocoPara: '50', observacao: '' });
  assert.deepEqual(retirada, {
    slug: SLUG, status: 'novo', nome: 'Ana', modo: 'retirada', pagamento: 'pix',
    itens: [{ produtoId: 'p1', quantidade: 0.5 }, { produtoId: 'p2', quantidade: 6 }],
  });
  const entrega = util.montarPedidoDemo({ slug: SLUG, itens, nome: 'Ana', modo: 'entrega', endereco: ' Rua A, 10 ', pagamento: 'dinheiro', trocoPara: '50,5', observacao: ' sem cebola ' });
  assert.equal(entrega.endereco, 'Rua A, 10');
  assert.equal(entrega.trocoPara, 50.5);
  assert.equal(entrega.observacao, 'sem cebola');
  assert.equal(util.montarPedidoDemo({ slug: SLUG, itens, nome: 'Ana', pagamento: 'boleto' }).pagamento, 'pix');
  assert.equal(util.montarPedidoDemo({ slug: SLUG, itens: Array(60).fill(itens[1]), nome: 'Ana', pagamento: 'pix' }).itens.length, 40);
  assert.ok(!JSON.stringify(entrega).includes('16.9'), 'preço nunca vai no pedido');
});
