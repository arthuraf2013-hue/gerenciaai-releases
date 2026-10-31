const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const { montarNfeXml } = require('./helpers/nfeXml');
const nfeEntradaService = require('../electron/services/nfeEntradaService');
const cad = require('../electron/services/cadastroAutomaticoService');
const assistente = require('../electron/services/assistenteFiscalService');
const motor = require('../electron/services/motorTributarioService');
const aiService = require('../electron/services/aiService');

function regime(db, r) {
  db.prepare(`INSERT INTO fiscal_config (id, regime_tributario, uf) VALUES ('default', ?, 'PE')
              ON CONFLICT(id) DO UPDATE SET regime_tributario = excluded.regime_tributario, uf = 'PE'`).run(r);
}
function produto(db, campos) {
  const id = createProduct(db, { nome: campos.nome || 'P' });
  const cols = Object.keys(campos).filter((c) => c !== 'nome');
  if (cols.length) db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => campos[c]), id);
  return id;
}
const CAIXA = { codigo: 'RF2L-06', ean: '17894900011514', eanTrib: '7894900011517', descricao: 'REFRIG COLA PET 2L CX C/6', ncm: '22021000', cfop: '5405', uCom: 'CX', qCom: 4, vUnCom: 37.2, vProd: 148.8, uTrib: 'UN', qTrib: 24, vFrete: 4.8 };
const SOLTO = { codigo: 'BCR130', ean: '7891000315507', descricao: 'BISC RECH CHOC 130G', ncm: '19053100', cfop: '5102', uCom: 'UN', qCom: 30, vUnCom: 1.79, vProd: 53.7 };

test('nome, unidade e preço de prateleira', () => {
  assert.equal(cad.nomeDoProduto('REFRIG COLA PET 2L CX C/6', { tirarEmbalagem: true }), 'Refrig Cola PET 2L');
  assert.equal(cad.nomeDoProduto('  BISC   RECH DE CHOC 130G '), 'Bisc Rech de Choc 130G');
  assert.equal(cad.unidadeDoApp('KG'), 'kg');
  assert.equal(cad.unidadeDoApp('LT'), 'l');
  assert.equal(cad.unidadeDoApp('XYZ'), 'un');
  assert.equal(cad.arredondarPreco(9.43, 'x9'), 9.49);
  assert.equal(cad.arredondarPreco(9.49, 'x9'), 9.49);
  assert.equal(cad.arredondarPreco(9.5, 'x9'), 9.59);
  assert.equal(cad.arredondarPreco(9.43, 'x90'), 9.9);
  assert.equal(cad.arredondarPreco(9.95, 'x90'), 10.9);
  assert.equal(cad.arredondarPreco(9.431, 'nenhum'), 9.43);
  assert.equal(cad.precoSugerido(6.4, 50, 'x9'), 9.69); // 9,60 -> 9,69
  assert.equal(cad.precoSugerido(0, 50, 'x9'), 0);
});

test('prévia da nota: caixa vira produto unitário com EAN da unidade, custo por unidade, preço e fiscal do fornecedor', () => {
  const { db, locationId, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  produto(db, { nome: 'Guaraná 2L', ncm: '22021000', categoria: 'Bebidas', cfop: '5405', cst_csosn: '500', cest: '0300700' });
  const { xml } = montarNfeXml({ itens: [CAIXA, SOLTO] });
  const imp = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  const r = cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 50, arredondamento: 'x9' });
  assert.equal(r.ok, true, r.error);
  const [refri, bisc] = r.itens;
  assert.equal(refri.acao, 'criar');
  assert.equal(refri.nome, 'Refrig Cola PET 2L');
  assert.equal(refri.codigoBarras, '7894900011517');
  assert.equal(refri.unidade, 'un');
  assert.equal(refri.fator, 6);
  assert.equal(refri.custo, 6.4); // (148,80 + 4,80) / 24
  assert.equal(refri.preco, 9.69);
  assert.equal(refri.categoria, 'Bebidas'); // aprendeu com o produto do mesmo NCM
  assert.deepEqual([refri.cfop, refri.cstCsosn, refri.cest], ['5405', '500', '0300700']);
  assert.match(refri.fonteFiscal, /CFOP 5405 do fornecedor/); // o CFOP do fornecedor vale mais que a maioria; o CEST veio da loja
  assert.equal(bisc.fator, 1);
  assert.deepEqual([bisc.cfop, bisc.cstCsosn], ['5102', '102']); // sem histórico: CFOP do fornecedor
  assert.match(bisc.fonteFiscal, /CFOP 5102 do fornecedor/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 1, 'prévia não grava nada');
});

test('cadastrar: cria, vincula a nota, a confirmação funciona e a margem fica lembrada', () => {
  const { db, locationId, operadorId } = freshTestDb();
  regime(db, 'mei');
  const { xml } = montarNfeXml({ itens: [CAIXA, SOLTO] });
  const imp = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  assert.equal(cad.produtosDaNota({ entradaId: imp.id, aplicar: true }).ok, false, 'sem margem padrão ainda');
  const r = cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 40, arredondamento: 'x90', aplicar: true, operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.criados, 2);
  const nota = nfeEntradaService.obter(imp.id);
  assert.equal(nota.pendencias, 0);
  const conf = nfeEntradaService.confirmar({ entradaId: imp.id, locationId, operadorId, deviceId: 't', contaAPagar: { modo: 'nenhuma' } });
  assert.equal(conf.ok, true, conf.error);
  const p = db.prepare("SELECT * FROM products WHERE codigo_barras = '7894900011517'").get();
  assert.equal(p.preco, 9.9); // 6,40 x 1,4 = 8,96 -> termina em ,90 sem ficar abaixo
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'produtos_cadastrados_da_nota'").get());
  assert.deepEqual(cad.configCadastro(db), { margemPadrao: 40, arredondamento: 'x90' });
});

test('EAN repetido na nota e EAN de produto existente: vincula em vez de duplicar; EAN de produto desativado vira aviso', () => {
  const { db, locationId, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  const outro = { ...SOLTO, codigo: 'BCR130B', descricao: 'BISC RECH CHOC 130G PROMO' };
  const sabao = { codigo: 'SB1', ean: '7896000000016', descricao: 'SABAO PO 1KG', ncm: '34022000', cfop: '5102', uCom: 'UN', qCom: 5, vUnCom: 8, vProd: 40 };
  const agua = { codigo: 'AG1', ean: '7896000000023', descricao: 'AGUA 500ML', ncm: '22011000', cfop: '5102', uCom: 'UN', qCom: 5, vUnCom: 1, vProd: 5 };
  const { xml } = montarNfeXml({ itens: [SOLTO, outro, sabao, agua] });
  const imp = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  // depois da importação: um produto ATIVO com o EAN do sabão e um INATIVO com o da água
  const sabaoId = produto(db, { nome: 'Sabão em pó 1kg', codigo_barras: '7896000000016' });
  produto(db, { nome: 'Água antiga', codigo_barras: '7896000000023', ativo: 0 });
  const previa = cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 30 });
  assert.equal(previa.itens.find((i) => i.descricao.startsWith('SABAO')).acao, 'vincular');
  const r = cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 30, aplicar: true, operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.criados, 2); // biscoito (uma vez) + água sem código
  assert.equal(r.vinculados, 2); // segundo biscoito + sabão
  assert.ok(r.avisos.some((a) => /desativado/.test(a)));
  const itens = db.prepare('SELECT descricao, product_id FROM nfe_entrada_itens WHERE entrada_id = ? ORDER BY n_item').all(imp.id);
  assert.equal(itens[0].product_id, itens[1].product_id);
  assert.equal(itens[2].product_id, sabaoId);
  assert.equal(db.prepare('SELECT codigo_barras FROM products WHERE id = ?').get(itens[3].product_id).codigo_barras, null);
});

test('regras: nota confirmada, margem inválida e regime normal sem histórico (fiscal fica vazio e avisa)', () => {
  const { db, locationId, operadorId } = freshTestDb();
  regime(db, 'lucro_presumido');
  const { xml } = montarNfeXml({ itens: [SOLTO] });
  const imp = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  assert.equal(cad.produtosDaNota({ entradaId: imp.id, margemPercentual: -5, aplicar: true }).ok, false);
  assert.equal(cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 30, arredondamento: 'abc', aplicar: true }).ok, false);
  const r = cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 30, aplicar: true, operadorId });
  assert.equal(r.ok, true);
  assert.ok(r.avisos.some((a) => /sem CFOP/.test(a)));
  nfeEntradaService.confirmar({ entradaId: imp.id, locationId, operadorId, deviceId: 't', contaAPagar: { modo: 'nenhuma' } });
  assert.equal(cad.produtosDaNota({ entradaId: imp.id, margemPercentual: 30, aplicar: true }).ok, false);
});

test('confirmar a nota completa CFOP/CSOSN só quando os dois estão vazios (Simples: pelo CFOP do fornecedor)', () => {
  const { db, locationId, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  const vazio = produto(db, { nome: 'Refri', codigo_barras: '7894900011517' });
  const meio = produto(db, { nome: 'Bisc', codigo_barras: '7891000315507', cfop: '5102' });
  const { xml } = montarNfeXml({ itens: [CAIXA, SOLTO] });
  const imp = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  const conf = nfeEntradaService.confirmar({ entradaId: imp.id, locationId, operadorId, deviceId: 't', contaAPagar: { modo: 'nenhuma' } });
  assert.equal(conf.ok, true, conf.error);
  const a = db.prepare('SELECT ncm, cfop, cst_csosn FROM products WHERE id = ?').get(vazio);
  assert.deepEqual([a.ncm, a.cfop, a.cst_csosn], ['22021000', '5405', '500']);
  const b = db.prepare('SELECT cfop, cst_csosn FROM products WHERE id = ?').get(meio);
  assert.deepEqual([b.cfop, b.cst_csosn], ['5102', null], 'meio preenchido não é mexido');
});

test('NCM digitado no cadastro sugere o que a loja usa (maioria); sem histórico, padrão do Simples marcado', () => {
  const { db } = freshTestDb();
  regime(db, 'simples_nacional');
  produto(db, { nome: 'A', ncm: '22021000', cfop: '5405', cst_csosn: '500', cest: '0300700', categoria: 'Bebidas' });
  produto(db, { nome: 'B', ncm: '22021000', cfop: '5405', cst_csosn: '500', cest: '0300700', categoria: 'Bebidas' });
  produto(db, { nome: 'C', ncm: '22021000', cfop: '5102', cst_csosn: '102' });
  produto(db, { nome: 'D', ncm: '22021000', cfop: '5405', cst_csosn: '102' }); // incoerente: não conta
  const r = cad.sugerirPorNcm({ ncm: '2202.10.00' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.fiscal.cfop, r.fiscal.cstCsosn, r.fiscal.cest, r.fiscal.padrao], ['5405', '500', '0300700', false]);
  assert.equal(r.categoria, 'Bebidas');
  const novo = cad.sugerirPorNcm({ ncm: '19053100' });
  assert.equal(novo.fiscal.padrao, true);
  assert.equal(cad.sugerirPorNcm({ ncm: '123' }).ok, false);
  regime(db, 'lucro_real');
  assert.equal(cad.sugerirPorNcm({ ncm: '19053100' }).fiscal, null);
});

test('assistente: produto com NCM e sem nota é completado pelo que a loja usa (não pelo padrão)', () => {
  const { db, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  produto(db, { nome: 'A', ncm: '22021000', cfop: '5405', cst_csosn: '500', cest: '0300700' });
  const alvo = produto(db, { nome: 'Novo', ncm: '22021000' });
  const diag = assistente.diagnosticoCadastro();
  assert.match(diag.produtos.find((p) => p.id === alvo).sugestao.fonte, /mesmo NCM/);
  const r = assistente.aplicarSugestoes({ operadorId });
  assert.ok(r.alterados >= 1);
  const p = db.prepare('SELECT cfop, cst_csosn, cest FROM products WHERE id = ?').get(alvo);
  assert.deepEqual([p.cfop, p.cst_csosn, p.cest], ['5405', '500', '0300700']);
});

test('NCM pela IA: só sugestão validada; aplicar grava onde está vazio e completa o resto pela loja', async () => {
  const { db, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  produto(db, { nome: 'Coca', ncm: '22021000', cfop: '5405', cst_csosn: '500', cest: '0300700' });
  const semNcm = produto(db, { nome: 'Guaraná Antarctica 2L' });
  const outro = produto(db, { nome: 'Coisa estranha' });
  const original = aiService.sugerirNcm;
  aiService.sugerirNcm = async () => ({ ok: true, sugestoes: [
    { produtoId: semNcm, ncm: '2202.10.00', cest: '', descricao: 'Refrigerantes', confianca: 'alta' },
    { produtoId: outro, ncm: '12', confianca: 'alta' },          // inválido: descartado
    { produtoId: 'inventado', ncm: '22021000', confianca: 'alta' }, // não pedido: descartado
  ] });
  try {
    const r = await cad.sugerirNcmComIA({});
    assert.equal(r.ok, true);
    assert.equal(r.sugestoes.length, 1);
    assert.equal(r.sugestoes[0].ncm, '22021000');
    assert.equal(r.sugestoes[0].fiscalDaLoja.cfop, '5405');
    assert.deepEqual(r.semSugestao.map((s) => s.productId), [outro]);
  } finally {
    aiService.sugerirNcm = original;
  }
  assert.equal(cad.aplicarNcm({ itens: [{ productId: semNcm, ncm: '999' }] }).ok, false);
  const ap = cad.aplicarNcm({ itens: [{ productId: semNcm, ncm: '22021000' }], operadorId });
  assert.equal(ap.ok, true);
  assert.equal(ap.ncmGravados, 1);
  assert.equal(ap.completadosPelaLoja, 1);
  const p = db.prepare('SELECT ncm, cfop, cst_csosn, cest FROM products WHERE id = ?').get(semNcm);
  assert.deepEqual([p.ncm, p.cfop, p.cst_csosn, p.cest], ['22021000', '5405', '500', '0300700']);
  // NCM válido já gravado não é trocado
  assert.equal(cad.aplicarNcm({ itens: [{ productId: semNcm, ncm: '19053100' }] }).ncmGravados, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'fiscal_ncm_aplicado'").get());
});

test('motor x cadastro: corrige ST incoerente e vazio, respeita CSOSN válido escolhido pela loja, regra da loja manda', () => {
  const { db, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  const st = produto(db, { nome: 'ST errado', ncm: '22021000', cfop: '5405', cst_csosn: '102' });
  const vazio = produto(db, { nome: 'Vazio', ncm: '19053100', cfop: '5102' });
  const isento = produto(db, { nome: 'Isento', ncm: '07019000', cfop: '5102', cst_csosn: '400' });
  const r = motor.conferirCadastro({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.divergentes.map((d) => d.id).sort(), [st, vazio].sort());
  assert.equal(motor.conferirCadastro({ aplicar: true, operadorId }).aplicados, 2);
  assert.equal(db.prepare('SELECT cst_csosn FROM products WHERE id = ?').get(st).cst_csosn, '500');
  assert.equal(db.prepare('SELECT cst_csosn FROM products WHERE id = ?').get(isento).cst_csosn, '400');
  // a loja cadastra regra para hortifrúti (NCM 07...) com CSOSN 103: agora o motor manda
  motor.criar({ nome: 'Hortifrúti', tributo: 'ICMS', regime: 'simples_nacional', ncmPrefixo: '07', cst: '103', recolhidoNoDas: true, vigenciaInicio: '2020-01-01' });
  const r2 = motor.conferirCadastro({});
  assert.deepEqual(r2.divergentes.map((d) => [d.id, d.indicado, d.motivo]), [[isento, '103', 'regra da loja']]);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'regras_aplicadas_ao_cadastro'").get());
});

test('reajuste pela margem depois da nota: sugere só quem ficou abaixo e confere o preço anterior', () => {
  const { db, locationId, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  const barato = produto(db, { nome: 'Refri', codigo_barras: '7894900011517', preco: 7, custo: 0 });
  const folgado = produto(db, { nome: 'Bisc', codigo_barras: '7891000315507', preco: 9.99, custo: 0 });
  db.prepare("INSERT INTO erp_config (id, margem_padrao, arredondamento_preco) VALUES ('default', 40, 'x9') ON CONFLICT(id) DO UPDATE SET margem_padrao = 40, arredondamento_preco = 'x9'").run();
  const { xml } = montarNfeXml({ itens: [CAIXA, SOLTO] });
  const imp = nfeEntradaService.importarXml({ xml, locationId, operadorId });
  nfeEntradaService.confirmar({ entradaId: imp.id, locationId, operadorId, deviceId: 't', contaAPagar: { modo: 'nenhuma' } });
  const r = cad.reajustePorMargem({ entradaId: imp.id });
  assert.equal(r.margem, 40);
  assert.deepEqual(r.itens.map((i) => [i.productId, i.precoSugerido]), [[barato, 8.99]]); // custo 6,40 x 1,4 = 8,96
  assert.equal(cad.aplicarReajuste({ itens: [{ productId: barato, preco: 8.99, precoAnterior: 6.5 }], operadorId }).ok, false, 'preço mudou no meio tempo');
  assert.equal(cad.aplicarReajuste({ itens: [{ productId: barato, preco: 0, precoAnterior: 7 }], operadorId }).ok, false);
  const ap = cad.aplicarReajuste({ itens: [{ productId: barato, preco: 8.99, precoAnterior: 7 }], operadorId });
  assert.equal(ap.aplicados, 1);
  assert.equal(db.prepare('SELECT preco FROM products WHERE id = ?').get(barato).preco, 8.99);
  assert.equal(db.prepare('SELECT preco FROM products WHERE id = ?').get(folgado).preco, 9.99);
  assert.ok(db.prepare('SELECT 1 FROM product_price_history WHERE product_id = ? AND preco_novo = 8.99').get(barato), 'histórico de preço');
});

test('maioria da loja não passa por cima de CFOP válido diferente (não perde ST)', () => {
  const { db, operadorId } = freshTestDb();
  regime(db, 'simples_nacional');
  produto(db, { nome: 'A', ncm: '22021000', cfop: '5102', cst_csosn: '102' });
  produto(db, { nome: 'B', ncm: '22021000', cfop: '5102', cst_csosn: '102' });
  const st = produto(db, { nome: 'Com ST', ncm: '22021000', cfop: '5405', cst_csosn: '102' });
  const vazio = produto(db, { nome: 'Vazio', ncm: '22021000' });
  assistente.aplicarSugestoes({ operadorId });
  const a = db.prepare('SELECT cfop, cst_csosn FROM products WHERE id = ?').get(st);
  assert.deepEqual([a.cfop, a.cst_csosn], ['5405', '500']);
  const b = db.prepare('SELECT cfop, cst_csosn FROM products WHERE id = ?').get(vazio);
  assert.deepEqual([b.cfop, b.cst_csosn], ['5102', '102']);
});
