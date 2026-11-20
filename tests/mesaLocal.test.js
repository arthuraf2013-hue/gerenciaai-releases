const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem Firebase neste teste: tudo pela rede da loja'); };

const mesaLocal = require('../electron/services/mesaLocalService');
const tableService = require('../electron/services/tableService');
const vitrine = require('../electron/services/vitrineService');

// Pedido pelo QR da mesa pela rede da loja: sem Firebase, sem internet.

function loja() {
  const ctx = freshTestDb();
  const peixe = createProduct(ctx.db, { nome: 'Peixe frito', preco: 45, categoria: 'Pratos' });
  const suco = createProduct(ctx.db, { nome: 'Suco de laranja', preco: 8, categoria: 'Bebidas' });
  for (const p of [peixe, suco]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 30, operadorId: ctx.adminId });
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '5' });
  const tableId = mesa.id || ctx.db.prepare("SELECT id FROM restaurant_tables WHERE numero = '5'").get().id;
  ctx.db.prepare("UPDATE restaurant_tables SET qr_token = 'AbCdEfGhIjKlMnOpQrStUv12' WHERE id = ?").run(tableId);
  return { ...ctx, peixe, suco, tableId, token: 'AbCdEfGhIjKlMnOpQrStUv12' };
}

function pedir(porta, metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: dados ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(texto); } catch { /* html */ }
        resolve({ status: res.statusCode, texto, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

test('servidor na rede da loja: página da mesa, cardápio e pedido, sem Firebase', async (t) => {
  const ctx = loja();
  const r = await mesaLocal.iniciar(0);
  assert.equal(r.ok, true, r.error);
  t.after(() => mesaLocal.parar());
  const porta = r.porta;

  const pagina = await pedir(porta, 'GET', `/m/${ctx.token}`);
  assert.equal(pagina.status, 200);
  assert.match(pagina.texto, /Buscar no cardápio/);
  assert.match(pagina.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal((await pedir(porta, 'GET', '/m/XXXXXXXXXXXXXXXXXXXXXXXX')).status, 404, 'QR trocado/inválido');

  const cardapio = await pedir(porta, 'GET', `/api/cardapio?m=${ctx.token}`);
  assert.equal(cardapio.json.mesa, 'Mesa 5');
  assert.deepEqual(cardapio.json.produtos.map((p) => p.nome).sort(), ['Peixe frito', 'Suco de laranja']);

  const enviado = await pedir(porta, 'POST', '/api/pedido', {
    m: ctx.token, id: 'pedidoTeste0000001', nome: 'Ana', telefone: '(81) 91234-5678', observacao: 'sem cebola',
    itens: [{ produtoId: ctx.peixe, quantidade: 1 }, { produtoId: ctx.suco, quantidade: 2 }],
  });
  assert.equal(enviado.json.ok, true, enviado.json.error);
  assert.equal(enviado.json.aceitoSozinho, false, 'mesa fechada: o atendente aceita');
  const pedido = ctx.db.prepare("SELECT * FROM bot_orders WHERE canal = 'mesa_local'").get();
  assert.equal(pedido.mesa_numero, '5');
  assert.equal(pedido.cliente_nome, 'Ana');
  assert.equal(pedido.telefone_informado, '81912345678');
  assert.equal(pedido.status, 'novo');

  // Mesmo pedido de novo (rede ruim, toque duplo): não duplica.
  const repetido = await pedir(porta, 'POST', '/api/pedido', { m: ctx.token, id: 'pedidoTeste0000001', nome: 'Ana', itens: [{ produtoId: ctx.suco, quantidade: 1 }] });
  assert.equal(repetido.json.id, enviado.json.id);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM bot_orders WHERE canal = 'mesa_local'").get().n, 1);

  const acomp = await pedir(porta, 'GET', `/api/pedido?m=${ctx.token}&id=pedidoTeste0000001`);
  assert.equal(acomp.json.etapa, 'recebido');
  assert.equal((await pedir(porta, 'GET', '/api/pedido?m=XXXXXXXXXXXXXXXXXXXXXXXX&id=pedidoTeste0000001')).status, 404, 'outra mesa não vê o pedido');
});

test('atendente aceita: entra na comanda na pessoa "Ana", ligada ao cliente pelo celular; o próximo entra sozinho', async () => {
  const ctx = loja();
  const r1 = mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'primeiroPedido00001', nome: 'Ana', telefone: '81912345678', itens: [{ produtoId: ctx.peixe, quantidade: 1 }] });
  assert.equal(r1.ok, true, r1.error);
  const aceito = require('../electron/services/botOrderService').lancarPedidoNaMesa({ orderId: r1.id, operadorId: ctx.operadorId, deviceId: 'pc' });
  assert.equal(aceito.ok, true, aceito.error);
  const pessoa = ctx.db.prepare('SELECT sp.nome, c.nome AS cliente, c.telefone FROM sale_people sp JOIN customers c ON c.id = sp.customer_id WHERE sp.sale_id = ?').get(aceito.saleId);
  assert.deepEqual(pessoa, { nome: 'Ana', cliente: 'Ana', telefone: '(81) 91234-5678' });

  const r2 = mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'segundoPedido000001', nome: 'Bruno', itens: [{ produtoId: ctx.suco, quantidade: 2 }] });
  assert.equal(r2.aceitoSozinho, true, 'mesa já aberta: entra direto');
  const itens = ctx.db.prepare('SELECT COUNT(*) n FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(aceito.saleId).n;
  assert.equal(itens, 2);
  assert.equal(mesaLocal.andamento(ctx.token, 'segundoPedido000001').etapa, 'na_mesa');
});

test('validações: QR inválido, nome, celular, itens e limite de pedidos esperando na mesa', () => {
  const ctx = loja();
  assert.match(mesaLocal.criarPedido({ token: 'XXXXXXXXXXXXXXXXXXXXXXXX', pedidoId: 'abcdefghijkl1', nome: 'Ana', itens: [] }).error, /não vale mais/);
  assert.match(mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'abcdefghijkl2', nome: 'A', itens: [] }).error, /nome/);
  assert.match(mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'abcdefghijkl3', nome: 'Ana', telefone: '123', itens: [{ produtoId: ctx.suco, quantidade: 1 }] }).error, /celular/);
  assert.match(mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'abcdefghijkl4', nome: 'Ana', itens: [{ produtoId: 'nao-existe', quantidade: 1 }] }).error, /disponível/);
  for (let i = 0; i < 6; i++) {
    assert.equal(mesaLocal.criarPedido({ token: ctx.token, pedidoId: `limiteDeMesa0000${i}`, nome: 'Ana', itens: [{ produtoId: ctx.suco, quantidade: 1 }] }).ok, true);
  }
  assert.match(mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'limiteDeMesa00009', nome: 'Ana', itens: [{ produtoId: ctx.suco, quantidade: 1 }] }).error, /esperando/);
});

test('configuração: só gestão, porta e endereço válidos; link da mesa e QR do Wi-Fi', () => {
  const ctx = loja();
  assert.equal(mesaLocal.saveConfig({ ativo: true, requestingUserId: ctx.operadorId }).ok, false);
  assert.match(mesaLocal.saveConfig({ ativo: false, porta: 47820, requestingUserId: ctx.gerenteId }).error, /Porta/);
  assert.match(mesaLocal.saveConfig({ ativo: false, enderecoFixo: '999.1.1.1', requestingUserId: ctx.gerenteId }).error, /Endereço/);
  const r = mesaLocal.saveConfig({ ativo: false, enderecoFixo: '192.168.1.74', wifiNome: 'Sabor;Wifi', wifiSenha: 'a:b', mostrarWifi: true, requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, true, r.error);
  assert.equal(mesaLocal.linkDaMesa(ctx.token), `http://192.168.1.74:47830/m/${ctx.token}`);
  assert.equal(mesaLocal.textoQrWifi(mesaLocal.getConfig()), String.raw`WIFI:T:WPA;S:Sabor\;Wifi;P:a\:b;;`);
});

test('endereço da máquina: rede privada primeiro, virtuais por último', () => {
  const ips = mesaLocal.enderecosDaMaquina({
    'VirtualBox Host-Only': [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
    'Wi-Fi': [{ address: '192.168.1.74', family: 'IPv4', internal: false }],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  });
  assert.equal(ips[0], '192.168.1.74');
  assert.equal(ips.at(-1), '192.168.56.1');
});

test('cada celular é uma conta: mesmo celular cai na mesma pessoa; mesmo nome em outro celular vira outra pessoa', () => {
  const ctx = loja();
  const bot = require('../electron/services/botOrderService');
  const pedir = (id, nome, aparelho) => {
    const r = mesaLocal.criarPedido({ token: ctx.token, pedidoId: id, nome, aparelho, itens: [{ produtoId: ctx.suco, quantidade: 1 }] });
    assert.equal(r.ok, true, r.error);
    if (!r.aceitoSozinho) assert.equal(bot.lancarPedidoNaMesa({ orderId: r.id, operadorId: ctx.operadorId, deviceId: 'pc' }).ok, true);
    return r;
  };
  pedir('pedidoCelularA0001', 'Ana', 'celularAAAAAAAAAAAAAAA');
  pedir('pedidoCelularB0001', 'Ana', 'celularBBBBBBBBBBBBBBB');
  pedir('pedidoCelularA0002', 'ana silva', 'celularAAAAAAAAAAAAAAA');
  const saleId = ctx.db.prepare("SELECT sale_id FROM restaurant_tables WHERE numero = '5'").get().sale_id;
  const pessoas = ctx.db.prepare(`
    SELECT sp.nome, sp.aparelho, COALESCE(SUM(si.quantidade), 0) AS itens FROM sale_people sp
    LEFT JOIN sale_items si ON si.sale_id = sp.sale_id AND si.pessoa_numero = sp.numero AND si.cancelado = 0
    WHERE sp.sale_id = ? GROUP BY sp.numero ORDER BY sp.numero`).all(saleId);
  assert.deepEqual(pessoas.map((p) => [p.nome, p.itens]), [['Ana', 2], ['Ana (2)', 1]]);
});

// ------------------------------------------------------------ integrantes da mesa

const CEL_ANA = 'celularAnaAAAAAAAAAAAA';
const CEL_BIA = 'celularBiaBBBBBBBBBBBB';
const CEL_CAU = 'celularCauCCCCCCCCCCCC';

test('vários celulares entram na mesa livre: esperam e viram pessoas da comanda quando ela abre', () => {
  const ctx = loja();
  const bot = require('../electron/services/botOrderService');
  const ana = mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_ANA, nome: 'Ana', telefone: '81912345678' });
  assert.equal(ana.ok, true, ana.error);
  assert.equal(ana.aberta, false);
  assert.deepEqual(ana.eu, { nome: 'Ana', numero: null });
  const bia = mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_BIA, nome: 'Bia' });
  assert.deepEqual(bia.integrantes.map((p) => [p.nome, p.eu]), [['Ana', false], ['Bia', true]]);
  assert.equal(ctx.db.prepare("SELECT status FROM restaurant_tables WHERE id = ?").get(ctx.tableId).status, 'livre', 'entrar não abre a mesa');

  // Primeiro pedido (da Bia) aceito: a mesa abre e as duas entram na comanda.
  const p = mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'pedidoDaBia00000001', nome: 'outro nome', aparelho: CEL_BIA, itens: [{ produtoId: ctx.suco, quantidade: 2 }] });
  assert.equal(p.ok, true, p.error);
  assert.equal(ctx.db.prepare('SELECT cliente_nome FROM bot_orders WHERE id = ?').get(p.id).cliente_nome, 'Bia', 'o pedido sai no nome com que entrou');
  const aceito = bot.lancarPedidoNaMesa({ orderId: p.id, operadorId: ctx.operadorId, deviceId: 'pc' });
  assert.equal(aceito.ok, true, aceito.error);
  const pessoas = ctx.db.prepare('SELECT numero, nome, aparelho, customer_id FROM sale_people WHERE sale_id = ? ORDER BY numero').all(aceito.saleId);
  assert.deepEqual(pessoas.map((x) => [x.nome, x.aparelho]), [['Ana', CEL_ANA], ['Bia', CEL_BIA]]);
  assert.ok(pessoas[0].customer_id, 'Ana ligada ao cliente pelo celular');

  const daBia = mesaLocal.estadoDaMesa(ctx.token, CEL_BIA);
  assert.equal(daBia.aberta, true);
  assert.deepEqual(daBia.meusItens, [{ nome: 'Suco de laranja', quantidade: 2, total: 16 }]);
  assert.equal(daBia.meuTotal, 16);
  assert.equal(daBia.totalMesa, 16);
  assert.deepEqual(mesaLocal.estadoDaMesa(ctx.token, CEL_ANA).meusItens, [], 'cada um vê só a própria conta');

  // Com a mesa aberta, quem chega entra na hora.
  const cau = mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_CAU, nome: 'Ana' });
  assert.equal(cau.ok, true);
  assert.equal(cau.eu.nome, 'Ana (2)', 'mesmo nome em outro celular é outra pessoa');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM sale_people WHERE sale_id = ?').get(aceito.saleId).n, 3);
  // Entrar de novo pelo mesmo celular não duplica nem renomeia.
  assert.equal(mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_ANA, nome: 'Outra' }).eu.nome, 'Ana');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM sale_people WHERE sale_id = ?').get(aceito.saleId).n, 3);
});

test('chamar o garçom não precisa de nome; pedir a conta é de quem entrou (1 por minuto cada)', () => {
  const ctx = loja();
  const SEM_NOME = 'celularSemNomeXXXXXXXX';
  assert.deepEqual(mesaLocal.chamar({ token: ctx.token, aparelho: SEM_NOME, tipo: 'garcom' }), { ok: true });
  const ind = tableService.listTables(ctx.locationId).find((m) => m.id === ctx.tableId).indicadores;
  assert.deepEqual(ind.chamados.map((c) => [c.tipo, c.nome]), [['garcom', null]], 'chamado geral, sem nome');
  assert.equal(mesaLocal.chamar({ token: ctx.token, aparelho: 'curto', tipo: 'garcom', ip: '10.0.0.5' }).ok, true, 'sem código do celular: conta pelo IP');
  assert.equal(mesaLocal.chamar({ token: ctx.token, aparelho: 'curto', tipo: 'garcom', ip: '10.0.0.5' }).repetido, true);
  assert.match(mesaLocal.chamar({ token: ctx.token, aparelho: CEL_ANA, tipo: 'conta' }).error, /Entre na mesa/);
  mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_ANA, nome: 'Ana' });
  assert.deepEqual(mesaLocal.chamar({ token: ctx.token, aparelho: CEL_ANA, tipo: 'garcom' }), { ok: true });
  assert.equal(mesaLocal.chamar({ token: ctx.token, aparelho: CEL_ANA, tipo: 'garcom' }).repetido, true);
  assert.deepEqual(mesaLocal.chamar({ token: ctx.token, aparelho: CEL_ANA, tipo: 'conta' }), { ok: true });
  assert.equal(mesaLocal.chamar({ token: ctx.token, aparelho: CEL_ANA, tipo: 'outra' }).ok, false);
});

test('mesa fechada e limpa: a lista de integrantes zera (o próximo grupo começa do zero)', () => {
  const ctx = loja();
  const { saleId } = tableService.openTable({ tableId: ctx.tableId, locationId: ctx.locationId, operadorId: ctx.operadorId });
  mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_ANA, nome: 'Ana' });
  assert.equal(mesaLocal.estadoDaMesa(ctx.token, CEL_ANA).eu.nome, 'Ana');
  tableService.releaseTable(ctx.tableId);
  assert.equal(mesaLocal.estadoDaMesa(ctx.token, CEL_ANA).eu, null);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM mesa_local_membros').get().n, 0);
  assert.ok(saleId);
});

test('mesa transferida: os celulares vão junto e continuam pedindo pelo QR antigo', () => {
  const ctx = loja();
  tableService.createTable({ locationId: ctx.locationId, numero: '9' });
  const nova = ctx.db.prepare("SELECT id FROM restaurant_tables WHERE numero = '9'").get().id;
  const { saleId } = tableService.openTable({ tableId: ctx.tableId, locationId: ctx.locationId, operadorId: ctx.operadorId });
  mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_ANA, nome: 'Ana' });
  assert.equal(tableService.transferTable({ fromTableId: ctx.tableId, toTableId: nova }).ok, true);
  const e = mesaLocal.estadoDaMesa(ctx.token, CEL_ANA);
  assert.equal(e.mesa, 'Mesa 9');
  assert.equal(e.eu.nome, 'Ana');
  const p = mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'pedidoDepoisDaTroca1', nome: 'x', aparelho: CEL_ANA, itens: [{ produtoId: ctx.suco, quantidade: 1 }] });
  assert.equal(p.aceitoSozinho, true, 'entra direto na comanda que foi para a Mesa 9');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).n, 1);
});

test('pela rede: entrar, ver a mesa e chamar', async (t) => {
  const ctx = loja();
  const r = await mesaLocal.iniciar(0);
  assert.equal(r.ok, true, r.error);
  t.after(() => mesaLocal.parar());
  const entrar = await pedir(r.porta, 'POST', '/api/entrar', { m: ctx.token, aparelho: CEL_ANA, nome: 'Ana' });
  assert.equal(entrar.status, 200);
  assert.equal(entrar.json.eu.nome, 'Ana');
  const estado = await pedir(r.porta, 'GET', `/api/mesa?m=${ctx.token}&a=${CEL_ANA}`);
  assert.deepEqual(estado.json.integrantes, [{ nome: 'Ana', eu: true }]);
  assert.equal((await pedir(r.porta, 'GET', `/api/mesa?m=XXXXXXXXXXXXXXXXXXXXXXXX&a=${CEL_ANA}`)).status, 404);
  assert.equal((await pedir(r.porta, 'POST', '/api/chamar', { m: ctx.token, aparelho: CEL_ANA, tipo: 'conta' })).json.ok, true);
  assert.equal((await pedir(r.porta, 'POST', '/api/entrar', { m: ctx.token, aparelho: 'curto', nome: 'Bia' })).status, 400);
});

test('QR das mesas: com a rede da loja ligada aponta para este computador (sem vitrine), com o QR do Wi-Fi no cartão', async () => {
  const ctx = loja();
  const vitrineSvc = require('../electron/services/vitrineService');
  assert.equal((await vitrineSvc.qrDasMesas()).ok, false, 'sem rede da loja e sem vitrine: não tem para onde apontar');
  mesaLocal.saveConfig({ ativo: true, enderecoFixo: '192.168.1.74', wifiNome: 'Quiosque', wifiSenha: 'praia2026', mostrarWifi: true, requestingUserId: ctx.gerenteId });
  mesaLocal.parar();
  const r = await vitrineSvc.qrDasMesas();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.modo, 'local');
  assert.equal(r.mesas[0].link, `http://192.168.1.74:47830/m/${ctx.token}`);
  assert.equal(r.wifi.nome, 'Quiosque');
  const html = vitrineSvc.montarFolhaQrMesas({ nomeLoja: 'Quiosque', mesas: r.mesas, wifi: r.wifi });
  assert.equal((html.match(/class="qrwifi"/g) || []).length, 1);
  assert.match(html, /Wi-Fi<br><b>Quiosque<\/b>/);
  const um = await vitrineSvc.qrDaMesa(ctx.tableId);
  assert.equal(um.modo, 'local');
});

test('vitrine pela internet: o pedido da mesa leva o código do celular (e só pedido de mesa)', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { montarPedidoLoja } = await import(pathToFileURL(path.join(__dirname, '..', 'pwa-mobile', 'loja-util.js')).href);
  const comMesa = montarPedidoLoja({ slug: 's', itens: [], nome: 'Ana', modo: 'local', mesaToken: ctx24(), aparelho: CEL_ANA });
  assert.equal(comMesa.aparelho, CEL_ANA);
  assert.equal(montarPedidoLoja({ slug: 's', itens: [], nome: 'Ana', modo: 'retirada', aparelho: CEL_ANA }).aparelho, undefined);
  assert.equal(montarPedidoLoja({ slug: 's', itens: [], nome: 'Ana', modo: 'local', mesaToken: ctx24(), aparelho: 'x' }).aparelho, undefined);
});
function ctx24() { return 'AbCdEfGhIjKlMnOpQrStUv12'; }

const CEL_ANA2 = 'celularAna2AAAAAAAAAAA';
const CEL_BIA2 = 'celularBia2BBBBBBBBBBB';
test('chamados ficam no quadrado da mesa até alguém atender; pedidos esperando e celulares na mesa também', () => {
  const ctx = loja();
  const { saleId } = tableService.openTable({ tableId: ctx.tableId, locationId: ctx.locationId, operadorId: ctx.operadorId });
  mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_ANA2, nome: 'Ana' });
  mesaLocal.entrarNaMesa({ token: ctx.token, aparelho: CEL_BIA2, nome: 'Bia' });
  ctx.db.prepare('UPDATE vitrine_config SET aceitar_mesa_aberta = 0').run();
  ctx.db.prepare("INSERT OR IGNORE INTO vitrine_config (id, aceitar_mesa_aberta) VALUES ('default', 0)").run();
  mesaLocal.criarPedido({ token: ctx.token, pedidoId: 'pedidoEsperando00009', nome: 'x', aparelho: CEL_ANA2, itens: [{ produtoId: ctx.suco, quantidade: 1 }] });
  mesaLocal.chamar({ token: ctx.token, aparelho: CEL_ANA2, tipo: 'conta' });
  mesaLocal.chamar({ token: ctx.token, aparelho: CEL_BIA2, tipo: 'garcom' });

  const doQuadrado = () => tableService.listTables(ctx.locationId).find((m) => m.id === ctx.tableId).indicadores;
  const ind = doQuadrado();
  assert.deepEqual(ind.chamados.map((c) => [c.tipo, c.nome]).sort(), [['conta', 'Ana'], ['garcom', 'Bia']]);
  assert.equal(ind.pedidosEsperando, 1);
  assert.equal(ind.noQr, 2);

  // Atender o garçom só tira o garçom.
  assert.equal(mesaLocal.atenderChamados({ tableId: ctx.tableId, tipo: 'garcom', usuarioId: ctx.operadorId }).atendidos, 1);
  assert.deepEqual(doQuadrado().chamados.map((c) => c.tipo), ['conta']);
  // Mesa fechada: os chamados acabam.
  tableService.releaseTable(ctx.tableId);
  assert.equal(tableService.listTables(ctx.locationId).find((m) => m.id === ctx.tableId).indicadores?.chamados?.length || 0, 0);
  assert.ok(saleId);
});

test('avisos para os caixas: só os novos, e o primeiro pedido traz só o número atual', () => {
  const avisos = require('../electron/services/avisosDoServidor');
  const inicio = avisos.desde(-1);
  assert.deepEqual(inicio.avisos, []);
  avisos.registrar('mesa:chamado', { tipo: 'conta', mesa: 'Mesa 5', nome: 'Ana' });
  const r = avisos.desde(inicio.seq);
  assert.equal(r.seq, inicio.seq + 1);
  assert.deepEqual(r.avisos, [{ evento: 'mesa:chamado', dados: { tipo: 'conta', mesa: 'Mesa 5', nome: 'Ana' } }]);
  assert.deepEqual(avisos.desde(r.seq).avisos, []);
});
