const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

// Rede (Firestore/WhatsApp) fora dos testes: só a parte local.
const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };

const cozinha = require('../electron/services/cozinhaService');
const escpos = require('../electron/services/escposService');
const chamada = require('../electron/services/chamadaService');
const vitrine = require('../electron/services/vitrineService');
const vitrinePedido = require('../electron/services/vitrinePedidoService');
const botOrderService = require('../electron/services/botOrderService');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');

const esperar = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function loja() {
  const ctx = freshTestDb();
  const lanche = createProduct(ctx.db, { nome: 'X-Burguer', preco: 22, categoria: 'Lanches' });
  const refri = createProduct(ctx.db, { nome: 'Refrigerante', preco: 6, categoria: 'Bebidas' });
  const fritas = createProduct(ctx.db, { nome: 'Fritas', preco: 12, categoria: 'Lanches' });
  for (const p of [lanche, refri, fritas]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  return { ...ctx, lanche, refri, fritas };
}

function impressoraFalsa() {
  const saidas = [];
  let falhar = false;
  cozinha._definirImpressorasParaTeste({
    windows: async (html, opts) => { if (falhar) throw new Error('Impressora sem papel'); saidas.push({ html, opts }); },
    rede: async ({ ip, porta, dados }) => { if (falhar) throw new Error('Impressora desligada'); saidas.push({ ip, porta, dados }); },
  });
  return { saidas, falhar: (v) => { falhar = v; } };
}

function abrirMesa(ctx, numero = '5') {
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero });
  const tableId = mesa.id || ctx.db.prepare('SELECT id FROM restaurant_tables WHERE numero = ?').get(numero).id;
  const aberta = tableService.openTable({ tableId, locationId: ctx.locationId, operadorId: ctx.adminId, pessoas: 2 });
  return { tableId, saleId: aberta.saleId };
}

// ---------------- cozinha ----------------

test('cozinha: config só de gestão, valida IP/impressora, categorias', () => {
  const ctx = loja();
  assert.equal(cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '192.168.0.50', requestingUserId: ctx.operadorId }).ok, false);
  assert.match(cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '999.1.1.1', requestingUserId: ctx.gerenteId }).error, /IP/);
  assert.match(cozinha.saveConfig({ ativa: true, tipo: 'windows', impressoraWindows: '', requestingUserId: ctx.gerenteId }).error, /impressora/);
  const r = cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '192.168.0.50', categorias: ['Lanches', ' Lanches ', ''], requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.categorias, ['Lanches']);
  assert.deepEqual(cozinha.listarCategorias(), ['Bebidas', 'Lanches']);
});

test('cozinha: comanda da mesa só com itens da cozinha, marca enviado só depois de imprimir', async () => {
  const ctx = loja();
  const imp = impressoraFalsa();
  cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '192.168.0.50', categorias: ['Lanches'], requestingUserId: ctx.gerenteId });
  const { saleId } = abrirMesa(ctx);
  saleService.addItem({ saleId, productId: ctx.lanche, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.adminId, deviceId: 'pc', observacao: 'sem cebola' });
  saleService.addItem({ saleId, productId: ctx.refri, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.adminId, deviceId: 'pc' });

  imp.falhar(true);
  const falha = await cozinha.imprimirItensDaVenda({ saleId });
  assert.equal(falha.ok, false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ? AND enviado_cozinha = 1').get(saleId).n, 0, 'falhou: nada marcado');
  assert.equal(cozinha.listarUltimas()[0].status, 'falhou');

  imp.falhar(false);
  const ok = await cozinha.imprimirItensDaVenda({ saleId });
  assert.equal(ok.ok, true);
  assert.equal(ok.totalItens, 1, 'refrigerante não é da cozinha');
  const texto = imp.saidas[0].dados.toString('latin1');
  assert.match(texto, /MESA 5/);
  assert.match(texto, /X-Burguer/);
  assert.match(texto, /sem cebola/);
  assert.doesNotMatch(texto, /Refrigerante/);
  assert.equal((await cozinha.imprimirItensDaVenda({ saleId })).nadaNovo, true, 'não imprime de novo');

  // Reimprimir a que falhou sai igual e marca os itens dela.
  const falhada = cozinha.listarUltimas().find((l) => l.status === 'falhou');
  assert.equal((await cozinha.reimprimir({ id: falhada.id })).ok, true);
});

test('cozinha automática: junta itens lançados em sequência e imprime uma vez por mesa', async () => {
  const ctx = loja();
  const imp = impressoraFalsa();
  cozinha.saveConfig({ ativa: true, automatica: true, tipo: 'windows', impressoraWindows: 'Cozinha', requestingUserId: ctx.gerenteId });
  const { saleId } = abrirMesa(ctx);
  saleService.addItem({ saleId, productId: ctx.lanche, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.adminId, deviceId: 'pc' });
  // Item recém-lançado espera os segundos de agrupamento.
  assert.deepEqual(cozinha.comandasComItensNovos(), []);
  ctx.db.prepare(`UPDATE sale_items SET criado_em = datetime(criado_em, '-10 seconds') WHERE sale_id = ?`).run(saleId);
  assert.deepEqual(cozinha.comandasComItensNovos(), [saleId]);
  await cozinha.cicloAutomatico();
  assert.equal(imp.saidas.length, 1);
  assert.match(imp.saidas[0].html, /X-Burguer/);
  assert.equal(imp.saidas[0].opts.impressora, 'Cozinha');
  await cozinha.cicloAutomatico();
  assert.equal(imp.saidas.length, 1, 'não repete');
});

test('ESC/POS: acentos na tabela 860, corte, quebra de linha e IP validado', () => {
  assert.deepEqual(escpos.codificar('ação', 'cp860'), [0x61, 0x87, 0x84, 0x6f]);
  assert.deepEqual(escpos.codificar('ação', 'cp850'), [0x61, 0x87, 0xc6, 0x6f]);
  assert.deepEqual(escpos.codificar('ação 🍔', 'sem_acento'), [...Buffer.from('acao ')]);
  const buf = escpos.montarComandaEscPos({ titulo: 'SENHA 12', itens: [{ quantidade: 1, nome: 'Pão' }] }, { largura: 58, codepage: 'cp860' });
  assert.deepEqual([...buf.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 3]);
  assert.deepEqual([...buf.subarray(buf.length - 4)], [0x1d, 0x56, 66, 3]);
  assert.deepEqual(escpos.quebrarLinhas('um dois tres quatro', 9), ['um dois', 'tres', 'quatro']);
  assert.equal(escpos.enderecoValido('192.168.0.10'), true);
  assert.equal(escpos.enderecoValido('192.168.0'), false);
});

// ---------------- senhas ----------------

test('senhas: numeração do dia, uma por venda/pedido, painel sem dado sensível', () => {
  const ctx = loja();
  assert.equal(chamada.criarManual({ nome: 'Ana' }).ok, false, 'desligado');
  chamada.saveConfig({ ativa: true, senhaNoBalcao: true, modelo: { corFundo: '#123456', layout: 'nada', titulo: 'Lanchonete' }, requestingUserId: ctx.gerenteId });
  const cfg = chamada.getConfig();
  assert.match(cfg.link, /painel\.html\?p=[A-Za-z0-9]{32}$/);
  assert.equal(cfg.modelo.corFundo, '#123456');
  assert.equal(cfg.modelo.layout, 'duas_colunas', 'valor inválido volta ao padrão');

  const a = chamada.criarManual({ nome: 'Ana Maria Souza' });
  const b = chamada.criarManual({ nome: '' });
  assert.equal(a.chamada.numero, 1);
  assert.equal(b.chamada.numero, 2);
  assert.equal(a.chamada.nome, 'Ana');

  const painel1 = chamada.montarPainel();
  assert.deepEqual(painel1.preparando, [{ n: 1, nome: 'Ana' }, { n: 2, nome: null }]);
  assert.equal(painel1.ultimaChamada, null);

  chamada.chamar({ id: a.chamada.id });
  const painel2 = chamada.montarPainel();
  assert.deepEqual(painel2.prontos, [{ n: 1, nome: 'Ana' }]);
  assert.equal(painel2.ultimaChamada.n, 1);
  const seq1 = painel2.ultimaChamada.seq;
  chamada.chamar({ id: a.chamada.id });
  assert.notEqual(chamada.montarPainel().ultimaChamada.seq, seq1, 'chamar de novo muda o aviso');

  chamada.entregar({ id: a.chamada.id });
  assert.deepEqual(chamada.montarPainel().prontos, []);
  assert.equal(JSON.stringify(chamada.montarPainel()).includes('total'), false);

  // Sai do painel depois do tempo configurado.
  chamada.chamar({ id: b.chamada.id });
  assert.equal(chamada.montarPainel({ agoraMs: Date.now() + 16 * 60000 }).prontos.length, 0);
});

test('senha no balcão: na venda finalizada, não em venda de mesa; recibo/cozinha usam a senha', async () => {
  const ctx = loja();
  const imp = impressoraFalsa();
  chamada.saveConfig({ ativa: true, senhaNoBalcao: true, requestingUserId: ctx.gerenteId });
  cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '10.0.0.9', requestingUserId: ctx.gerenteId });
  const venda = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.adminId });
  const saleId = venda.saleId || venda.id;
  saleService.addItem({ saleId, productId: ctx.lanche, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.adminId, deviceId: 'pc' });
  const s = chamada.criarParaVenda({ saleId, nome: 'Bruno Lima', operadorId: ctx.adminId });
  assert.equal(s.ok, true);
  assert.equal(chamada.criarParaVenda({ saleId }).jaExistia, true);
  const r = await cozinha.imprimirItensDaVenda({ saleId });
  assert.equal(r.ok, true);
  assert.match(imp.saidas[0].dados.toString('latin1'), /SENHA 1/);
  assert.match(imp.saidas[0].dados.toString('latin1'), /Bruno/);
});

// ---------------- vitrine / QR da mesa ----------------

function lojaComVitrine() {
  const ctx = loja();
  ctx.db.prepare(`INSERT OR IGNORE INTO vitrine_config (id) VALUES ('default')`).run();
  ctx.db.prepare(`UPDATE vitrine_config SET slug = 'lanchonete-boa' WHERE id = 'default'`).run();
  const r = vitrine.saveConfig({
    ativa: true, ocultarSemEstoque: false, avisoPoucasUnidades: 0, mensagem: '', modos: ['retirada', 'local'], pedidoMinimo: 0,
    pedidosOnline: true, requestingUserId: ctx.gerenteId,
  });
  assert.equal(r.ok, true, r.error);
  return ctx;
}

test('vitrine: consumo no local exige receber pedidos no sistema; ligar abre a Separação', () => {
  const ctx = loja();
  ctx.db.prepare(`INSERT OR IGNORE INTO vitrine_config (id) VALUES ('default')`).run();
  const r = vitrine.saveConfig({ ativa: true, modos: ['local'], avisoPoucasUnidades: 0, pedidoMinimo: 0, pedidosOnline: false, requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, false);
  assert.equal(botOrderService.getConfig().ativo, false);
  assert.equal(vitrine.saveConfig({ ativa: true, modos: ['local'], avisoPoucasUnidades: 0, pedidoMinimo: 0, pedidosOnline: true, requestingUserId: ctx.gerenteId }).ok, true);
  assert.equal(botOrderService.getConfig().ativo, true);
});

test('QR da mesa: segredo próprio por mesa, a página só recebe o hash', async () => {
  const ctx = lojaComVitrine();
  const { tableId } = abrirMesa(ctx, '7');
  const qr = await vitrine.qrDasMesas();
  assert.equal(qr.ok, true);
  const m = qr.mesas.find((x) => x.tableId === tableId);
  const token = new URL(m.link).searchParams.get('m');
  assert.match(token, /^[A-Za-z0-9]{24}$/);
  assert.equal(vitrine.mesaPeloToken(token).id, tableId);
  const mapa = vitrine.mapaPublicoDasMesas();
  assert.equal(mapa[vitrine.hashTokenMesa(token)], 'Mesa 7');
  assert.equal(JSON.stringify(mapa).includes(token), false);
  // Trocar invalida o impresso antigo.
  assert.equal(vitrine.trocarQrDaMesa({ tableId, requestingUserId: ctx.gerenteId }).ok, true);
  assert.equal(vitrine.mesaPeloToken(token), null);
});

test('pedido pelo QR da mesa: atendente aceita -> comanda na pessoa com o nome, cozinha imprime', async () => {
  const ctx = lojaComVitrine();
  const imp = impressoraFalsa();
  cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '10.0.0.9', categorias: ['Lanches'], requestingUserId: ctx.gerenteId });
  const { tableId, saleId } = abrirMesa(ctx, '3');
  const token = vitrine.garantirTokenMesa(ctx.db, tableId);

  const r = vitrinePedido.criarPedidoVitrine({
    pedidoId: 'AAAAAAAAAAAAAAAAAAA1', slug: 'lanchonete-boa', nome: 'Carla', modo: 'local', mesa: token, pagamento: 'pix',
    itens: [{ produtoId: ctx.lanche, quantidade: 1, observacao: 'bem passado' }, { produtoId: ctx.refri, quantidade: 2 }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mesa, 'Mesa 3');
  // Repetido (reentrega do Firestore) não duplica.
  assert.equal(vitrinePedido.criarPedidoVitrine({ pedidoId: 'AAAAAAAAAAAAAAAAAAA1', slug: 'lanchonete-boa', nome: 'Carla', itens: [] }).jaExistia, true);
  const pedido = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id);
  assert.equal(pedido.mesa_numero, '3');
  assert.equal(pedido.canal, 'vitrine');
  assert.equal(pedido.status, 'novo', 'nada vai pra mesa sem o atendente aceitar');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?').get(saleId).n, 0);
  assert.equal(vitrinePedido.etapaDoPedido(pedido).etapa, 'recebido');

  const lancado = botOrderService.lancarPedidoNaMesa({ orderId: r.id, operadorId: ctx.adminId, deviceId: 'pc' });
  assert.equal(lancado.ok, true);
  const itens = ctx.db.prepare('SELECT si.*, sp.nome AS pessoa FROM sale_items si LEFT JOIN sale_people sp ON sp.sale_id = si.sale_id AND sp.numero = si.pessoa_numero WHERE si.sale_id = ?').all(saleId);
  assert.equal(itens.length, 2);
  assert.ok(itens.every((i) => i.pessoa === 'Carla'), 'itens na pessoa com o nome do cliente');
  assert.equal(itens.find((i) => i.product_id === ctx.lanche).observacao, 'bem passado');
  await esperar(30);
  assert.equal(imp.saidas.length, 1, 'aceito: comanda na cozinha');
  assert.match(imp.saidas[0].dados.toString('latin1'), /para: Carla/);
  assert.equal(vitrinePedido.etapaDoPedido(ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id)).etapa, 'na_mesa');

  // Segundo pedido da mesma pessoa vai pra mesma pessoa.
  const r2 = vitrinePedido.criarPedidoVitrine({ pedidoId: 'AAAAAAAAAAAAAAAAAAA2', slug: 'lanchonete-boa', nome: 'carla', mesa: token, itens: [{ produtoId: ctx.fritas, quantidade: 1 }] });
  botOrderService.lancarPedidoNaMesa({ orderId: r2.id, operadorId: ctx.adminId, deviceId: 'pc' });
  assert.equal(ctx.db.prepare('SELECT COUNT(DISTINCT pessoa_numero) AS n FROM sale_items WHERE sale_id = ?').get(saleId).n, 1);
});

test('pedido de retirada pelo site: aceitar gera senha e comanda; pronto chama; retirado conclui', async () => {
  const ctx = lojaComVitrine();
  const imp = impressoraFalsa();
  chamada.saveConfig({ ativa: true, requestingUserId: ctx.gerenteId });
  cozinha.saveConfig({ ativa: true, tipo: 'rede', ip: '10.0.0.9', requestingUserId: ctx.gerenteId });
  const r = vitrinePedido.criarPedidoVitrine({
    pedidoId: 'BBBBBBBBBBBBBBBBBBB1', slug: 'lanchonete-boa', nome: 'Diego', modo: 'local', pagamento: 'dinheiro', trocoPara: 50,
    itens: [{ produtoId: ctx.lanche, quantidade: 1 }],
  });
  assert.equal(r.ok, true, r.error);
  const pedido = ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id);
  assert.equal(pedido.consumo_local, 1, 'comer aqui sem mesa');
  assert.match(pedido.observacoes, /troco para R\$ 50,00/);

  assert.equal(botOrderService.updateOrderStatus({ orderId: r.id, status: 'em_separacao', operadorId: ctx.adminId }).ok, true);
  const senha = ctx.db.prepare('SELECT * FROM chamadas WHERE bot_order_id = ?').get(r.id);
  assert.equal(senha.numero, 1);
  await esperar(30);
  assert.match(imp.saidas[0].dados.toString('latin1'), /SENHA 1/);
  assert.match(imp.saidas[0].dados.toString('latin1'), /COMER AQUI/);
  assert.equal(vitrinePedido.etapaDoPedido(ctx.db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(r.id), 1).etapa, 'preparando');

  // Chamar pela tela de senhas marca o pedido como pronto.
  chamada.chamar({ id: senha.id, operadorId: ctx.adminId });
  assert.equal(ctx.db.prepare('SELECT status FROM bot_orders WHERE id = ?').get(r.id).status, 'pronto');
  // Concluir na Separação entrega a senha.
  botOrderService.updateOrderStatus({ orderId: r.id, status: 'concluido', operadorId: ctx.adminId });
  assert.equal(ctx.db.prepare('SELECT status FROM chamadas WHERE id = ?').get(senha.id).status, 'entregue');
  assert.ok(ctx.db.prepare('SELECT sale_id FROM bot_orders WHERE id = ?').get(r.id).sale_id, 'virou venda');
});

test('pedido pelo site: recusa endereço de outra loja, mesa inválida, modo não oferecido e fila cheia', () => {
  const ctx = lojaComVitrine();
  const base = { slug: 'lanchonete-boa', nome: 'Eva', itens: [{ produtoId: ctx.lanche, quantidade: 1 }] };
  assert.match(vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC1', slug: 'outra-loja' }).error, /não é desta loja/);
  assert.match(vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC2', mesa: 'X'.repeat(24) }).error, /QR de mesa/);
  assert.match(vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC3', modo: 'entrega', endereco: 'Rua A, 10' }).error, /não oferece/);
  assert.match(vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC4', nome: 'E' }).error, /nome/);
  assert.match(vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC5', itens: [{ produtoId: 'nao-existe', quantidade: 1 }] }).error, /Nenhum produto/);
  // Preço é sempre o da loja (o pedido nem leva preço).
  const ok = vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC6', modo: 'retirada', itens: [{ produtoId: ctx.lanche, quantidade: 2, preco: 0.01 }] });
  assert.equal(ok.total, 44);
  ctx.db.prepare(`UPDATE vitrine_config SET pedidos_online = 0`).run();
  assert.match(vitrinePedido.criarPedidoVitrine({ ...base, pedidoId: 'CCCCCCCCCCCCCCCCCCC7', modo: 'retirada' }).error, /não está recebendo/);
});

test('pedido de mesa nunca vira venda avulsa pelo "concluir"', () => {
  const ctx = lojaComVitrine();
  const { tableId } = abrirMesa(ctx, '9');
  const token = vitrine.garantirTokenMesa(ctx.db, tableId);
  const r = vitrinePedido.criarPedidoVitrine({ pedidoId: 'DDDDDDDDDDDDDDDDDDD1', slug: 'lanchonete-boa', nome: 'Fábio', mesa: token, itens: [{ produtoId: ctx.lanche, quantidade: 1 }] });
  const tentativa = botOrderService.updateOrderStatus({ orderId: r.id, status: 'concluido', operadorId: ctx.adminId });
  assert.equal(tentativa.ok, false);
  assert.match(tentativa.error, /Lançar na Mesa 9/);
});
