const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const vitrine = require('../electron/services/vitrineService');

// Publicar mexe em rede (Firestore); aqui só a parte local.
const licenseService = require('../electron/services/licenseService');
licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };

function lojaComProdutos() {
  const ctx = freshTestDb();
  const arroz = createProduct(ctx.db, { nome: 'Arroz 5 kg', preco: 27.9, custo: 21, categoria: 'Mercearia' });
  const leite = createProduct(ctx.db, { nome: 'Leite 1 L', preco: 5.49, custo: 3.1, categoria: 'Laticínios' });
  const sabao = createProduct(ctx.db, { nome: 'Sabão', preco: 9, categoria: 'Limpeza' });
  const corte = createProduct(ctx.db, { nome: 'Entrega', preco: 5, tipo: 'servico' });
  const brinde = createProduct(ctx.db, { nome: 'Brinde', preco: 0 });
  addStock(ctx.db, { productId: arroz, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  addStock(ctx.db, { productId: leite, locationId: ctx.locationId, quantidade: 2, operadorId: ctx.adminId });
  return { ...ctx, arroz, leite, sabao, corte, brinde };
}

test('catálogo público: preço de venda e faixa de disponibilidade; nunca custo nem estoque exato', () => {
  const ctx = lojaComProdutos();
  const { itens } = vitrine.montarCatalogo();
  const porNome = Object.fromEntries(itens.map((i) => [i.nome, i]));
  assert.equal(porNome['Arroz 5 kg'].disponibilidade, 'disponivel');
  assert.equal(porNome['Leite 1 L'].disponibilidade, 'poucas'); // padrão: avisa com até 3
  assert.equal(porNome.Entrega.disponibilidade, 'disponivel'); // serviço não tem estoque
  assert.equal(porNome['Sabão'], undefined); // sem estoque: escondido (padrão)
  assert.equal(porNome.Brinde, undefined); // preço zero não vai pra vitrine
  // Sem os ids (UUID aleatório pode conter "50" e deixava o teste instável).
  const texto = JSON.stringify(itens.map(({ id, ...resto }) => resto));
  assert.ok(!/custo|estoque|\b21\b|\b50\b/.test(texto), texto);
  assert.deepEqual(Object.keys(porNome['Arroz 5 kg']).sort(), ['categoria', 'disponibilidade', 'id', 'nome', 'preco', 'unidade']);
});

test('catálogo público: promoção por validade aparece com o preço "de"; esgotado aparece se a loja quiser', () => {
  const ctx = lojaComProdutos();
  ctx.db.prepare(`UPDATE products SET preco_promocional = 4.5, promocao_valida_ate = '2999-12-31' WHERE id = ?`).run(ctx.leite);
  ctx.db.prepare(`UPDATE vitrine_config SET ocultar_sem_estoque = 0, aviso_poucas_unidades = 0 WHERE id = 'default'`).run();
  vitrine.getConfig(); // garante a linha
  ctx.db.prepare(`UPDATE vitrine_config SET ocultar_sem_estoque = 0, aviso_poucas_unidades = 0 WHERE id = 'default'`).run();
  const porNome = Object.fromEntries(vitrine.montarCatalogo().itens.map((i) => [i.nome, i]));
  assert.equal(porNome['Leite 1 L'].preco, 4.5);
  assert.equal(porNome['Leite 1 L'].precoDe, 5.49);
  assert.equal(porNome['Leite 1 L'].disponibilidade, 'disponivel');
  assert.equal(porNome['Sabão'].disponibilidade, 'esgotado');
});

test('configuração: só gestão salva; ligar exige pelo menos um jeito de receber; Auditoria registra', () => {
  const ctx = lojaComProdutos();
  const base = { ativa: true, ocultarSemEstoque: true, avisoPoucasUnidades: 3, mensagem: 'Oi', modos: ['entrega'], pedidoMinimo: 20 };
  assert.equal(vitrine.saveConfig({ ...base, requestingUserId: ctx.operadorId }).ok, false);
  assert.match(vitrine.saveConfig({ ...base, modos: [], requestingUserId: ctx.gerenteId }).error, /retirada/);
  assert.equal(vitrine.saveConfig({ ...base, avisoPoucasUnidades: -1, requestingUserId: ctx.gerenteId }).ok, false);
  const r = vitrine.saveConfig({ ...base, modos: ['entrega', 'drone'], requestingUserId: ctx.gerenteId });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.modos, ['entrega']);
  assert.equal(r.config.link, null); // sem endereço criado na Central
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE tipo_evento = 'vitrine_alterada'`).get().c, 1);
});

test('endereço vem da Central; endereço com formato estranho é ignorado', () => {
  lojaComProdutos();
  vitrine.aplicarDaInstalacao({ vitrineSlug: 'padaria-pao-quente' });
  assert.equal(vitrine.getConfig().link, 'https://gerenciaai-garcom.web.app/loja.html?s=padaria-pao-quente');
  vitrine.aplicarDaInstalacao({ vitrineSlug: '<script>' });
  assert.equal(vitrine.getConfig().slug, null);
});

// ---------------------------------------------------------------------
// Página pública (pwa-mobile/loja-util.js)
// ---------------------------------------------------------------------
const carregarUtil = () => import(pathToFileURL(path.join(__dirname, '..', 'pwa-mobile', 'loja-util.js')).href);

test('pedido: preço atual do catálogo, item que saiu ou esgotou some, kg fracionado', async () => {
  const u = await carregarUtil();
  const catalogo = [
    { id: 'a', nome: 'Refri', preco: 9.9, unidade: 'un', disponibilidade: 'disponivel' },
    { id: 'p', nome: 'Pão francês', preco: 16.9, unidade: 'kg', disponibilidade: 'poucas' },
    { id: 's', nome: 'Sabão', preco: 9, unidade: 'un', disponibilidade: 'esgotado' },
  ];
  const itens = u.itensDoCarrinho({ a: 2, p: 0.5, s: 1, sumiu: 3, a2: 'x' }, catalogo);
  assert.deepEqual(itens.map((i) => [i.id, i.quantidade, i.total]), [['a', 2, 19.8], ['p', 0.5, 8.45]]);
  assert.equal(u.totalDoCarrinho(itens), 28.25);
  assert.equal(u.passoDa('kg'), 0.1);
  assert.equal(u.quantidadeInicial('kg'), 0.5);
  assert.equal(u.formatarQuantidade(0.5, 'kg'), '0,5 kg');
  assert.equal(u.formatarQuantidade(2, 'un'), '2x');
});

test('mensagem do pedido e link de WhatsApp', async () => {
  const u = await carregarUtil();
  const itens = u.itensDoCarrinho({ a: 2 }, [{ id: 'a', nome: 'Refri', preco: 9.9, unidade: 'un', disponibilidade: 'disponivel' }]);
  const texto = u.montarMensagemPedido({ nomeLoja: 'Padaria', itens, nome: 'Ana', modo: 'entrega', endereco: 'Rua A, 10', pagamento: 'dinheiro', trocoPara: 50, observacao: 'sem gelo' });
  assert.match(texto, /Olá, Padaria!/);
  assert.match(texto, /• 2x Refri — R\$\s?19,80/);
  assert.match(texto, /Total estimado: R\$\s?19,80/);
  assert.match(texto, /Entrega: Rua A, 10/);
  assert.match(texto, /Dinheiro \(troco para R\$\s?50,00\)/);
  assert.match(texto, /Observação: sem gelo/);
  assert.match(u.montarMensagemPedido({ itens, modo: 'retirada' }), /Retirada na loja/);
  assert.equal(u.linkWhatsapp('(81) 99999-1234', 'oi & tchau'), 'https://wa.me/5581999991234?text=oi%20%26%20tchau');
  assert.equal(u.linkWhatsapp('123', 'x'), null);
  assert.equal(u.slugValido('padaria-pao-quente'), true);
  assert.equal(u.slugValido('../x'), false);
  assert.equal(u.slugValido('-a'), false);
});
