const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { freshTestDb, createProduct, createFinalizedSale } = require('./helpers/testDb');
const { montarNfeXml } = require('./helpers/nfeXml');
const tabelas = require('../electron/services/tabelasFiscais');
const assistente = require('../electron/services/assistenteFiscalService');
const fin = require('../electron/services/financeiroService');
const nfeEntradaService = require('../electron/services/nfeEntradaService');

const AGORA = new Date('2026-10-15T15:00:00.000Z').getTime();
const dateNowOriginal = Date.now;
test.beforeEach(() => { Date.now = () => AGORA; });
test.afterEach(() => { Date.now = dateNowOriginal; });

function regime(db, r) {
  db.prepare(`INSERT INTO fiscal_config (id, regime_tributario, cnpj, razao_social) VALUES ('default', ?, '12.345.678/0001-90', 'Mercadinho Teste')
    ON CONFLICT(id) DO UPDATE SET regime_tributario = excluded.regime_tributario, cnpj = excluded.cnpj, razao_social = excluded.razao_social`).run(r);
}

// ---------- tabelas ----------

test('Anexo I: faixas, alíquota efetiva e acima do limite', () => {
  assert.equal(tabelas.aliquotaEfetivaAnexoI(100000).efetiva, 0.04);
  const f3 = tabelas.aliquotaEfetivaAnexoI(370000.01);
  assert.equal(f3.faixa, 3);
  assert.equal(Math.round(f3.efetiva * 10000) / 100, 5.75);
  assert.equal(tabelas.aliquotaEfetivaAnexoI(180000).faixa, 1);
  assert.equal(tabelas.aliquotaEfetivaAnexoI(180000.01).faixa, 2);
  assert.equal(tabelas.aliquotaEfetivaAnexoI(5000000).acimaDoLimite, true);
});

test('DAS-MEI 2026 por atividade e ano sem salário mínimo conhecido vira estimado', () => {
  assert.equal(tabelas.dasMei(2026, 'comercio').valor, 82.05);
  assert.equal(tabelas.dasMei(2026, 'servicos').valor, 86.05);
  assert.equal(tabelas.dasMei(2026, 'ambos').valor, 87.05);
  assert.equal(tabelas.dasMei(2027).estimado, true);
  assert.equal(tabelas.dasMei(2025).valor, 76.9);
});

test('limite do MEI proporcional no ano da abertura (aberta em junho: 7 meses)', () => {
  assert.deepEqual(tabelas.limiteMei(2026, '2026-06-10'), { limite: 47250, comTolerancia: 56700, meses: 7 });
  assert.equal(tabelas.limiteMei(2026, '2024-01-01').limite, 81000);
  assert.equal(tabelas.limiteMei(2026, null).comTolerancia, 97200);
});

// ---------- RBT12 e painel ----------

function vendaNoMes(c, p, comp, valor) {
  return createFinalizedSale(c.db, { locationId: c.locationId, operadorId: c.gerenteId, finalizadaEm: `${comp}-10 15:00:00`,
    itens: [{ productId: p, quantidade: 1, preco: valor }], pagamentos: [['pix', valor]] });
}

test('RBT12: soma dos 12 meses anteriores; empresa nova usa média × 12 e 1º mês × 12', () => {
  const c = freshTestDb();
  const p = createProduct(c.db, { preco: 1 });
  for (const comp of fin.competenciasEntre('2025-10', '2026-09')) vendaNoMes(c, p, comp, 1000);
  vendaNoMes(c, p, '2026-10', 5000);
  assert.equal(assistente.rbt12({ locationId: c.locationId, competencia: '2026-10' }).valor, 12000);

  fin.salvarConfig({ dataAberturaEmpresa: '2026-08-05' });
  const prop = assistente.rbt12({ locationId: c.locationId, competencia: '2026-10' });
  assert.equal(prop.base, 'proporcional');
  assert.equal(prop.valor, 12000, '(1000 + 1000) / 2 × 12');
  fin.salvarConfig({ dataAberturaEmpresa: '2026-10-01' });
  assert.deepEqual([assistente.rbt12({ locationId: c.locationId, competencia: '2026-10' }).base, assistente.rbt12({ locationId: c.locationId, competencia: '2026-10' }).valor], ['primeiro_mes', 60000]);
});

test('RBT12 com histórico curto completa com o faturamento anterior informado', () => {
  const c = freshTestDb();
  const p = createProduct(c.db, { preco: 1 });
  vendaNoMes(c, p, '2026-08', 2000);
  vendaNoMes(c, p, '2026-09', 2000);
  const sem = assistente.rbt12({ locationId: c.locationId, competencia: '2026-10' });
  assert.equal(sem.valor, 4000);
  assert.equal(sem.estimado, true);
  fin.salvarConfig({ rbt12Anterior: 24000 });
  const com = assistente.rbt12({ locationId: c.locationId, competencia: '2026-10' });
  assert.equal(com.valor, 10 * 2000 + 4000);
  assert.equal(com.mesesCompletados, 10);
});

test('painel do MEI: acumulado, % do limite e alerta perto do teto', () => {
  const c = freshTestDb();
  regime(c.db, 'mei');
  const p = createProduct(c.db, { preco: 1 });
  for (const comp of fin.competenciasEntre('2026-01', '2026-09')) vendaNoMes(c, p, comp, 7300);
  const r = assistente.painel({ locationId: c.locationId, ano: 2026 });
  assert.equal(r.acumulado, 65700);
  assert.equal(r.limite.tipo, 'mei');
  assert.equal(r.limite.usadoPercentual, 81.1);
  assert.match(r.avisos.map((a) => a.texto).join(' '), /81\.1% do limite/);
  assert.equal(r.imposto.valorMensal, 82.05);
  vendaNoMes(c, p, '2026-10', 20000);
  const passou = assistente.painel({ locationId: c.locationId, ano: 2026 });
  assert.equal(passou.avisos[0].nivel, 'critico');
  assert.match(passou.avisos[0].texto, /passou do limite do MEI/);
});

test('painel do Simples: DAS estimado do mês = receita × efetiva', () => {
  const c = freshTestDb();
  regime(c.db, 'simples_nacional');
  const p = createProduct(c.db, { preco: 1 });
  for (const comp of fin.competenciasEntre('2025-10', '2026-09')) vendaNoMes(c, p, comp, 30000.01 / 1); // RBT12 = 360.000,12
  vendaNoMes(c, p, '2026-10', 10000);
  const r = assistente.painel({ locationId: c.locationId, ano: 2026 });
  assert.equal(r.imposto.faixa, 3);
  assert.equal(r.imposto.dasEstimado, Math.round(10000 * r.imposto.efetiva * 100) / 100);
});

test('calendário: DAS do MEI dia 20, relatório mensal, pacote do contador e DASN; fim de semana marcado', () => {
  freshTestDb();
  const itens = assistente.calendario({ hoje: '2026-10-15', regime: 'mei', dias: 240 });
  const titulos = itens.map((i) => `${i.data} ${i.titulo}`);
  assert.ok(titulos.includes('2026-10-20 DAS-MEI'));
  assert.ok(titulos.includes('2026-10-20 Relatório mensal de receitas (MEI)'));
  assert.ok(titulos.includes('2026-11-05 Pacote do contador'));
  assert.ok(titulos.includes('2027-05-31 DASN-SIMEI'));
  assert.equal(itens.find((i) => i.data === '2026-12-20').fimDeSemana, true, '20/12/2026 é domingo');
  assert.ok(!titulos.some((t) => t.includes('DEFIS')));
});

// ---------- saúde fiscal do cadastro ----------

test('diagnóstico aponta NCM, CFOP, CSOSN, ST e CEST; serviço fica de fora', () => {
  const c = freshTestDb();
  regime(c.db, 'simples_nacional');
  const ok = createProduct(c.db, { nome: 'Certo' });
  c.db.prepare(`UPDATE products SET ncm = '22021000', cfop = '5102', cst_csosn = '102' WHERE id = ?`).run(ok);
  const ruim = createProduct(c.db, { nome: 'Ruim' });
  c.db.prepare(`UPDATE products SET ncm = '2202', cfop = '6102', cst_csosn = '00', cest = '123' WHERE id = ?`).run(ruim);
  const st = createProduct(c.db, { nome: 'ST sem CEST' });
  c.db.prepare(`UPDATE products SET ncm = '22021000', cfop = '5405', cst_csosn = '102' WHERE id = ?`).run(st);
  createProduct(c.db, { nome: 'Corte de cabelo', tipo: 'servico' });
  const d = assistente.diagnosticoCadastro();
  assert.equal(d.totalProdutos, 3);
  assert.equal(d.comProblema, 2);
  const porNome = Object.fromEntries(d.produtos.map((p) => [p.nome, p.problemas.sort()]));
  assert.deepEqual(porNome.Ruim, ['cest_invalido', 'cfop_invalido', 'csosn_invalido', 'ncm_invalido'].sort());
  assert.deepEqual(porNome['ST sem CEST'], ['cest_faltando', 'st_inconsistente'].sort());
});

function confirmarNotaComSt(c, productId, { cfop, ncm = '22021000', cest = '0300700' } = {}) {
  c.db.prepare(`UPDATE products SET codigo_barras = '7891000100103' WHERE id = ?`).run(productId);
  const { xml } = montarNfeXml({ itens: [{ codigo: 'R1', ean: '7891000100103', descricao: 'REFRI', qCom: 6, vUnCom: 5, vProd: 30, cfop, ncm }] });
  const xmlComCest = xml.replace('<NCM>', `<CEST>${cest}</CEST><NCM>`).replace(/<CEST>(\d+)<\/CEST><NCM>(\d+)<\/NCM>/, '<NCM>$2</NCM><CEST>$1</CEST>');
  const r = nfeEntradaService.importarXml({ xml: xmlComCest, locationId: c.locationId, operadorId: c.gerenteId });
  assert.equal(r.ok, true, r.error);
  return nfeEntradaService.confirmar({ entradaId: r.id, locationId: c.locationId, operadorId: c.gerenteId, deviceId: 'd', contaAPagar: { modo: 'nenhuma' } });
}

test('entrada da NF-e preenche NCM e CEST vazios do produto, sem sobrescrever', () => {
  const c = freshTestDb();
  const p = createProduct(c.db, { nome: 'Refri' });
  const r = confirmarNotaComSt(c, p, { cfop: '5405' });
  assert.equal(r.fiscalPreenchidos, 1);
  assert.deepEqual(c.db.prepare('SELECT ncm, cest FROM products WHERE id = ?').get(p), { ncm: '22021000', cest: '0300700' });

  const c2 = freshTestDb();
  const p2 = createProduct(c2.db, { nome: 'Refri' });
  c2.db.prepare(`UPDATE products SET ncm = '22029900' WHERE id = ?`).run(p2);
  confirmarNotaComSt(c2, p2, { cfop: '5405' });
  assert.equal(c2.db.prepare('SELECT ncm FROM products WHERE id = ?').get(p2).ncm, '22029900');
});

test('aplicar sugestões: compra com ST vira 5405/500 + CEST; padrão 5102/102 só com permissão; valor válido não muda', () => {
  const c = freshTestDb();
  regime(c.db, 'simples_nacional');
  const comSt = createProduct(c.db, { nome: 'Refri' });
  confirmarNotaComSt(c, comSt, { cfop: '5405' });
  c.db.prepare(`UPDATE products SET cest = NULL WHERE id = ?`).run(comSt);
  const semNota = createProduct(c.db, { nome: 'Sem nota' });
  const valido = createProduct(c.db, { nome: 'Válido' });
  c.db.prepare(`UPDATE products SET ncm = '19053100', cfop = '5102', cst_csosn = '102' WHERE id = ?`).run(valido);

  const d = assistente.diagnosticoCadastro();
  assert.equal(d.produtos.find((p) => p.id === comSt).sugestao.st, true);
  assert.equal(d.sugestoesDeNota, 1);

  let r = assistente.aplicarSugestoes({ operadorId: c.gerenteId });
  assert.equal(r.alterados, 1);
  assert.deepEqual(c.db.prepare('SELECT ncm, cest, cfop, cst_csosn FROM products WHERE id = ?').get(comSt),
    { ncm: '22021000', cest: '0300700', cfop: '5405', cst_csosn: '500' });
  assert.equal(c.db.prepare('SELECT cfop FROM products WHERE id = ?').get(semNota).cfop, null);

  r = assistente.aplicarSugestoes({ incluirPadrao: true, operadorId: c.gerenteId });
  assert.equal(r.alterados, 1);
  assert.deepEqual(c.db.prepare('SELECT cfop, cst_csosn FROM products WHERE id = ?').get(semNota), { cfop: '5102', cst_csosn: '102' });
  assert.deepEqual(c.db.prepare('SELECT ncm, cfop FROM products WHERE id = ?').get(valido), { ncm: '19053100', cfop: '5102' });
  assert.ok(c.db.prepare(`SELECT 1 FROM audit_log WHERE tipo_evento = 'fiscal_cadastro_corrigido'`).get());
});

// ---------- relatório do MEI e pacote do contador ----------

test('relatório mensal do MEI: comércio x serviço, com e sem NFC-e, desconto rateado e devolução', () => {
  const c = freshTestDb();
  regime(c.db, 'mei');
  const prod = createProduct(c.db, { nome: 'Ração' });
  const serv = createProduct(c.db, { nome: 'Banho', tipo: 'servico' });
  const v1 = createFinalizedSale(c.db, { locationId: c.locationId, operadorId: c.gerenteId, finalizadaEm: '2026-09-10 15:00:00',
    itens: [{ productId: prod, quantidade: 1, preco: 60 }, { productId: serv, quantidade: 1, preco: 40 }], pagamentos: [['pix', 90]], desconto: 10 });
  const v2 = createFinalizedSale(c.db, { locationId: c.locationId, operadorId: c.gerenteId, finalizadaEm: '2026-09-11 15:00:00',
    itens: [{ productId: prod, quantidade: 2, preco: 50 }], pagamentos: [['dinheiro', 100]] });
  c.db.prepare(`INSERT INTO nfce_emitidas (id, sale_id, status) VALUES (?, ?, 'autorizada')`).run(randomUUID(), v2);
  c.db.prepare(`INSERT INTO returns (id, sale_id, location_id, operador_id, autorizado_por_id, valor_devolvido, criado_em) VALUES ('r', ?, ?, ?, ?, 50, '2026-09-20 15:00:00')`)
    .run(v2, c.locationId, c.gerenteId, c.gerenteId);
  const r = assistente.relatorioMei({ locationId: c.locationId, competencia: '2026-09' });
  assert.deepEqual(r.linhas, { I: 54, II: 50, III: 104, IV: 0, V: 0, VI: 0, VII: 36, VIII: 0, IX: 36, X: 140 });
  const html = assistente.htmlRelatorioMei(r);
  assert.match(html, /RELATÓRIO MENSAL DAS RECEITAS BRUTAS/);
  assert.match(html, /Mercadinho Teste/);
  assert.match(html, /01\/09\/2026 a 30\/09\/2026/);
  assert.equal(assistente.escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
});

test('pacote do contador: planilhas, XML das compras e das NFC-e, relatório do MEI e LEIA-ME', async () => {
  const c = freshTestDb();
  regime(c.db, 'mei');
  const p = createProduct(c.db, { nome: 'Refri' });
  c.db.prepare(`UPDATE products SET codigo_barras = '7891000100103' WHERE id = ?`).run(p);
  const v = createFinalizedSale(c.db, { locationId: c.locationId, operadorId: c.gerenteId, finalizadaEm: '2026-10-05 15:00:00',
    itens: [{ productId: p, quantidade: 1, preco: 10 }], pagamentos: [['pix', 10]] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfce-'));
  const xmlNfce = path.join(dir, 'nota.xml');
  fs.writeFileSync(xmlNfce, '<nfeProc/>');
  c.db.prepare(`INSERT INTO nfce_emitidas (id, sale_id, status, chave_acesso, xml_path, criado_em) VALUES (?, ?, 'autorizada', '2626', ?, '2026-10-05 15:00:00')`).run(randomUUID(), v, xmlNfce);
  c.db.prepare(`INSERT INTO nfce_emitidas (id, sale_id, status, chave_acesso, xml_path, criado_em) VALUES (?, ?, 'autorizada', '2627', ?, '2026-10-05 15:00:01')`).run(randomUUID(), v, path.join(dir, 'sumiu.xml'));
  const { xml } = montarNfeXml({ itens: [{ codigo: 'R1', ean: '7891000100103', descricao: 'REFRI', qCom: 6, vUnCom: 5, vProd: 30 }] });
  const e = nfeEntradaService.importarXml({ xml, locationId: c.locationId, operadorId: c.gerenteId });
  nfeEntradaService.confirmar({ entradaId: e.id, locationId: c.locationId, operadorId: c.gerenteId, deviceId: 'd', contaAPagar: { modo: 'nenhuma' } });

  const r = await assistente.pacoteContador({ locationId: c.locationId, competencia: '2026-10' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nomeSugerido, 'contador-2026-10.zip');
  const zip = await JSZip.loadAsync(r.buffer);
  const nomes = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  const chave = c.db.prepare('SELECT chave FROM nfe_entradas').get().chave;
  assert.deepEqual(nomes, ['LEIA-ME.txt', 'compras-2026-10.xlsx', 'contabil-2026-10.xlsx', 'financeiro-2026-10.xlsx', 'relatorio-mensal-receitas-mei-2026-10.html',
    'vendas-2026-10.xlsx', `xml/compras/${chave}.xml`, 'xml/nfce/2626.xml'].sort());
  assert.match(await zip.file('LEIA-ME.txt').async('string'), /1 NFC-e sem o arquivo XML/);
  assert.equal(r.resumo.vendas, 1);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await zip.file('vendas-2026-10.xlsx').async('nodebuffer'));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Resumo', 'Vendas', 'Por tributação']);
  assert.equal(wb.getWorksheet('Vendas').rowCount, 2);
});
