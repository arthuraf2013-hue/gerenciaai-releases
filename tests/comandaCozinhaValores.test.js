const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };

const layout = require('../electron/services/impressaoLayout');
const cozinha = require('../electron/services/cozinhaService');
const estudio = require('../electron/services/estudioImpressaoService');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');
const kitchenService = require('../electron/services/kitchenService');

// Comanda da cozinha: valor de cada item (variações do mesmo prato por preço),
// mesa sempre em destaque e aparência pelo estúdio de impressão.

function loja() {
  const ctx = freshTestDb();
  const peixe = createProduct(ctx.db, { nome: 'Peixe', preco: 45, categoria: 'Pratos' });
  const peixeKg = createProduct(ctx.db, { nome: 'Peixe no peso', preco: 70, categoria: 'Pratos' });
  ctx.db.prepare("UPDATE products SET unidade = 'kg' WHERE id = ?").run(peixeKg);
  for (const p of [peixe, peixeKg]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  return { ...ctx, peixe, peixeKg };
}

function impressoraFalsa() {
  const saidas = [];
  cozinha._definirImpressorasParaTeste({
    windows: async (html) => { saidas.push({ html }); },
    rede: async ({ dados }) => { saidas.push({ dados }); },
  });
  return saidas;
}

function mesaAberta(ctx, numero) {
  const id = tableService.createTable({ locationId: ctx.locationId, numero }).id
    || ctx.db.prepare('SELECT id FROM restaurant_tables WHERE numero = ?').get(numero).id;
  return { tableId: id, saleId: tableService.openTable({ tableId: id, locationId: ctx.locationId, operadorId: ctx.adminId, pessoas: 2 }).saleId };
}

test('layout: valor de cada item, detalhe do peso e da quantidade, total e mesa em destaque', () => {
  const html = layout.montarComandaCozinha({}, layout.exemploComanda());
  assert.match(html, /<h1>MESA 5<\/h1>/);
  assert.match(html, /R\$ 60,00/);
  assert.match(html, /R\$ 45,00/);
  assert.match(html, /0,750 kg x R\$ 70,00\/kg/);
  assert.match(html, /2 x R\$ 8,00/);
  assert.match(html, /Total desta comanda: R\$ 173,50/);
  assert.match(html, /Atendente: Carla/);
});

test('layout: o estúdio esconde valores; sem mesa sai a senha; textos escapados', () => {
  const semValor = layout.montarComandaCozinha({ mostrarValores: false }, layout.exemploComanda());
  assert.doesNotMatch(semValor, /R\$/);
  const balcao = layout.montarComandaCozinha({}, { mesa: null, titulo: 'SENHA 12', itens: [{ quantidade: 1, nome: '<b>Pão</b>', precoUnitario: 5 }] });
  assert.match(balcao, /<h1>SENHA 12<\/h1>/);
  assert.match(balcao, /&lt;b&gt;Pão/);
  const vazio = layout.montarComandaCozinha({}, { itens: [] });
  assert.match(vazio, /<h1>COMANDA<\/h1>/);
});

test('impressão de rede: mesa unida (MESA 4 + 5) e o valor de cada variação do peixe', async () => {
  const ctx = loja();
  const saidas = impressoraFalsa();
  cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '192.168.0.50', requestingUserId: ctx.gerenteId });
  const { tableId, saleId } = mesaAberta(ctx, '4');
  const m5 = tableService.createTable({ locationId: ctx.locationId, numero: '5' });
  const id5 = m5.id || ctx.db.prepare("SELECT id FROM restaurant_tables WHERE numero = '5'").get().id;
  assert.equal(tableService.juntarMesas({ tableId, mesaIds: [id5], currentOperatorId: ctx.adminId }).ok, true);

  const base = { saleId, locationId: ctx.locationId, operadorId: ctx.adminId, deviceId: 'pc' };
  saleService.addItem({ ...base, productId: ctx.peixe, quantidade: 1 });
  const item = ctx.db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(saleId);
  ctx.db.prepare('UPDATE sale_items SET preco_unitario = 60 WHERE id = ?').run(item.id); // variação mais cara
  saleService.addItem({ ...base, productId: ctx.peixe, quantidade: 1, observacao: 'posta' });
  saleService.addItem({ ...base, productId: ctx.peixeKg, quantidade: 0.75 });

  const r = await cozinha.imprimirItensDaVenda({ saleId });
  assert.equal(r.ok, true, r.error);
  const texto = saidas[0].dados.toString('latin1');
  assert.match(texto, /MESA 4 \+ 5/);
  assert.match(texto, /R\$ 60,00/);
  assert.match(texto, /R\$ 45,00/);
  assert.match(texto, /R\$ 52,50/);
  assert.match(texto, /0,750 kg x R\$ 70,00\/kg/);
  assert.match(texto, /Total desta comanda: R\$ 157,50/);
});

test('impressora do Windows usa o layout do estúdio; desligar valores some com eles', async () => {
  const ctx = loja();
  const saidas = impressoraFalsa();
  cozinha.saveConfig({ ativa: true, tipo: 'windows', impressoraWindows: 'Cozinha', requestingUserId: ctx.gerenteId });
  assert.equal(estudio.salvar({ tipo: 'cozinha', config: { mostrarValores: false, titulo: 'CHAPA' } }).ok, true);
  const { saleId } = mesaAberta(ctx, '9');
  saleService.addItem({ saleId, productId: ctx.peixe, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.adminId, deviceId: 'pc' });
  assert.equal((await cozinha.imprimirItensDaVenda({ saleId })).ok, true);
  assert.match(saidas[0].html, /CHAPA/);
  assert.match(saidas[0].html, /MESA 9/);
  assert.doesNotMatch(saidas[0].html, /R\$/);
  assert.equal(cozinha.getConfig().mostrarValores, false, 'tela Cozinha segue o estúdio');
});

test('estúdio: salva, lê e mostra a prévia da comanda da cozinha', async () => {
  freshTestDb();
  const tudo = estudio.getTudo();
  assert.equal(tudo.cozinha.mostrarValores, true);
  assert.equal(tudo.cozinha.mesaTamanho, 'enorme');
  assert.equal(estudio.salvar({ tipo: 'cozinha', config: { mesaTamanho: 'grande', rodape: 'Conferir' } }).ok, true);
  assert.equal(estudio.getConfig('cozinha').mesaTamanho, 'grande');
  const p = await estudio.previa({ tipo: 'cozinha', config: { mostrarTotal: false } });
  assert.equal(p.ok, true);
  assert.match(p.html, /MESA 5/);
  assert.doesNotMatch(p.html, /Total desta comanda/);
});

test('tela Cozinha recebe o preço e a unidade de cada item', () => {
  const ctx = loja();
  const { saleId } = mesaAberta(ctx, '3');
  saleService.addItem({ saleId, productId: ctx.peixeKg, locationId: ctx.locationId, quantidade: 1.2, operadorId: ctx.adminId, deviceId: 'pc' });
  const lista = kitchenService.listActiveItems(ctx.locationId);
  const i = lista.find((x) => x.sale_id === saleId);
  assert.equal(i.preco_unitario, 70);
  assert.equal(i.unidade, 'kg');
});

test('reimprimir a comanda inteira: sai de novo mesmo com tudo já impresso; sem reimprimir, avisa que nada é novo', async () => {
  const ctx = loja();
  const saidas = impressoraFalsa();
  cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '192.168.0.50', requestingUserId: ctx.gerenteId });
  const { saleId } = mesaAberta(ctx, '7');
  saleService.addItem({ saleId, productId: ctx.peixe, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.adminId, deviceId: 'pc' });

  assert.equal((await cozinha.imprimirItensDaVenda({ saleId })).ok, true);
  const semNovidade = await cozinha.imprimirItensDaVenda({ saleId });
  assert.equal(semNovidade.ok, false);
  assert.equal(semNovidade.nadaNovo, true);
  assert.equal(saidas.length, 1, 'não imprime de novo sem pedido');

  const de_novo = await cozinha.imprimirItensDaVenda({ saleId, reimprimirTudo: true });
  assert.equal(de_novo.ok, true, de_novo.error);
  assert.equal(de_novo.totalItens, 1);
  assert.equal(saidas.length, 2);
  assert.match(saidas[1].dados.toString('latin1'), /MESA 7/);
});
