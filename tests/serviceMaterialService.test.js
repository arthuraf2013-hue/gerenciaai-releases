const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const serviceMaterialService = require('../electron/services/serviceMaterialService');
const customItemService = require('../electron/services/customItemService');
const saleService = require('../electron/services/saleService');
const stockService = require('../electron/services/stockService');

test('setMateriais/getMateriais: CRUD básico, substitui a lista inteira', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });

  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);
  let materiais = serviceMaterialService.getMateriais(servico);
  assert.equal(materiais.length, 1);
  assert.equal(materiais[0].materialId, tintura);
  assert.equal(materiais[0].quantidade, 0.5);
  assert.equal(materiais[0].cobraNoPreco, 1);

  // Chamar de novo substitui, não soma.
  const shampoo = createProduct(ctx.db, { nome: 'Shampoo', preco: 20, custo: 8 });
  serviceMaterialService.setMateriais(servico, [{ materialId: shampoo, quantidade: 0.1, cobraNoPreco: false }]);
  materiais = serviceMaterialService.getMateriais(servico);
  assert.equal(materiais.length, 1);
  assert.equal(materiais[0].materialId, shampoo);
  assert.equal(materiais[0].cobraNoPreco, 0);
});

test('setMateriais ignora linhas sem materialId ou com quantidade <= 0', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Corte', preco: 25, tipo: 'servico' });
  const produto = createProduct(ctx.db, { nome: 'Pomada', preco: 15, custo: 5 });

  serviceMaterialService.setMateriais(servico, [
    { materialId: produto, quantidade: 0 },
    { materialId: null, quantidade: 5 },
    { materialId: produto, quantidade: 0.2, cobraNoPreco: true },
  ]);

  const materiais = serviceMaterialService.getMateriais(servico);
  assert.equal(materiais.length, 1);
  assert.equal(materiais[0].quantidade, 0.2);
});

test('custoMaterialPorUnidade soma só os materiais com cobraNoPreco=true, usando o CUSTO (não o preço)', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 }); // cobra: 0.5 x 12 = 6
  const luva = createProduct(ctx.db, { nome: 'Luva descartável', preco: 2, custo: 0.5 }); // não cobra

  serviceMaterialService.setMateriais(servico, [
    { materialId: tintura, quantidade: 0.5, cobraNoPreco: true },
    { materialId: luva, quantidade: 1, cobraNoPreco: false },
  ]);

  assert.equal(serviceMaterialService.custoMaterialPorUnidade(servico), 6);
});

test('custoMaterialPorUnidade cai pro custo da ficha técnica quando o material não tem custo direto cadastrado', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Serviço X', preco: 10, tipo: 'servico' });
  const materialSemCusto = createProduct(ctx.db, { nome: 'Kit preparado', preco: 20, custo: 0 });
  const insumoBase = createProduct(ctx.db, { nome: 'Insumo base' }); // só placeholder, ficha técnica é insumo->ingredient
  // custoUnitarioProduto cai pra computeDishCost quando custo=0 -- sem ficha técnica cadastrada, isso é 0.
  serviceMaterialService.setMateriais(servico, [{ materialId: materialSemCusto, quantidade: 2, cobraNoPreco: true }]);
  assert.equal(serviceMaterialService.custoMaterialPorUnidade(servico), 0);
  void insumoBase;
});

test('gerarLinhasParaQuantidade escala cada material padrão pela quantidade informada', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const linhas = serviceMaterialService.gerarLinhasParaQuantidade(servico, 3);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].tipo, 'produto');
  assert.equal(linhas[0].produtoId, tintura);
  assert.equal(linhas[0].quantidade, 1.5); // 0.5 x 3
});

test('saleService.addItem: serviço com material desconta o estoque do material e soma o custo ao preço', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  addStock(ctx.db, { productId: tintura, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const result = saleService.addItem({
    saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(result.ok, true);
  // preço = 40 (serviço) + 0.5 x 12 (custo da tintura) = 46
  assert.equal(result.precoUnitario, 46);

  const estoqueTintura = stockService.getCurrentStock(tintura, ctx.locationId);
  assert.equal(estoqueTintura, 9.5); // 10 - 0.5

  const sale = ctx.db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId);
  assert.equal(sale.total, 46);

  // O próprio serviço nunca gera stock_movements dele mesmo (sem estoque físico).
  const movServico = ctx.db.prepare(`SELECT COUNT(*) as c FROM stock_movements WHERE product_id = ?`).get(servico).c;
  assert.equal(movServico, 0);
});

test('saleService.addItem: material com cobraNoPreco=false desconta estoque mas não muda o preço do serviço', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Corte simples', preco: 25, tipo: 'servico' });
  const luva = createProduct(ctx.db, { nome: 'Luva', preco: 2, custo: 0.5 });
  addStock(ctx.db, { productId: luva, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: luva, quantidade: 1, cobraNoPreco: false }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const result = saleService.addItem({
    saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste',
  });

  assert.equal(result.precoUnitario, 25); // sem acréscimo
  assert.equal(stockService.getCurrentStock(luva, ctx.locationId), 19); // mas o estoque desconta igual
});

test('saleService.addItem: somar o mesmo serviço duas vezes no carrinho desconta o material só da quantidade nova', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  addStock(ctx.db, { productId: tintura, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const r1 = saleService.addItem({ saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  const r2 = saleService.addItem({ saleId, productId: servico, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: 'd' });

  assert.equal(r1.itemId, r2.itemId); // mesma linha (soma quantidade)
  assert.equal(r2.quantidadeTotal, 3);
  // Total consumido: 0.5 (primeira chamada) + 1.0 (segunda, 0.5 x 2) = 1.5, nunca 0.5 x 3 x 2.
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 8.5); // 10 - 1.5

  const linhas = ctx.db.prepare('SELECT * FROM custom_item_lines WHERE sale_item_id = ?').all(r1.itemId);
  assert.equal(linhas.length, 2); // uma linha por chamada de addItem
});

test('cancelSaleItem: devolve o estoque do material consumido pelo serviço', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  addStock(ctx.db, { productId: tintura, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const { itemId } = saleService.addItem({
    saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 9.5);

  const cancel = saleService.cancelSaleItem({
    saleId, saleItemId: itemId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId, deviceId: 'device-teste',
  });
  assert.equal(cancel.ok, true);
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 10); // devolvido
});

test('cancelSale: devolve o estoque de material de todos os serviços da venda cancelada', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  addStock(ctx.db, { productId: tintura, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 9.5);

  const cancel = saleService.cancelSale({
    saleId, locationId: ctx.locationId, currentOperatorId: ctx.operadorId,
    candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(cancel.ok, true);
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 10);
});

test('listItensParaAjuste inclui o serviço vendido com material (não só itens eh_personalizado=1)', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  addStock(ctx.db, { productId: tintura, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const { itemId } = saleService.addItem({
    saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd',
  });

  const itens = customItemService.listItensParaAjuste({ locationId: ctx.locationId });
  const item = itens.find((i) => i.saleItemId === itemId);
  assert.ok(item, 'o item do serviço deveria aparecer na lista de ajuste');
  assert.equal(item.nome, 'Coloração'); // nome vem do produto (COALESCE), já que não é eh_personalizado
  assert.equal(item.linhas.length, 1);
  assert.equal(item.linhas[0].quantidade, 0.5);
});

test('ajustarLinhas corrige a quantidade final do material do serviço, aplicando só o delta no estoque', () => {
  const ctx = freshTestDb();
  const servico = createProduct(ctx.db, { nome: 'Coloração', preco: 40, tipo: 'servico' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  addStock(ctx.db, { productId: tintura, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.operadorId });
  serviceMaterialService.setMateriais(servico, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const { itemId } = saleService.addItem({
    saleId, productId: servico, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd',
  });
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 9.5);

  const linha = ctx.db.prepare('SELECT * FROM custom_item_lines WHERE sale_item_id = ?').get(itemId);
  const ajuste = customItemService.ajustarLinhas({
    ajustes: [{ linhaId: linha.id, quantidadeFinal: 0.7 }], // usou mais do que o estimado
    operadorId: ctx.operadorId, locationId: ctx.locationId, deviceId: 'd',
  });
  assert.equal(ajuste.ok, true);
  // desconta só a diferença (0.7 - 0.5 = 0.2) em cima do que já tinha sido descontado
  assert.equal(stockService.getCurrentStock(tintura, ctx.locationId), 9.3);
});
