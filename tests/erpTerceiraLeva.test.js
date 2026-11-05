const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const { setDbForTesting } = require('../electron/db/database');
const migracoes = require('../electron/db/migracoes');
const cashService = require('../electron/services/cashService');
const saleService = require('../electron/services/saleService');
const authService = require('../electron/services/authService');
const customerService = require('../electron/services/customerService');
const fin = require('../electron/services/financeiroService');
const expenseService = require('../electron/services/expenseService');
const contabil = require('../electron/services/contabilService');
const naturezas = require('../electron/services/naturezaOperacaoService');
const validadores = require('../electron/services/validadores');
const tabelas = require('../electron/services/tabelasFiscais');
const assistente = require('../electron/services/assistenteFiscalService');
const getDbFromCtx = () => require('../electron/db/database').getDb();

// Relógio congelado: 20/10/2026, meio-dia em Brasília.
const AGORA = new Date('2026-10-20T15:00:00.000Z').getTime();
const original = Date.now;
test.beforeEach(() => { Date.now = () => AGORA; });
test.afterEach(() => { Date.now = original; });

// ---------- migrações versionadas ----------

test('migração 1: aplica uma vez, desfaz e refaz em base populada sem perder dados antigos', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  assert.deepEqual(db.prepare('SELECT versao FROM schema_migrations').all().map((r) => r.versao), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(migracoes.aplicarMigracoes(db), [], 'segunda aplicação não faz nada');

  // Base populada: dado antigo e dado nas colunas novas.
  const cliente = randomUUID();
  db.prepare("INSERT INTO customers (id, nome, cpf, limite_fiado) VALUES (?, 'Ana', '52998224725', 150)").run(cliente);
  expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel', valor: 900, dataVencimento: '2026-10-05', locationId, operadorId: gerenteId });

  // Voltar ao zero desfaz da mais nova para a mais antiga (2 = vitrine de demonstração, 3 = mesas unidas, 4 = mesas da venda, 5 = comandos da mesa pelo celular, 6 = especificações no item vendido).
  assert.deepEqual(migracoes.reverterMigracoes(db, 0), [6, 5, 4, 3, 2, 1]);
  const colsCliente = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  assert.ok(!colsCliente.includes('limite_fiado'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'journal_entries'").get().n, 0);
  assert.equal(db.prepare('SELECT nome FROM customers WHERE id = ?').get(cliente).nome, 'Ana', 'linha antiga intacta');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 1);

  assert.deepEqual(migracoes.aplicarMigracoes(db), [1, 2, 3, 4, 5, 6]);
  assert.equal(db.prepare('SELECT limite_fiado FROM customers WHERE id = ?').get(cliente).limite_fiado, null, 'coluna volta vazia');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM natureza_operacao').get().n, migracoes.NATUREZAS.length);
});

test('migração com erro não deixa nada pela metade', () => {
  const db = setDbForTesting(new Database(':memory:'));
  const quebrada = [{ versao: 99, nome: 'teste', up(d) { d.exec('CREATE TABLE tmp_x (a)'); throw new Error('falhou'); }, down() {} }];
  assert.throws(() => migracoes.aplicarMigracoes(db, quebrada), /falhou/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tmp_x'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE versao = 99').get().n, 0);
});

test('auditoria e lançamentos manuais são só de inclusão', () => {
  const { db, gerenteId } = freshTestDb();
  db.prepare("INSERT INTO audit_log (id, tipo_evento, solicitante_id, sucesso) VALUES ('a1', 'x', ?, 1)").run(gerenteId);
  assert.throws(() => db.prepare("UPDATE audit_log SET motivo = 'mexi' WHERE id = 'a1'").run(), /não pode ser alterada/);
  assert.throws(() => db.prepare("DELETE FROM audit_log WHERE id = 'a1'").run(), /não pode ser apagada/);
});

// ---------- caixa: sangria, suprimento e conferência ----------

function vender(ctx, { preco, metodo }) {
  const productId = createProduct(ctx.db, { preco });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(saleService.addPayment({ saleId, metodo, valor: preco, detalhes: {} }).ok, true);
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  return saleId;
}

test('caixa: suprimento soma, sangria tira, sangria acima da gaveta é recusada', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });
  vender(ctx, { preco: 50, metodo: 'dinheiro' });
  assert.equal(cashService.registrarMovimento({ sessionId, tipo: 'suprimento', valor: 20, operadorId: ctx.operadorId }).ok, true);
  assert.match(cashService.registrarMovimento({ sessionId, tipo: 'sangria', valor: 10, operadorId: ctx.operadorId }).error, /motivo/);
  assert.match(cashService.registrarMovimento({ sessionId, tipo: 'sangria', valor: 170.01, motivo: 'banco', operadorId: ctx.operadorId }).error, /passa do dinheiro/);
  const r = cashService.registrarMovimento({ sessionId, tipo: 'sangria', valor: 120, motivo: 'Depósito no banco', operadorId: ctx.operadorId });
  assert.equal(r.ok, true);
  assert.equal(r.valorEsperado, 50); // 100 + 50 + 20 − 120
  const resumo = cashService.getSessionSummary(sessionId);
  assert.equal(resumo.totalSangrias, 120);
  assert.equal(resumo.totalSuprimentos, 20);
  assert.throws(() => ctx.db.prepare('DELETE FROM cash_movements').run(), /não se apaga/);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tipo_evento = 'caixa_sangria' AND entidade = 'cash_movements'").get().n, 1);
});

test('caixa: conferência por forma de pagamento no fechamento e fechamento único', () => {
  const ctx = freshTestDb();
  const { id: sessionId } = cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 0 });
  vender(ctx, { preco: 80, metodo: 'pix' });
  vender(ctx, { preco: 40, metodo: 'cartao_debito' });
  const r = cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: 0, conferencia: { pix: 80, cartao_debito: 35 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.diferencasPorMetodo.map((d) => [d.metodo, d.diferenca]), [['pix', 0], ['cartao_debito', -5]]);
  assert.ok(ctx.db.prepare('SELECT conferencia_json FROM cash_sessions WHERE id = ?').get(sessionId).conferencia_json.includes('cartao_debito'));
  assert.equal(cashService.closeSession({ sessionId, operadorId: ctx.operadorId, valorInformado: 0 }).ok, false);
  assert.equal(cashService.caixaAtual({ locationId: ctx.locationId }).aberto, false);
});

// ---------- desconto por perfil ----------

function vendaAberta(ctx, preco = 100) {
  const productId = createProduct(ctx.db, { preco });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  return saleId;
}

test('limite de desconto do operador: até o limite sem PIN; acima, só com gerente', () => {
  const ctx = freshTestDb();
  assert.equal(authService.updateSecurityConfig(ctx.gerenteId, { limiteDescontoOperador: 10 }).ok, false, 'gerente não muda a trava');
  assert.match(authService.updateSecurityConfig(ctx.adminId, { limiteDescontoOperador: 120 }).error, /0% a 100%/);
  assert.equal(authService.updateSecurityConfig(ctx.adminId, { limiteDescontoOperador: 10 }).ok, true);

  const s1 = vendaAberta(ctx);
  const dentro = saleService.applyManagerDiscount({ saleId: s1, percentual: 8, motivo: 'cliente fiel', currentOperatorId: ctx.operadorId });
  assert.equal(dentro.ok, true, 'exigir_autorizacao_desconto ligado, mas 8% está no limite');
  const s2 = vendaAberta(ctx);
  const acima = saleService.applyManagerDiscount({ saleId: s2, percentual: 15, currentOperatorId: ctx.operadorId });
  assert.equal(acima.precisaAutorizacao, true);
  const comGerente = saleService.applyManagerDiscount({ saleId: s2, percentual: 15, currentOperatorId: ctx.operadorId, candidateManagerId: ctx.gerenteId, pin: '1234' });
  assert.equal(comGerente.ok, true);
  assert.equal(comGerente.autorizadoPor.id, ctx.gerenteId);

  // Chave geral desligada: o limite continua valendo para o operador.
  authService.updateSecurityConfig(ctx.adminId, { exigirAutorizacaoDesconto: false });
  const s3 = vendaAberta(ctx);
  assert.equal(saleService.applyManagerDiscount({ saleId: s3, valor: 20, currentOperatorId: ctx.operadorId }).precisaAutorizacao, true);
  assert.equal(saleService.applyManagerDiscount({ saleId: s3, valor: 20, currentOperatorId: ctx.gerenteId }).ok, true, 'gerente segue só a chave geral');
  const ultimo = ctx.db.prepare("SELECT tipo_evento FROM audit_log WHERE tipo_evento LIKE 'config_seguranca%' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(ultimo.tipo_evento, 'config_seguranca_alterada');
});

// ---------- fiado: limite e bloqueio ----------

test('fiado: limite por cliente e bloqueio valem no pagamento e na finalização', () => {
  const ctx = freshTestDb();
  const cliente = randomUUID();
  ctx.db.prepare("INSERT INTO customers (id, nome) VALUES (?, 'Maria')").run(cliente);
  customerService.registrarDivida({ customerId: cliente, valor: 80, saleId: null, operadorId: ctx.operadorId });
  assert.equal(customerService.definirLimiteFiado({ customerId: cliente, limite: 100, operadorId: ctx.gerenteId }).ok, true);

  const saleId = vendaAberta(ctx, 30);
  saleService.setCustomer(saleId, cliente);
  const r = saleService.addPayment({ saleId, metodo: 'fiado', valor: 30 });
  assert.equal(r.limiteExcedido, true);
  assert.equal(r.disponivel, 20);
  assert.equal(saleService.addPayment({ saleId, metodo: 'fiado', valor: 20 }).ok, true);
  assert.equal(saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 10 }).ok, true);
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  assert.equal(customerService.getSaldoFiado(cliente), 100);

  customerService.definirLimiteFiado({ customerId: cliente, limite: '', bloqueado: true, operadorId: ctx.gerenteId });
  const s2 = vendaAberta(ctx, 5);
  saleService.setCustomer(s2, cliente);
  assert.equal(saleService.addPayment({ saleId: s2, metodo: 'fiado', valor: 5 }).fiadoBloqueado, true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE tipo_evento = 'fiado_limite_alterado'").get().n, 2);
});

// ---------- baixa com encargos e parcial ----------

test('conta a receber: baixa parcial com juros gera conta do saldo; contábil separa os juros', () => {
  const { locationId, gerenteId } = freshTestDb();
  const { id } = fin.criarRecebivel({ descricao: 'Serviço', valor: 100, vencimento: '2026-10-01', locationId, operadorId: gerenteId });
  assert.match(fin.baixarRecebivel({ id, principal: 120 }).error, /passa do valor/);
  assert.match(fin.baixarRecebivel({ id, principal: 10, desconto: 15 }).error, /desconto/);
  const r = fin.baixarRecebivel({ id, data: '2026-10-15', principal: 60, juros: 3, multa: 2, operadorId: gerenteId });
  assert.equal(r.ok, true);
  assert.equal(r.valorRecebido, 65);
  assert.equal(r.saldo, 40);
  const conta = (x) => getDbFromCtx().prepare('SELECT * FROM receivables WHERE id = ?').get(x);
  assert.deepEqual([conta(id).valor, conta(id).valor_recebido, conta(id).juros, conta(id).multa], [60, 65, 3, 2]);
  assert.deepEqual([conta(r.saldoId).valor, conta(r.saldoId).recebido_em, conta(r.saldoId).parcial_de_id], [40, null, id]);
  const lanc = contabil.lancamentos({ locationId, competencia: '2026-10' });
  assert.equal(lanc.linhas.find((l) => l.historico === 'Contas a receber recebidas').valor, 60);
  assert.equal(lanc.linhas.find((l) => l.historico === 'Juros e multas recebidos').valor, 5);
  const segunda = fin.baixarRecebivel({ id: r.saldoId, data: '2026-10-18', principal: 40, desconto: 4, operadorId: gerenteId });
  assert.equal(segunda.valorRecebido, 36);
  assert.equal(segunda.saldoId, null);
});

test('despesa: baixa parcial de recorrência não quebra o índice único e encargos viram despesa financeira', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  fin.criarRecorrencia({ descricao: 'Aluguel', categoria: 'aluguel', valor: 1000, diaVencimento: 5, competenciaInicio: '2026-10', locationId, operadorId: gerenteId });
  fin.gerarRecorrencias('2026-10-20');
  const despesa = db.prepare("SELECT * FROM expenses WHERE competencia = '2026-10'").get();
  const r = fin.baixarDespesa({ expenseId: despesa.id, data: '2026-10-10', principal: 600, juros: 12, multa: 20, operadorId: gerenteId });
  assert.equal(r.ok, true);
  assert.equal(r.valorPago, 632);
  const saldo = db.prepare('SELECT * FROM expenses WHERE id = ?').get(r.saldoId);
  assert.equal(saldo.valor, 400);
  assert.equal(saldo.recorrencia_id, null);
  assert.equal(saldo.parcial_de_id, despesa.id);
  const lanc = contabil.lancamentos({ locationId, competencia: '2026-10' });
  assert.equal(lanc.linhas.find((l) => l.debito === 'despesa:aluguel').valor, 1000, 'principal reconhecido inteiro');
  assert.equal(lanc.linhas.find((l) => l.debito === 'despesas_financeiras').valor, 32);
  assert.equal(lanc.totalDebitos, lanc.totalCreditos);
  assert.equal(fin.baixarDespesa({ expenseId: despesa.id }).ok, false, 'já paga');
});

// ---------- contabilidade gravada e fechamento ----------

test('contabilidade: manual, estorno, fechamento trava o mês e mantém a foto; reabrir pede motivo', () => {
  const { db, locationId, gerenteId } = freshTestDb();
  assert.match(contabil.lancarManual({ locationId, data: '2026-09-10', debito: 'caixa', credito: 'caixa', valor: 1, historico: 'x', operadorId: gerenteId }).error, /diferentes/);
  assert.match(contabil.lancarManual({ locationId, data: '2026-11-10', debito: 'caixa', credito: 'capital_social', valor: 1, historico: 'x', operadorId: gerenteId }).error, /futura/);
  const capital = contabil.lancarManual({ locationId, data: '2026-09-01', debito: 'banco', credito: 'capital_social', valor: 5000, historico: 'Integralização de capital', operadorId: gerenteId });
  assert.equal(capital.ok, true);
  expenseService.create({ categoria: 'aluguel', descricao: 'Aluguel set', valor: 800, dataVencimento: '2026-09-05', locationId, operadorId: gerenteId });

  const antes = contabil.lancamentos({ locationId, competencia: '2026-09' });
  assert.equal(antes.linhas.some((l) => l.manual && l.valor === 5000), true);
  assert.equal(contabil.fecharMes({ locationId, competencia: '2026-10', operadorId: gerenteId }).ok, false, 'mês corrente não fecha');
  assert.equal(contabil.fecharMes({ locationId, competencia: '2026-09', operadorId: gerenteId }).ok, true);
  assert.equal(contabil.fecharMes({ locationId, competencia: '2026-09', operadorId: gerenteId }).ok, false);

  // Travas.
  assert.equal(expenseService.create({ categoria: 'outro', descricao: 'Atrasada', valor: 10, dataVencimento: '2026-09-20', locationId, operadorId: gerenteId }).periodoFechado, true);
  const aluguel = db.prepare("SELECT id FROM expenses WHERE descricao = 'Aluguel set'").get().id;
  assert.equal(expenseService.remove({ expenseId: aluguel, operadorId: gerenteId }).periodoFechado, true);
  assert.equal(fin.pagarDespesaNaData({ expenseId: aluguel, data: '2026-09-30' }).periodoFechado, true);
  assert.equal(contabil.lancarManual({ locationId, data: '2026-09-15', debito: 'caixa', credito: 'banco', valor: 1, historico: 'saque', operadorId: gerenteId }).periodoFechado, true);
  // Pagar em outubro (aberto) a despesa de setembro: a competência fechada trava a baixa com encargos.
  assert.equal(fin.baixarDespesa({ expenseId: aluguel, data: '2026-10-02', juros: 5 }).periodoFechado, true);
  assert.equal(fin.pagarDespesaNaData({ expenseId: aluguel, data: '2026-10-02' }).ok, true, 'pagamento simples em mês aberto continua');

  // A foto não muda mesmo que algo com data em setembro apareça.
  const depois = contabil.lancamentos({ locationId, competencia: '2026-09' });
  assert.ok(depois.fechado);
  assert.equal(depois.totalDebitos, antes.totalDebitos);

  // Estorno de lançamento de mês fechado vai para hoje (mês aberto).
  const est = contabil.estornarManual({ id: capital.id, motivo: 'valor errado', operadorId: gerenteId });
  assert.equal(est.ok, true);
  assert.equal(contabil.estornarManual({ id: capital.id, operadorId: gerenteId }).ok, false);
  const outubro = contabil.lancamentos({ locationId, competencia: '2026-10' });
  const linhaEstorno = outubro.linhas.find((l) => l.estornoDeId === capital.id);
  assert.equal(linhaEstorno.debito, 'capital_social');
  assert.equal(linhaEstorno.data, '2026-10-20');
  assert.throws(() => db.prepare('UPDATE journal_entries SET valor = 1').run(), /estorno/);

  assert.match(contabil.reabrirMes({ locationId, competencia: '2026-09', motivo: '', operadorId: gerenteId }).error, /por que/);
  assert.equal(contabil.reabrirMes({ locationId, competencia: '2026-09', motivo: 'contador ajustou a provisão', operadorId: gerenteId }).ok, true);
  assert.equal(contabil.lancamentos({ locationId, competencia: '2026-09' }).fechado, null);
  assert.deepEqual(contabil.listarFechamentos({ locationId }), []);
  const tipos = db.prepare("SELECT tipo_evento FROM audit_log WHERE tipo_evento LIKE 'contabil_%' ORDER BY rowid").all().map((r) => r.tipo_evento);
  assert.deepEqual(tipos, ['contabil_lancamento_manual', 'contabil_mes_fechado', 'contabil_estorno', 'contabil_mes_reaberto']);
});

test('contabilidade: razão com saldo corrente e DRE contábil pela classificação das contas', () => {
  const { locationId, gerenteId } = freshTestDb();
  contabil.lancarManual({ locationId, data: '2026-10-01', debito: 'banco', credito: 'capital_social', valor: 1000, historico: 'Capital', operadorId: gerenteId });
  contabil.lancarManual({ locationId, data: '2026-10-02', debito: 'despesa:aluguel', credito: 'banco', valor: 300, historico: 'Aluguel', operadorId: gerenteId });
  contabil.lancarManual({ locationId, data: '2026-10-03', debito: 'banco', credito: 'receita_outras', valor: 500, historico: 'Serviço avulso', operadorId: gerenteId });
  const razao = contabil.razao({ locationId, competencia: '2026-10', conta: 'banco' });
  assert.deepEqual(razao.movimentos.map((m) => m.saldo), [1000, 700, 1200]);
  const dre = contabil.dreContabil({ locationId, competencia: '2026-10' });
  assert.equal(dre.resultado, 200);
  assert.equal(dre.linhas[0].valor, 500);
});

// ---------- natureza da operação ----------

test('natureza da operação: CFOP pela UF de destino e pela ST; CSOSN só na venda do Simples', () => {
  freshTestDb();
  assert.equal(naturezas.cfopPara({ codigo: 'venda_revenda', ufEmitente: 'PE', ufDestino: 'PE' }).cfop, '5102');
  const inter = naturezas.cfopPara({ codigo: 'venda_revenda', ufEmitente: 'PE', ufDestino: 'SP', comSt: true, regime: 'simples_nacional' });
  assert.deepEqual([inter.cfop, inter.interestadual, inter.csosnSugerido], ['6404', true, '500']);
  const dev = naturezas.cfopPara({ codigo: 'devolucao_compra', ufEmitente: 'PE', comSt: true, regime: 'simples_nacional' });
  assert.deepEqual([dev.cfop, dev.finalidade, dev.csosnSugerido], ['5411', 4, null]);
  assert.match(dev.aviso, /chave da nota original/);
  assert.equal(naturezas.cfopPara({ codigo: 'remessa_conserto', ufEmitente: 'PE', comSt: true }).cfop, '5915');
  assert.equal(naturezas.cfopPara({ codigo: 'venda_nao_contribuinte_outra_uf', ufEmitente: 'PE', ufDestino: 'PE' }).ok, false);
  assert.equal(naturezas.cfopPara({ codigo: 'venda_revenda', ufEmitente: 'XX' }).ok, false);
});

// ---------- validadores ----------

test('validadores: CPF, CNPJ numérico e alfanumérico, IE de PE e SP', () => {
  assert.equal(validadores.cpfValido('529.982.247-25'), true);
  assert.equal(validadores.cpfValido('111.111.111-11'), false);
  assert.equal(validadores.cnpjValido('11.222.333/0001-81'), true);
  assert.equal(validadores.cnpjValido('11.222.333/0001-80'), false);
  assert.equal(validadores.cnpjValido('12.ABC.345/01DE-35'), true, 'exemplo oficial do CNPJ alfanumérico');
  assert.equal(validadores.cnpjValido('12abc34501de35'), true, 'minúsculas normalizadas');
  assert.equal(validadores.ieValida('0321418-40', 'PE'), true);
  assert.equal(validadores.ieValida('0321418-41', 'PE'), false);
  assert.equal(validadores.ieValida('110.042.490.114', 'SP'), true);
  assert.equal(validadores.ieValida('ISENTO', 'SP'), true);
  assert.match(validadores.conferirDocumentos({ ie: '123', uf: 'PE' }).error, /PE/);
});

test('cadastros conferem CPF/CNPJ só quando o documento muda', () => {
  const { db } = freshTestDb();
  assert.match(customerService.upsert({ nome: 'João', cpf: '123.456.789-00' }).error, /CPF inválido/);
  const antigo = randomUUID();
  db.prepare("INSERT INTO customers (id, nome, cpf) VALUES (?, 'Antigo', '00000000001')").run(antigo);
  assert.equal(customerService.upsert({ id: antigo, nome: 'Antigo Silva', cpf: '00000000001' }).ok, true, 'documento antigo inalterado passa');
  const supplierService = require('../electron/services/supplierService');
  assert.match(supplierService.upsert({ nome: 'Distribuidora', cnpjCpf: '11222333000180' }).error, /CPF\/CNPJ inválido/);
  assert.equal(supplierService.upsert({ nome: 'Distribuidora', cnpjCpf: '11.222.333/0001-81' }).ok, true);
});

// ---------- Simples: anexos e fator R ----------

test('Simples: anexos II a V e fator R (V → III com folha ≥ 28%)', () => {
  const iii = tabelas.aliquotaEfetivaSimples(300000, 'III');
  assert.equal(iii.faixa, 2);
  assert.equal(iii.efetiva, tabelas.arred((300000 * 0.112 - 9360) / 300000, 6));
  const vAlto = tabelas.aliquotaEfetivaSimples(300000, 'V', { folha12: 90000 });
  assert.deepEqual([vAlto.anexo, vAlto.anexoInformado, vAlto.fatorR], ['III', 'V', 0.3]);
  const vBaixo = tabelas.aliquotaEfetivaSimples(300000, 'V', { folha12: 30000 });
  assert.equal(vBaixo.anexo, 'V');
  assert.equal(tabelas.aliquotaEfetivaSimples(300000, 'V').fatorR, null, 'sem folha informada fica no V');
});

test('ajustes do assistente: anexo validado e gravação tudo-ou-nada', () => {
  freshTestDb();
  assert.match(fin.salvarConfig({ anexoSimples: 'VI' }).error, /Anexo/);
  const antes = fin.getConfig();
  assert.equal(fin.salvarConfig({ rbt12Anterior: 5000, diaPacoteContador: 40 }).ok, false);
  assert.equal(fin.getConfig().rbt12_anterior, antes.rbt12_anterior, 'nada gravado quando um campo é inválido');
  const ok = fin.salvarConfig({ anexoSimples: 'v', folha12Meses: '1200.50' });
  assert.equal(ok.config.anexo_simples, 'V');
  assert.equal(ok.config.folha_12_meses, 1200.5);
});

// ---------- certificado digital ----------

test('certificado: aviso a 30 dias do vencimento, crítico vencido, erro legível sem arquivo', () => {
  const { db } = freshTestDb();
  const forge = require('node-forge');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(AGORA - 300 * 86400000);
  cert.validity.notAfter = new Date(AGORA + 10 * 86400000 + 3600000);
  cert.setSubject([{ name: 'commonName', value: 'LOJA TESTE:11222333000181' }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC TESTE' }]);
  cert.sign(keys.privateKey);
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'senha123', { algorithm: '3des' });
  const arquivo = path.join(os.tmpdir(), `cert-${randomUUID()}.pfx`);
  fs.writeFileSync(arquivo, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  try {
    assert.equal(assistente.avisoCertificado(), null, 'sem certificado configurado');
    db.prepare("UPDATE fiscal_config SET certificado_path = ?, certificado_senha = 'senha123' WHERE id = 'default'").run(arquivo);
    const aviso = assistente.avisoCertificado({ agora: AGORA });
    assert.equal(aviso.nivel, 'aviso');
    assert.match(aviso.texto, /em 10 dia/);
    assert.equal(assistente.avisoCertificado({ agora: AGORA - 40 * 86400000 }), null, 'longe do vencimento');
    assert.equal(assistente.avisoCertificado({ agora: AGORA + 20 * 86400000 }).nivel, 'critico');
    db.prepare("UPDATE fiscal_config SET certificado_senha = 'errada' WHERE id = 'default'").run();
    assert.match(assistente.avisoCertificado().texto, /Não foi possível abrir/);
    db.prepare("UPDATE fiscal_config SET certificado_path = ? WHERE id = 'default'").run(`${arquivo}.sumiu`);
    assert.match(assistente.avisoCertificado().texto, /não foi encontrado/);
  } finally {
    fs.rmSync(arquivo, { force: true });
  }
});
