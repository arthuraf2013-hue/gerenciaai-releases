const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, createFinalizedSale } = require('./helpers/testDb');
const fin = require('../electron/services/financeiroService');
const expenseService = require('../electron/services/expenseService');

// Relógio congelado: 15/09/2026, meio-dia em Brasília.
const AGORA = new Date('2026-09-15T15:00:00.000Z').getTime();
const dateNowOriginal = Date.now;
test.beforeEach(() => { Date.now = () => AGORA; });
test.afterEach(() => { Date.now = dateNowOriginal; });

function ctx() {
  const c = freshTestDb();
  const p = createProduct(c.db, { nome: 'Produto', preco: 10, custo: 4 });
  const venda = (finalizadaEm, pagamentos, extra = {}) => createFinalizedSale(c.db, {
    locationId: c.locationId, operadorId: c.gerenteId, finalizadaEm,
    itens: extra.itens || [{ productId: p, quantidade: extra.qtd || 10, preco: 10 }], pagamentos, desconto: extra.desconto || 0,
  });
  return { ...c, p, venda };
}

// ---------- configuração ----------

test('taxas: padrão sem taxa, salvar valida e persiste', () => {
  ctx();
  assert.deepEqual(fin.getTaxas().map((t) => [t.metodo, t.taxa_percentual, t.prazo_dias]), [['cartao_debito', 0, 1], ['cartao_credito', 0, 30]]);
  assert.equal(fin.salvarTaxas([{ metodo: 'cartao_credito', taxaPercentual: 50, prazoDias: 30 }]).ok, false);
  assert.equal(fin.salvarTaxas([{ metodo: 'cartao_credito', taxaPercentual: 3.5, prazoDias: 1.5 }]).ok, false);
  assert.equal(fin.salvarTaxas([{ metodo: 'cartao_credito', taxaPercentual: 3.5, prazoDias: 30 }, { metodo: 'cartao_debito', taxaPercentual: 1.2, prazoDias: 1 }]).ok, true);
  assert.deepEqual(fin.getTaxas().map((t) => t.taxa_percentual), [1.2, 3.5]);
});

test('config: saldo inicial, datas e DAS validados', () => {
  ctx();
  assert.equal(fin.salvarConfig({ dataSaldoInicial: '15/09/2026' }).ok, false);
  assert.equal(fin.salvarConfig({ diaPacoteContador: 31 }).ok, false);
  const r = fin.salvarConfig({ saldoInicial: '1500.5', dataSaldoInicial: '2026-09-01', atividadeMei: 'ambos' });
  assert.equal(r.ok, true);
  assert.equal(r.config.saldo_inicial, 1500.5);
  assert.equal(r.config.atividade_mei, 'ambos');
});

// ---------- vendas -> dinheiro ----------

test('dinheiro com troco conta só o devido; cartão cai no prazo líquido da taxa', () => {
  const { db, locationId, venda } = ctx();
  fin.salvarTaxas([{ metodo: 'cartao_credito', taxaPercentual: 4, prazoDias: 30 }, { metodo: 'cartao_debito', taxaPercentual: 1, prazoDias: 1 }]);
  venda('2026-09-10 15:00:00', [['dinheiro', 150]]); // devia 100, entregou 150
  venda('2026-09-10 16:00:00', [['dinheiro', 20], ['cartao_credito', 80]]);
  const vendas = fin.vendasComPagamentos(db, locationId, '2026-09-10', '2026-09-10');
  assert.deepEqual(vendas.map((v) => v.dinheiro).sort((a, b) => a - b), [20, 100]);

  const ar = fin.contasAReceber({ locationId });
  assert.equal(ar.cartao.length, 1);
  assert.deepEqual([ar.cartao[0].data, ar.cartao[0].bruto, ar.cartao[0].taxa, ar.cartao[0].liquido], ['2026-10-10', 80, 3.2, 76.8]);
});

test('venda das 22h em Brasília conta no dia certo (não no dia seguinte em UTC)', () => {
  const { db, locationId, venda } = ctx();
  venda('2026-09-11 01:30:00', [['pix', 100]]); // 22h30 de 10/09 em Brasília
  const vendas = fin.vendasComPagamentos(db, locationId, '2026-09-10', '2026-09-10');
  assert.equal(vendas.length, 1);
  assert.equal(vendas[0].data, '2026-09-10');
});

// ---------- contas a receber ----------

test('recebível manual: criar, listar como vencido, receber com outro valor, não baixa duas vezes', () => {
  const { db, locationId, gerenteId } = ctx();
  assert.equal(fin.criarRecebivel({ descricao: '', valor: 10, vencimento: '2026-09-01', locationId, operadorId: gerenteId }).ok, false);
  const r = fin.criarRecebivel({ descricao: 'Aluguel do espaço', valor: 300, vencimento: '2026-09-10', locationId, operadorId: gerenteId });
  assert.equal(r.ok, true);
  let ar = fin.contasAReceber({ locationId });
  assert.equal(ar.manuais[0].vencida, true);
  assert.equal(ar.totais.manuais, 300);
  assert.equal(fin.receberRecebivel({ id: r.id, data: '2026-09-14', valor: 280 }).ok, true);
  assert.equal(fin.receberRecebivel({ id: r.id }).ok, false);
  ar = fin.contasAReceber({ locationId });
  assert.equal(ar.manuais.length, 0);
  assert.equal(db.prepare('SELECT valor_recebido FROM receivables WHERE id = ?').get(r.id).valor_recebido, 280);
});

test('fiado em aberto aparece por cliente com o saldo líquido', () => {
  const { db, locationId, gerenteId } = ctx();
  const cid = randomUUID();
  db.prepare(`INSERT INTO customers (id, nome) VALUES (?, 'Dona Maria')`).run(cid);
  db.prepare(`INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, operador_id) VALUES (?, ?, 'divida', 120, ?)`).run(randomUUID(), cid, gerenteId);
  db.prepare(`INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, operador_id) VALUES (?, ?, 'pagamento', 50, ?)`).run(randomUUID(), cid, gerenteId);
  const ar = fin.contasAReceber({ locationId });
  assert.deepEqual(ar.fiado.map((f) => [f.nome, f.saldo]), [['Dona Maria', 70]]);
  assert.equal(ar.totais.fiado, 70);
});

// ---------- recorrências e parcelas ----------

test('recorrência gera do mês inicial até o atual, uma vez só, e não ressuscita excluída', () => {
  const { db, locationId, gerenteId } = ctx();
  const r = fin.criarRecorrencia({ descricao: 'Aluguel', categoria: 'aluguel', valor: 1200, diaVencimento: 31, competenciaInicio: '2026-07', locationId, operadorId: gerenteId });
  assert.equal(r.ok, true);
  const geradas = () => db.prepare('SELECT competencia, data_vencimento, valor FROM expenses WHERE recorrencia_id = ? ORDER BY competencia').all(r.id);
  assert.deepEqual(geradas().map((g) => [g.competencia, g.data_vencimento]), [['2026-07', '2026-07-31'], ['2026-08', '2026-08-31'], ['2026-09', '2026-09-30']]);
  assert.equal(fin.gerarRecorrencias().geradas, 0);
  const setembro = db.prepare(`SELECT id FROM expenses WHERE recorrencia_id = ? AND competencia = '2026-09'`).get(r.id).id;
  expenseService.remove({ expenseId: setembro, operadorId: gerenteId });
  fin.gerarRecorrencias();
  assert.equal(geradas().length, 2, 'excluída não volta');
  // Mês seguinte chega: gera outubro.
  Date.now = () => new Date('2026-10-02T15:00:00.000Z').getTime();
  assert.equal(fin.gerarRecorrencias().geradas, 1);
  assert.equal(geradas().at(-1).competencia, '2026-10');
});

test('recorrência desativada para de gerar', () => {
  const { db, locationId, gerenteId } = ctx();
  const r = fin.criarRecorrencia({ descricao: 'Internet', categoria: 'contas_consumo', valor: 99.9, diaVencimento: 10, competenciaInicio: '2026-09', locationId, operadorId: gerenteId });
  fin.alterarRecorrencia({ id: r.id, ativa: false });
  Date.now = () => new Date('2026-11-02T15:00:00.000Z').getTime();
  fin.gerarRecorrencias();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM expenses WHERE recorrencia_id = ?').get(r.id).c, 1);
});

test('despesa parcelada: soma bate com o total e o dia se ajusta em mês curto', () => {
  const { db, locationId, gerenteId } = ctx();
  const r = fin.criarDespesaParcelada({ descricao: 'Freezer', categoria: 'manutencao', valorTotal: 1000, parcelas: 3, primeiroVencimento: '2027-01-31', locationId, operadorId: gerenteId });
  assert.equal(r.ok, true);
  const ps = db.prepare('SELECT valor, data_vencimento FROM expenses ORDER BY data_vencimento').all();
  assert.deepEqual(ps.map((p) => p.valor), [333.33, 333.33, 333.34]);
  assert.deepEqual(ps.map((p) => p.data_vencimento), ['2027-01-31', '2027-02-28', '2027-03-31']);
});

test('pagar despesa numa data: não aceita futura e grava no dia local certo', () => {
  const { db, locationId, gerenteId } = ctx();
  const { id } = expenseService.create({ categoria: 'outro', descricao: 'X', valor: 10, dataVencimento: '2026-09-20', locationId, operadorId: gerenteId });
  assert.equal(fin.pagarDespesaNaData({ expenseId: id, data: '2026-09-16' }).ok, false);
  assert.equal(fin.pagarDespesaNaData({ expenseId: id, data: '2026-09-14' }).ok, true);
  assert.equal(fin.dataLocalDeUtc(db.prepare('SELECT data_pagamento FROM expenses WHERE id = ?').get(id).data_pagamento), '2026-09-14');
});

// ---------- fluxo de caixa ----------

test('fluxo de caixa: saldo inicial + realizado até hoje + previsto depois, com contas vencidas hoje', () => {
  const { locationId, gerenteId, venda } = ctx();
  fin.salvarConfig({ saldoInicial: 1000, dataSaldoInicial: '2026-09-01' });
  fin.salvarTaxas([{ metodo: 'cartao_credito', taxaPercentual: 5, prazoDias: 10 }, { metodo: 'cartao_debito', taxaPercentual: 0, prazoDias: 1 }]);
  venda('2026-09-05 15:00:00', [['dinheiro', 100]]);               // realizado antes do período
  venda('2026-09-12 15:00:00', [['cartao_credito', 100]]);          // cai 22/09 (previsto), líquido 95
  venda('2026-09-14 15:00:00', [['pix', 100]]);                     // realizado no período
  const aluguel = expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel', valor: 300, dataVencimento: '2026-09-15', locationId, operadorId: gerenteId });
  assert.equal(fin.pagarDespesaNaData({ expenseId: aluguel.id, data: '2026-09-15' }).ok, true);
  expenseService.create({ categoria: 'contas_consumo', descricao: 'Luz', valor: 80, dataVencimento: '2026-09-10', locationId, operadorId: gerenteId }); // vencida
  expenseService.create({ categoria: 'outro', descricao: 'Boleto', valor: 50, dataVencimento: '2026-09-25', locationId, operadorId: gerenteId });

  const f = fin.fluxoDeCaixa({ locationId, dataInicio: '2026-09-10', dataFim: '2026-09-30' });
  assert.equal(f.ok, true);
  assert.equal(f.saldoInicialPeriodo, 1100);
  const dia = (d) => f.dias.find((x) => x.data === d);
  assert.equal(dia('2026-09-14').entradas, 100);
  assert.equal(dia('2026-09-15').saidas, 380, 'aluguel pago hoje + luz vencida trazida pra hoje');
  assert.equal(dia('2026-09-22').entradas, 95);
  assert.equal(dia('2026-09-22').previsto, true);
  assert.equal(dia('2026-09-25').saidas, 50);
  assert.equal(f.saldoFinal, 1100 + 100 - 380 + 95 - 50);
  assert.match(f.avisos.join(' '), /vencida/);
});

test('fluxo sem saldo inicial avisa e recorrência futura entra como previsão', () => {
  const { locationId, gerenteId } = ctx();
  fin.criarRecorrencia({ descricao: 'Aluguel', categoria: 'aluguel', valor: 500, diaVencimento: 5, competenciaInicio: '2026-09', locationId, operadorId: gerenteId });
  const f = fin.fluxoDeCaixa({ locationId, dataInicio: '2026-09-15', dataFim: '2026-11-10' });
  assert.match(f.avisos.join(' '), /saldo inicial/);
  assert.equal(f.dias.find((d) => d.data === '2026-10-05').saidas, 500);
  assert.equal(f.dias.find((d) => d.data === '2026-11-05').saidas, 500);
  assert.equal(f.menorSaldo.saldo < 0, true);
});

// ---------- DRE ----------

test('DRE: CMV pelo custo da hora da venda, devolução, taxa de cartão, despesas sem compra de mercadoria', () => {
  const { db, locationId, gerenteId, p, venda } = ctx();
  fin.salvarTaxas([{ metodo: 'cartao_credito', taxaPercentual: 3, prazoDias: 30 }, { metodo: 'cartao_debito', taxaPercentual: 0, prazoDias: 1 }]);
  const v1 = venda('2026-09-03 15:00:00', [['dinheiro', 100]]);            // 10 un, custo 4 na hora
  db.prepare('UPDATE products SET custo = 6 WHERE id = ?').run(p);       // custo sobe depois
  venda('2026-09-04 15:00:00', [['cartao_credito', 95]], { desconto: 5 }); // 10 un, custo 6
  db.prepare(`INSERT INTO returns (id, sale_id, location_id, operador_id, autorizado_por_id, valor_devolvido, criado_em) VALUES ('r1', ?, ?, ?, ?, 20, '2026-09-05 15:00:00')`)
    .run(v1, locationId, gerenteId, gerenteId);
  db.prepare(`INSERT INTO return_items (id, return_id, product_id, quantidade, valor_unitario) VALUES ('ri1', 'r1', ?, 2, 10)`).run(p);
  expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel', valor: 50, dataVencimento: '2026-09-10', locationId, operadorId: gerenteId });
  expenseService.create({ categoria: 'fornecedor', descricao: 'Compra mercadoria', valor: 400, dataVencimento: '2026-09-10', locationId, operadorId: gerenteId });
  expenseService.create({ categoria: 'retirada_socio', descricao: 'Pró-labore', valor: 30, dataVencimento: '2026-09-10', locationId, operadorId: gerenteId });
  expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel de outubro', valor: 50, dataVencimento: '2026-10-10', locationId, operadorId: gerenteId });

  const { meses: [m] } = fin.dre({ locationId, competencias: ['2026-09'] });
  assert.equal(m.receitaBruta, 200);
  assert.equal(m.descontos, 5);
  assert.equal(m.devolucoes, 20);
  assert.equal(m.receitaLiquida, 175);
  assert.equal(m.cmv, 40 + 60 - 8, 'custo da hora: 4 e 6; devolução volta 2 un a 4');
  assert.equal(m.cmvItensEstimados, 0);
  assert.equal(m.impostos, 0, 'sem regime: impostos vêm das despesas');
  assert.equal(m.lucroBruto, 175 - 92);
  assert.equal(m.taxasCartao, 2.85);
  assert.deepEqual(m.despesas, [{ categoria: 'aluguel', total: 50 }]);
  assert.equal(m.resultado, 30.15);
  assert.equal(m.retiradas, 30);
});

test('DRE com Simples: imposto estimado pela alíquota efetiva do Anexo I', () => {
  const { db, locationId, venda } = ctx();
  db.prepare(`INSERT INTO fiscal_config (id, regime_tributario) VALUES ('default', 'simples_nacional') ON CONFLICT(id) DO UPDATE SET regime_tributario = excluded.regime_tributario`).run();
  venda('2026-09-03 15:00:00', [['pix', 1000]], { qtd: 100 });
  const { meses: [m] } = fin.dre({ locationId, competencias: ['2026-09'] });
  assert.equal(m.impostosOrigem, 'simples_anexo_i');
  assert.equal(m.impostos, 40, '4% da 1ª faixa');
});

test('DRE com MEI: DAS fixo do ano (comércio 2026 = R$ 82,05)', () => {
  const { db, locationId, venda } = ctx();
  db.prepare(`INSERT INTO fiscal_config (id, regime_tributario) VALUES ('default', 'mei') ON CONFLICT(id) DO UPDATE SET regime_tributario = excluded.regime_tributario`).run();
  venda('2026-09-03 15:00:00', [['pix', 1000]], { qtd: 100 });
  const { meses: [m] } = fin.dre({ locationId, competencias: ['2026-09'] });
  assert.equal(m.impostos, 82.05);
  fin.salvarConfig({ dasMeiValor: 90 });
  assert.equal(fin.dre({ locationId, competencias: ['2026-09'] }).meses[0].impostos, 90);
});

test('DRE recusa período vazio ou grande demais', () => {
  const { locationId } = ctx();
  assert.equal(fin.dre({ locationId, competencias: [] }).ok, false);
  assert.equal(fin.dre({ locationId, competencias: Array.from({ length: 25 }, (_, i) => fin.somarMeses('2024-01', i)) }).ok, false);
});
