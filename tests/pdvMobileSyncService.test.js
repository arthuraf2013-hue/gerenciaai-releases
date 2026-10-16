const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const saleService = require('../electron/services/saleService');
const stockSyncService = require('../electron/services/stockSyncService');
const cashService = require('../electron/services/cashService');
const pdvMobileSyncService = require('../electron/services/pdvMobileSyncService');
const pdvMobileConfigService = require('../electron/services/pdvMobileConfigService');
const pdvMobileConsultaService = require('../electron/services/pdvMobileConsultaService');
const pedidoGarcomSyncService = require('../electron/services/pedidoGarcomSyncService');
const pairingService = require('../electron/services/pairingService');
const { atualizarCheckTipoPareamentoParaIncluirPdv } = require('../electron/db/database');

// Só a parte local/SQLite do PDV móvel -- a escuta do Firestore
// (iniciarPdvMobile) e o envio do resultado pro celular dependem de rede
// de verdade, fora do escopo de um teste local (mesma limitação de
// pedidoGarcomSyncService.test.js).

const { ErroVendaMobile } = pdvMobileSyncService;

function prepararLoja({ estoque = 10, preco = 10, caixaAberto = true } = {}) {
  const ctx = freshTestDb();
  ctx.produtoId = createProduct(ctx.db, { nome: 'Refrigerante', preco });
  addStock(ctx.db, { productId: ctx.produtoId, locationId: ctx.locationId, quantidade: estoque, operadorId: ctx.adminId });
  if (caixaAberto) cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.adminId, valorAbertura: 100 });
  ctx.db.prepare(`INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-pdv-1', 'pdv', ?, 1)`).run(ctx.operadorId);
  ctx.dispositivo = pdvMobileSyncService.buscarDispositivoPdv('uid-pdv-1');
  return ctx;
}

function venda(ctx, overrides = {}) {
  return {
    dispositivoUid: 'uid-pdv-1',
    itens: [{ productId: ctx.produtoId, nome: 'Refrigerante', quantidade: 2, precoUnitario: 10 }],
    subtotalEsperado: 20,
    pagamentos: [{ metodo: 'dinheiro', valor: 20, valorRecebido: 50 }],
    ...overrides,
  };
}

function estoque(ctx) {
  return ctx.db.prepare('SELECT COALESCE(SUM(quantidade), 0) as t FROM stock_movements WHERE product_id = ?').get(ctx.produtoId).t;
}

function criar(ctx, vendaId, dados) {
  return pdvMobileSyncService.criarVendaLocal({ vendaId, dados, dispositivo: ctx.dispositivo, locationId: ctx.locationId });
}

test('venda do celular vira venda local finalizada: estoque baixado, troco fora do caixa, rastreada em mobile_sales', async () => {
  const ctx = prepararLoja();
  const { saleId } = criar(ctx, 'venda-1', venda(ctx));

  const row = ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-1');
  assert.equal(row.status, 'criada');
  assert.equal(row.sale_id, saleId);
  assert.equal(estoque(ctx), 8);

  await pdvMobileSyncService.avancarVendaCriada(row);
  const sale = ctx.db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  assert.equal(sale.status, 'finalizada');
  assert.equal(sale.operador_id, ctx.operadorId); // em nome do usuário vinculado ao celular
  assert.equal(ctx.db.prepare('SELECT status FROM mobile_sales WHERE id = ?').get('venda-1').status, 'finalizada');

  const pagamentos = ctx.db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);
  assert.equal(pagamentos.length, 1);
  assert.equal(pagamentos[0].valor, 20); // só o valor da venda entra como dinheiro no caixa
  const detalhes = JSON.parse(pagamentos[0].detalhes);
  assert.equal(detalhes.troco, 30);
  assert.equal(detalhes.origem, 'pdv_movel');

  const resumo = pdvMobileSyncService.montarResumo(saleId);
  assert.equal(resumo.total, 20);
  assert.equal(resumo.troco, 30);
  assert.equal(resumo.itens[0].quantidade, 2);
});

test('estoque movimentado pela venda do celular carrega o uid do celular como device_id', () => {
  const ctx = prepararLoja();
  const { saleId } = criar(ctx, 'venda-device', venda(ctx));
  const mov = ctx.db.prepare(`SELECT device_id, operador_id FROM stock_movements WHERE sale_id = ? AND tipo = 'venda'`).get(saleId);
  assert.equal(mov.device_id, 'uid-pdv-1');
  assert.equal(mov.operador_id, ctx.operadorId);
});

test('sem caixa aberto no computador, recusa sem criar nada', () => {
  const ctx = prepararLoja({ caixaAberto: false });
  assert.throws(() => criar(ctx, 'venda-2', venda(ctx)), (err) => err instanceof ErroVendaMobile && err.codigo === 'caixa_fechado');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM sales').get().c, 0);
  assert.equal(estoque(ctx), 10);
});

test('estoque insuficiente em um item desfaz a venda INTEIRA (inclusive a baixa dos itens anteriores)', () => {
  const ctx = prepararLoja({ estoque: 10 });
  const outroId = createProduct(ctx.db, { nome: 'Salgado', preco: 5 });
  addStock(ctx.db, { productId: outroId, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.adminId });

  const dados = venda(ctx, {
    itens: [
      { productId: ctx.produtoId, nome: 'Refrigerante', quantidade: 2, precoUnitario: 10 },
      { productId: outroId, nome: 'Salgado', quantidade: 3, precoUnitario: 5 },
    ],
    subtotalEsperado: 35,
    pagamentos: [{ metodo: 'dinheiro', valor: 35 }],
  });
  assert.throws(() => criar(ctx, 'venda-3', dados), (err) => err.codigo === 'item_recusado' && /Salgado/.test(err.message));
  assert.equal(estoque(ctx), 10); // baixa do refrigerante desfeita junto
  assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM sales').get().c, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM mobile_sales').get().c, 0);
});

test('preço mudou desde o catálogo do celular: recusa e devolve os preços atuais', () => {
  const ctx = prepararLoja({ preco: 12 }); // celular ainda acha que custa 10
  assert.throws(() => criar(ctx, 'venda-4', venda(ctx)), (err) => {
    assert.equal(err.codigo, 'precos_alterados');
    assert.equal(err.extra.precosAtuais[ctx.produtoId], 12);
    return true;
  });
  assert.equal(estoque(ctx), 10);
});

test('pagamento menor que o total é recusado', () => {
  const ctx = prepararLoja();
  assert.throws(
    () => criar(ctx, 'venda-5', venda(ctx, { pagamentos: [{ metodo: 'cartao_debito', valor: 15 }] })),
    (err) => err.codigo === 'pagamento_incompleto'
  );
});

test('forma de pagamento não liberada pra o celular é recusada (fiado fica de fora por padrão)', () => {
  const ctx = prepararLoja();
  assert.throws(
    () => criar(ctx, 'venda-6', venda(ctx, { pagamentos: [{ metodo: 'fiado', valor: 20 }] })),
    (err) => err.codigo === 'metodo_nao_permitido'
  );
});

test('desconto: com autorização exigida e política 0%, celular não dá desconto', () => {
  const ctx = prepararLoja();
  ctx.db.prepare(`UPDATE security_config SET exigir_autorizacao_desconto = 1`).run();
  assert.throws(
    () => criar(ctx, 'venda-7', venda(ctx, { desconto: { valor: 2 }, pagamentos: [{ metodo: 'dinheiro', valor: 18 }] })),
    (err) => err.codigo === 'desconto_nao_permitido'
  );
});

test('desconto dentro da política (10%) passa, com quem salvou a política como autorizador e rastro em audit_log', async () => {
  const ctx = prepararLoja();
  ctx.db.prepare(`UPDATE security_config SET exigir_autorizacao_desconto = 1`).run();
  const r = pdvMobileConfigService.saveConfig({
    permitirVenda: true, permitirMesas: true, permitirCliente: true,
    metodosPagamento: ['dinheiro', 'pix'], descontoMaximoPercentual: 10, requestingUserId: ctx.gerenteId,
  });
  assert.equal(r.ok, true);

  assert.throws(
    () => criar(ctx, 'venda-8a', venda(ctx, { desconto: { valor: 3 }, pagamentos: [{ metodo: 'dinheiro', valor: 17 }] })),
    (err) => err.codigo === 'desconto_acima_do_limite'
  );

  const { saleId } = criar(ctx, 'venda-8', venda(ctx, { desconto: { valor: 2, motivo: 'cliente fiel' }, pagamentos: [{ metodo: 'pix', valor: 18 }] }));
  const sale = ctx.db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  assert.equal(sale.desconto_gerente, 2);
  assert.equal(sale.desconto_autorizado_por_id, ctx.gerenteId);
  const audit = ctx.db.prepare(`SELECT * FROM audit_log WHERE sale_id = ? AND tipo_evento = 'desconto_pdv_movel'`).get(saleId);
  assert.ok(audit);
  assert.equal(audit.solicitante_id, ctx.operadorId);

  await pdvMobileSyncService.avancarVendaCriada(ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-8'));
  assert.equal(ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId).status, 'finalizada');
});

test('fiado exige cliente; com cliente vinculado, vira dívida do cliente ao finalizar', async () => {
  const ctx = prepararLoja();
  pdvMobileConfigService.saveConfig({
    permitirVenda: true, permitirMesas: false, permitirCliente: true,
    metodosPagamento: ['dinheiro', 'fiado'], descontoMaximoPercentual: 0, requestingUserId: ctx.adminId,
  });
  assert.throws(
    () => criar(ctx, 'venda-9a', venda(ctx, { pagamentos: [{ metodo: 'fiado', valor: 20 }] })),
    (err) => err.codigo === 'fiado_sem_cliente'
  );

  ctx.db.prepare(`INSERT INTO customers (id, nome, telefone, cpf) VALUES ('cli-1', 'Maria', '81999990000', '12345678901')`).run();
  const { saleId } = criar(ctx, 'venda-9', venda(ctx, { clienteId: 'cli-1', pagamentos: [{ metodo: 'fiado', valor: 20 }] }));
  await pdvMobileSyncService.avancarVendaCriada(ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-9'));
  assert.equal(ctx.db.prepare('SELECT status, customer_id FROM sales WHERE id = ?').get(saleId).customer_id, 'cli-1');
  assert.equal(require('../electron/services/customerService').getSaldoFiado('cli-1'), 20);
});

test('venda pelo celular desligada na configuração é recusada', () => {
  const ctx = prepararLoja();
  pdvMobileConfigService.saveConfig({
    permitirVenda: false, permitirMesas: true, permitirCliente: false,
    metodosPagamento: [], descontoMaximoPercentual: 0, requestingUserId: ctx.adminId,
  });
  assert.throws(() => criar(ctx, 'venda-10', venda(ctx)), (err) => err.codigo === 'venda_desligada');
});

test('estoque do grupo recusado de verdade: a venda é desfeita pelo sistema (estoque devolvido) e marcada com erro', async () => {
  const ctx = prepararLoja();
  const { saleId } = criar(ctx, 'venda-11', venda(ctx));
  const original = stockSyncService.verificarEDebitarEstoqueRemoto;
  stockSyncService.verificarEDebitarEstoqueRemoto = async () => ({ ok: false, motivo: 'estoque_insuficiente', error: 'Sem estoque no grupo.' });
  try {
    await pdvMobileSyncService.avancarVendaCriada(ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-11'));
  } finally {
    stockSyncService.verificarEDebitarEstoqueRemoto = original;
  }
  assert.equal(ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId).status, 'cancelada');
  assert.equal(estoque(ctx), 10);
  const row = ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-11');
  assert.equal(row.status, 'erro');
  assert.match(row.erro, /Sem estoque no grupo/);
  assert.ok(ctx.db.prepare(`SELECT 1 FROM audit_log WHERE sale_id = ? AND tipo_evento = 'cancelamento_venda_automatico_sistema'`).get(saleId));
});

test('falha de REDE no estoque do grupo deixa pendente; quando o ciclo automático finaliza, a reconciliação marca finalizada', async () => {
  const ctx = prepararLoja();
  const { saleId } = criar(ctx, 'venda-12', venda(ctx));
  const original = stockSyncService.verificarEDebitarEstoqueRemoto;
  stockSyncService.verificarEDebitarEstoqueRemoto = async () => ({ ok: false, motivo: 'rede', error: 'offline' });
  try {
    await pdvMobileSyncService.avancarVendaCriada(ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-12'));
  } finally {
    stockSyncService.verificarEDebitarEstoqueRemoto = original;
  }
  assert.equal(ctx.db.prepare('SELECT status FROM mobile_sales WHERE id = ?').get('venda-12').status, 'pendente_estoque');

  // Venda pendente do celular nunca vira o "carrinho atual" de quem abrir o PDV no computador.
  const atual = saleService.getOrOpenCurrentSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  assert.notEqual(atual.saleId, saleId);

  await saleService.tentarFinalizarVendasPendentesDeEstoque({ forcar: true }); // sem grupo -> ok
  await pdvMobileSyncService.avancarVendaCriada(ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-12'));
  assert.equal(ctx.db.prepare('SELECT status FROM mobile_sales WHERE id = ?').get('venda-12').status, 'finalizada');
});

test('avancarVendaCriada é idempotente: chamar de novo numa venda já finalizada não finaliza duas vezes', async () => {
  const ctx = prepararLoja();
  criar(ctx, 'venda-13', venda(ctx));
  const row = ctx.db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get('venda-13');
  await pdvMobileSyncService.avancarVendaCriada(row);
  await pdvMobileSyncService.avancarVendaCriada(row); // reentrega com o registro "velho"
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) as c FROM sales WHERE status = 'finalizada'`).get().c, 1);
  assert.equal(estoque(ctx), 8);
});

test('mesmo id de venda não pode ser criado duas vezes', () => {
  const ctx = prepararLoja();
  criar(ctx, 'venda-14', venda(ctx));
  assert.throws(() => criar(ctx, 'venda-14', venda(ctx)));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM sales').get().c, 1);
  assert.equal(estoque(ctx), 8);
});

test('normalizarPayload recusa quantidade inválida e soma linhas repetidas do mesmo produto', () => {
  assert.throws(
    () => pdvMobileSyncService.normalizarPayload({ itens: [{ productId: 'p', quantidade: -1 }], pagamentos: [{ metodo: 'dinheiro', valor: 1 }], subtotalEsperado: 1 }),
    (err) => err.codigo === 'item_invalido'
  );
  const p = pdvMobileSyncService.normalizarPayload({
    itens: [{ productId: 'p', quantidade: 1 }, { productId: 'p', quantidade: 2 }],
    pagamentos: [{ metodo: 'pix', valor: 3 }], subtotalEsperado: 3,
  });
  assert.equal(p.itens.length, 1);
  assert.equal(p.itens[0].quantidade, 3);
});

test('buscarDispositivoPdv não acha celular revogado nem de outro tipo', () => {
  const ctx = prepararLoja();
  ctx.db.prepare(`UPDATE paired_devices SET ativo = 0 WHERE id = 'uid-pdv-1'`).run();
  assert.equal(pdvMobileSyncService.buscarDispositivoPdv('uid-pdv-1'), undefined);
  ctx.db.prepare(`INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-consulta', 'consulta', ?, 1)`).run(ctx.adminId);
  assert.equal(pdvMobileSyncService.buscarDispositivoPdv('uid-consulta'), undefined);
});

test('pedido de mesa: celular PDV móvel lança pedido enquanto a função Mesas estiver ligada', () => {
  const ctx = prepararLoja();
  assert.ok(pedidoGarcomSyncService.buscarUsuarioLocalDoDispositivo('uid-pdv-1'));
  pdvMobileConfigService.saveConfig({
    permitirVenda: true, permitirMesas: false, permitirCliente: true,
    metodosPagamento: ['dinheiro'], descontoMaximoPercentual: 0, requestingUserId: ctx.adminId,
  });
  assert.equal(pedidoGarcomSyncService.buscarUsuarioLocalDoDispositivo('uid-pdv-1'), undefined);
});

test('saveConfig: só gestão altera, e exige ao menos uma forma de pagamento quando a venda está ligada', () => {
  const ctx = prepararLoja();
  assert.equal(pdvMobileConfigService.saveConfig({ permitirVenda: true, metodosPagamento: ['pix'], descontoMaximoPercentual: 0, requestingUserId: ctx.operadorId }).ok, false);
  assert.equal(pdvMobileConfigService.saveConfig({ permitirVenda: true, metodosPagamento: [], descontoMaximoPercentual: 0, requestingUserId: ctx.adminId }).ok, false);
  assert.equal(pdvMobileConfigService.saveConfig({ permitirVenda: true, metodosPagamento: ['pix', 'cheque'], descontoMaximoPercentual: 150, requestingUserId: ctx.adminId }).ok, false);
  const ok = pdvMobileConfigService.saveConfig({ permitirVenda: true, permitirMesas: true, metodosPagamento: ['pix', 'cheque'], descontoMaximoPercentual: 5, requestingUserId: ctx.adminId });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.metodosPagamento, ['pix']); // método desconhecido descartado
});

test('consulta de clientes devolve telefone/documento mascarados', () => {
  const ctx = prepararLoja();
  ctx.db.prepare(`INSERT INTO customers (id, nome, telefone, cpf) VALUES ('cli-2', 'João Silva', '(81) 98888-7777', '111.222.333-44')`).run();
  const r = pdvMobileConsultaService.executarConsulta({ tipo: 'clientes', termo: 'joão' });
  assert.equal(r.resultado.length, 1);
  assert.equal(r.resultado[0].telefoneFinal, '•••7777');
  assert.equal(r.resultado[0].documentoFinal, '•••3344');
  assert.equal(JSON.stringify(r.resultado).includes('98888'), false);
});

test('consulta por código acha por código de barras e por etiqueta de balança (peso embutido)', () => {
  const ctx = prepararLoja();
  ctx.db.prepare(`UPDATE products SET codigo_barras = '7891234567895' WHERE id = ?`).run(ctx.produtoId);
  const r = pdvMobileConsultaService.executarConsulta({ tipo: 'codigo', codigo: '7891234567895' });
  assert.equal(r.resultado.produto.id, ctx.produtoId);
  assert.equal(r.resultado.produto.estoque, 10);

  const nao = pdvMobileConsultaService.executarConsulta({ tipo: 'codigo', codigo: '7890000000000' });
  assert.equal(nao.resultado.naoEncontrado, true);

  // Etiqueta de balança: prefixo 2 + código (6) + peso em gramas (5) + DV.
  const weightBarcodeService = require('../electron/services/weightBarcodeService');
  weightBarcodeService.updateConfig({ formato: 'peso_cod6', campo: 'peso' });
  ctx.db.prepare(`UPDATE products SET codigo_balanca = '012345' WHERE id = ?`).run(ctx.produtoId);
  const doze = '2' + '012345' + '00750';
  const etiqueta = doze + weightBarcodeService.calcularDigitoVerificador(doze);
  const pesado = pdvMobileConsultaService.executarConsulta({ tipo: 'codigo', codigo: etiqueta });
  assert.equal(pesado.resultado.produto.id, ctx.produtoId);
  assert.equal(pesado.resultado.quantidade, 0.75);
});

test('consulta de Pix devolve payload e a matriz do QR (sem SVG/HTML)', () => {
  const ctx = prepararLoja();
  ctx.db.prepare(`UPDATE payment_config SET pix_chave = 'loja@exemplo.com', pix_nome_recebedor = 'Loja Exemplo', pix_cidade = 'Recife' WHERE id = 'default'`).run();
  pdvMobileConfigService.saveConfig({ permitirVenda: true, permitirMesas: true, metodosPagamento: ['pix'], descontoMaximoPercentual: 0, requestingUserId: ctx.adminId });
  const r = pdvMobileConsultaService.executarConsulta({ tipo: 'pix', valor: 18.5, txid: 'abc123' });
  assert.ok(r.resultado.payload.startsWith('000201'));
  assert.equal(r.resultado.valor, 18.5);
  assert.equal(r.resultado.qr.bits.length, r.resultado.qr.size * r.resultado.qr.size);
  assert.match(r.resultado.qr.bits, /^[01]+$/);
});

test('pareamento: código de PDV móvel recusa usuário garçom (antes de tocar rede)', async () => {
  const ctx = prepararLoja();
  const garcomId = require('crypto').randomUUID();
  ctx.db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Garçom', 'garcom', 'x')`).run(garcomId);
  const r = await pairingService.gerarCodigo({ tipo: 'pdv', vinculoUserId: garcomId, requestingUserId: ctx.adminId });
  assert.equal(r.ok, false);
  assert.match(r.error, /PDV móvel/);
});

test('pareamento: módulo PDV móvel confirmado desligado recusa na hora', async () => {
  const ctx = prepararLoja();
  ctx.db.prepare(
    `INSERT INTO modulos_pagos_state (id, cliente_id, consulta_remota, app_garcom, pdv_mobile, ja_sincronizado) VALUES ('default', 'c', 1, 1, 0, 1)`
  ).run();
  const r = await pairingService.gerarCodigo({ tipo: 'pdv', vinculoUserId: ctx.operadorId, requestingUserId: ctx.adminId });
  assert.equal(r.ok, false);
  assert.match(r.error, /PDV móvel/);
});

test('migração: banco antigo (CHECK sem pdv) passa a aceitar dispositivo/código pdv sem perder linhas', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('u1');
    CREATE TABLE pairing_codes (
      id TEXT PRIMARY KEY, tipo TEXT NOT NULL CHECK (tipo IN ('garcom','consulta')),
      vinculo_user_id TEXT NOT NULL REFERENCES users(id), criado_por_id TEXT NOT NULL REFERENCES users(id),
      criado_em TEXT NOT NULL DEFAULT '2026-01-01 00:00:00', expira_em TEXT NOT NULL, usado INTEGER NOT NULL DEFAULT 0, usado_em TEXT
    );
    CREATE TABLE paired_devices (
      id TEXT PRIMARY KEY, tipo TEXT NOT NULL CHECK (tipo IN ('garcom','consulta')),
      vinculo_user_id TEXT NOT NULL REFERENCES users(id), nome_dispositivo TEXT,
      criado_em TEXT NOT NULL DEFAULT '2026-01-01 00:00:00', ativo INTEGER NOT NULL DEFAULT 1, ultimo_acesso TEXT
    );
    INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('123456', 'garcom', 'u1', 'u1', '2026-01-01 00:10:00');
    INSERT INTO paired_devices (id, tipo, vinculo_user_id, nome_dispositivo) VALUES ('d1', 'consulta', 'u1', 'Celular do dono');
  `);
  db.function('NOW_SYNCED', () => '2026-01-01 00:00:00');
  assert.throws(() => db.prepare(`INSERT INTO paired_devices (id, tipo, vinculo_user_id) VALUES ('d2', 'pdv', 'u1')`).run());

  atualizarCheckTipoPareamentoParaIncluirPdv(db);
  atualizarCheckTipoPareamentoParaIncluirPdv(db); // idempotente

  db.prepare(`INSERT INTO paired_devices (id, tipo, vinculo_user_id) VALUES ('d2', 'pdv', 'u1')`).run();
  db.prepare(`INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES ('654321', 'pdv', 'u1', 'u1', 'x')`).run();
  assert.equal(db.prepare(`SELECT nome_dispositivo FROM paired_devices WHERE id = 'd1'`).get().nome_dispositivo, 'Celular do dono');
  assert.equal(db.prepare(`SELECT COUNT(*) as c FROM pairing_codes`).get().c, 2);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_pairing_codes_usado'`).get());
});
