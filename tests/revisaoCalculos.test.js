// Revisão de cálculos (nov/2026): taxa de serviço contada uma vez só nos
// relatórios, lucro com o custo do dia da venda, troco que não entra no
// caixa, devolução pelo que o cliente pagou, fiado recebido no fechamento.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const returnService = require('../electron/services/returnService');
const customerService = require('../electron/services/customerService');
const cashService = require('../electron/services/cashService');
const financeiro = require('../electron/services/financeiroService');
const dashboard = require('../electron/services/dashboardService');
const bi = require('../electron/services/biService');
const timeService = require('../electron/services/timeService');
const { valoresDaVendaFinalizada } = require('../electron/services/valoresDaVenda');

const hoje = () => timeService.hojeLocalISO();

function venda(ctx, { itens = [{ preco: 100, custo: 40, qtd: 1 }], taxa = 0, pagamentos, customerId, descontoGerente = 0 } = {}) {
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  if (customerId) saleService.setCustomer(saleId, customerId);
  const linhas = [];
  for (const it of itens) {
    const productId = it.productId || createProduct(ctx.db, { nome: it.nome || `P${randomUUID().slice(0, 4)}`, preco: it.preco, custo: it.custo ?? 0 });
    if (!it.productId) addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
    const r = saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: it.qtd || 1, operadorId: ctx.operadorId, deviceId: 'd', pessoaNumero: it.pessoa });
    assert.notEqual(r.ok, false, r.error);
    linhas.push({ productId, saleItemId: r.itemId });
  }
  if (descontoGerente) {
    const d = saleService.applyManagerDiscount({ saleId, valor: descontoGerente, motivo: 'teste', currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234' });
    assert.equal(d.ok, true, d.error);
  }
  if (taxa) saleService.setServiceCharge(saleId, taxa);
  for (const p of pagamentos || []) {
    const r = saleService.addPayment({ saleId, metodo: p.metodo, valor: p.valor, detalhes: {} });
    assert.equal(r.ok, true, r.error);
  }
  return { saleId, linhas };
}

test('taxa de serviço conta UMA vez: DRE, BI, fluxo de caixa e o helper batem com o que o cliente pagou', () => {
  const ctx = freshTestDb();
  const { saleId } = venda(ctx, { taxa: 10, pagamentos: [{ metodo: 'pix', valor: 110 }] });
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  const sale = ctx.db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  const v = valoresDaVendaFinalizada(sale);
  assert.equal(v.liquido, 110);
  assert.ok(Math.abs(v.taxaServico - 10) < 1e-9);

  const comp = hoje().slice(0, 7);
  const mes = financeiro.dre({ locationId: ctx.locationId, competencias: [comp] }).meses[0];
  assert.equal(mes.receitaBruta, 110, 'antes: 121 (taxa somada duas vezes)');
  assert.equal(mes.receitaLiquida, 110);
  assert.equal(mes.lucroBruto, 70);
  assert.equal(financeiro.receitaLiquidaDoMes(ctx.db, ctx.locationId, comp), 110);

  const m = bi.metricas(ctx.db, ctx.locationId, hoje(), hoje());
  assert.equal(Math.round(m.faturamento * 100) / 100, 110);

  const linhas = financeiro.vendasComPagamentos(ctx.db, ctx.locationId, hoje(), hoje());
  const linha = linhas.find((l) => l.id === saleId) || linhas[0];
  assert.equal(Math.round((linha.devido ?? linha.total ?? 110) * 100) / 100, 110);
});

test('painel: lucro usa o custo do dia da venda e o faturado (sem desconto); resultado tira as devoluções', () => {
  const ctx = freshTestDb();
  const { saleId, linhas } = venda(ctx, { itens: [{ preco: 100, custo: 40, qtd: 2 }], descontoGerente: 20, pagamentos: [{ metodo: 'dinheiro', valor: 180 }] });
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  // O custo do produto sobe depois da venda: o lucro daquela venda não muda.
  ctx.db.prepare('UPDATE products SET custo = 90 WHERE id = ?').run(linhas[0].productId);

  const s = dashboard.getSummary({ locationId: ctx.locationId, dataInicio: hoje(), dataFim: hoje() });
  assert.equal(s.totalFaturado, 180);
  assert.equal(s.lucroBrutoEstimado, 100, '180 faturado − 2 × 40 de custo (antes: 200 − 180 = 20)');

  const dev = returnService.createReturn({
    saleId, locationId: ctx.locationId, itens: [{ saleItemId: linhas[0].saleItemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(dev.ok, true, dev.error);
  assert.equal(dev.valorDevolvido, 90, 'devolve o que o cliente pagou por 1 unidade (100 com 10% de desconto)');
  const r = dashboard.getResultadoSimples({ locationId: ctx.locationId, dataInicio: hoje(), dataFim: hoje() });
  assert.equal(r.receita, 90);
  assert.equal(r.custoProdutos, 40);
  assert.equal(r.lucroBruto, 50);
  assert.equal(r.devolucoes, 90);
});

test('dinheiro: o troco não entra no caixa nem dá ponto; desconto maior que a venda não fecha', () => {
  const ctx = freshTestDb();
  customerService.updateLoyaltyConfig({ ativado: true, reaisPorPonto: 1, valorResgatePonto: 0.05 });
  const cliente = customerService.upsert({ nome: 'Maria', telefone: '81999990000' });
  const customerId = cliente.id || cliente.customerId;
  cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 50 });

  const { saleId } = venda(ctx, { itens: [{ preco: 30, custo: 10 }], customerId });
  const r = saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 100, detalhes: {} });
  assert.equal(r.ok, true);
  assert.equal(r.valor, 30);
  const pg = ctx.db.prepare('SELECT valor, detalhes FROM payments WHERE sale_id = ?').get(saleId);
  assert.equal(pg.valor, 30);
  assert.deepEqual(JSON.parse(pg.detalhes), { valorRecebido: 100, troco: 70 });
  assert.equal(saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 5, detalhes: {} }).semLancamento, true, 'já pago: não lança de novo');
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  assert.equal(ctx.db.prepare('SELECT pontos FROM customers WHERE id = ?').get(customerId).pontos, 30, 'pontos sobre 30, não sobre 100');

  const sessao = cashService.getOpenSession(ctx.locationId);
  assert.equal(cashService.getSessionSummary(sessao.id).valorEsperado, 80, '50 de abertura + 30 da venda');

  // Desconto dado e depois o item sai: não deixa fechar com venda negativa.
  const outra = venda(ctx, { itens: [{ preco: 50, custo: 0 }, { preco: 10, custo: 0 }], descontoGerente: 40 });
  const cancel = saleService.cancelSaleItem({
    saleId: outra.saleId, saleItemId: outra.linhas[0].saleItemId, locationId: ctx.locationId,
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', motivo: 'teste', deviceId: 'd',
  });
  assert.equal(cancel.ok, true, cancel.error);
  const fechar = saleService.finalizeSale(outra.saleId);
  assert.equal(fechar.ok, false);
  assert.match(fechar.error, /desconto/i);
});

test('devolução: mesmo produto em duas linhas, pedido repetido e mesa com taxa', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { nome: 'Cerveja', preco: 10, custo: 4 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  const { saleId, linhas } = venda(ctx, { itens: [{ productId, preco: 10, qtd: 1, pessoa: 1 }, { productId, preco: 10, qtd: 1, pessoa: 2 }], taxa: 10, pagamentos: [{ metodo: 'pix', valor: 22 }] });
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  const devolver = (itens) => returnService.createReturn({
    saleId, locationId: ctx.locationId, itens, currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });

  // A mesma linha duas vezes no pedido passava do vendido.
  assert.equal(devolver([{ saleItemId: linhas[0].saleItemId, quantidade: 2 }, { saleItemId: linhas[0].saleItemId, quantidade: 1 }]).ok, false);

  const r1 = devolver([{ saleItemId: linhas[0].saleItemId, quantidade: 1 }]);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.valorDevolvido, 11, 'com a taxa de serviço que foi paga');
  const tela = returnService.getSaleItemsForReturn(saleId);
  assert.deepEqual(tela.map((l) => l.ja_devolvido), [1, 0], 'devolvido não aparece repetido na outra linha');
  assert.equal(tela[1].valor_pago_unitario, 11);

  const r2 = devolver([{ saleItemId: linhas[1].saleItemId, quantidade: 1 }]);
  assert.equal(r2.ok, true, 'antes: a segunda linha do mesmo produto ficava travada');
  assert.equal(ctx.db.prepare('SELECT SUM(valor_devolvido) AS v FROM returns WHERE sale_id = ?').get(saleId).v, 22, 'nunca mais do que foi pago');
  assert.equal(devolver([{ saleItemId: linhas[1].saleItemId, quantidade: 1 }]).ok, false);
});

test('devolução tira os pontos que a parte devolvida deu', () => {
  const ctx = freshTestDb();
  customerService.updateLoyaltyConfig({ ativado: true, reaisPorPonto: 1, valorResgatePonto: 0.05 });
  const c = customerService.upsert({ nome: 'João', telefone: '81988887777' });
  const customerId = c.id || c.customerId;
  const { saleId, linhas } = venda(ctx, { itens: [{ preco: 20, qtd: 2 }], customerId, pagamentos: [{ metodo: 'pix', valor: 40 }] });
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  assert.equal(ctx.db.prepare('SELECT pontos FROM customers WHERE id = ?').get(customerId).pontos, 40);
  returnService.createReturn({
    saleId, locationId: ctx.locationId, itens: [{ saleItemId: linhas[0].saleItemId, quantidade: 1 }],
    currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234', deviceId: 'd',
  });
  assert.equal(ctx.db.prepare('SELECT pontos FROM customers WHERE id = ?').get(customerId).pontos, 20);
});

test('caixa: fiado recebido em dinheiro entra no esperado; pix aparece na conferência; caixa fechado não soma o dia seguinte', () => {
  const ctx = freshTestDb();
  const c = customerService.upsert({ nome: 'Ana', telefone: '81977776666' });
  const customerId = c.id || c.customerId;
  customerService.registrarDivida({ customerId, valor: 100, saleId: null, operadorId: ctx.operadorId });
  cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 0 });
  const sessao = cashService.getOpenSession(ctx.locationId);

  assert.equal(customerService.registrarPagamento({ customerId, valor: 'abc', operadorId: ctx.operadorId }).ok, false, 'valor inválido não grava');
  assert.equal(customerService.registrarPagamento({ customerId, valor: 10, operadorId: ctx.operadorId, metodo: 'cheque' }).ok, false);
  const r = customerService.registrarPagamento({ customerId, valor: 30, operadorId: ctx.operadorId, metodo: 'dinheiro', locationId: ctx.locationId });
  assert.equal(r.ok, true);
  assert.equal(r.caixa, true);
  customerService.registrarPagamento({ customerId, valor: 20, operadorId: ctx.operadorId, metodo: 'pix', locationId: ctx.locationId });

  const resumo = cashService.getSessionSummary(sessao.id);
  assert.equal(resumo.fiadoRecebidoEmDinheiro, 30);
  assert.equal(resumo.valorEsperado, 30);
  const fechado = cashService.closeSession({ sessionId: sessao.id, operadorId: ctx.operadorId, valorInformado: 30, conferencia: { pix: 20 } });
  assert.equal(fechado.ok, true);
  assert.equal(fechado.diferenca, 0);
  assert.deepEqual(fechado.diferencasPorMetodo.find((d) => d.metodo === 'pix'), { metodo: 'pix', esperado: 20, informado: 20, diferenca: 0 });

  // Venda depois do fechamento não muda o resumo do caixa fechado.
  ctx.db.prepare("UPDATE cash_sessions SET fechada_em = datetime(aberta_em, '+1 hour') WHERE id = ?").run(sessao.id);
  const depois = venda(ctx, { itens: [{ preco: 15 }], pagamentos: [{ metodo: 'dinheiro', valor: 15 }] });
  assert.equal(saleService.finalizeSale(depois.saleId).ok, true);
  ctx.db.prepare("UPDATE sales SET finalizada_em = datetime('now', '+2 hours') WHERE id = ?").run(depois.saleId);
  assert.equal(cashService.getSessionSummary(sessao.id).totalVendasDinheiro, 0);
});

test('caixa: fechamento às 22h de Brasília aparece no dia certo', () => {
  const ctx = freshTestDb();
  ctx.db.prepare(`INSERT INTO cash_sessions (id, location_id, operador_abertura_id, valor_abertura, aberta_em, fechada_em, status, diferenca)
                  VALUES (?, ?, ?, 0, '2026-11-20 12:00:00', '2026-11-21 01:00:00', 'fechada', 0)`).run(randomUUID(), ctx.locationId, ctx.operadorId);
  assert.equal(cashService.listClosedSessions({ locationId: ctx.locationId, dataInicio: '2026-11-20', dataFim: '2026-11-20' }).length, 1);
  assert.equal(cashService.listClosedSessions({ locationId: ctx.locationId, dataInicio: '2026-11-21', dataFim: '2026-11-21' }).length, 0);
  assert.equal(cashService.getClosedSessionsSummary({ locationId: ctx.locationId, dataInicio: '2026-11-20', dataFim: '2026-11-20' }).total_sessoes, 1);
});

test('fidelidade: R$ por ponto zero ou inválido é recusado (era divisão por zero)', () => {
  freshTestDb();
  assert.equal(customerService.updateLoyaltyConfig({ ativado: true, reaisPorPonto: 0 }).ok, false);
  assert.equal(customerService.updateLoyaltyConfig({ ativado: true, reaisPorPonto: -1 }).ok, false);
  assert.equal(customerService.updateLoyaltyConfig({ ativado: true, reaisPorPonto: 2, valorResgatePonto: 0.1 }).ok, true);
  assert.equal(customerService.getLoyaltyConfig().reais_por_ponto, 2);
});
