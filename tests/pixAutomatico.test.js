const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const pixAuto = require('../electron/services/pixAutomaticoService');
const { criarMercadoPago, mapearStatus, dataMercadoPago } = require('../electron/services/provedoresPix/mercadoPago');

// Token de mentira, só com o formato certo (nunca um token real em teste).
const TOKEN_FALSO = 'TEST-0000000000000000-000000-ffffffffffffffffffffffffffffffff-000000000';

/** Provedor falso: guarda as cobranças em memória; o teste decide o status. */
function provedorFalso() {
  const cobrancas = new Map();
  const chamadas = { criar: [], consultar: 0, cancelar: [] };
  let proximo = 1000;
  let falharCancelar = false;
  let falharCriar = null;
  const p = {
    id: 'mercadopago',
    async criar(args) {
      chamadas.criar.push(args);
      if (falharCriar) throw new Error(falharCriar);
      const provedorId = String(proximo++);
      cobrancas.set(provedorId, { status: 'pendente', valor: args.valor });
      return { provedorId, copiaECola: `00020126-falso-${provedorId}`, status: 'pendente' };
    },
    async consultar({ provedorId }) {
      chamadas.consultar++;
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
  return {
    p, chamadas, cobrancas,
    pagar(provedorId) { cobrancas.get(provedorId).status = 'pago'; },
    falharCancelar(v) { falharCancelar = v; },
    falharCriar(msg) { falharCriar = msg; },
  };
}

function lojaComPixAutomatico() {
  const ctx = freshTestDb();
  const falso = provedorFalso();
  pixAuto._definirProvedorParaTeste(() => falso.p);
  const r = pixAuto.saveConfig({ ativo: true, token: TOKEN_FALSO, emailPagador: 'vendas@exemplo.com', validadeMin: 30, requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, true, r.error);
  const productId = createProduct(ctx.db, { preco: 50 });
  addStock(ctx.db, { productId, locationId: ctx.locationId, quantidade: 10, operadorId: ctx.adminId });
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  saleService.addItem({ saleId, productId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'device-teste' });
  return { ...ctx, falso, saleId, productId };
}

const pagamentosDa = (db, saleId) => db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);
const auditoria = (db, tipo) => db.prepare('SELECT * FROM audit_log WHERE tipo_evento = ?').all(tipo);
// Consultas seguidas precisam respeitar o intervalo mínimo de 2,5 s.
let relogio = Date.now();
const depois = () => (relogio += 3000);

test('config: só gestão salva; o token nunca volta pra tela (só o final)', () => {
  const ctx = freshTestDb();
  const negado = pixAuto.saveConfig({ ativo: true, token: TOKEN_FALSO, emailPagador: 'a@b.com', validadeMin: 30, requestingUserId: ctx.operadorId });
  assert.equal(negado.ok, false);
  const r = pixAuto.saveConfig({ ativo: true, token: TOKEN_FALSO, emailPagador: 'vendas@exemplo.com', validadeMin: 30, requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, true, r.error);
  const c = pixAuto.getConfig();
  assert.equal(c.temToken, true);
  assert.equal(c.tokenFinal, TOKEN_FALSO.slice(-4));
  assert.equal(c.tokenDeTeste, true);
  assert.ok(!JSON.stringify(c).includes(TOKEN_FALSO.slice(0, 20)));
  assert.equal(auditoria(ctx.db, 'pix_automatico_alterado').length, 1);
  assert.ok(!auditoria(ctx.db, 'pix_automatico_alterado')[0].motivo.includes(TOKEN_FALSO.slice(0, 20)));
  // Salvar sem token mantém o atual.
  assert.equal(pixAuto.saveConfig({ ativo: true, emailPagador: 'vendas@exemplo.com', validadeMin: 60, requestingUserId: ctx.adminId }).ok, true);
  assert.equal(pixAuto.getConfig().tokenFinal, TOKEN_FALSO.slice(-4));
});

test('config: recusa token com formato errado, e-mail faltando e validade fora de 30–240', () => {
  const ctx = freshTestDb();
  const base = { ativo: true, token: TOKEN_FALSO, emailPagador: 'vendas@exemplo.com', validadeMin: 30, requestingUserId: ctx.gerenteId };
  assert.equal(pixAuto.saveConfig({ ...base, token: 'minha-senha' }).ok, false);
  assert.equal(pixAuto.saveConfig({ ...base, emailPagador: '' }).ok, false);
  assert.equal(pixAuto.saveConfig({ ...base, validadeMin: 10 }).ok, false);
  assert.equal(pixAuto.saveConfig({ ...base, validadeMin: 500 }).ok, false);
  assert.equal(pixAuto.saveConfig({ ...base, token: undefined }).ok, false); // ligar sem token nenhum
  assert.equal(pixAuto.getConfig().ativo, false);
});

test('desligado: o caixa cai no QR fixo', async () => {
  const ctx = freshTestDb();
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  const r = await pixAuto.criarCobranca({ saleId, valor: 10, operadorId: ctx.operadorId });
  assert.equal(r.ok, false);
  assert.equal(r.usarQrFixo, true);
});

test('pago no provedor: vira UM pagamento na venda, mesmo com consultas repetidas', async () => {
  const ctx = lojaComPixAutomatico();
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  assert.match(r.cobranca.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(r.cobranca.status, 'pendente');
  const enviado = ctx.falso.chamadas.criar[0];
  assert.equal(enviado.idempotencia, r.cobranca.id);
  assert.equal(enviado.emailPagador, 'vendas@exemplo.com');
  assert.equal(enviado.valor, 50);

  const antes = await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: depois() });
  assert.equal(antes.cobranca.status, 'pendente');
  assert.equal(pagamentosDa(ctx.db, ctx.saleId).length, 0);

  ctx.falso.pagar(ctx.db.prepare('SELECT provedor_id FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id).provedor_id);
  const pago = await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: depois() });
  assert.equal(pago.cobranca.status, 'pago');
  assert.ok(pago.pagamento?.id);
  await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: depois() });
  await pixAuto.reconciliar({ agoraMs: depois() });
  const pagamentos = pagamentosDa(ctx.db, ctx.saleId);
  assert.equal(pagamentos.length, 1);
  assert.equal(pagamentos[0].metodo, 'pix');
  assert.equal(pagamentos[0].valor, 50);
  assert.equal(JSON.parse(pagamentos[0].detalhes).pixAutomatico.provedor, 'mercadopago');
});

test('consulta tem intervalo mínimo (não martela o provedor)', async () => {
  const ctx = lojaComPixAutomatico();
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  const t = depois();
  await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: t });
  await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: t + 1000 });
  assert.equal(ctx.falso.chamadas.consultar, 1);
  await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: t + 3000 });
  assert.equal(ctx.falso.chamadas.consultar, 2);
});

test('confirmado na mão e depois pelo provedor: não duplica; fica na Auditoria', async () => {
  const ctx = lojaComPixAutomatico();
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  const m = pixAuto.confirmarManual({ id: r.cobranca.id, operadorId: ctx.operadorId });
  assert.equal(m.ok, true, m.error);
  const provedorId = ctx.db.prepare('SELECT provedor_id FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id).provedor_id;
  ctx.falso.pagar(provedorId);
  await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: depois() });
  await pixAuto.reconciliar({ agoraMs: depois() });
  assert.equal(pixAuto.confirmarManual({ id: r.cobranca.id, operadorId: ctx.operadorId }).ok, true); // repetir também não duplica
  assert.equal(pagamentosDa(ctx.db, ctx.saleId).length, 1);
  const linha = ctx.db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id);
  assert.equal(linha.confirmado_manual, 1);
  assert.equal(linha.status, 'pago'); // não pode virar "pago sem venda" por já estar quitada
  assert.equal(auditoria(ctx.db, 'pix_recebido_sem_venda').length, 0);
  const aud = auditoria(ctx.db, 'pix_confirmado_manual');
  assert.equal(aud.length, 1);
  assert.equal(aud[0].solicitante_id, ctx.operadorId);
});

test('gerar de novo na mesma venda cancela a cobrança anterior no provedor', async () => {
  const ctx = lojaComPixAutomatico();
  const a = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  const b = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  assert.equal(ctx.falso.chamadas.cancelar.length, 1);
  assert.equal(ctx.db.prepare('SELECT status FROM pix_cobrancas WHERE id = ?').get(a.cobranca.id).status, 'cancelado');
  assert.equal(ctx.db.prepare('SELECT status FROM pix_cobrancas WHERE id = ?').get(b.cobranca.id).status, 'pendente');
});

test('cancelamento que falhou no provedor: se o cliente pagar o QR velho e a venda já quitou, vira "pago sem venda"', async () => {
  const ctx = lojaComPixAutomatico();
  const a = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  ctx.falso.falharCancelar(true);
  const c = await pixAuto.cancelarCobranca({ id: a.cobranca.id });
  assert.equal(c.cancelado, false);
  assert.equal(c.cobranca.status, 'pendente'); // continua sendo conferida
  // Operador recebeu em dinheiro e fechou.
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 50, detalhes: {} });
  saleService.finalizeSale(ctx.saleId);
  const provedorId = ctx.db.prepare('SELECT provedor_id FROM pix_cobrancas WHERE id = ?').get(a.cobranca.id).provedor_id;
  ctx.falso.pagar(provedorId);
  await pixAuto.reconciliar({ agoraMs: depois() });
  assert.equal(ctx.db.prepare('SELECT status FROM pix_cobrancas WHERE id = ?').get(a.cobranca.id).status, 'pago_sem_venda');
  assert.equal(pagamentosDa(ctx.db, ctx.saleId).filter((p) => p.metodo === 'pix').length, 0);
  assert.equal(auditoria(ctx.db, 'pix_recebido_sem_venda').length, 1);
  const lista = pixAuto.listarRecebidosSemVenda();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].valor, 50);
});

test('venda ainda aberta mas já quitada por outro meio: Pix pago vira "pago sem venda", sem lançar a mais', async () => {
  const ctx = lojaComPixAutomatico();
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'cartao_credito', valor: 50, detalhes: {} });
  const provedorId = ctx.db.prepare('SELECT provedor_id FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id).provedor_id;
  ctx.falso.pagar(provedorId);
  const c = await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: depois() });
  assert.equal(c.cobranca.status, 'pago_sem_venda');
  assert.equal(pagamentosDa(ctx.db, ctx.saleId).filter((p) => p.metodo === 'pix').length, 0);
  assert.match(auditoria(ctx.db, 'pix_recebido_sem_venda')[0].motivo, /já estava quitada/);
});

test('venda diminuiu depois do QR: lança só o que falta e registra o valor a mais', async () => {
  const ctx = lojaComPixAutomatico();
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  ctx.db.prepare('UPDATE sales SET desconto = 10 WHERE id = ?').run(ctx.saleId);
  const provedorId = ctx.db.prepare('SELECT provedor_id FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id).provedor_id;
  ctx.falso.pagar(provedorId);
  const pago = await pixAuto.consultarCobranca({ id: r.cobranca.id, agoraMs: depois() });
  assert.equal(pago.cobranca.status, 'pago');
  const [p] = pagamentosDa(ctx.db, ctx.saleId);
  assert.equal(p.valor, 40);
  assert.equal(JSON.parse(p.detalhes).valorRecebido, 50);
  assert.match(auditoria(ctx.db, 'pix_recebido_sem_venda')[0].motivo, /10,00 a mais/);
});

test('provedor fora do ar ao criar: avisa e manda usar o QR fixo', async () => {
  const ctx = lojaComPixAutomatico();
  ctx.falso.falharCriar('Sem conexão com o Mercado Pago. Confira a internet.');
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId });
  assert.equal(r.ok, false);
  assert.equal(r.usarQrFixo, true);
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM pix_cobrancas WHERE status = 'erro'`).get().n, 1);
});

test('cobrança vencida há mais de 10 min sai da conferência como expirada', async () => {
  const ctx = lojaComPixAutomatico();
  const agora = Date.now();
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 50, operadorId: ctx.operadorId, agoraMs: agora });
  await pixAuto.reconciliar({ agoraMs: agora + 35 * 60000 }); // venceu há 5 min: ainda confere
  assert.equal(ctx.db.prepare('SELECT status FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id).status, 'pendente');
  await pixAuto.reconciliar({ agoraMs: agora + 41 * 60000 });
  assert.equal(ctx.db.prepare('SELECT status FROM pix_cobrancas WHERE id = ?').get(r.cobranca.id).status, 'expirado');
  assert.equal(pixAuto.confirmarManual({ id: r.cobranca.id, operadorId: ctx.operadorId }).ok, false);
});

test('não cobra mais do que falta nem venda fechada', async () => {
  const ctx = lojaComPixAutomatico();
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 20, detalhes: {} });
  const r = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 999, operadorId: ctx.operadorId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.cobranca.valor, 30);
  saleService.addPayment({ saleId: ctx.saleId, metodo: 'dinheiro', valor: 30, detalhes: {} });
  saleService.finalizeSale(ctx.saleId);
  const fechada = await pixAuto.criarCobranca({ saleId: ctx.saleId, valor: 10, operadorId: ctx.operadorId });
  assert.equal(fechada.ok, false);
});

// ---- adaptador do Mercado Pago (fetch falso, sem rede) ----

function fetchFalso(respostas) {
  const chamadas = [];
  const fn = async (url, opts) => {
    chamadas.push({ url, ...opts, corpo: opts.body ? JSON.parse(opts.body) : null });
    const r = respostas.shift();
    return { ok: r.status < 400, status: r.status, json: async () => r.corpo };
  };
  return { fn, chamadas };
}

test('Mercado Pago: criar manda token, idempotência, Pix e vencimento em -03:00', async () => {
  const f = fetchFalso([{ status: 201, corpo: { id: 123, status: 'pending', point_of_interaction: { transaction_data: { qr_code: '000201-copia' } } } }]);
  const mp = criarMercadoPago({ fetch: f.fn });
  const expira = Date.UTC(2026, 9, 24, 15, 30, 0, 0); // 12:30 em Brasília
  const r = await mp.criar({ token: TOKEN_FALSO, valor: 12.345, descricao: 'Loja - venda', referencia: 'ref-1', idempotencia: 'ref-1', expiraEmMs: expira, emailPagador: 'vendas@exemplo.com' });
  assert.deepEqual(r, { provedorId: '123', copiaECola: '000201-copia', status: 'pendente' });
  const [c] = f.chamadas;
  assert.equal(c.url, 'https://api.mercadopago.com/v1/payments');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Bearer ${TOKEN_FALSO}`);
  assert.equal(c.headers['X-Idempotency-Key'], 'ref-1');
  assert.equal(c.corpo.payment_method_id, 'pix');
  assert.equal(c.corpo.transaction_amount, 12.35);
  assert.equal(c.corpo.date_of_expiration, '2026-10-24T12:30:00.000-03:00');
  assert.equal(c.corpo.payer.email, 'vendas@exemplo.com');
  assert.equal(dataMercadoPago(expira), '2026-10-24T12:30:00.000-03:00');
});

test('Mercado Pago: status, token inválido e falta do código Pix', async () => {
  assert.equal(mapearStatus('approved'), 'pago');
  assert.equal(mapearStatus('in_process'), 'pendente');
  assert.equal(mapearStatus('cancelled', 'expired'), 'expirado');
  assert.equal(mapearStatus('cancelled', 'by_collector'), 'cancelado');
  assert.equal(mapearStatus('rejected'), 'falhou');
  assert.equal(mapearStatus('refunded'), 'estornado');

  const f = fetchFalso([{ status: 401, corpo: { message: 'invalid access token' } }, { status: 201, corpo: { id: 9, status: 'pending' } }]);
  const mp = criarMercadoPago({ fetch: f.fn });
  await assert.rejects(mp.testar({ token: TOKEN_FALSO }), /Token do Mercado Pago inválido/);
  await assert.rejects(mp.criar({ token: TOKEN_FALSO, valor: 1, expiraEmMs: Date.now(), emailPagador: 'a@b.com' }), /não devolveu o código Pix/);

  const g = fetchFalso([{ status: 200, corpo: { status: 'approved', transaction_amount: 10, transaction_details: { total_paid_amount: 10 } } }, { status: 200, corpo: {} }]);
  const mp2 = criarMercadoPago({ fetch: g.fn });
  assert.deepEqual((await mp2.consultar({ token: TOKEN_FALSO, provedorId: '9/../x' })).status, 'pago');
  assert.equal(g.chamadas[0].url, 'https://api.mercadopago.com/v1/payments/9%2F..%2Fx');
  await mp2.cancelar({ token: TOKEN_FALSO, provedorId: '9' });
  assert.equal(g.chamadas[1].method, 'PUT');
  assert.deepEqual(g.chamadas[1].corpo, { status: 'cancelled' });
});

test('Mercado Pago: sem internet dá mensagem clara', async () => {
  const mp = criarMercadoPago({ fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(mp.testar({ token: TOKEN_FALSO }), /Sem conexão com o Mercado Pago/);
});
