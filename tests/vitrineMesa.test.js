const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');

const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem Firebase neste teste'); };

const mesaLocal = require('../electron/services/mesaLocalService');
const tableService = require('../electron/services/tableService');
const vitrine = require('../electron/services/vitrineService');
const vm = require('../electron/services/vitrineMesaService');

// QR da mesa PELA INTERNET (cliente sem o Wi-Fi da loja): chamado e conta pela vitrine.

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12';
const CEL_ANA = 'celularAnaAAAAAAAAAAAA';
const CEL_BIA = 'celularBiaBBBBBBBBBBBB';

function loja() {
  const ctx = freshTestDb();
  const suco = createProduct(ctx.db, { nome: 'Suco de laranja', preco: 8, categoria: 'Bebidas' });
  const peixe = createProduct(ctx.db, { nome: 'Peixe frito', preco: 45, categoria: 'Pratos' });
  for (const p of [suco, peixe]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 30, operadorId: ctx.adminId });
  const mesa = tableService.createTable({ locationId: ctx.locationId, numero: '5' });
  const tableId = mesa.id || ctx.db.prepare("SELECT id FROM restaurant_tables WHERE numero = '5'").get().id;
  ctx.db.prepare('UPDATE restaurant_tables SET qr_token = ? WHERE id = ?').run(TOKEN, tableId);
  return { ...ctx, suco, peixe, tableId };
}

test('chaves: a da conta não é o hash público da mesa e a página calcula a mesma', async () => {
  const publico = vitrine.hashTokenMesa(TOKEN);
  const conta = vm.chaveDaConta(TOKEN);
  assert.match(conta, /^[0-9a-f]{32}$/);
  assert.notEqual(conta.slice(0, 24), publico, 'quem lê o mapa público da vitrine não chega na conta');
  const util = require('../pwa-mobile/loja-util.js');
  assert.equal(await util.chaveDaContaMesa(TOKEN), conta);
  assert.equal(await util.chaveDoAparelho(CEL_ANA), vm.chaveDoAparelho(CEL_ANA));
  assert.equal(await util.chaveDaContaMesa('curto'), null);
  assert.equal(await util.chaveDoAparelho('curto'), null);
});

test('chamado da vitrine: garçom sem nome, conta só de quem entrou; marca o quadrado da mesa', () => {
  const ctx = loja();
  const r1 = vm.tratarChamado({ mesa: TOKEN, tipo: 'garcom', aparelho: CEL_ANA });
  assert.equal(r1.ok, true);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM mesa_chamados WHERE table_id = ? AND tipo = ? AND atendido_em IS NULL').get(ctx.tableId, 'garcom').n, 1);
  // Repetido em menos de 1 minuto: aceito, sem duplicar.
  assert.equal(vm.tratarChamado({ mesa: TOKEN, tipo: 'garcom', aparelho: CEL_ANA }).repetido, true);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM mesa_chamados WHERE table_id = ?').get(ctx.tableId).n, 1);
  // Conta sem ter entrado na mesa: recusa com motivo.
  const sem = vm.tratarChamado({ mesa: TOKEN, tipo: 'conta', aparelho: CEL_BIA });
  assert.equal(sem.ok, false);
  assert.match(sem.erro, /Entre na mesa/);
  mesaLocal.entrarNaMesa({ token: TOKEN, aparelho: CEL_BIA, nome: 'Bia' });
  assert.equal(vm.tratarChamado({ mesa: TOKEN, tipo: 'conta', aparelho: CEL_BIA }).ok, true);
  // Lixo: segredo errado, tipo inventado, objeto vazio.
  assert.equal(vm.tratarChamado({ mesa: 'XXXXXXXXXXXXXXXXXXXXXXXX', tipo: 'garcom' }).ok, false);
  assert.equal(vm.tratarChamado({ mesa: TOKEN, tipo: 'apagar' }).ok, false);
  assert.equal(vm.tratarChamado(null).ok, false);
});

test('conta da mesa: cada pessoa com o que pediu, total da mesa; mesa fechada some; só o que mudou é gravado', async () => {
  const ctx = loja();
  const bot = require('../electron/services/botOrderService');
  mesaLocal.entrarNaMesa({ token: TOKEN, aparelho: CEL_ANA, nome: 'Ana' });
  mesaLocal.entrarNaMesa({ token: TOKEN, aparelho: CEL_BIA, nome: 'Bia' });
  const p = mesaLocal.criarPedido({ token: TOKEN, pedidoId: 'pedidoDaBia00000001', nome: 'x', aparelho: CEL_BIA, itens: [{ produtoId: ctx.suco, quantidade: 2 }, { produtoId: ctx.peixe, quantidade: 1 }] });
  assert.equal(bot.lancarPedidoNaMesa({ orderId: p.id, operadorId: ctx.operadorId, deviceId: 'pc' }).ok, true);

  const mesa = ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(ctx.tableId);
  const conta = vm.contaDaMesa(ctx.db, mesa);
  assert.equal(conta.rotulo, 'Mesa 5');
  assert.equal(conta.aberta, true);
  assert.equal(conta.totalMesa, 61);
  const bia = conta.pessoas.find((x) => x.nome === 'Bia');
  const ana = conta.pessoas.find((x) => x.nome === 'Ana');
  assert.equal(bia.chave, vm.chaveDoAparelho(CEL_BIA));
  assert.equal(bia.total, 61);
  assert.deepEqual(bia.itens.map((i) => [i.nome, i.quantidade, i.total]), [['Suco de laranja', 2, 16], ['Peixe frito', 1, 45]]);
  assert.equal(ana.total, 0);
  // Nada de aparelho em claro, telefone ou id interno no documento público.
  const texto = JSON.stringify(conta);
  assert.ok(!texto.includes(CEL_BIA) && !texto.includes(CEL_ANA), 'o código do celular não vai em claro');

  // Publicação: só com a vitrine recebendo pedidos; só o que mudou.
  const gravados = [];
  const gravar = async (chave, c) => { gravados.push([chave, c]); };
  const antes = vitrine.internetDisponivel;
  vitrine.internetDisponivel = () => false;
  assert.equal(await vm.publicarContas({ gravar }), 0, 'vitrine desligada: não publica');
  vitrine.internetDisponivel = () => true;
  assert.equal(await vm.publicarContas({ gravar }), 1);
  assert.equal(gravados[0][0], vm.chaveDaConta(TOKEN));
  assert.equal(await vm.publicarContas({ gravar }), 0, 'nada mudou');
  // Mais um item: republica.
  const p2 = mesaLocal.criarPedido({ token: TOKEN, pedidoId: 'pedidoDaAna00000001', nome: 'x', aparelho: CEL_ANA, itens: [{ produtoId: ctx.suco, quantidade: 1 }] });
  assert.equal(bot.lancarPedidoNaMesa({ orderId: p2.id, operadorId: ctx.operadorId, deviceId: 'pc' }).ok, true);
  assert.equal(await vm.publicarContas({ gravar }), 1);
  assert.equal(gravados.at(-1)[1].totalMesa, 69);
  // Mesa fechada: publica "fechada" uma vez e a conta some da página.
  ctx.db.prepare("UPDATE restaurant_tables SET status = 'livre', sale_id = NULL WHERE id = ?").run(ctx.tableId);
  assert.equal(await vm.publicarContas({ gravar }), 1);
  assert.equal(gravados.at(-1)[1].aberta, false);
  assert.deepEqual(gravados.at(-1)[1].pessoas, []);
  assert.equal(await vm.publicarContas({ gravar }), 0);
  // Falha de rede: não marca como publicado, tenta de novo depois.
  ctx.db.prepare("UPDATE restaurant_tables SET status = 'ocupada', sale_id = ? WHERE id = ?").run(mesa.sale_id, ctx.tableId);
  assert.equal(await vm.publicarContas({ gravar: async () => { throw new Error('sem rede'); } }), 0);
  assert.equal(await vm.publicarContas({ gravar }), 1);
  vitrine.internetDisponivel = antes;
  vm.parar();
});

test('QR duplo: com a rede da loja ligada e a vitrine ativa, a mesa ganha o QR pela internet com o MESMO segredo', async () => {
  const ctx = loja();
  const ml = require('../electron/services/mesaLocalService');
  const antes = ml.getConfig;
  ml.getConfig = () => ({ ativo: true, endereco: 'http://192.168.0.10:47830', porta: 47830 });
  const antesLink = ml.linkDaMesa;
  ml.linkDaMesa = (t) => `http://192.168.0.10:47830/m/${t}`;
  const vcfg = vitrine.getConfig;
  try {
    // Vitrine sem endereço: só o QR local.
    const so = await vitrine.qrDasMesas();
    assert.equal(so.modo, 'local');
    assert.equal(so.duplo, false);
    assert.equal(so.mesas[0].qrInternetDataUrl, null);
    // Vitrine ativa com pedido no sistema: dois QRs.
    ctx.db.prepare("INSERT OR IGNORE INTO vitrine_config (id) VALUES ('default')").run();
    ctx.db.prepare("UPDATE vitrine_config SET slug = 'casa-do-peixe', ativa = 1, pedidos_online = 1, modos = '[\"local\"]'").run();
    const duplo = await vitrine.qrDasMesas();
    assert.equal(duplo.duplo, true);
    const m = duplo.mesas[0];
    assert.equal(m.link, `http://192.168.0.10:47830/m/${TOKEN}`);
    assert.equal(m.linkInternet, `https://gerenciaai-garcom.web.app/loja.html?s=casa-do-peixe&m=${TOKEN}`);
    assert.match(m.qrDataUrl, /^data:image\/png;base64,/);
    assert.match(m.qrInternetDataUrl, /^data:image\/png;base64,/);
    const uma = await vitrine.qrDaMesa(ctx.tableId);
    assert.equal(uma.urlInternet, m.linkInternet);
    // Cartão impresso: grande leva os dois; pequeno só o da internet.
    const layout = require('../electron/services/impressaoLayout');
    const grande = layout.montarCartoesQr(layout.normalizarConfig('qrmesa', { porFolha: 4 }), { loja: { nome: 'Casa' }, mesas: [m] });
    assert.match(grande, /Sem Wi-Fi\? Use a sua internet/);
    assert.equal((grande.match(/<img class="qr"/g) || []).length, 2);
    const pequeno = layout.montarCartoesQr(layout.normalizarConfig('qrmesa', { porFolha: 16, orientacao: 'retrato' }), { loja: { nome: 'Casa' }, mesas: [m] });
    assert.equal((pequeno.match(/<img class="qr"/g) || []).length, 1);
    assert.ok(pequeno.includes(m.qrInternetDataUrl));
  } finally {
    ml.getConfig = antes; ml.linkDaMesa = antesLink; vitrine.getConfig = vcfg;
  }
});
