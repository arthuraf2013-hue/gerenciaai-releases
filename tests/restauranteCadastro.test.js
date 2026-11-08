// Cadastro de refeições e insumos no dia a dia do restaurante (nov/2026):
// prato feito na hora, compra de insumos em lote, conferência de estoque,
// "usado em N pratos" e o cardápio do dia ligado/desligado na lista.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, createFinalizedSale } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const ingredientService = require('../electron/services/ingredientService');
const productService = require('../electron/services/productService');
const assistente = require('../electron/services/assistenteFiscalService');

function insumo(db, { nome = 'Insumo', unidade = 'kg', custo = 10, estoque = 0 } = {}) {
  const r = ingredientService.upsert({ nome, unidade, custoUnitario: custo, estoqueAtual: estoque });
  assert.equal(r.ok, true);
  return r.id;
}
const estoqueDe = (db, id) => db.prepare('SELECT estoque_atual FROM ingredients WHERE id = ?').get(id).estoque_atual;
const custoDe = (db, id) => db.prepare('SELECT custo_unitario FROM ingredients WHERE id = ?').get(id).custo_unitario;

/** Prato feito na hora: tipo 'servico' no banco + feito_na_hora, sem estoque próprio. */
function pratoFeitoNaHora(ctx) {
  const productId = createProduct(ctx.db, { nome: 'Prato executivo', preco: 30, tipo: 'servico', estoqueMinimo: 0 });
  ctx.db.prepare(`UPDATE products SET custom_fields = ? WHERE id = ?`)
    .run(JSON.stringify({ feito_na_hora: true, tipo_prato: 'Prato principal' }), productId);
  const arroz = insumo(ctx.db, { nome: 'Arroz', custo: 6, estoque: 5 });
  const frango = insumo(ctx.db, { nome: 'Frango', custo: 20, estoque: 3 });
  ingredientService.setRecipe(productId, [{ ingredientId: arroz, quantidade: 0.15 }, { ingredientId: frango, quantidade: 0.2 }]);
  return { productId, arroz, frango };
}

test('prato feito na hora vende sem estoque do prato e baixa os insumos da ficha', () => {
  const ctx = freshTestDb();
  const { productId, arroz, frango } = pratoFeitoNaHora(ctx);
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });

  const r = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(r.ok, true, r.error);
  assert.equal(estoqueDe(ctx.db, arroz), 5 - 0.3);
  assert.equal(estoqueDe(ctx.db, frango), 3 - 0.4);
  // Sem movimento de estoque do PRATO (ele não tem estoque próprio).
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM stock_movements WHERE product_id = ?').get(productId).c, 0);
  // O consumo teórico fica registrado para o relatório.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM ingredient_consumo WHERE sale_id = ?').get(saleId).c, 2);
});

test('cancelar item e cancelar a venda do prato feito na hora devolvem os insumos', () => {
  const ctx = freshTestDb();
  const { productId, arroz, frango } = pratoFeitoNaHora(ctx);
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const a = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  const c1 = saleService.cancelSaleItem({ saleId, saleItemId: a.itemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd' });
  assert.equal(c1.ok, true, c1.error);
  assert.equal(estoqueDe(ctx.db, arroz), 5);
  assert.equal(estoqueDe(ctx.db, frango), 3);

  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 3, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.ok(Math.abs(estoqueDe(ctx.db, arroz) - 4.55) < 1e-9);
  const c2 = saleService.cancelSale({ saleId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId,
    candidateManagerId: ctx.gerenteId, pin: '1234', motivo: 'Teste', deviceId: 'd' });
  assert.equal(c2.ok, true, c2.error);
  assert.ok(Math.abs(estoqueDe(ctx.db, arroz) - 5) < 1e-9);
  assert.ok(Math.abs(estoqueDe(ctx.db, frango) - 3) < 1e-9);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM stock_movements WHERE product_id = ?').get(productId).c, 0);
});

test('serviço sem ficha técnica (taxa, couvert) continua igual: não mexe em insumo nenhum', () => {
  const ctx = freshTestDb();
  const arroz = insumo(ctx.db, { nome: 'Arroz', estoque: 5 });
  const couvert = createProduct(ctx.db, { nome: 'Couvert', preco: 8, tipo: 'servico' });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const r = saleService.addItem({ saleId, productId: couvert, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(r.ok, true);
  assert.equal(estoqueDe(ctx.db, arroz), 5);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM ingredient_consumo').get().c, 0);
});

test('relatório do MEI conta o prato feito na hora como comércio, não como serviço', () => {
  const ctx = freshTestDb();
  ctx.db.prepare(`INSERT INTO fiscal_config (id, regime_tributario) VALUES ('default', 'mei')
    ON CONFLICT(id) DO UPDATE SET regime_tributario = 'mei'`).run();
  const { productId: prato } = pratoFeitoNaHora(ctx);
  const taxa = createProduct(ctx.db, { nome: 'Taxa de rolha', preco: 20, tipo: 'servico' });
  createFinalizedSale(ctx.db, { locationId: ctx.locationId, operadorId: ctx.gerenteId, finalizadaEm: '2026-09-10 15:00:00',
    itens: [{ productId: prato, quantidade: 2, preco: 30 }, { productId: taxa, quantidade: 1, preco: 20 }], pagamentos: [['pix', 80]] });
  const r = assistente.relatorioMei({ locationId: ctx.locationId, competencia: '2026-09' });
  assert.equal(r.ok, true);
  assert.equal(r.linhas.III, 60); // refeições = comércio
  assert.equal(r.linhas.IX, 20); // só a taxa é serviço
});

test('registrar compra: entrada no estoque com rastro e custo passa a ser o preço pago', () => {
  const ctx = freshTestDb();
  const tomate = insumo(ctx.db, { nome: 'Tomate', custo: 6, estoque: 1 });
  const oleo = insumo(ctx.db, { nome: 'Óleo', unidade: 'l', custo: 8, estoque: 2 });
  const r = ingredientService.registrarCompra({
    itens: [{ ingredientId: tomate, quantidade: 4, valorTotal: 30 }, { ingredientId: oleo, quantidade: 6 }],
    fornecedor: 'Hortifruti do Zé', operadorId: ctx.gerenteId,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(estoqueDe(ctx.db, tomate), 5);
  assert.equal(custoDe(ctx.db, tomate), 7.5); // 30 / 4
  assert.equal(estoqueDe(ctx.db, oleo), 8);
  assert.equal(custoDe(ctx.db, oleo), 8); // sem valor: custo fica como estava
  const mov = ctx.db.prepare(`SELECT * FROM ingredient_stock_movements WHERE ingredient_id = ?`).get(tomate);
  assert.equal(mov.tipo, 'entrada');
  assert.equal(mov.quantidade, 4);
  assert.equal(mov.estoque_antes, 1);
  assert.equal(mov.estoque_depois, 5);
  assert.equal(mov.motivo, 'Compra — Hortifruti do Zé');
  assert.equal(mov.operador_id, ctx.gerenteId);
});

test('registrar compra sem atualizar custo, e compra inválida não grava nada', () => {
  const ctx = freshTestDb();
  const tomate = insumo(ctx.db, { nome: 'Tomate', custo: 6, estoque: 1 });
  let r = ingredientService.registrarCompra({ itens: [{ ingredientId: tomate, quantidade: 2, valorTotal: 20 }], atualizarCusto: false });
  assert.equal(r.ok, true);
  assert.equal(custoDe(ctx.db, tomate), 6);
  assert.equal(estoqueDe(ctx.db, tomate), 3);

  // Uma linha com insumo que não existe derruba a compra inteira (nada parcial).
  r = ingredientService.registrarCompra({ itens: [{ ingredientId: tomate, quantidade: 5, valorTotal: 10 }, { ingredientId: 'nao-existe', quantidade: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(estoqueDe(ctx.db, tomate), 3);
  assert.equal(custoDe(ctx.db, tomate), 6);

  assert.equal(ingredientService.registrarCompra({ itens: [] }).ok, false);
  assert.equal(ingredientService.registrarCompra({ itens: [{ ingredientId: tomate, quantidade: 0 }] }).ok, false);
  assert.equal(ingredientService.registrarCompra({ itens: [{ ingredientId: tomate, quantidade: 1, valorTotal: -3 }] }).ok, false);
});

test('conferência de estoque: só a diferença vira ajuste, com valor da diferença', () => {
  const ctx = freshTestDb();
  const arroz = insumo(ctx.db, { nome: 'Arroz', custo: 6, estoque: 10 });
  const feijao = insumo(ctx.db, { nome: 'Feijão', custo: 9, estoque: 4 });
  const r = ingredientService.registrarContagem({
    itens: [{ ingredientId: arroz, contado: 8.5 }, { ingredientId: feijao, contado: 4 }, { ingredientId: arroz, contado: '' }],
    operadorId: ctx.gerenteId,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.ajustados, 1);
  assert.equal(r.semDiferenca, 1);
  assert.equal(r.valorDiferenca, -9); // -1,5 kg x R$ 6
  assert.equal(estoqueDe(ctx.db, arroz), 8.5);
  const mov = ctx.db.prepare(`SELECT * FROM ingredient_stock_movements WHERE ingredient_id = ?`).get(arroz);
  assert.equal(mov.tipo, 'ajuste');
  assert.equal(mov.quantidade, -1.5);
  assert.equal(mov.motivo, 'Conferência de estoque');
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) c FROM ingredient_stock_movements WHERE ingredient_id = ?`).get(feijao).c, 0);
  assert.equal(ingredientService.registrarContagem({ itens: [{ ingredientId: arroz, contado: -1 }] }).ok, false);
});

test('lista de insumos diz em quantos pratos ativos cada um entra', () => {
  const ctx = freshTestDb();
  const { productId, arroz, frango } = pratoFeitoNaHora(ctx);
  const outro = createProduct(ctx.db, { nome: 'Arroz à grega', tipo: 'servico' });
  ingredientService.setRecipe(outro, [{ ingredientId: arroz, quantidade: 0.2 }]);
  const sobra = insumo(ctx.db, { nome: 'Sal grosso' });
  let lista = Object.fromEntries(ingredientService.list().map((i) => [i.id, i.usado_em]));
  assert.deepEqual([lista[arroz], lista[frango], lista[sobra]], [2, 1, 0]);
  // Prato excluído não conta mais.
  ctx.db.prepare('UPDATE products SET ativo = 0 WHERE id = ?').run(productId);
  lista = Object.fromEntries(ingredientService.list().map((i) => [i.id, i.usado_em]));
  assert.deepEqual([lista[arroz], lista[frango]], [1, 0]);
});

test('cardápio do dia: lista os pratos e liga/desliga "disponível hoje" sem mexer no resto', () => {
  const ctx = freshTestDb();
  const { productId: prato } = pratoFeitoNaHora(ctx);
  const sobremesa = createProduct(ctx.db, { nome: 'Pudim', tipo: 'produto' });
  ctx.db.prepare(`UPDATE products SET custom_fields = ? WHERE id = ?`).run(JSON.stringify({ tipo_prato: 'Sobremesa', tempo_preparo: 2 }), sobremesa);
  createProduct(ctx.db, { nome: 'Pilha AA' }); // não é prato: fica de fora

  let pratos = productService.listPratosParaCardapio();
  assert.deepEqual(pratos.map((p) => [p.nome, p.disponivelHoje]), [['Prato executivo', false], ['Pudim', false]]);

  let r = productService.setDisponivelHoje({ productIds: [prato, sobremesa], disponivel: true });
  assert.deepEqual(r, { ok: true, alterados: 2 });
  assert.deepEqual(productService.listDailyMenu().map((p) => p.nome), ['Prato executivo', 'Pudim']);
  const custom = JSON.parse(ctx.db.prepare('SELECT custom_fields FROM products WHERE id = ?').get(sobremesa).custom_fields);
  assert.deepEqual(custom, { tipo_prato: 'Sobremesa', tempo_preparo: 2, disponivel_hoje: true });

  r = productService.setDisponivelHoje({ productIds: prato, disponivel: false });
  assert.equal(r.alterados, 1);
  assert.deepEqual(productService.listDailyMenu().map((p) => p.nome), ['Pudim']);
  pratos = productService.listPratosParaCardapio();
  assert.deepEqual(pratos.map((p) => p.disponivelHoje), [false, true]);
  assert.equal(productService.setDisponivelHoje({ productIds: [] }).ok, false);

  // Produto com custom_fields vazio/nulo também aceita a marca.
  const semCampos = randomUUID();
  ctx.db.prepare(`INSERT INTO products (id, nome, preco, unidade, custom_fields) VALUES (?, 'Suco', 8, 'un', NULL)`).run(semCampos);
  assert.equal(productService.setDisponivelHoje({ productIds: [semCampos], disponivel: true }).alterados, 1);
  assert.ok(productService.listDailyMenu().some((p) => p.id === semCampos));
});
