const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

// Rede (Firestore) fora dos testes: só a parte local.
const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };

const saleService = require('../electron/services/saleService');
const pixAuto = require('../electron/services/pixAutomaticoService');
const vitrine = require('../electron/services/vitrineService');
const vitrinePedido = require('../electron/services/vitrinePedidoService');
const vitrinePix = require('../electron/services/vitrinePixService');
const botOrderService = require('../electron/services/botOrderService');
const chamada = require('../electron/services/chamadaService');
const cozinha = require('../electron/services/cozinhaService');
const tableService = require('../electron/services/tableService');
const maquininha = require('../electron/services/maquininhaService');
const { mapearStatus, detalhesDoPagamento } = require('../electron/services/provedoresMaquininha/mercadoPagoPoint');

const TOKEN_FALSO = 'TEST-0000000000000000-000000-ffffffffffffffffffffffffffffffff-000000000';

function pixFalso() {
  const cobrancas = new Map();
  const chamadas = { criar: [], cancelar: [] };
  let proximo = 5000;
  let falharCancelar = false;
  const p = {
    id: 'mercadopago',
    async criar(args) {
      chamadas.criar.push(args);
      const provedorId = String(proximo++);
      cobrancas.set(provedorId, { status: 'pendente', valor: args.valor });
      return { provedorId, copiaECola: `00020126-falso-${provedorId}`, status: 'pendente' };
    },
    async consultar({ provedorId }) {
      const c = cobrancas.get(provedorId);
      return { status: c.status, valorPago: c.status === 'pago' ? c.valor : null };
    },
    async cancelar({ provedorId }) {
      chamadas.cancelar.push(provedorId);
      if (falharCancelar) throw new Error('fora do ar');
      cobrancas.get(provedorId).status = 'cancelado';
    },
    async testar() { return { conta: 'LOJA_TESTE' }; },
  };
  return { p, chamadas, cobrancas, pagar: (id) => { cobrancas.get(id).status = 'pago'; }, falharCancelar: (v) => { falharCancelar = v; } };
}

function lojaComPixNoSite({ pix = true } = {}) {
  const ctx = freshTestDb();
  const lanche = createProduct(ctx.db, { nome: 'X-Burguer', preco: 22, categoria: 'Lanches' });
  addStock(ctx.db, { productId: lanche, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  const falso = pixFalso();
  pixAuto._definirProvedorParaTeste(() => falso.p);
  if (pix) {
    const r = pixAuto.saveConfig({ ativo: true, token: TOKEN_FALSO, emailPagador: 'vendas@exemplo.com', validadeMin: 30, requestingUserId: ctx.gerenteId });
    assert.equal(r.ok, true, r.error);
  }
  ctx.db.prepare(`INSERT OR IGNORE INTO vitrine_config (id) VALUES ('default')`).run();
  ctx.db.prepare(`UPDATE vitrine_config SET slug = 'lanchonete-boa' WHERE id = 'default'`).run();
  const r = vitrine.saveConfig({
    ativa: true, ocultarSemEstoque: false, avisoPoucasUnidades: 0, mensagem: '', modos: ['retirada', 'local'], pedidoMinimo: 0,
    pedidosOnline: true, pixOnline: pix, requestingUserId: ctx.gerenteId,
  });
  assert.equal(r.ok, true, r.error);
  chamada.saveConfig({ ativa: true, requestingUserId: ctx.gerenteId });
  return { ...ctx, lanche, falso };
}

let seq = 0;
const novoId = () => `PIXSITE${String(++seq).padStart(13, '0')}`;

test('Pix pelo site: só com Pix automático; pago, o pedido é aceito sozinho e a venda nasce como Pix dinâmico', async () => {
  const sem = lojaComPixNoSite({ pix: false });
  assert.equal(vitrine.getConfig().pixOnline, false);
  const recusado = vitrine.saveConfig({ ativa: true, modos: ['retirada'], avisoPoucasUnidades: 0, pedidoMinimo: 0, pedidosOnline: true, pixOnline: true, requestingUserId: sem.gerenteId });
  assert.match(recusado.error, /Pix automático/);
  assert.match(vitrinePedido.criarPedidoVitrine({ pedidoId: novoId(), slug: 'lanchonete-boa', nome: 'Ana', modo: 'retirada', pagamento: 'pix_online', itens: [{ produtoId: sem.lanche, quantidade: 1 }] }).error, /não está aceitando Pix/);

  const ctx = lojaComPixNoSite();
  assert.equal(vitrine.getConfig().pixOnline, true);
  const r = vitrinePedido.criarPedidoVitrine({ pedidoId: novoId(), slug: 'lanchonete-boa', nome: 'Ana Souza', modo: 'retirada', pagamento: 'pix_online', itens: [{ produtoId: ctx.lanche, quantidade: 2 }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pixOnline, true);
  let pedido = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id);
  assert.equal(pedido.pagamento_online, 'aguardando');
  assert.equal(vitrinePedido.etapaDoPedido(pedido, null).etapa, 'pagamento');

  // Atendente não prepara antes do Pix.
  const cedo = botOrderService.updateOrderStatus({ orderId: r.id, status: 'em_separacao', operadorId: ctx.adminId });
  assert.equal(cedo.ok, false);
  assert.match(cedo.error, /esperando o cliente pagar o Pix/);

  const c = await vitrinePix.criarParaPedido({ botOrderId: r.id });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.cobranca.valor, 44, 'valor é o do cadastro');
  assert.equal(c.cobranca.status, 'pendente');
  assert.equal((await vitrinePix.criarParaPedido({ botOrderId: r.id })).cobranca.id, c.cobranca.id, 'idempotente');
  assert.equal(ctx.falso.chamadas.criar.length, 1);
  assert.equal(vitrinePix.paraPagina(vitrinePix.getDoPedido(r.id)).copiaECola.startsWith('00020126'), true);

  ctx.falso.pagar(c.cobranca.provedor_id);
  const pago = await vitrinePix.consultar({ id: c.cobranca.id, agoraMs: Date.now() + 5000 });
  assert.equal(pago.ok, true);
  pedido = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id);
  assert.equal(pedido.pagamento_online, 'pago');
  assert.equal(pedido.status, 'em_separacao', 'aceito sozinho');
  const senha = ctx.db.prepare('SELECT * FROM chamadas WHERE bot_order_id = ?').get(r.id);
  assert.equal(senha.numero, 1);
  assert.equal(senha.nome, 'Ana');
  assert.equal(vitrinePedido.etapaDoPedido(pedido, 1).pago, true);
  // Consulta repetida não paga duas vezes.
  assert.equal((await vitrinePix.registrarPago(c.cobranca.id, { valorPago: 44 })).jaRegistrado, true);

  // Retirou: vira venda com o Pix (pixAutomatico -> NFC-e tPag 17), sem "outro".
  assert.equal(chamada.entregar({ id: senha.id, operadorId: ctx.adminId }).ok, true);
  pedido = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id);
  assert.equal(pedido.status, 'concluido');
  const pagamentos = ctx.db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(pedido.sale_id);
  assert.equal(pagamentos.length, 1);
  assert.equal(pagamentos[0].metodo, 'pix');
  assert.equal(pagamentos[0].valor, 44);
  const d = JSON.parse(pagamentos[0].detalhes);
  assert.equal(d.origem, 'vitrine_pix');
  assert.equal(d.pixAutomatico.cobranca, c.cobranca.provedor_id);
});

test('Pix pelo site: vencido cancela o pedido; pago depois do cancelamento vira "estornar"; receber no balcão', async () => {
  const ctx = lojaComPixNoSite();
  const base = { slug: 'lanchonete-boa', nome: 'Bia', modo: 'retirada', pagamento: 'pix_online', itens: [{ produtoId: ctx.lanche, quantidade: 1 }] };

  // Vence sem pagar: pedido cancelado com o motivo.
  const a = vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: novoId() });
  const ca = await vitrinePix.criarParaPedido({ botOrderId: a.id });
  await vitrinePix.reconciliar({ agoraMs: Date.now() + 45 * 60000 });
  const pa = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(a.id);
  assert.equal(pa.status, 'cancelado');
  assert.equal(pa.pagamento_online, 'expirado');
  assert.equal(vitrinePix.getDoPedido(a.id).status, 'expirado');
  assert.equal(vitrinePedido.etapaDoPedido(pa).motivo, 'O Pix não foi pago no prazo.');
  assert.ok(ca.cobranca);

  // Loja cancela antes; QR cancelado no provedor. Se o provedor falhou e o
  // cliente pagou mesmo assim, o dinheiro não some.
  const b = vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: novoId() });
  const cb = await vitrinePix.criarParaPedido({ botOrderId: b.id });
  ctx.falso.falharCancelar(true);
  assert.equal(botOrderService.updateOrderStatus({ orderId: b.id, status: 'cancelado', operadorId: ctx.adminId }).ok, true);
  await new Promise((r) => setTimeout(r, 20));
  ctx.falso.pagar(cb.cobranca.provedor_id);
  await vitrinePix.consultar({ id: cb.cobranca.id, agoraMs: Date.now() + 9000 });
  assert.equal(vitrinePix.getDoPedido(b.id).status, 'estornar');
  assert.equal(vitrinePix.listarParaEstornar().length, 1);
  ctx.falso.falharCancelar(false);

  // Cliente vai pagar no balcão: QR cancelado, pedido volta a ser aceito pelo atendente.
  const c = vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: novoId() });
  await vitrinePix.criarParaPedido({ botOrderId: c.id });
  assert.equal((await vitrinePix.receberNoBalcao({ botOrderId: c.id })).ok, true);
  assert.equal(vitrinePix.getDoPedido(c.id).status, 'cancelado');
  assert.equal(ctx.db.prepare('SELECT pagamento_online FROM bot_orders WHERE id = ?').get(c.id).pagamento_online, '');
  assert.equal(botOrderService.updateOrderStatus({ orderId: c.id, status: 'em_separacao', operadorId: ctx.adminId }).ok, true);
});

test('QR da mesa: paga na conta da mesa (nunca Pix antecipado)', () => {
  const ctx = lojaComPixNoSite();
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '3' });
  const tableId = mesa.id || ctx.db.prepare(`SELECT id FROM restaurant_tables WHERE numero = '3'`).get().id;
  const token = vitrine.garantirTokenMesa(ctx.db, tableId);
  const r = vitrinePedido.criarPedidoVitrine({ pedidoId: novoId(), slug: 'lanchonete-boa', nome: 'Caio', mesa: token, modo: 'local', pagamento: 'pix_online', itens: [{ produtoId: ctx.lanche, quantidade: 1 }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pixOnline, false);
  assert.equal(ctx.db.prepare('SELECT pagamento_online FROM bot_orders WHERE id = ?').get(r.id).pagamento_online, '');
  assert.match(vitrinePedido.criarPedidoVitrine({ pedidoId: novoId(), slug: 'lanchonete-boa', nome: 'Caio', pagamento: 'boleto', itens: [{ produtoId: ctx.lanche, quantidade: 1 }] }).error, /pagamento inválida/);
});

test('senha no balcão: gerada na finalização, nunca em venda de mesa; folha de QR escapa o nome da loja', async () => {
  const ctx = freshTestDb();
  const lanche = createProduct(ctx.db, { nome: 'Coxinha', preco: 8, categoria: 'Salgados' });
  addStock(ctx.db, { productId: lanche, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.adminId });
  cozinha._definirImpressorasParaTeste({ rede: async () => {} });
  assert.equal(chamada.aposFinalizarVenda({ saleId: 'x' }), null, 'desligado não gera');
  chamada.saveConfig({ ativa: true, senhaNoBalcao: true, requestingUserId: ctx.gerenteId });
  const v = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.adminId });
  const saleId = v.saleId || v.id;
  saleService.addItem({ saleId, productId: lanche, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.adminId, deviceId: 'pc' });
  const senha = chamada.aposFinalizarVenda({ saleId, nome: 'Davi Lima', operadorId: ctx.adminId });
  assert.equal(senha.numero, 1);
  assert.equal(senha.nome, 'Davi');
  assert.equal(chamada.aposFinalizarVenda({ saleId, operadorId: ctx.adminId }).numero, 1, 'mesma venda, mesma senha');

  const painel = chamada.montarPainel();
  assert.deepEqual(painel.preparando, [{ n: 1, nome: 'Davi' }]);
  assert.equal(painel.modelo.corDestaque, '#d9a441', 'identidade do Vértice por padrão');
  assert.equal(JSON.stringify(painel).includes('Coxinha'), false, 'painel não leva item');

  const html = vitrine.montarFolhaQrMesas({ nomeLoja: '<b>Bar & Cia</b>', mesas: [{ rotulo: 'Mesa "1"', qrDataUrl: 'javascript:alert(1)' }] });
  assert.ok(html.includes('&lt;b&gt;Bar &amp; Cia&lt;/b&gt;'));
  assert.ok(html.includes('Mesa &quot;1&quot;'));
  assert.equal(html.includes('javascript:alert'), false, 'só imagem data:image/png');
});

// ---------------- maquininha (Mercado Pago Point) ----------------

function pointFalso() {
  const orders = new Map();
  const chamadas = { criar: [], cancelar: [] };
  let n = 1;
  let rejeitarCancelamento = false;
  const p = {
    id: 'mercadopago_point',
    async listarTerminais() { return [{ id: 'NEWLAND_N950__N950NCB801293324', modo: 'STANDALONE' }]; },
    async testar() { return { conta: 'LOJA_TESTE' }; },
    async ativarModoPdv() { return { modo: 'PDV' }; },
    async criar(args) {
      chamadas.criar.push(args);
      const provedorId = `ORD${String(n++).padStart(6, '0')}`;
      orders.set(provedorId, { status: 'pendente', valor: args.valor });
      return { provedorId, pagamentoId: `PAY${provedorId}`, status: 'pendente' };
    },
    async consultar({ provedorId }) {
      const o = orders.get(provedorId);
      return o.status === 'pago'
        ? { status: 'pago', bandeira: 'visa', tipoCartao: 'credit_card', parcelas: 1, autorizacao: 'A1B2C3', ultimos4: '4242', valorPago: o.valor }
        : { status: o.status, naMaquininha: o.status === 'pendente' };
    },
    async cancelar({ provedorId }) {
      chamadas.cancelar.push(provedorId);
      if (rejeitarCancelamento) return { confirmado: false };
      orders.get(provedorId).status = 'cancelado';
      return { confirmado: true };
    },
  };
  return { p, chamadas, orders, pagar: (id) => { orders.get(id).status = 'pago'; }, rejeitarCancelamento: (v) => { rejeitarCancelamento = v; } };
}

function caixaComMaquininha() {
  const ctx = freshTestDb();
  const falso = pointFalso();
  maquininha._definirProvedorParaTeste(() => falso.p);
  assert.equal(maquininha.saveConfig({ ativa: true, usarTokenPix: false, token: TOKEN_FALSO, terminalId: 'NEWLAND_N950__N950NCB801293324', requestingUserId: ctx.operadorId }).ok, false, 'operador não configura');
  const r = maquininha.saveConfig({ ativa: true, usarTokenPix: false, token: TOKEN_FALSO, terminalId: 'NEWLAND_N950__N950NCB801293324', requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.config.pronta, true);
  assert.equal(JSON.stringify(r.config).includes(TOKEN_FALSO), false, 'token nunca volta para a tela');
  const productId = createProduct(ctx.db, { preco: 58 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const v = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const saleId = v.saleId || v.id;
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'pc' });
  return { ...ctx, falso, saleId };
}

test('maquininha: cobra o que falta, aprovada vira pagamento com bandeira e autorização, uma vez só', async () => {
  const ctx = caixaComMaquininha();
  assert.match((await maquininha.criarCobranca({ saleId: ctx.saleId, valor: 58, tipo: 'boleto', operadorId: ctx.operadorId })).error, /crédito, débito ou Pix/);
  const c = await maquininha.criarCobranca({ saleId: ctx.saleId, valor: 100, tipo: 'credito', parcelas: 1, operadorId: ctx.operadorId });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.cobranca.valor, 58, 'nunca cobra mais que o restante');
  assert.equal(ctx.falso.chamadas.criar[0].idempotencia, c.cobranca.id);
  assert.equal(ctx.falso.chamadas.criar[0].terminalId, 'NEWLAND_N950__N950NCB801293324');

  ctx.falso.pagar([...ctx.falso.orders.keys()][0]);
  const t = Date.now() + 10000;
  const [r1, r2] = await Promise.all([
    maquininha.consultarCobranca({ id: c.cobranca.id, agoraMs: t }),
    maquininha.consultarCobranca({ id: c.cobranca.id, agoraMs: t + 3000 }),
  ]);
  assert.equal(r1.ok && r2.ok, true);
  const pagamentos = ctx.db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(ctx.saleId);
  assert.equal(pagamentos.length, 1, 'consultas juntas não duplicam');
  assert.equal(ctx.db.prepare('SELECT status FROM maquininha_cobrancas WHERE id = ?').get(c.cobranca.id).status, 'pago');
  assert.equal(maquininha.listarPagasSemVenda().length, 0, 'a segunda consulta não vira "pago sem venda"');
  assert.equal(pagamentos[0].metodo, 'cartao_credito');
  const d = JSON.parse(pagamentos[0].detalhes).maquininha;
  assert.equal(d.bandeira, 'visa');
  assert.equal(d.autorizacao, 'A1B2C3');
  assert.equal(saleService.finalizeSale(ctx.saleId).ok, true);
});

test('maquininha: nova cobrança cancela a anterior; aprovada depois da venda fechada vira "pago sem venda"', async () => {
  const ctx = caixaComMaquininha();
  const a = await maquininha.criarCobranca({ saleId: ctx.saleId, valor: 58, tipo: 'debito', operadorId: ctx.operadorId });
  const b = await maquininha.criarCobranca({ saleId: ctx.saleId, valor: 58, tipo: 'pix', operadorId: ctx.operadorId });
  assert.equal(b.ok, true);
  assert.equal(ctx.falso.chamadas.cancelar.length, 1);
  assert.equal(ctx.db.prepare('SELECT status FROM maquininha_cobrancas WHERE id = ?').get(a.cobranca.id).status, 'cancelado');

  // Cliente pagou em dinheiro e a venda fechou; a maquininha aprova depois.
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 58 });
  saleService.finalizeSale(ctx.saleId);
  ctx.falso.pagar(ctx.db.prepare('SELECT provedor_id FROM maquininha_cobrancas WHERE id = ?').get(b.cobranca.id).provedor_id);
  const r = await maquininha.consultarCobranca({ id: b.cobranca.id, agoraMs: Date.now() + 10000 });
  assert.equal(r.semVenda, true);
  assert.equal(maquininha.listarPagasSemVenda().length, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM payments WHERE sale_id = ?').get(ctx.saleId).n, 1, 'venda continua só com o dinheiro');
});

test('Mercado Pago Point: status da order e dados do cartão para a NFC-e', () => {
  assert.equal(mapearStatus('processed'), 'pago');
  assert.equal(mapearStatus('at_terminal'), 'pendente');
  assert.equal(mapearStatus('canceled'), 'cancelado');
  assert.equal(mapearStatus('failed'), 'falhou');
  const d = detalhesDoPagamento({ transactions: { payments: [{ id: 'PAY1', paid_amount: '58.00', authorization_code: '123456', payment_method: { id: 'master', type: 'debit_card', installments: 1 }, card: { last_four_digits: '1111' } }] } });
  assert.equal(d.bandeira, 'master');
  assert.equal(d.autorizacao, '123456');
  assert.equal(d.valorPago, 58);
  assert.equal(d.ultimos4, '1111');
});
