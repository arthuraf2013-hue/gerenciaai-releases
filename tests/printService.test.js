const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const fiscalService = require('../electron/services/fiscalService');
const printService = require('../electron/services/printService');

// printReceipt() abre uma janela real do Electron (BrowserWindow), que
// não existe neste ambiente de teste (electron é mockado) — só
// buildReceiptWhatsappLink não depende disso, então é o que dá pra
// testar de ponta a ponta aqui. A parte de HTML/QR do recibo impresso
// (buildFiscalHtmlBlock) é privada nesse arquivo; a lógica que ela usa
// (montarUrlQrCode, formatarChaveAcesso) já é testada isoladamente em
// nfceQrCodeService.test.js.

function venderEFinalizar(ctx) {
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });
  saleService.finalizeSale(saleId);
  return saleId;
}

function inserirNfce(db, { saleId, status = 'autorizada', ambiente = 'homologacao', chaveAcesso = '35260800000000019100650010000000011234567890' }) {
  db.prepare(
    `INSERT INTO nfce_emitidas (id, sale_id, numero, serie, chave_acesso, status, ambiente, xml_path, protocolo_autorizacao)
     VALUES (?, ?, 1, '1', ?, ?, ?, '/tmp/fake.xml', ?)`
  ).run(randomUUID(), saleId, chaveAcesso, status, ambiente, status === 'autorizada' ? '135260000000123' : null);
}

test('buildReceiptWhatsappLink não menciona NFC-e quando a venda não tem nenhuma', () => {
  const ctx = freshTestDb();
  const saleId = venderEFinalizar(ctx);
  const result = printService.buildReceiptWhatsappLink(saleId);
  assert.equal(result.ok, true);
  assert.doesNotMatch(decodeURIComponent(result.url), /NFC-e/);
});

test('buildReceiptWhatsappLink inclui a chave de acesso quando a NFC-e está autorizada', () => {
  const ctx = freshTestDb();
  const saleId = venderEFinalizar(ctx);
  inserirNfce(ctx.db, { saleId, status: 'autorizada' });
  const result = printService.buildReceiptWhatsappLink(saleId);
  assert.equal(result.ok, true);
  const texto = decodeURIComponent(result.url);
  assert.match(texto, /NFC-e nº 1/);
  assert.match(texto, /35260800000000019100650010000000011234567890/);
});

test('buildReceiptWhatsappLink não inclui link de consulta quando a URL de consulta não está configurada', () => {
  const ctx = freshTestDb();
  const saleId = venderEFinalizar(ctx);
  inserirNfce(ctx.db, { saleId, status: 'autorizada' });
  const result = printService.buildReceiptWhatsappLink(saleId);
  assert.doesNotMatch(decodeURIComponent(result.url), /Consulte:/);
});

test('buildReceiptWhatsappLink inclui o link de consulta (QR) quando a URL está configurada', () => {
  const ctx = freshTestDb();
  fiscalService.updateFiscalConfig(ctx.adminId, { qrCodeUrl: 'https://www.nfce.fazenda.sp.gov.br/qrcode' });
  const saleId = venderEFinalizar(ctx);
  inserirNfce(ctx.db, { saleId, status: 'autorizada', ambiente: 'homologacao' });
  const result = printService.buildReceiptWhatsappLink(saleId);
  const texto = decodeURIComponent(result.url);
  assert.match(texto, /Consulte: https:\/\/www\.nfce\.fazenda\.sp\.gov\.br\/qrcode\?p=35260800000000019100650010000000011234567890\|3\|2/);
});

test('buildReceiptWhatsappLink não menciona NFC-e quando ela está pendente/rejeitada (documento sem valor fiscal ainda)', () => {
  const ctx = freshTestDb();
  const saleId = venderEFinalizar(ctx);
  inserirNfce(ctx.db, { saleId, status: 'pendente' });
  const result = printService.buildReceiptWhatsappLink(saleId);
  assert.doesNotMatch(decodeURIComponent(result.url), /NFC-e/);
});

// ---------------------------------------------------------------------
// editarHistoricoVenda corrige sales.total sem recalcular sale_items/
// payments (de propósito -- são registros do que de fato aconteceu).
// Isso deixava o recibo reimpresso mostrar itens que não batem com o
// "Total:", sem explicação nenhuma -- parecia bug de impressão, não um
// ajuste deliberado (auditoria, seção 3).
// ---------------------------------------------------------------------

test('buildReceiptWhatsappLink avisa quando o total foi ajustado manualmente (não bate com a soma dos itens)', async () => {
  const ctx = freshTestDb();
  const saleId = venderEFinalizar(ctx); // venda de R$ 10 (1 item de R$ 10)
  const edicao = await saleService.editarHistoricoVenda({ saleId, novoTotal: 25, currentOperatorId: ctx.adminId });
  assert.equal(edicao.ok, true);

  const result = printService.buildReceiptWhatsappLink(saleId);
  const texto = decodeURIComponent(result.url);
  assert.match(texto, /Total: R\$ 25\.00/);
  assert.match(texto, /ajustado manualmente/);
});

test('buildReceiptWhatsappLink NÃO avisa quando o total nunca foi editado (soma dos itens bate certinho)', () => {
  const ctx = freshTestDb();
  const saleId = venderEFinalizar(ctx);
  const result = printService.buildReceiptWhatsappLink(saleId);
  const texto = decodeURIComponent(result.url);
  assert.doesNotMatch(texto, /ajustado manualmente/);
});

// ---------------------------------------------------------------------
// A taxa de serviço de mesa (setServiceCharge) é somada em sales.total
// só na hora de finalizar (ver saleService.finalizeSale) -- o recibo
// precisa mostrar ela separada (não só embutida no Total) e o aviso de
// "ajustado manualmente" não pode disparar por causa dela nem por causa
// de um desconto normal (nenhum dos dois passa por editarHistoricoVenda).
// ---------------------------------------------------------------------

test('buildReceiptWhatsappLink mostra a taxa de serviço separada e não avisa "ajustado manualmente" por causa dela', () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { preco: 100 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  saleService.setServiceCharge(saleId, 10); // 10% de 100 = 10 -> total a pagar 110
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 110, detalhes: {} });
  saleService.finalizeSale(saleId);

  const result = printService.buildReceiptWhatsappLink(saleId);
  const texto = decodeURIComponent(result.url);
  assert.match(texto, /Taxa de serviço \(10%\): R\$ 10\.00/);
  assert.match(texto, /Total: R\$ 110\.00/);
  assert.doesNotMatch(texto, /ajustado manualmente/);
});

test('buildReceiptWhatsappLink NÃO avisa "ajustado manualmente" numa venda com desconto de fidelidade normal', () => {
  const customerService = require('../electron/services/customerService');
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, { preco: 100 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: customerId } = customerService.upsert({ nome: 'Cliente Fidelidade' });
  ctx.db.prepare('UPDATE customers SET pontos = 100 WHERE id = ?').run(customerId);

  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  saleService.setCustomer(saleId, customerId);
  saleService.redeemLoyaltyPoints({ saleId, pontos: 100 }); // R$5 de desconto -> total a pagar 95
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 95, detalhes: {} });
  saleService.finalizeSale(saleId);

  const result = printService.buildReceiptWhatsappLink(saleId);
  const texto = decodeURIComponent(result.url);
  assert.match(texto, /Desconto fidelidade: -R\$ 5\.00/);
  assert.match(texto, /Total: R\$ 95\.00/);
  assert.doesNotMatch(texto, /ajustado manualmente/, 'desconto normal não é edição manual do histórico -- não devia acusar nada');
});
