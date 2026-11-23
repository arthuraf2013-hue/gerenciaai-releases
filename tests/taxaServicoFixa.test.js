const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const taxa = require('../electron/services/taxaServicoService');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');
const estudio = require('../electron/services/estudioImpressaoService');
const printService = require('../electron/services/printService');

function mesaComItem(ctx, { numero = '7', preco = 50 } = {}) {
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero });
  const tableId = mesa.id || mesa.tableId;
  const aberta = tableService.openTable({ tableId, locationId: ctx.locationId, operadorId: ctx.operadorId, pessoas: 2 });
  assert.equal(aberta.ok, true, aberta.error);
  const p = createProduct(ctx.db, { nome: 'Charque', preco });
  addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const r = saleService.addItem({ saleId: aberta.saleId, productId: p, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd', pessoaNumero: 1 });
  assert.notEqual(r?.ok, false, r?.error);
  return { tableId, saleId: aberta.saleId };
}

const taxaDaVenda = (db, saleId) => db.prepare('SELECT taxa_servico_percentual AS t FROM sales WHERE id = ?').get(saleId).t;

test('começa desligada com 10%; salvar valida a % e registra na Auditoria só quando muda', () => {
  const { db, gerenteId } = freshTestDb();
  assert.deepEqual(taxa.getConfig(), { ok: true, ativa: false, percentual: 10 });
  assert.equal(taxa.percentualFixo(), 0);
  assert.equal(taxa.percentualSugerido(), 10);

  for (const ruim of [0, -5, 31, 'abc']) {
    const r = taxa.salvar({ ativa: true, percentual: ruim, operadorId: gerenteId });
    assert.equal(r.ok, false, String(ruim));
    assert.match(r.error, /inválida/);
  }
  assert.equal(taxa.getConfig().ativa, false, 'valor ruim não grava nada');

  const r = taxa.salvar({ ativa: true, percentual: '12,5', operadorId: gerenteId });
  assert.deepEqual(r, { ok: true, ativa: true, percentual: 12.5 });
  assert.equal(taxa.percentualFixo(), 12.5);
  assert.equal(taxa.percentualSugerido(), 12.5);
  taxa.salvar({ ativa: true, percentual: 12.5, operadorId: gerenteId });
  const eventos = db.prepare("SELECT * FROM audit_log WHERE tipo_evento = 'taxa_servico_fixa'").all();
  assert.equal(eventos.length, 1, 'salvar igual não repete a Auditoria');
  assert.equal(eventos[0].solicitante_id, gerenteId);
  assert.match(eventos[0].motivo, /desligada -> ligada \(12\.5%\)/);

  assert.deepEqual(taxa.salvar({ ativa: false }), { ok: true, ativa: false, percentual: 12.5 }, 'desligar guarda a % para a próxima vez');
  assert.equal(taxa.percentualFixo(), 0);
});

test('ligada: a mesa nova já abre com a taxa; o cliente pode tirar; desligada não muda nada', () => {
  const ctx = freshTestDb();
  const semTaxa = mesaComItem(ctx, { numero: '1' });
  assert.equal(taxaDaVenda(ctx.db, semTaxa.saleId), 0, 'desligada: como sempre foi');

  taxa.salvar({ ativa: true, percentual: 12 });
  const comTaxa = mesaComItem(ctx, { numero: '2' });
  assert.equal(taxaDaVenda(ctx.db, comTaxa.saleId), 12);
  assert.equal(tableService.getTableCart(comTaxa.saleId).taxaServicoPercentual, 12);
  assert.equal(taxaDaVenda(ctx.db, semTaxa.saleId), 0, 'mesa que já estava aberta não muda');

  // Reabrir a mesa ocupada devolve a mesma conta, sem mexer na taxa que o cliente escolheu.
  assert.equal(saleService.setServiceCharge(comTaxa.saleId, 0).ok, true);
  const reaberta = tableService.openTable({ tableId: comTaxa.tableId, locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.equal(reaberta.saleId, comTaxa.saleId);
  assert.equal(taxaDaVenda(ctx.db, comTaxa.saleId), 0);

  // Venda de balcão nunca ganha taxa.
  const { id: balcao } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.equal(taxaDaVenda(ctx.db, balcao), 0);
});

test('ligada: o pagamento cobra itens + taxa fixa e a venda fecha', () => {
  const ctx = freshTestDb();
  taxa.salvar({ ativa: true, percentual: 10 });
  const { saleId } = mesaComItem(ctx, { preco: 50 });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 55, detalhes: {} });
  const r = saleService.finalizeSale(saleId);
  assert.equal(r.ok, true, r.error);
});

test('impressão: com a taxa fixa, nota e pré-nota da MESA sempre trazem os dois totais, mesmo sem taxa na conta', async () => {
  const ctx = freshTestDb();
  const cfgNota = estudio.getConfig('nota');
  assert.equal(taxa.aplicarNaImpressao('nota', cfgNota, { mesa: 'Mesa 7' }), cfgNota, 'desligada: config do estúdio intacta');

  taxa.salvar({ ativa: true, percentual: 10 });
  const naMesa = taxa.aplicarNaImpressao('nota', cfgNota, { mesa: 'Mesa 7' });
  assert.equal(naMesa.mostrarComESemServico, true);
  assert.equal(naMesa.taxaSugeridaPercentual, 10);
  assert.equal(cfgNota.mostrarComESemServico, false, 'não altera o objeto salvo do estúdio');
  assert.equal(taxa.aplicarNaImpressao('nota', cfgNota, { mesa: null }), cfgNota, 'balcão não muda');
  const cozinha = estudio.getConfig('cozinha');
  assert.equal(taxa.aplicarNaImpressao('cozinha', cozinha, { mesa: 'Mesa 7' }), cozinha);

  // Pré-nota de uma conta de verdade em que o cliente tirou a taxa.
  const { saleId } = mesaComItem(ctx, { preco: 50 });
  saleService.setServiceCharge(saleId, 0);
  const pre = await estudio.htmlDaPreNota({ saleId });
  assert.equal(pre.ok, true, pre.error);
  assert.match(pre.html, /Total sem serviço/);
  assert.match(pre.html, /Total com serviço \(10%, opcional\)/);
  assert.match(pre.html, /R\$ 55,00/);

  // Nota (recibo) da mesa sem taxa: Total cobrado = 50 e os dois totais logo abaixo.
  const venda = { id: 'abcdef1234', finalizada_em: '2026-11-23 18:00:00', total: 50, desconto: 0, desconto_gerente: 0, taxa_servico_percentual: 0 };
  const itens = [{ nome: 'Charque', quantidade: 1, preco_unitario: 50 }];
  const notaMesa = printService.buildReceiptHtml(venda, itens, [{ metodo: 'pix', valor: 50 }], { nome: 'Loja' }, 80, '', null, null, null, { mesa: 'Mesa 7' });
  assert.match(notaMesa, /Total sem serviço/);
  assert.match(notaMesa, /Total com serviço \(10%, opcional\)/);
  const notaBalcao = printService.buildReceiptHtml(venda, itens, [{ metodo: 'pix', valor: 50 }], { nome: 'Loja' }, 80, '', null, null, null, {});
  assert.doesNotMatch(notaBalcao, /Total com serviço/, 'balcão segue o estúdio');

  taxa.salvar({ ativa: false });
  const desligada = printService.buildReceiptHtml(venda, itens, [], { nome: 'Loja' }, 80, '', null, null, null, { mesa: 'Mesa 7' });
  assert.doesNotMatch(desligada, /Total com serviço/);
});

test('estúdio: getTudo informa a taxa fixa e a prévia (conta de mesa) mostra os dois totais', async () => {
  freshTestDb();
  assert.equal(estudio.getTudo().taxaFixa.ativa, false);
  taxa.salvar({ ativa: true, percentual: 12 });
  const tudo = estudio.getTudo();
  assert.deepEqual(tudo.taxaFixa, { ok: true, ativa: true, percentual: 12 });
  assert.equal(tudo.nota.mostrarComESemServico, false, 'o que está salvo no estúdio não muda');
  const previa = await estudio.previa({ tipo: 'nota', config: tudo.nota });
  assert.equal(previa.ok, true);
  assert.match(previa.html, /Total com serviço \(12%, opcional\)/);
});

test('celular: a conta da mesa manda a % do botão (a fixa ou 10%)', () => {
  const ctx = freshTestDb();
  const mesaCelular = require('../electron/services/mesaCelularService');
  const { saleId } = mesaComItem(ctx);
  assert.equal(mesaCelular.calcularConta(ctx.db, saleId).taxaSugeridaPercentual, 10);
  taxa.salvar({ ativa: true, percentual: 12 });
  const conta = mesaCelular.calcularConta(ctx.db, saleId);
  assert.equal(conta.taxaSugeridaPercentual, 12);
  assert.equal(conta.taxaServicoPercentual, 0, 'mesa aberta antes de ligar continua como estava');
});

test('IPC: salvar a taxa fixa é só de gestão e quem salvou vem da sessão', async () => {
  const Module = require('module');
  const canais = new Map();
  const electronFalso = {
    ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { getFocusedWindow: () => null },
    shell: { openPath: async () => '', openExternal: async () => {} },
    app: { getVersion: () => '0.0.0-teste', getPath: () => require('os').tmpdir() },
  };
  const loadOriginal = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronFalso;
    return loadOriginal.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../electron/ipc/handlers')];
    require('../electron/ipc/handlers').registerIpcHandlers();
  } finally {
    Module._load = loadOriginal;
  }
  const sessionService = require('../electron/services/sessionService');
  const { db, operadorId, gerenteId } = freshTestDb();
  const chamar = (canal, payload, id) => canais.get(canal)({ sender: { id } }, payload);

  sessionService.iniciarSessao(71, { id: operadorId, nome: 'Op', role: 'operador' });
  const lido = await chamar('taxaServico:get', {}, 71);
  assert.equal(lido.ok, true, 'operador lê (o botão do pagamento usa)');
  const negado = await chamar('taxaServico:salvar', { ativa: true, percentual: 15 }, 71);
  assert.equal(negado.ok, false);
  assert.match(negado.error, /permissão/);
  assert.equal(taxa.getConfig().ativa, false);

  sessionService.iniciarSessao(72, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const ok = await chamar('taxaServico:salvar', { ativa: true, percentual: 15, operadorId }, 72);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(db.prepare("SELECT solicitante_id FROM audit_log WHERE tipo_evento = 'taxa_servico_fixa'").get().solicitante_id, gerenteId);
  sessionService.encerrarSessao(71);
  sessionService.encerrarSessao(72);
});
