const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock, createFinalizedSale } = require('./helpers/testDb');
const fin = require('../electron/services/financeiroService');
const expenseService = require('../electron/services/expenseService');
const centros = require('../electron/services/centroCustoService');
const cobranca = require('../electron/services/cobrancaService');
const conciliacao = require('../electron/services/conciliacaoService');
const comissao = require('../electron/services/comissaoService');
const contabil = require('../electron/services/contabilService');
const rh = require('../electron/services/rhService');
const bi = require('../electron/services/biService');

// Relógio congelado: 20/10/2026, meio-dia em Brasília.
const AGORA = new Date('2026-10-20T15:00:00.000Z').getTime();
const original = Date.now;
test.beforeEach(() => { Date.now = () => AGORA; });
test.afterEach(() => { Date.now = original; });

function cliente(db, nome = 'Maria Silva') {
  const id = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(id, nome, '81999990000');
  return id;
}
function fiado(db, customerId, tipo, valor, criadoEm) {
  db.prepare('INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, criado_em) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), customerId, tipo, valor, criadoEm);
}

// ---------- centros de custo ----------

test('centros de custo: nome único, despesa com centro, DRE por centro sem compra de mercadoria', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const cozinha = centros.salvar({ nome: 'Cozinha' }).id;
  assert.equal(centros.salvar({ nome: 'cozinha' }).ok, false);
  assert.equal(expenseService.create({ categoria: 'manutencao', descricao: 'Fogão', valor: 300, dataVencimento: '2026-10-10', locationId, operadorId: gerenteId, centroCustoId: 'x' }).ok, false);
  expenseService.create({ categoria: 'manutencao', descricao: 'Fogão', valor: 300, dataVencimento: '2026-10-10', locationId, operadorId: gerenteId, centroCustoId: cozinha });
  expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel', valor: 1000, dataVencimento: '2026-10-05', locationId, operadorId: gerenteId });
  expenseService.create({ categoria: 'fornecedor', descricao: 'Compra', valor: 999, dataVencimento: '2026-10-05', locationId, operadorId: gerenteId, centroCustoId: cozinha });
  const r = centros.despesasPorCentro({ locationId, competencias: ['2026-10'] });
  assert.deepEqual(r.centros.map((c) => [c.centro, c.total]), [['Sem centro de custo', 1000], ['Cozinha', 300]]);
  assert.equal(centros.definirAtivo({ id: cozinha, ativo: false }).ok, true);
  assert.equal(centros.listar().length, 0);
});

// ---------- inadimplência ----------

test('inadimplência: pagamento abate a dívida mais antiga; prazo do fiado; contas vencidas por faixa', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const maria = cliente(db);
  fiado(db, maria, 'divida', 100, '2026-07-01 15:00:00');   // 111 dias
  fiado(db, maria, 'divida', 50, '2026-10-10 15:00:00');    // 10 dias
  fiado(db, maria, 'pagamento', 30, '2026-08-01 15:00:00'); // abate a de julho
  const joao = cliente(db, 'João');
  fiado(db, joao, 'divida', 40, '2026-10-01 15:00:00');
  fiado(db, joao, 'pagamento', 40, '2026-10-02 15:00:00');  // quitado
  fin.criarRecebivel({ descricao: 'Encomenda', customerId: maria, valor: 200, vencimento: '2026-09-15', locationId, operadorId: gerenteId }); // 35 dias
  const r = cobranca.relatorio({ prazoFiadoDias: 30 });
  assert.equal(r.clientes.length, 1);
  const c = r.clientes[0];
  assert.equal(c.aberto, 320);        // 70 + 50 + 200
  assert.equal(c.vencido, 270);       // 70 (fiado de julho) + 200
  assert.equal(c.maisAntigo, '2026-07-01');
  assert.deepEqual(Object.fromEntries(r.faixas.map((f) => [f.chave, f.valor])), { ate30: 0, de31a60: 200, de61a90: 70, mais90: 0 });
  assert.equal(r.totalVencido, 270);
  const msg = cobranca.mensagemDeCobranca({ customerId: maria });
  assert.match(msg.texto, /Maria/);
  assert.match(msg.texto, /320,00/);
  assert.equal(cobranca.mensagemDeCobranca({ customerId: joao }).ok, false);
});

// ---------- conciliação ----------

const OFX = `OFXHEADER:100
DATA:OFXSGML
CHARSET:1252
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0341<BRANCHID>1234<ACCTID>56789-0</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261010120000[-3:BRT]<TRNAMT>-1000.00<FITID>A1<MEMO>PIX ENVIADO IMOBILIARIA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261012<TRNAMT>-45,90<FITID>A2<NAME>TARIFA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261016<TRNAMT>200.00<FITID>A3<MEMO>PIX RECEBIDO MARIA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261015<TRNAMT>97.00<FITID>A4<MEMO>REDE CARTOES</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('conciliação: lê OFX (SGML, vírgula), não duplica, sugere e baixa conta, cria despesa, repasse de cartão', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const p = createProduct(db, { preco: 100 });
  fin.salvarTaxas([{ metodo: 'cartao_debito', taxaPercentual: 3, prazoDias: 1 }]);
  createFinalizedSale(db, { locationId, operadorId: gerenteId, finalizadaEm: '2026-10-14 15:00:00', itens: [{ productId: p, quantidade: 1, preco: 100 }], pagamentos: [['cartao_debito', 100]] });
  const aluguel = expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel out', valor: 1000, dataVencimento: '2026-10-10', locationId, operadorId: gerenteId }).id;
  const maria = cliente(db);
  const receb = fin.criarRecebivel({ descricao: 'Encomenda', customerId: maria, valor: 200, vencimento: '2026-10-15', locationId, operadorId: gerenteId }).id;

  const imp = conciliacao.importar({ buffer: Buffer.from(OFX, 'latin1'), operadorId: gerenteId });
  assert.equal(imp.ok, true, imp.error);
  assert.deepEqual([imp.importadas, imp.conta, imp.de, imp.ate], [4, '0341/1234/56789-0', '2026-10-10', '2026-10-16']);
  assert.equal(conciliacao.importar({ buffer: Buffer.from(OFX, 'latin1') }).importadas, 0, 'reimportar não duplica');
  assert.equal(conciliacao.importar({ buffer: Buffer.from('não é ofx') }).ok, false);

  const lista = conciliacao.listar({ locationId }).linhas;
  const linha = (fitid) => lista.find((l) => l.fitid === fitid);
  assert.equal(linha('A2').valor, -45.9);
  assert.deepEqual(linha('A1').sugestoes.map((s) => [s.tipo, s.id]), [['despesa', aluguel]]);
  assert.deepEqual(linha('A3').sugestoes.map((s) => [s.tipo, s.id]), [['recebivel', receb]]);
  assert.deepEqual(linha('A4').sugestoes.map((s) => s.tipo), ['cartao']); // 100 - 3% caiu dia 15

  assert.equal(conciliacao.conciliar({ linhaId: linha('A1').id, tipo: 'recebivel', vinculoId: receb }).ok, false, 'saída não casa com receber');
  assert.equal(conciliacao.conciliar({ linhaId: linha('A1').id, tipo: 'despesa', vinculoId: aluguel, operadorId: gerenteId }).ok, true);
  assert.equal(db.prepare('SELECT data_pagamento FROM expenses WHERE id = ?').get(aluguel).data_pagamento, '2026-10-10 15:00:00');
  assert.equal(conciliacao.conciliar({ linhaId: linha('A1').id, tipo: 'despesa', vinculoId: aluguel }).ok, false, 'linha já conciliada');
  assert.equal(conciliacao.conciliar({ linhaId: linha('A2').id, tipo: 'despesa', vinculoId: aluguel }).ok, false, 'a mesma conta não casa com duas linhas');
  assert.equal(conciliacao.conciliar({ linhaId: linha('A3').id, tipo: 'recebivel', vinculoId: receb, operadorId: gerenteId }).ok, true);
  assert.equal(db.prepare('SELECT recebido_em FROM receivables WHERE id = ?').get(receb).recebido_em, '2026-10-16');
  const nova = conciliacao.criarDespesa({ linhaId: linha('A2').id, categoria: 'taxas_bancarias', locationId, operadorId: gerenteId });
  assert.equal(nova.ok, true, nova.error);
  const e = db.prepare('SELECT valor, descricao, data_pagamento FROM expenses WHERE id = ?').get(nova.expenseId);
  assert.deepEqual([e.valor, e.descricao, e.data_pagamento], [45.9, 'TARIFA', '2026-10-12 15:00:00']);
  assert.equal(conciliacao.ignorar({ linhaId: linha('A4').id }).ok, true);
  assert.equal(conciliacao.listar({ locationId }).linhas.length, 0);
  assert.equal(conciliacao.desfazer({ linhaId: linha('A4').id }).ok, true);
  assert.equal(conciliacao.listar({ locationId }).linhas.length, 1);
});

test('OFX em XML (2.x) e linha sem data é ignorada com contagem', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><OFX><BANKACCTFROM><BANKID>001</BANKID><ACCTID>9</ACCTID></BANKACCTFROM>
    <STMTTRN><DTPOSTED>20261001</DTPOSTED><TRNAMT>-10.5</TRNAMT><FITID>X</FITID><MEMO>Café</MEMO></STMTTRN>
    <STMTTRN><DTPOSTED>2026</DTPOSTED><TRNAMT>1</TRNAMT><FITID>Y</FITID></STMTTRN></OFX>`;
  const r = conciliacao.parseOfx(xml);
  assert.equal(r.ok, true);
  assert.deepEqual(r.linhas.map((l) => [l.data, l.valor, l.descricao]), [['2026-10-01', -10.5, 'Café']]);
  assert.equal(r.ignoradas, 1);
});

// ---------- comissões e metas ----------

test('comissões: base líquida de devoluções, percentual por vendedor, metas da loja e do vendedor com projeção', () => {
  const { db, locationId, gerenteId, operadorId } = freshTestDb();
  const p = createProduct(db, { preco: 100 });
  createFinalizedSale(db, { locationId, operadorId, finalizadaEm: '2026-10-05 15:00:00', itens: [{ productId: p, quantidade: 10, preco: 100 }], pagamentos: [['dinheiro', 1000]] });
  const devolvida = createFinalizedSale(db, { locationId, operadorId, finalizadaEm: '2026-10-06 15:00:00', itens: [{ productId: p, quantidade: 1, preco: 100 }], pagamentos: [['dinheiro', 100]], desconto: 0 });
  createFinalizedSale(db, { locationId, operadorId: gerenteId, finalizadaEm: '2026-10-07 15:00:00', itens: [{ productId: p, quantidade: 5, preco: 100 }], pagamentos: [['pix', 500]] });
  db.prepare('INSERT INTO returns (id, sale_id, location_id, operador_id, autorizado_por_id, valor_devolvido, criado_em) VALUES (?, ?, ?, ?, ?, 100, ?)')
    .run(randomUUID(), devolvida, locationId, operadorId, gerenteId, '2026-10-08 15:00:00');
  assert.equal(comissao.salvarRegra({ userId: operadorId, percentual: 150 }).ok, false);
  comissao.salvarRegra({ userId: operadorId, percentual: 2 });
  comissao.salvarMeta({ competencia: '2026-10', valor: 3100 });
  comissao.salvarMeta({ competencia: '2026-10', userId: operadorId, valor: 2000 });
  comissao.salvarMeta({ competencia: '2026-10', userId: operadorId, valor: 2000 }); // atualiza, não duplica
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sales_goals').get().n, 2);
  const r = comissao.relatorio({ locationId, competencia: '2026-10' });
  const op = r.vendedores.find((v) => v.userId === operadorId);
  assert.deepEqual([op.bruto, op.devolucoes, op.base, op.comissao, op.atingido], [1100, 100, 1000, 20, 50]);
  assert.equal(r.vendedores.find((v) => v.userId === gerenteId).comissao, null, 'sem regra, sem comissão');
  assert.equal(r.loja.base, 1500);
  assert.equal(r.loja.projecao, 2325); // 1500 / 20 dias x 31
  assert.equal(r.totalComissoes, 20);
});

// ---------- contabilidade ----------

test('contábil: partidas dobradas fecham, vendas por forma de pagamento, CMV, compras e despesas com o de-para', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const p = createProduct(db, { preco: 10, custo: 4 });
  createFinalizedSale(db, { locationId, operadorId: gerenteId, finalizadaEm: '2026-10-05 15:00:00', itens: [{ productId: p, quantidade: 10, preco: 10 }], pagamentos: [['dinheiro', 60], ['cartao_credito', 40]] });
  const aluguel = expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel', valor: 500, dataVencimento: '2026-10-10', locationId, operadorId: gerenteId }).id;
  fin.pagarDespesaNaData({ expenseId: aluguel, data: '2026-10-10' });
  const r = contabil.lancamentos({ locationId, competencia: '2026-10' });
  assert.equal(r.ok, true);
  assert.equal(r.totalDebitos, r.totalCreditos);
  const par = (d, c) => r.linhas.find((l) => l.debito === d && l.credito === c)?.valor;
  assert.equal(par('caixa', 'receita_vendas'), 60);
  assert.equal(par('cartao_receber', 'receita_vendas'), 40);
  assert.equal(par('cmv', 'estoque'), 40);
  assert.equal(par('despesa:aluguel', 'contas_pagar'), 500);
  assert.equal(par('contas_pagar', 'banco'), 500);
  const saldo = Object.fromEntries(r.balancete.map((b) => [b.chave, b.saldo]));
  assert.equal(saldo.contas_pagar, 0);
  assert.equal(saldo.receita_vendas, -100);
  assert.equal(r.balancete.reduce((s, b) => s + b.saldo, 0).toFixed(2), '0.00');
  assert.equal(contabil.salvarPlano({ contas: [{ chave: 'caixa', codigo: 'a b', nome: 'Caixa' }] }).ok, false);
  assert.equal(contabil.salvarPlano({ contas: [{ chave: 'caixa', codigo: '1.01.01.001', nome: 'Caixa geral' }] }).ok, true);
  assert.equal(contabil.lancamentos({ locationId, competencia: '2026-10' }).linhas.find((l) => l.debito === 'caixa').debitoCodigo, '1.01.01.001');
});

test('contábil: planilha com Lançamentos, Balancete, Plano e Leia-me', async () => {
  const { locationId } = freshTestDb();
  const r = await contabil.xlsx({ locationId, competencia: '2026-10' });
  assert.equal(r.ok, true);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Lançamentos', 'Balancete', 'Plano (de-para)', 'Leia-me']);
});

// ---------- RH ----------

test('equipe: CPF válido, documentos, férias (mínimo 5 dias, sem sobreposição) e alerta de férias vencidas', () => {
  const { db } = freshTestDb();
  assert.equal(rh.salvar({ nome: 'Ana', cpf: '111.111.111-11' }).ok, false);
  assert.equal(rh.cpfValido('529.982.247-25'), true);
  const ana = rh.salvar({ nome: 'Ana Souza', cpf: '529.982.247-25', cargo: 'Caixa', departamento: 'Loja', admissao: '2024-03-01', salario: 1621, documentos: { rg: true, cpf: true } });
  assert.equal(ana.ok, true, ana.error);
  assert.equal(rh.salvar({ nome: 'Outra', cpf: '52998224725' }).ok, false, 'CPF repetido');
  assert.equal(rh.salvar({ nome: 'X', documentos: { passaporte: true } }).ok, false);
  assert.equal(rh.registrarFerias({ employeeId: ana.id, inicio: '2025-05-01', fim: '2025-05-03' }).ok, false, 'menos de 5 dias');
  assert.equal(rh.registrarFerias({ employeeId: ana.id, inicio: '2025-05-01', fim: '2025-06-10' }).ok, false, 'mais de 30');
  assert.equal(rh.registrarFerias({ employeeId: ana.id, inicio: '2025-05-01', fim: '2025-05-20' }).ok, true);
  assert.equal(rh.registrarFerias({ employeeId: ana.id, inicio: '2025-05-15', fim: '2025-05-25' }).ok, false, 'sobreposição');
  const r = rh.listar({});
  const a = r.colaboradores[0];
  // período 1: 01/03/2024 a 28/02/2025 (30 dias, 20 gozados, limite 28/02/2026 passou) -> vencidas
  assert.deepEqual(a.periodos.map((p) => [p.inicio, p.direito, p.gozados, p.situacao]), [
    ['2024-03-01', 30, 20, 'vencidas'], ['2025-03-01', 30, 0, 'a_gozar'], ['2026-03-01', 0, 0, 'em_aquisicao'],
  ]);
  assert.ok(r.alertas.some((x) => x.nivel === 'critico' && /venceram/.test(x.texto)));
  assert.ok(r.alertas.some((x) => /documento/.test(x.texto)));
  assert.equal(r.resumo.folhaBaseMensal, 1621);
  rh.salvar({ id: ana.id, nome: 'Ana Souza', cpf: '52998224725', admissao: '2024-03-01', demissao: '2026-10-01' });
  assert.equal(rh.listar({}).colaboradores.length, 0, 'desligada sai da lista de ativos');
  assert.equal(db.prepare('SELECT ativo FROM employees WHERE id = ?').get(ana.id).ativo, 0);
});

// ---------- painel executivo ----------

test('painel executivo: comparação com o período anterior, curva ABC, estoque parado, ruptura e alertas', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  const a = createProduct(db, { nome: 'Campeão', preco: 10, custo: 5, estoqueMinimo: 5 });
  const b = createProduct(db, { nome: 'Médio', preco: 10, custo: 6 });
  const parado = createProduct(db, { nome: 'Encalhado', preco: 50, custo: 30 });
  addStock(db, { productId: parado, locationId, quantidade: 4, operadorId: gerenteId });
  addStock(db, { productId: a, locationId, quantidade: 2, operadorId: gerenteId });
  db.prepare("UPDATE products SET criado_em = '2026-06-01 12:00:00' WHERE id = ?").run(parado);
  const venda = (dia, itens) => createFinalizedSale(db, { locationId, operadorId: gerenteId, finalizadaEm: `${dia} 15:00:00`, itens, pagamentos: [['dinheiro', itens.reduce((s, i) => s + i.quantidade * i.preco, 0)]] });
  venda('2026-10-02', [{ productId: a, quantidade: 80, preco: 10 }, { productId: b, quantidade: 15, preco: 10 }]);
  venda('2026-10-03', [{ productId: b, quantidade: 5, preco: 10 }]);
  venda('2026-09-20', [{ productId: a, quantidade: 50, preco: 10 }]); // período anterior (19 dias antes de 01/10)
  const r = bi.painel({ locationId, dataInicio: '2026-10-01', dataFim: '2026-10-20' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.atual.faturamento, 1000);
  assert.equal(r.anterior.faturamento, 500);
  assert.equal(r.variacao.faturamento, 100);
  assert.equal(r.atual.lucroBruto, 1000 - (80 * 5 + 20 * 6));
  assert.deepEqual(r.abc.map((p) => [p.nome, p.classe]), [['Campeão', 'A'], ['Médio', 'B']]);
  assert.deepEqual(r.estoqueParado.map((p) => [p.nome, p.valorParado]), [['Encalhado', 120]]);
  assert.deepEqual(r.ruptura.map((p) => p.nome), ['Campeão']);
  assert.ok(r.alertas.some((x) => x.nivel === 'critico' && /curva A/.test(x.texto)));
  assert.ok(r.alertas.some((x) => /parados no estoque/.test(x.texto)));
  assert.equal(r.serie.length, 20);
  assert.equal(bi.painel({ locationId, dataInicio: '2026-10-20', dataFim: '2026-10-01' }).ok, false);
});
