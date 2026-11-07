const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Contas da página pública (pwa-mobile/loja-util.js, módulo ES) usadas no
// pedido direto no sistema: formato do documento que firestore.rules aceita,
// hash do QR da mesa igual ao do computador e passo a passo do acompanhamento.
const util = () => import(pathToFileURL(path.join(__dirname, '..', 'pwa-mobile', 'loja-util.js')).href);
const vitrineService = require('../electron/services/vitrineService');

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';

test('hash do QR da mesa: a página calcula o mesmo que o computador publica', async () => {
  const { hashTokenMesa } = await util();
  assert.equal(await hashTokenMesa(TOKEN), vitrineService.hashTokenMesa(TOKEN));
  assert.equal(await hashTokenMesa('curto'), null);
});

test('pedido pela mesa: modo local, pagamento na conta da mesa e o segredo vai junto', async () => {
  const { montarPedidoLoja } = await util();
  const p = montarPedidoLoja({ slug: 'boa-hora', itens: [{ id: 'p1', quantidade: 2 }], nome: '  Ana ', modo: 'local', pagamento: 'pix_online', mesaToken: TOKEN });
  assert.deepEqual(p, { slug: 'boa-hora', status: 'novo', nome: 'Ana', modo: 'local', pagamento: 'mesa', mesa: TOKEN, itens: [{ produtoId: 'p1', quantidade: 2 }] });
  // Leu o QR mas vai retirar no balcão: sem mesa, paga como escolheu.
  const r = montarPedidoLoja({ slug: 'boa-hora', itens: [{ id: 'p1', quantidade: 1 }], nome: 'Ana', modo: 'retirada', pagamento: 'pix_online', mesaToken: TOKEN });
  assert.equal(r.mesa, undefined);
  assert.equal(r.pagamento, 'pix_online');
  assert.equal(montarPedidoLoja({ slug: 'x', itens: [], nome: 'Ana', modo: 'retirada', pagamento: 'boleto' }).pagamento, 'pix');
  assert.equal(montarPedidoLoja({ slug: 'x', itens: [], nome: 'Ana', modo: 'retirada', pagamento: 'dinheiro', trocoPara: '50' }).trocoPara, 50);
});

test('formas de receber: pela mesa "comer aqui" vem primeiro e não tem entrega', async () => {
  const { modosOferecidos, rotuloModo } = await util();
  assert.deepEqual(modosOferecidos(['retirada', 'entrega', 'local'], { mesaRotulo: 'Mesa 5', pedidosOnline: true }), ['local', 'retirada']);
  assert.deepEqual(modosOferecidos(['retirada', 'entrega', 'local'], { pedidosOnline: false }), ['retirada', 'entrega']);
  assert.equal(rotuloModo('local', 'Mesa 5'), 'Comer aqui · Mesa 5');
  assert.equal(rotuloModo('retirada', 'Mesa 5'), 'Retirar no balcão');
});

test('acompanhamento: Pix, senha e pronto', async () => {
  const { passosDoPedido, tempoRestante } = await util();
  assert.equal(passosDoPedido({ statusDoc: 'novo', etapa: null }).fase, 'enviado');
  const pag = passosDoPedido({ statusDoc: 'recebido', etapa: { etapa: 'pagamento' }, pixOnline: true });
  assert.equal(pag.fase, 'pagamento');
  assert.deepEqual(pag.passos.map((p) => p.feito), [true, true, false, false, false]);
  const pronto = passosDoPedido({ statusDoc: 'recebido', etapa: { etapa: 'pronto', senha: 42, pago: true }, pixOnline: true });
  assert.deepEqual(pronto.passos.map((p) => p.feito), [true, true, true, true, true]);
  assert.equal(passosDoPedido({ statusDoc: 'recebido', etapa: { etapa: 'na_mesa' }, comMesa: true }).fase, 'na_mesa');
  assert.equal(passosDoPedido({ statusDoc: 'erro', etapa: null }).fase, 'erro');
  assert.equal(tempoRestante('2026-11-07T10:30:00.000Z', Date.parse('2026-11-07T10:01:19.000Z')), '28:41');
  assert.equal(tempoRestante('lixo'), null);
});

// ---------------- painel de senhas (TV / Vértice) ----------------
const painelUtil = () => import(pathToFileURL(path.join(__dirname, '..', 'pwa-mobile', 'painel-util.js')).href);
const chamadaService = require('../electron/services/chamadaService');

test('painel: mesmo modelo padrão do computador; tipos conferidos; nome some quando desligado', async () => {
  const { lerPainel, MODELO_PADRAO, tokenValido } = await painelUtil();
  assert.deepEqual({ ...MODELO_PADRAO }, { ...chamadaService.MODELO_PADRAO }, 'mudou um, mude o outro');
  const p = lerPainel({
    ativo: true, nomeLoja: 'Boa Hora', modelo: { corFundo: 'red', layout: 'x', mostrarNome: false },
    preparando: [{ n: 43, nome: 'Bruno' }, { n: 'x' }, { n: -1 }], prontos: [{ n: 42, nome: 'Ana' }],
    ultimaChamada: { n: 42, nome: 'Ana', seq: 'abc-1' },
  });
  assert.equal(p.modelo.corFundo, '#141a26', 'cor inválida volta ao padrão');
  assert.equal(p.modelo.layout, 'duas_colunas');
  assert.deepEqual(p.preparando, [{ n: 43, nome: null }]);
  assert.deepEqual(p.ultimaChamada, { n: 42, nome: null, seq: 'abc-1' });
  assert.equal(lerPainel({ ativo: false }).ativo, false);
  assert.equal(tokenValido('a'.repeat(32)), true);
  assert.equal(tokenValido('../x'), false);
});

test('painel: senha falada por extenso', async () => {
  const { porExtenso, fraseDaChamada } = await painelUtil();
  assert.equal(porExtenso(42), 'quarenta e dois');
  assert.equal(porExtenso(100), 'cem');
  assert.equal(porExtenso(139), 'cento e trinta e nove');
  assert.equal(porExtenso(17), 'dezessete');
  assert.equal(fraseDaChamada({ n: 139, nome: 'Luiza' }), 'Senha cento e trinta e nove, Luiza.');
});
