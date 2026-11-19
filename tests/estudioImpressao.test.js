const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const layout = require('../electron/services/impressaoLayout');
const estudio = require('../electron/services/estudioImpressaoService');
const printService = require('../electron/services/printService');
const saleService = require('../electron/services/saleService');
const tableService = require('../electron/services/tableService');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ataque = '<img src=x onerror="alert(1)">';

// ---------------------------------------------------------------- configuração

test('configuração: só chaves conhecidas, escolhas e números nos limites', () => {
  const c = layout.normalizarConfig('prenota', {
    fonte: 'comic', tamanho: 'grande', alinhamento: 'esquerda', logoLarguraPct: 500, taxaSugeridaPercentual: 99,
    mostrarMesa: 'sim', titulo: 'x'.repeat(200), extra: 'nada', pixQr: true,
  });
  assert.equal(c.fonte, 'mono');
  assert.equal(c.tamanho, 'grande');
  assert.equal(c.alinhamento, 'esquerda');
  assert.equal(c.logoLarguraPct, 100);
  assert.equal(c.taxaSugeridaPercentual, 30);
  assert.equal(c.mostrarMesa, true, 'valor não booleano fica no padrão');
  assert.equal(c.titulo.length, 60);
  assert.equal(c.extra, undefined);
  assert.equal(c.pixQr, true);
  assert.throws(() => layout.normalizarConfig('cupom', {}));
});

test('logo: só PNG ou JPEG em data URL, e com limite de tamanho', () => {
  assert.equal(layout.normalizarConfig('nota', { logo: PNG }).logo, PNG);
  assert.equal(layout.normalizarConfig('nota', { logo: 'data:image/svg+xml;base64,PHN2Zz4=' }).logo, '');
  assert.equal(layout.normalizarConfig('nota', { logo: 'https://site/logo.png' }).logo, '');
  assert.equal(layout.normalizarConfig('nota', { logo: `data:image/png;base64,${'A'.repeat(layout.LOGO_MAX_CARACTERES)}` }).logo, '');
});

// ---------------------------------------------------------------- pré-nota (desenho)

function contaExemplo(extra = {}) {
  return {
    ...layout.exemplo('prenota', { larguraMm: 80, loja: { nome: 'Loja' } }),
    ...extra,
  };
}

test('pré-nota: sempre "NÃO É DOCUMENTO FISCAL", mesmo com tudo desligado', () => {
  const desligado = Object.fromEntries(Object.entries(layout.PADRAO.prenota).map(([k, v]) => [k, typeof v === 'boolean' ? false : v]));
  const html = layout.montarPreNota({ ...desligado, titulo: '', rodape: '' }, contaExemplo());
  assert.equal(html.match(/NÃO É DOCUMENTO FISCAL/g).length, 2);
});

test('pré-nota: textos do cadastro e do estúdio saem escapados', () => {
  const html = layout.montarPreNota({ cabecalhoTexto: ataque, titulo: ataque, rodape: ataque, nomeLoja: ataque }, contaExemplo({
    itens: [{ nome: ataque, quantidade: 1, precoUnitario: 10, observacao: ataque, pessoaNumero: 1 }],
    pessoas: [{ numero: 1, nome: ataque }], mesa: ataque, operador: ataque,
  }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('pré-nota: conta igual à da tela (itens − desconto + taxa) e a parte de cada pessoa soma o total', () => {
  const d = contaExemplo({ desconto: 10, taxaServicoPercentual: 10 });
  const geral = layout.valoresDaPreNota(d);
  // itens: 54,90 + 19,00 + 79,90 + 6,50 = 160,30; −10 = 150,30; +10% = 165,33
  assert.equal(geral.totalDoc, 165.33);
  const ana = layout.valoresDaPreNota({ ...d, pessoaNumero: 1 });
  const bruno = layout.valoresDaPreNota({ ...d, pessoaNumero: 2 });
  assert.ok(Math.abs(ana.totalDoc + bruno.totalDoc - geral.totalDoc) <= 0.01);
  const html = layout.montarPreNota({}, d);
  assert.match(html, /Ana/);
  assert.match(html, /Bruno/);
  assert.match(html, /Taxa de serviço \(10%\)/);
  assert.match(html, /R\$ 165,33/);
});

test('pré-nota: a parte de uma pessoa bate com a da tela da mesa (contaPorPessoa.js)', async () => {
  const { valorDaPessoa } = await import('../src/utils/contaPorPessoa.js');
  const d = contaExemplo({ desconto: 7.5, taxaServicoPercentual: 10 });
  const subtotalItens = d.itens.reduce((a, i) => a + i.precoUnitario * i.quantidade, 0);
  for (const n of [1, 2]) {
    const subtotalPessoa = d.itens.filter((i) => i.pessoaNumero === n).reduce((a, i) => a + i.precoUnitario * i.quantidade, 0);
    const daTela = valorDaPessoa({ subtotalPessoa, subtotalItens, desconto: 7.5, taxaServicoPercentual: 10 });
    assert.equal(layout.valoresDaPreNota({ ...d, pessoaNumero: n }).totalDoc, daTela);
  }
});

test('pré-nota de uma pessoa: só os itens dela, com o que já pagou e o que falta', () => {
  const html = layout.montarPreNota({}, contaExemplo({ pessoaNumero: 2, pagoPorPessoa: { 2: 20 } }));
  assert.match(html, /Picanha/);
  assert.doesNotMatch(html, /Feijoada/);
  assert.match(html, /Conta de: Bruno/);
  assert.match(html, /Falta pagar/);
});

test('pré-nota: sugestão de serviço só quando a conta não tem taxa; Pix só com valor a pagar', () => {
  const semTaxa = contaExemplo({ taxaServicoPercentual: 0 });
  assert.match(layout.montarPreNota({ taxaSugeridaPercentual: 10 }, semTaxa), /Serviço opcional \(10%\)/);
  assert.doesNotMatch(layout.montarPreNota({ taxaSugeridaPercentual: 10 }, contaExemplo()), /Serviço opcional/);
  const pix = { qrDataUrl: PNG, copiaCola: '000201...' };
  assert.match(layout.montarPreNota({ pixQr: true }, contaExemplo({ pix })), /Pague com Pix/);
  assert.doesNotMatch(layout.montarPreNota({ pixQr: false }, contaExemplo({ pix })), /Pague com Pix/);
  const quitada = contaExemplo({ pix, totalPago: 1000 });
  assert.doesNotMatch(layout.montarPreNota({ pixQr: true }, quitada), /Pague com Pix/);
});

// ---------------------------------------------------------------- nota (recibo)

const vendaNota = { id: 'abcdef1234', finalizada_em: '2026-11-18 12:00:00', total: 10, desconto: 0, desconto_gerente: 0, taxa_servico_percentual: 0 };

test('nota: o estúdio muda o recibo de verdade (título, atendente, pagamentos)', () => {
  const ctx = freshTestDb();
  void ctx;
  const antes = printService.buildReceiptHtml(vendaNota, [{ nome: 'Café', quantidade: 1, preco_unitario: 10 }], [{ metodo: 'pix', valor: 10 }], { nome: 'Loja' }, 80, 'Volte sempre', null, null, null, { operador: 'Carla' });
  assert.doesNotMatch(antes, /Atendente/);
  assert.match(antes, /<span>Pix<\/span>/);
  assert.equal(estudio.salvar({ tipo: 'nota', config: { titulo: 'RECIBO DE VENDA', mostrarOperador: true, mostrarPagamentos: false } }).ok, true);
  const depois = printService.buildReceiptHtml(vendaNota, [{ nome: 'Café', quantidade: 1, preco_unitario: 10 }], [{ metodo: 'pix', valor: 10 }], { nome: 'Loja' }, 80, 'Volte sempre', null, null, null, { operador: 'Carla' });
  assert.match(depois, /RECIBO DE VENDA/);
  assert.match(depois, /Atendente: Carla/);
  assert.doesNotMatch(depois, /<span>Pix<\/span>/);
  assert.match(depois, /Volte sempre/);
});

test('nota: bloco da NFC-e sai mesmo com o estúdio escondendo tudo', () => {
  freshTestDb();
  const tudoDesligado = Object.fromEntries(Object.entries(layout.PADRAO.nota).map(([k, v]) => [k, typeof v === 'boolean' ? false : v]));
  estudio.salvar({ tipo: 'nota', config: tudoDesligado });
  const nfce = { status: 'autorizada', numero: 12, serie: '1', chave_acesso: '35260800000000019100650010000000011234567890', protocolo_autorizacao: '135260000000123' };
  const html = printService.buildReceiptHtml(vendaNota, [{ nome: 'Café', quantidade: 1, preco_unitario: 10 }], [], { nome: 'Loja' }, 80, '', nfce, null);
  assert.match(html, /NFC-e nº 12/);
  assert.match(html, /Protocolo de autorização/);
});

// ---------------------------------------------------------------- serviço (banco)

test('estúdio: salvar, ler, padrão e rodapé da nota no mesmo lugar do WhatsApp', () => {
  const ctx = freshTestDb();
  assert.deepEqual(estudio.getConfig('prenota'), layout.normalizarConfig('prenota', {}));
  const r = estudio.salvar({ tipo: 'prenota', config: { logo: PNG, fonte: 'sans', titulo: 'CONFIRA' } });
  assert.equal(r.ok, true);
  assert.equal(estudio.getConfig('prenota').fonte, 'sans');
  assert.equal(estudio.getConfig('prenota').logo, PNG);
  assert.equal(estudio.salvar({ tipo: 'prenota', config: { logo: 'data:image/svg+xml;base64,PHN2Zz4=' } }).ok, false, 'logo inválida avisa');
  assert.equal(estudio.salvar({ tipo: 'nota', config: {}, rodapeNota: 'Volte sempre!' }).ok, true);
  assert.equal(ctx.db.prepare("SELECT rodape_texto FROM receipt_config WHERE id = 'default'").get().rodape_texto, 'Volte sempre!');
  assert.equal(estudio.restaurarPadrao({ tipo: 'prenota' }).config.fonte, 'mono');
  assert.equal(estudio.salvar({ tipo: 'outro', config: {} }).ok, false);
  const tudo = estudio.getTudo();
  assert.equal(tudo.ok, true);
  assert.equal(tudo.rodapeNota, 'Volte sempre!');
});

test('prévia do estúdio: usa a configuração da tela, sem gravar nada', async () => {
  const ctx = freshTestDb();
  const r = await estudio.previa({ tipo: 'prenota', config: { titulo: 'TESTE DA TELA' }, larguraMm: 58 });
  assert.equal(r.ok, true);
  assert.match(r.html, /TESTE DA TELA/);
  assert.match(r.html, /58mm/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM impressao_estudio').get().n, 0);
  assert.match((await estudio.previa({ tipo: 'nota', config: {} })).html, /Feijoada/);
});

function contaAberta(ctx) {
  const p1 = createProduct(ctx.db, { nome: 'Pizza', preco: 50 });
  const p2 = createProduct(ctx.db, { nome: 'Suco', preco: 10 });
  for (const p of [p1, p2]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const add = (productId, pessoaNumero, observacao) => saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd', pessoaNumero, observacao });
  add(p1, 1, 'sem cebola'); add(p2, 1); add(p2, 2);
  return saleId;
}

test('pré-nota de uma conta de verdade: itens, observação, taxa e já pago; nada muda na venda', async () => {
  const ctx = freshTestDb();
  const saleId = contaAberta(ctx);
  saleService.setServiceCharge(saleId, 10);
  const pg = saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 11, detalhes: {} });
  saleService.marcarPagamentoPessoa({ saleId, paymentId: pg.id || pg.paymentId, pessoaNumero: 2 });
  const antes = ctx.db.prepare('SELECT status, total FROM sales WHERE id = ?').get(saleId);

  const r = await estudio.htmlDaPreNota({ saleId });
  assert.equal(r.ok, true);
  assert.match(r.html, /Pizza/);
  assert.match(r.html, /sem cebola/);
  assert.match(r.html, /Taxa de serviço \(10%\)/);
  assert.match(r.html, /R\$ 77,00/); // (50+10+10) × 1,1
  assert.match(r.html, /Falta pagar/);
  assert.match(r.html, /R\$ 66,00/);

  const soDois = await estudio.htmlDaPreNota({ saleId, pessoaNumero: 2 });
  assert.equal(soDois.ok, true);
  assert.doesNotMatch(soDois.html, /Pizza/);
  assert.match(soDois.html, /Total da parte<\/span><span>R\$ 11,00/);

  assert.equal((await estudio.htmlDaPreNota({ saleId, pessoaNumero: 5 })).ok, false);
  assert.deepEqual(ctx.db.prepare('SELECT status, total FROM sales WHERE id = ?').get(saleId), antes);
});

test('pré-nota: conta fechada, vazia ou inexistente avisa em vez de imprimir', async () => {
  const ctx = freshTestDb();
  const { id: vazia } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.match((await estudio.htmlDaPreNota({ saleId: vazia })).error, /não tem itens/);
  assert.equal((await estudio.htmlDaPreNota({ saleId: 'nao-existe' })).ok, false);
  const saleId = contaAberta(ctx);
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 70, detalhes: {} });
  saleService.finalizeSale(saleId);
  assert.match((await estudio.htmlDaPreNota({ saleId })).error, /já foi fechada/);
});

test('pré-nota na mesa: mostra o nome da mesa e as pessoas com nome', async () => {
  const ctx = freshTestDb();
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '7' });
  const mesaId = mesa.id || mesa.tableId;
  const aberta = tableService.openTable({ tableId: mesaId, locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 2 });
  const p = createProduct(ctx.db, { nome: 'Pastel', preco: 8 });
  addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  saleService.addItem({ saleId: aberta.saleId, productId: p, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.operadorId, deviceId: 'd', pessoaNumero: 1 });
  tableService.renomearPessoa({ tableId: mesaId, numero: 1, nome: 'Marina' });
  const r = await estudio.htmlDaPreNota({ saleId: aberta.saleId });
  assert.equal(r.ok, true);
  assert.match(r.html, /Mesa: Mesa 7/);
  assert.match(r.html, /Marina/);
});

// ---------------------------------------------------------------- número da mesa na nota

test('nota: número da mesa em destaque (maior e em negrito) por padrão; no balcão não sai nada', () => {
  freshTestDb();
  const itens = [{ nome: 'Café', quantidade: 1, preco_unitario: 10 }];
  const daMesa = printService.buildReceiptHtml(vendaNota, itens, [], { nome: 'Loja' }, 80, '', null, null, null, { mesa: 'Mesa 7' });
  // 80mm, letra normal = 11px; "grande" = 17px
  assert.match(daMesa, /<p class="mesa" style="font-size:17px;font-weight:bold;">Mesa 7<\/p>/);
  assert.doesNotMatch(daMesa, /Mesa: Mesa 7/);
  const balcao = printService.buildReceiptHtml(vendaNota, itens, [], { nome: 'Loja' }, 80, '', null, null, null, {});
  assert.doesNotMatch(balcao, /class="mesa"/);
  assert.doesNotMatch(balcao, /Mesa/);
});

test('nota: o estúdio muda tamanho, negrito e pode esconder a mesa', () => {
  const d = layout.exemplo('nota', { larguraMm: 80, loja: { nome: 'Loja' } });
  assert.match(layout.montarNota({ mesaTamanho: 'enorme' }, d), /font-size:24px;font-weight:bold;">Mesa 7/);
  assert.match(layout.montarNota({ mesaTamanho: 'grande', mesaNegrito: false }, d), /font-size:17px;font-weight:normal;">Mesa 7/);
  // normal e sem negrito: volta para a linha de informações, como na pré-nota antiga
  const simples = layout.montarNota({ mesaTamanho: 'normal', mesaNegrito: false }, d);
  assert.doesNotMatch(simples, /class="mesa"/);
  assert.match(simples, /Mesa: Mesa 7/);
  assert.doesNotMatch(layout.montarNota({ mostrarMesa: false }, d), /Mesa 7/);
  assert.equal(layout.normalizarConfig('nota', { mesaTamanho: 'gigante' }).mesaTamanho, 'grande');
  assert.match(layout.montarNota({}, { ...d, mesa: ataque }), /&lt;img src=x/);
  assert.doesNotMatch(layout.montarNota({}, { ...d, mesa: ataque }), /<img src=x/);
});

test('pré-nota: continua com "Mesa: 7" na linha de informações até a loja escolher destacar', () => {
  const d = contaExemplo();
  assert.match(layout.montarPreNota({}, d), /Mesa: Mesa 7/);
  const destacada = layout.montarPreNota({ mesaTamanho: 'grande', mesaNegrito: true }, d);
  assert.match(destacada, /class="mesa"[^>]*>Mesa 7</);
  assert.doesNotMatch(destacada, /Mesa: Mesa 7/);
});

test('nota da venda de mesa finalizada: acha a mesa (e as unidas) mesmo depois de a mesa ser liberada', () => {
  const ctx = freshTestDb();
  const m7 = tableService.createTable({ locationId: ctx.locationId, numero: '7' });
  const m8 = tableService.createTable({ locationId: ctx.locationId, numero: '8' });
  const id7 = m7.id || m7.tableId;
  const id8 = m8.id || m8.tableId;
  const aberta = tableService.openTable({ tableId: id7, locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 2 });
  const juntou = tableService.juntarMesas({ tableId: id7, mesaIds: [id8], currentOperatorId: ctx.operadorId });
  assert.notEqual(juntou?.ok, false, juntou?.error);
  const p = createProduct(ctx.db, { nome: 'Pastel', preco: 8 });
  addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  saleService.addItem({ saleId: aberta.saleId, productId: p, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  assert.equal(printService.mesaDaVenda(ctx.db, aberta.saleId), 'Mesa 7 + 8', 'reimpressão com a mesa ainda aberta');
  saleService.addPayment({ saleId: aberta.saleId, metodo: 'dinheiro', valor: 8, detalhes: {} });
  assert.equal(saleService.finalizeSale(aberta.saleId).ok, true);
  tableService.liberarMesaDaVenda(aberta.saleId);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM restaurant_tables WHERE sale_id = ?').get(aberta.saleId).n, 0);
  assert.equal(printService.mesaDaVenda(ctx.db, aberta.saleId), 'Mesa 7 + 8');

  const { id: balcao } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.equal(printService.mesaDaVenda(ctx.db, balcao), null);
});
