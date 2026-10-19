const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const productService = require('../electron/services/productService');
const attachmentService = require('../electron/services/attachmentService');
const printService = require('../electron/services/printService');
const { readSheetAsRows } = require('../electron/services/xlsxHelpers');

// Regressões da auditoria de segurança (out/2026). Cada teste reproduz o
// ataque que funcionava antes da correção.

function arquivoForaDaPasta(conteudo = 'nao apagar') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-'));
  const f = path.join(dir, 'alvo.png');
  fs.writeFileSync(f, conteudo);
  return f;
}

function vendaFinalizada(ctx) {
  const productId = createProduct(ctx.db, { preco: 10 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' });
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 10, detalhes: {} });
  saleService.finalizeSale(saleId);
  return saleId;
}

test('foto de produto: caminho gravado no banco fora da pasta de fotos não é lido nem apagado', async () => {
  const ctx = freshTestDb();
  const productId = createProduct(ctx.db, {});
  const alvo = arquivoForaDaPasta();
  ctx.db.prepare('UPDATE products SET foto_path = ? WHERE id = ?').run(alvo, productId);

  assert.equal(productService.getFotoDataUrl(productId), null);
  productService.removeFoto(productId);
  await new Promise((r) => setTimeout(r, 50)); // unlink é assíncrono
  assert.equal(fs.existsSync(alvo), true);
});

test('foto de produto: id com "../" não grava arquivo fora da pasta', () => {
  freshTestDb();
  const origem = arquivoForaDaPasta('img');
  const idDoAtaque = `../../../fora-${randomUUID()}`;
  const destinoDoAtaque = path.join(__dirname, '..', '.data', 'fotos-produtos', `${idDoAtaque}.png`);
  try {
    const r = productService.setFoto(idDoAtaque, origem);
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(destinoDoAtaque), false);
  } finally {
    fs.rmSync(destinoDoAtaque, { force: true });
  }
});

test('anexo de venda: saleId com "../" é recusado', () => {
  freshTestDb();
  const origem = arquivoForaDaPasta('pdf');
  const r = attachmentService.addAttachment({ saleId: '../../fora', sourceFilePath: origem.replace(/\.png$/, '.pdf'), operadorId: null });
  assert.equal(r.ok, false);
});

test('anexo de venda: caminho do banco fora da pasta de anexos não é apagado', async () => {
  const ctx = freshTestDb();
  const saleId = vendaFinalizada(ctx);
  const alvo = arquivoForaDaPasta();
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO sale_attachments (id, sale_id, nome_arquivo, caminho, tipo, operador_id) VALUES (?, ?, 'x.png', ?, 'imagem', ?)`
  ).run(id, saleId, alvo, ctx.operadorId);

  assert.equal(attachmentService.removeAttachment(id).ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(alvo), true);
  assert.equal(attachmentService.caminhoDeAnexoSeguro(alvo), null);
});

test('venda finalizada: desconto, taxa de serviço, pontos e cliente não mudam mais', () => {
  const ctx = freshTestDb();
  const saleId = vendaFinalizada(ctx);
  const antes = ctx.db.prepare('SELECT total, desconto, desconto_gerente, taxa_servico_percentual, customer_id FROM sales WHERE id = ?').get(saleId);

  assert.equal(saleService.removeManagerDiscount(saleId).ok, false);
  assert.equal(saleService.setServiceCharge(saleId, 10).ok, false);
  assert.equal(saleService.redeemLoyaltyPoints({ saleId, pontos: 100 }).ok, false);
  assert.equal(saleService.setCustomer(saleId, randomUUID()).ok, false);

  const depois = ctx.db.prepare('SELECT total, desconto, desconto_gerente, taxa_servico_percentual, customer_id FROM sales WHERE id = ?').get(saleId);
  assert.deepEqual(depois, antes);
});

test('venda aberta: cliente inexistente é recusado', () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.equal(saleService.setCustomer(saleId, randomUUID()).ok, false);
});

test('recibo impresso: nome de produto, pagamento, loja e rodapé saem escapados', () => {
  const ataque = '<img src=x onerror="alert(1)">';
  const html = printService.buildReceiptHtml(
    { id: 'abcdef1234', finalizada_em: '2026-10-19 12:00:00', total: 10, desconto: 0, desconto_gerente: 0, taxa_servico_percentual: 0 },
    [{ nome: ataque, quantidade: 1, preco_unitario: 10 }],
    [{ metodo: ataque, valor: 10 }],
    { nome: ataque },
    80,
    ataque,
    null,
    null,
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('toda janela de impressão roda sem JavaScript e em sandbox', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'printService.js'), 'utf-8');
  const janelas = src.match(/new \(getBrowserWindow\(\)\)\(\{[^\n]*/g) || [];
  assert.ok(janelas.length >= 6);
  for (const j of janelas) assert.match(j, /webPreferences:\s*\{\s*sandbox:\s*true,\s*javascript:\s*false\s*\}/);
  assert.equal((src.match(/new \(getBrowserWindow\(\)\)/g) || []).length, janelas.length);
});

test('planilha acima do limite é recusada antes de abrir', async () => {
  const f = path.join(os.tmpdir(), `grande-${randomUUID()}.xlsx`);
  const fd = fs.openSync(f, 'w');
  fs.ftruncateSync(fd, 31 * 1024 * 1024); // arquivo esparso: não ocupa 31 MB de disco
  fs.closeSync(fd);
  try {
    await assert.rejects(() => readSheetAsRows(f), /grande demais/);
  } finally {
    fs.unlinkSync(f);
  }
});

test('bloqueio por PIN errado segue o relógio sincronizado, não o do Windows', (t) => {
  const ctx = freshTestDb();
  const authService = require('../electron/services/authService');
  const timeService = require('../electron/services/timeService');
  const T = Date.UTC(2026, 9, 19, 15, 0, 0);
  t.mock.method(timeService, 'nowMs', () => T);
  for (let i = 0; i < 5; i++) authService.login(ctx.gerenteId, '0000');

  // Adiantar o relógio do sistema em 1 dia não desbloqueia...
  t.mock.method(Date, 'now', () => T + 24 * 3600e3);
  assert.match(authService.login(ctx.gerenteId, '1234').error || '', /bloqueado/i);
  // ...só o tempo de verdade (relógio sincronizado) passando.
  timeService.nowMs.mock.mockImplementation(() => T + 11 * 60e3);
  assert.equal(authService.login(ctx.gerenteId, '1234').ok, true);
});

test('auth:changeOwnPin usa o usuário da sessão, nunca um userId do payload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'handlers.js'), 'utf-8');
  const linha = src.split('\n').find((l) => l.includes("safeHandle('auth:changeOwnPin'"));
  assert.ok(linha);
  assert.match(linha, /changeOwnPin\(usuarioLogado\(event\)/);
  assert.doesNotMatch(linha, /userId/);
});
