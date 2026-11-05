const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, publicEncrypt, constants } = require('crypto');
const bcrypt = require('bcryptjs');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const mesas = require('../electron/services/mesaCelularService');
const tableService = require('../electron/services/tableService');
const cashService = require('../electron/services/cashService');

// Parte local (SQLite) das mesas pelo celular. A escuta do Firestore e a
// publicação dependem de rede (mesma limitação de pdvMobileGestao.test.js);
// as regras das coleções novas estão em firestoreRules.test.js.

const agora = Date.UTC(2026, 10, 4, 20, 0, 0);
const ts = (ms) => ({ toMillis: () => ms });

function loja() {
  const ctx = freshTestDb();
  const { db } = ctx;
  ctx.garcomId = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Garçom Teste', 'garcom', ?)`).run(ctx.garcomId, bcrypt.hashSync('2468', 10));
  const parear = (uid, tipo, userId) => db.prepare(
    `INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo, nome_dispositivo) VALUES (?, ?, ?, 1, ?)`
  ).run(uid, tipo, userId, `Celular ${uid}`);
  parear('uid-garcom', 'garcom', ctx.garcomId);
  parear('uid-caixa', 'pdv', ctx.operadorId);
  ctx.suco = createProduct(db, { nome: 'Suco', preco: 8 });
  ctx.prato = createProduct(db, { nome: 'Prato feito', preco: 30 });
  ctx.agua = createProduct(db, { nome: 'Água', preco: 4.5 });
  for (const p of [ctx.suco, ctx.prato, ctx.agua]) addStock(db, { productId: p, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  ctx.mesa1 = tableService.createTable({ locationId: ctx.locationId, numero: '1' }).id;
  ctx.mesa2 = tableService.createTable({ locationId: ctx.locationId, numero: '2' }).id;
  ctx.mesa3 = tableService.createTable({ locationId: ctx.locationId, numero: '3' }).id;
  return ctx;
}

let seq = 0;
function comando(tipo, extra = {}, uid = 'uid-garcom') {
  return { dispositivoUid: uid, tipo, status: 'novo', criadoEm: ts(agora - 2000), criadoEmCelularMs: agora - 3000, ...extra };
}
function executar(dados, id = `c${++seq}`) {
  return mesas.executarComando(id, dados, { agoraMs: agora });
}
function itensDa(ctx, mesaId) {
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(mesaId).sale_id;
  return ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND cancelado = 0 ORDER BY rowid').all(saleId);
}
function estoque(ctx, produtoId) {
  return ctx.db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS t FROM stock_movements WHERE product_id = ?').get(produtoId).t;
}
function cifrar(ctx, pin) {
  const chave = mesas.obterChave(ctx.db).chave_publica;
  return publicEncrypt(
    { key: Buffer.from(chave, 'base64'), format: 'der', type: 'spki', padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(pin, 'utf8'),
  ).toString('base64');
}
function abrirCaixa(ctx) {
  cashService.openSession({ locationId: ctx.locationId, operadorId: ctx.operadorId, valorAbertura: 100 });
}

test('garçom lança na mesa livre: abre a comanda, item por pessoa e com observação em linhas próprias', () => {
  const ctx = loja();
  const r = executar(comando('lancar', {
    mesaId: ctx.mesa1, pessoas: 2,
    itens: [
      { produtoId: ctx.suco, nome: 'Suco', quantidade: 1, pessoaNumero: 1 },
      { produtoId: ctx.suco, nome: 'Suco', quantidade: 1, pessoaNumero: 2 },
      { produtoId: ctx.agua, nome: 'Água', quantidade: 1, pessoaNumero: 2, observacao: 'sem gelo' },
      { produtoId: ctx.agua, nome: 'Água', quantidade: 1, pessoaNumero: 2 },
    ],
  }));
  assert.ifError(r.erro);
  assert.equal(r.resultado.lancados, 4);
  const mesa = ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(ctx.mesa1);
  assert.equal(mesa.status, 'ocupada');
  assert.equal(mesa.pessoas, 2);
  const venda = ctx.db.prepare('SELECT operador_id FROM sales WHERE id = ?').get(mesa.sale_id);
  assert.equal(venda.operador_id, ctx.garcomId, 'a comanda nasce no nome do garçom');
  const itens = itensDa(ctx, ctx.mesa1);
  assert.equal(itens.length, 4, 'suco da pessoa 1, suco da pessoa 2, água com observação e água sem');
  assert.equal(itens.find((i) => i.observacao === 'sem gelo').pessoa_numero, 2);
  assert.equal(estoque(ctx, ctx.suco), 48);
});

test('a segunda rodada não entra na linha que a cozinha já recebeu', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1, pessoaNumero: null }] }));
  // Ainda pendente e não impressa: soma na mesma linha.
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }));
  let itens = itensDa(ctx, ctx.mesa1);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].quantidade, 2);
  // Cozinha marcou pronto: a próxima vira linha nova (e aparece pendente na cozinha).
  ctx.db.prepare(`UPDATE sale_items SET status_preparo = 'pronto' WHERE id = ?`).run(itens[0].id);
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }));
  itens = itensDa(ctx, ctx.mesa1);
  assert.equal(itens.length, 2);
  assert.deepEqual(itens.map((i) => i.status_preparo), ['pronto', 'pendente']);
  // Impressa para a cozinha: também não soma.
  ctx.db.prepare('UPDATE sale_items SET enviado_cozinha = 1 WHERE id = ?').run(itens[1].id);
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }));
  assert.equal(itensDa(ctx, ctx.mesa1).length, 3);
});

test('o mesmo comando entregue duas vezes só vale uma', () => {
  const ctx = loja();
  const dados = comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.prato, quantidade: 1 }] });
  const a = mesas.executarComando('repetido', dados, { agoraMs: agora });
  const b = mesas.executarComando('repetido', dados, { agoraMs: agora });
  assert.ifError(a.erro);
  assert.equal(b.repetido, true);
  assert.deepEqual(b.resultado, a.resultado);
  assert.equal(itensDa(ctx, ctx.mesa1)[0].quantidade, 1);
  assert.equal(estoque(ctx, ctx.prato), 49);
});

test('nada entra (sem estoque): a mesa não fica aberta vazia e o erro fica registrado', () => {
  const ctx = loja();
  const semEstoque = createProduct(ctx.db, { nome: 'Sobremesa', preco: 12 });
  const r = executar(comando('lancar', { mesaId: ctx.mesa2, itens: [{ produtoId: semEstoque, nome: 'Sobremesa', quantidade: 1 }] }), 'sem-estoque');
  assert.match(r.erro, /Sobremesa: Estoque insuficiente/);
  assert.equal(ctx.db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(ctx.mesa2).status, 'livre');
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS c FROM sales WHERE status = 'aberta'`).get().c, 0);
  assert.equal(ctx.db.prepare(`SELECT ok FROM mobile_comandos_mesa WHERE id = 'sem-estoque'`).get().ok, 0);
});

test('parte entra, parte não: o que faltou volta na resposta', () => {
  const ctx = loja();
  const semEstoque = createProduct(ctx.db, { nome: 'Sobremesa', preco: 12 });
  const r = executar(comando('lancar', { mesaId: ctx.mesa1, itens: [
    { produtoId: ctx.prato, nome: 'Prato feito', quantidade: 1 },
    { produtoId: semEstoque, nome: 'Sobremesa', quantidade: 1 },
  ] }));
  assert.ifError(r.erro);
  assert.equal(r.resultado.lancados, 1);
  assert.equal(r.resultado.naoLancados[0].nome, 'Sobremesa');
});

test('pessoa que não existe mais: o item entra sem pessoa', () => {
  const ctx = loja();
  executar(comando('abrir', { mesaId: ctx.mesa1, pessoas: 2 }));
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1, pessoaNumero: 7 }] }));
  assert.equal(itensDa(ctx, ctx.mesa1)[0].pessoa_numero, null);
});

test('prazo: lançar fica na fila até 12 h; o resto precisa chegar na hora', () => {
  const ctx = loja();
  executar(comando('abrir', { mesaId: ctx.mesa1, pessoas: 1 }));
  const fila3h = executar(comando('lancar', {
    mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1 }], criadoEmCelularMs: agora - 3 * 3600 * 1000,
  }));
  assert.ifError(fila3h.erro);
  const fila13h = executar(comando('lancar', {
    mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1 }], criadoEmCelularMs: agora - 13 * 3600 * 1000,
  }));
  assert.match(fila13h.erro, /mais de 12 h sem internet/);
  const pessoaAtrasada = executar(comando('adicionar_pessoa', { mesaId: ctx.mesa1, nome: 'Ana', criadoEmCelularMs: agora - 20 * 60 * 1000 }));
  assert.match(pessoaAtrasada.erro, /sem internet e chegou atrasado/);
  const computadorFechado = executar(comando('adicionar_pessoa', { mesaId: ctx.mesa1, nome: 'Ana', criadoEm: ts(agora - 30 * 60 * 1000), criadoEmCelularMs: agora - 30 * 60 * 1000 }));
  assert.match(computadorFechado.erro, /chegou atrasado ao computador/);
});

test('celular desligado, usuário desativado ou mesas desligadas no PDV móvel: recusado', () => {
  const ctx = loja();
  ctx.db.prepare(`UPDATE paired_devices SET ativo = 0 WHERE id = 'uid-garcom'`).run();
  assert.match(executar(comando('abrir', { mesaId: ctx.mesa1 })).erro, /não reconhecido/);
  ctx.db.prepare(`UPDATE paired_devices SET ativo = 1 WHERE id = 'uid-garcom'`).run();
  ctx.db.prepare('UPDATE users SET ativo = 0 WHERE id = ?').run(ctx.garcomId);
  assert.match(executar(comando('abrir', { mesaId: ctx.mesa1 })).erro, /desativado/);
  require('../electron/services/pdvMobileConfigService').getConfig(); // cria a linha padrão
  ctx.db.prepare(`UPDATE pdv_mobile_config SET permitir_mesas = 0`).run();
  assert.match(executar(comando('abrir', { mesaId: ctx.mesa1 }, 'uid-caixa')).erro, /Mesas pelo celular está desligado/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM mobile_comandos_mesa').get().c, 0);
});

test('pessoas: adicionar com nome, renomear, mover item, remover (sem pagamento)', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, pessoas: 1, itens: [{ produtoId: ctx.prato, quantidade: 1, pessoaNumero: 1 }] }));
  const add = executar(comando('adicionar_pessoa', { mesaId: ctx.mesa1, nome: 'Bia' }));
  assert.equal(add.resultado.numero, 2);
  assert.ifError(executar(comando('renomear_pessoa', { mesaId: ctx.mesa1, numero: 1, nome: 'Ana' })).erro);
  const item = itensDa(ctx, ctx.mesa1)[0];
  assert.ifError(executar(comando('mover_item', { mesaId: ctx.mesa1, itemId: item.id, pessoaNumero: 2 })).erro);
  assert.equal(itensDa(ctx, ctx.mesa1)[0].pessoa_numero, 2);
  assert.match(executar(comando('mover_item', { mesaId: ctx.mesa1, itemId: item.id, pessoaNumero: 9 })).erro, /Pessoa não encontrada/);
  assert.ifError(executar(comando('mover_item', { mesaId: ctx.mesa1, itemId: item.id, pessoaNumero: null })).erro);
  assert.equal(itensDa(ctx, ctx.mesa1)[0].pessoa_numero, null);
  assert.ifError(executar(comando('observacao_item', { mesaId: ctx.mesa1, itemId: item.id, observacao: 'bem passado' })).erro);
  assert.equal(itensDa(ctx, ctx.mesa1)[0].observacao, 'bem passado');
  assert.ifError(executar(comando('remover_pessoa', { mesaId: ctx.mesa1, numero: 1 })).erro);
  const comanda = mesas.montarComanda(ctx.db, ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(ctx.mesa1));
  assert.deepEqual(comanda.pessoas, [{ numero: 1, nome: 'Bia' }]);
});

test('juntar, separar e transferir: só operador para cima', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.prato, quantidade: 1 }] }));
  executar(comando('lancar', { mesaId: ctx.mesa2, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }));
  assert.match(executar(comando('juntar', { mesaId: ctx.mesa1, mesaIds: [ctx.mesa2] })).erro, /caixa ou o gerente/);
  const j = executar(comando('juntar', { mesaId: ctx.mesa1, mesaIds: [ctx.mesa2] }, 'uid-caixa'));
  assert.ifError(j.erro);
  assert.equal(itensDa(ctx, ctx.mesa1).length, 2);
  const lista = mesas.montarMesas(ctx.db, ctx.locationId);
  assert.deepEqual(lista.find((m) => m.id === ctx.mesa1).unidas, ['2']);
  assert.equal(lista.find((m) => m.id === ctx.mesa2).unidaA, ctx.mesa1);
  // Lançar pela mesa unida cai na principal.
  executar(comando('lancar', { mesaId: ctx.mesa2, itens: [{ produtoId: ctx.agua, quantidade: 1 }] }));
  assert.equal(itensDa(ctx, ctx.mesa1).length, 3);
  assert.ifError(executar(comando('separar', { mesaId: ctx.mesa2 }, 'uid-caixa')).erro);
  assert.match(executar(comando('transferir', { mesaId: ctx.mesa1, destinoId: ctx.mesa3 })).erro, /caixa ou o gerente/);
  assert.ifError(executar(comando('transferir', { mesaId: ctx.mesa1, destinoId: ctx.mesa3 }, 'uid-caixa')).erro);
  assert.equal(ctx.db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(ctx.mesa3).status, 'ocupada');
});

test('mesa unida a uma mesa livre (grupo quebrado): a publicação conserta antes de mandar para o celular', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa2, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }));
  assert.ifError(executar(comando('juntar', { mesaId: ctx.mesa2, mesaIds: [ctx.mesa1] }, 'uid-caixa')).erro);
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa2).sale_id;
  // Como na foto: a 1 diz "unida à mesa 2", a 2 está livre e a comanda já foi fechada.
  ctx.db.prepare(`UPDATE sales SET status = 'finalizada' WHERE id = ?`).run(saleId);
  ctx.db.prepare(`UPDATE restaurant_tables SET status = 'livre', sale_id = NULL, pessoas = NULL WHERE id = ?`).run(ctx.mesa2);

  const lista = mesas.montarMesas(ctx.db, ctx.locationId);
  const um = lista.find((m) => m.id === ctx.mesa1);
  assert.equal(um.unidaA, null);
  assert.equal(um.status, 'aguardando_limpeza');
  assert.equal(lista.find((m) => m.id === ctx.mesa2).status, 'livre');
  assert.ifError(executar(comando('limpar_mesa', { mesaId: ctx.mesa1 })).erro);
  assert.equal(ctx.db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).status, 'livre');
});

test('nome dado no celular é o mesmo que o computador mostra na comanda', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, pessoas: 2, itens: [{ produtoId: ctx.prato, quantidade: 1, pessoaNumero: 1 }] }));
  assert.ifError(executar(comando('renomear_pessoa', { mesaId: ctx.mesa1, numero: 1, nome: '  Ana  Paula ' })).erro);
  assert.ifError(executar(comando('adicionar_pessoa', { mesaId: ctx.mesa1, nome: 'Caio' })).erro);
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).sale_id;
  assert.deepEqual(tableService.getTableCart(saleId).pessoas, [
    { numero: 1, nome: 'Ana Paula' }, { numero: 2, nome: null }, { numero: 3, nome: 'Caio' },
  ]);
  // E o caminho de volta: nome trocado no computador chega ao celular.
  tableService.renomearPessoa({ tableId: ctx.mesa1, numero: 2, nome: 'Bia' });
  const comanda = mesas.montarComanda(ctx.db, ctx.db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(ctx.mesa1));
  assert.deepEqual(comanda.pessoas.map((p) => p.nome), ['Ana Paula', 'Bia', 'Caio']);
});

test('avisarTelas manda "mesas:mudou" para as janelas abertas do computador', () => {
  const Module = require('module');
  const original = Module._load;
  const enviados = [];
  Module._load = function carregar(pedido, ...resto) {
    if (pedido === 'electron') {
      return { BrowserWindow: { getAllWindows: () => [
        { isDestroyed: () => false, webContents: { send: (canal, evento) => enviados.push([canal, evento]) } },
        { isDestroyed: () => true, webContents: { send: () => { throw new Error('janela fechada'); } } },
      ] } };
    }
    return original.call(this, pedido, ...resto);
  };
  try {
    mesas.avisarTelas({ origem: 'celular', tipo: 'renomear_pessoa', mesaId: 'm1' });
  } finally {
    Module._load = original;
  }
  assert.deepEqual(enviados, [['mesas:mudou', { origem: 'celular', tipo: 'renomear_pessoa', mesaId: 'm1' }]]);
  assert.doesNotThrow(() => mesas.avisarTelas({}), 'fora do Electron não faz nada');
});

test('conta por pessoa: taxa de serviço proporcional e a soma fecha com o total', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, pessoas: 2, itens: [
    { produtoId: ctx.prato, quantidade: 1, pessoaNumero: 1 },
    { produtoId: ctx.suco, quantidade: 1, pessoaNumero: 2 },
    { produtoId: ctx.agua, quantidade: 1 },
  ] }));
  abrirCaixa(ctx);
  assert.ifError(executar(comando('taxa_servico', { mesaId: ctx.mesa1, percentual: 10 }, 'uid-caixa')).erro);
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).sale_id;
  const conta = mesas.calcularConta(ctx.db, saleId);
  assert.equal(conta.subtotal, 42.5);
  assert.equal(conta.totalAPagar, 46.75);
  assert.deepEqual(conta.grupos.map((g) => [g.grupo, g.valor]), [['p1', 33], ['p2', 8.8], ['mesa', 4.95]]);
  assert.equal(Math.round(conta.grupos.reduce((s, g) => s + g.devido, 0) * 100), Math.round(conta.restante * 100));
});

test('receber por pessoa e depois o resto: finaliza a venda, libera a mesa e guarda quem pagou', async () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, pessoas: 2, itens: [
    { produtoId: ctx.prato, quantidade: 1, pessoaNumero: 1 },
    { produtoId: ctx.suco, quantidade: 1, pessoaNumero: 2 },
  ] }));
  abrirCaixa(ctx);
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).sale_id;

  assert.match(executar(comando('receber', { mesaId: ctx.mesa1, grupos: ['p1'], valorEsperado: 30, pagamentos: [{ metodo: 'pix', valor: 30 }] })).erro, /PDV móvel/,
    'o celular do garçom só lança');

  const ana = executar(comando('receber', {
    mesaId: ctx.mesa1, grupos: ['p1'], valorEsperado: 30, pagamentos: [{ metodo: 'dinheiro', valor: 30, valorRecebido: 50 }],
  }, 'uid-caixa'));
  assert.ifError(ana.erro);
  assert.equal(ana.resultado.troco, 20);
  assert.equal(ana.resultado.finalizar, false);
  const pag = ctx.db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(saleId);
  assert.equal(pag.valor, 30, 'só o que falta entra como dinheiro no caixa');
  assert.deepEqual(JSON.parse(pag.detalhes).grupos, [{ grupo: 'p1', valor: 30 }]);
  assert.equal(JSON.parse(pag.detalhes).origem, 'pdv_movel');

  let conta = mesas.calcularConta(ctx.db, saleId);
  assert.deepEqual(conta.grupos.map((g) => [g.grupo, g.devido]), [['p1', 0], ['p2', 8]]);

  // Valor desatualizado (item novo entrou): recusa com a conta de agora.
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.agua, quantidade: 1, pessoaNumero: 2 }] }));
  const velho = executar(comando('receber', { mesaId: ctx.mesa1, grupos: ['p2'], valorEsperado: 8, pagamentos: [{ metodo: 'pix', valor: 8 }] }, 'uid-caixa'));
  assert.match(velho.erro, /A conta mudou/);
  assert.equal(velho.extra.conta.restante, 12.5);

  const resto = executar(comando('receber', {
    mesaId: ctx.mesa1, grupos: 'tudo', valorEsperado: 12.5, pagamentos: [{ metodo: 'cartao_debito', valor: 12.5 }],
  }, 'uid-caixa'), 'fecha-conta');
  assert.ifError(resto.erro);
  assert.equal(resto.resultado.finalizar, true);
  const final = await mesas.concluirConta('fecha-conta');
  assert.equal(final.finalizada, true);
  assert.equal(ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId).status, 'finalizada');
  assert.equal(ctx.db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).status, 'aguardando_limpeza');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM sale_mesas WHERE sale_id = ?').get(saleId).c, 1, 'a venda lembra a mesa no histórico');
  // Repetir a conclusão não faz nada de novo.
  assert.equal((await mesas.concluirConta('fecha-conta')).finalizada, true);
  // Mesa limpa pelo garçom.
  assert.ifError(executar(comando('limpar_mesa', { mesaId: ctx.mesa1 })).erro);
  assert.equal(ctx.db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).status, 'livre');
});

test('receber: caixa fechado, forma de pagamento não liberada e cartão acima da conta são recusados', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.prato, quantidade: 1 }] }));
  const base = { mesaId: ctx.mesa1, grupos: 'tudo', valorEsperado: 30 };
  assert.match(executar(comando('receber', { ...base, pagamentos: [{ metodo: 'pix', valor: 30 }] }, 'uid-caixa')).erro, /caixa está fechado/);
  abrirCaixa(ctx);
  assert.match(executar(comando('receber', { ...base, pagamentos: [{ metodo: 'fiado', valor: 30 }] }, 'uid-caixa')).erro, /não está liberada/);
  assert.match(executar(comando('receber', { ...base, pagamentos: [{ metodo: 'cartao_credito', valor: 31 }] }, 'uid-caixa')).erro, /não podem passar/);
  assert.match(executar(comando('receber', { ...base, pagamentos: [{ metodo: 'pix', valor: 20 }] }, 'uid-caixa')).erro, /Faltam R\$ 10.00/);
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).sale_id;
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(saleId).c, 0, 'recusa desfaz tudo');
});

test('pagamento feito no computador (sem pessoa) abate de todos, na proporção', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, pessoas: 2, itens: [
    { produtoId: ctx.prato, quantidade: 1, pessoaNumero: 1 },
    { produtoId: ctx.prato, quantidade: 1, pessoaNumero: 2 },
  ] }));
  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).sale_id;
  require('../electron/services/saleService').addPayment({ saleId, metodo: 'pix', valor: 20, detalhes: {} });
  const conta = mesas.calcularConta(ctx.db, saleId);
  assert.deepEqual(conta.grupos.map((g) => [g.grupo, g.devido]), [['p1', 20], ['p2', 20]]);
  assert.equal(conta.restante, 40);
});

test('cancelar item: sem pagamento passa direto; com pagamento exige PIN de gerente cifrado, e PIN errado conta tentativa', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [
    { produtoId: ctx.prato, quantidade: 1 }, { produtoId: ctx.suco, quantidade: 1 }, { produtoId: ctx.agua, quantidade: 1 },
  ] }));
  const [prato, suco, agua] = itensDa(ctx, ctx.mesa1);
  assert.ifError(executar(comando('cancelar_item', { mesaId: ctx.mesa1, itemId: agua.id, motivo: 'desistiu' })).erro);
  assert.equal(estoque(ctx, ctx.agua), 50, 'estoque volta');

  const saleId = ctx.db.prepare('SELECT sale_id FROM restaurant_tables WHERE id = ?').get(ctx.mesa1).sale_id;
  require('../electron/services/saleService').addPayment({ saleId, metodo: 'pix', valor: 10, detalhes: {} });
  const semPin = executar(comando('cancelar_item', { mesaId: ctx.mesa1, itemId: suco.id }));
  assert.match(semPin.erro, /outra pessoa/);
  const errado = executar(comando('cancelar_item', { mesaId: ctx.mesa1, itemId: suco.id, autorizadorId: ctx.gerenteId, pinCifrado: cifrar(ctx, '0000') }), 'pin-errado');
  assert.match(errado.erro, /PIN incorreto/);
  assert.equal(ctx.db.prepare('SELECT tentativas_falhas FROM users WHERE id = ?').get(ctx.gerenteId).tentativas_falhas, 1,
    'o PIN errado pelo celular conta para o bloqueio, igual no computador');
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tipo_evento = 'cancelamento_item' AND sucesso = 0`).get().c >= 1, true,
    'a tentativa errada fica na auditoria');
  assert.ifError(executar(comando('cancelar_item', { mesaId: ctx.mesa1, itemId: suco.id, autorizadorId: ctx.gerenteId, pinCifrado: cifrar(ctx, '1234') })).erro);
  assert.equal(itensDa(ctx, ctx.mesa1).map((i) => i.id).join(), prato.id);
  assert.match(executar(comando('cancelar_item', { mesaId: ctx.mesa1, itemId: prato.id, autorizadorId: ctx.gerenteId, pinCifrado: 'lixo' })).erro, /Não deu para conferir o PIN/);
  assert.match(executar(comando('remover_pessoa', { mesaId: ctx.mesa1, numero: 1 })).erro, /já tem pagamento/);
  assert.match(executar(comando('taxa_servico', { mesaId: ctx.mesa1, percentual: 10 }, 'uid-caixa')).erro, /já tem pagamento/);
});

test('comanda e lista publicadas: o que o celular recebe', () => {
  const ctx = loja();
  executar(comando('lancar', { mesaId: ctx.mesa1, pessoas: 2, itens: [{ produtoId: ctx.suco, quantidade: 2, pessoaNumero: 1, observacao: 'gelo à parte' }] }));
  executar(comando('renomear_pessoa', { mesaId: ctx.mesa1, numero: 1, nome: 'Ana' }));
  const { mesas: doc, comandas } = mesas.montarPublicacao();
  assert.equal(doc.versao, 1);
  assert.equal(doc.caixaAberto, false);
  assert.ok(doc.chavePublica.length > 100);
  const ids = doc.autorizadores.map((a) => a.id);
  assert.ok(ids.includes(ctx.gerenteId) && ids.includes(ctx.adminId));
  assert.ok(!ids.includes(ctx.garcomId) && !ids.includes(ctx.operadorId), 'só quem pode autorizar');
  const m1 = doc.mesas.find((m) => m.id === ctx.mesa1);
  assert.equal(m1.status, 'ocupada');
  assert.equal(m1.total, 16);
  assert.equal(m1.abertaPorNome, 'Garçom Teste');
  assert.equal(doc.mesas.find((m) => m.id === ctx.mesa2).status, 'livre');
  const c = comandas.get(ctx.mesa1);
  assert.deepEqual(c.pessoas, [{ numero: 1, nome: 'Ana' }, { numero: 2, nome: null }]);
  assert.equal(c.itens[0].observacao, 'gelo à parte');
  assert.equal(c.itens[0].preparo, 'pendente');
  assert.equal(c.conta.grupos[0].rotulo, 'Ana');
  assert.equal(comandas.has(ctx.mesa2), false);
});

test('meu turno: só as vendas do usuário do celular, no caixa aberto', () => {
  const ctx = loja();
  assert.match(executar(comando('meu_turno', {})).erro, /PDV móvel/, 'celular do garçom não tem turno de caixa');
  require('../electron/services/pdvMobileConfigService').getConfig();
  ctx.db.prepare('UPDATE pdv_mobile_config SET permitir_mesas = 0').run();
  assert.equal(executar(comando('meu_turno', {}, 'uid-caixa')).resultado.caixaAberto, false, 'vale mesmo com mesas desligadas no celular');
  ctx.db.prepare('UPDATE pdv_mobile_config SET permitir_mesas = 1').run();
  assert.equal(executar(comando('meu_turno', {}, 'uid-caixa')).resultado.caixaAberto, false);
  abrirCaixa(ctx);
  executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.prato, quantidade: 1 }] }, 'uid-caixa'));
  executar(comando('receber', { mesaId: ctx.mesa1, grupos: 'tudo', valorEsperado: 30, pagamentos: [{ metodo: 'pix', valor: 30 }] }, 'uid-caixa'));
  require('../electron/services/saleService').finalizeSale(ctx.db.prepare(`SELECT id FROM sales WHERE status = 'aberta'`).get().id);
  const r = executar(comando('meu_turno', {}, 'uid-caixa'));
  assert.equal(r.resultado.vendas, 1);
  assert.equal(r.resultado.total, 30);
  assert.deepEqual(r.resultado.porMetodo, [{ metodo: 'pix', total: 30 }]);
  assert.equal(r.resultado.recebidoNasMesas, 30);
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS c FROM mobile_comandos_mesa WHERE tipo = 'meu_turno'`).get().c, 0, 'leitura não grava nada');
});

// Publicação para o celular com um Firestore falso: escreve só o que mudou,
// apaga a comanda de mesa que fechou e manda sinal de vida.
async function comFirestoreFalso(fn) {
  const escritas = [];
  const caminhoFirestore = require.resolve('firebase/firestore');
  const original = require.cache[caminhoFirestore];
  require.cache[caminhoFirestore] = {
    id: caminhoFirestore, filename: caminhoFirestore, loaded: true,
    exports: {
      doc: (_fs, ...partes) => partes.join('/'),
      setDoc: async (ref, dados) => { escritas.push({ op: 'set', ref, dados }); },
      deleteDoc: async (ref) => { escritas.push({ op: 'delete', ref }); },
      serverTimestamp: () => 'TS',
    },
  };
  const licenseService = require('../electron/services/licenseService');
  const pdvRegistry = require('../electron/services/pdvRegistryService');
  const origFs = licenseService.getLicenseFirestore;
  const origUid = pdvRegistry.getOrCreateDeviceUid;
  licenseService.getLicenseFirestore = () => ({});
  pdvRegistry.getOrCreateDeviceUid = () => 'pc1';
  mesas._reiniciarPublicacao();
  try {
    return await fn(escritas);
  } finally {
    licenseService.getLicenseFirestore = origFs;
    pdvRegistry.getOrCreateDeviceUid = origUid;
    if (original) require.cache[caminhoFirestore] = original; else delete require.cache[caminhoFirestore];
  }
}

test('publicação: só o que mudou vai para o Firestore; mesa fechada some; sem celular de mesa, nada', async () => {
  const ctx = loja();
  await comFirestoreFalso(async (escritas) => {
    executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }));
    await mesas.publicar();
    const primeira = escritas.splice(0);
    assert.ok(primeira.some((e) => e.op === 'set' && e.ref === 'installations/pc1/mesas_ao_vivo/atual' && e.dados.vivoEmMs > 0));
    assert.ok(primeira.some((e) => e.op === 'set' && e.ref === `installations/pc1/comandas_mesa/${ctx.mesa1}`));
    assert.ok(primeira.some((e) => e.op === 'delete' && e.ref === `installations/pc1/comandas_mesa/${ctx.mesa2}`), 'limpa o que ficou de antes');

    await mesas.publicar();
    assert.deepEqual(escritas.splice(0), [], 'nada mudou, nada escrito');

    executar(comando('lancar', { mesaId: ctx.mesa1, itens: [{ produtoId: ctx.agua, quantidade: 1 }] }));
    await mesas.publicar();
    assert.deepEqual(escritas.splice(0).map((e) => e.ref).sort(), [`installations/pc1/comandas_mesa/${ctx.mesa1}`, 'installations/pc1/mesas_ao_vivo/atual'].sort());

    // Conta fechada no computador: a mesa sai de ocupada.
    tableService.releaseTable(ctx.mesa1);
    await mesas.publicar();
    assert.ok(escritas.splice(0).some((e) => e.op === 'delete' && e.ref === `installations/pc1/comandas_mesa/${ctx.mesa1}`));

    ctx.db.prepare('UPDATE paired_devices SET ativo = 0').run();
    executar(comando('lancar', { mesaId: ctx.mesa2, itens: [{ produtoId: ctx.suco, quantidade: 1 }] }, 'uid-caixa'));
    await mesas.publicar();
    assert.deepEqual(escritas.splice(0), [], 'sem celular pareado, não gasta escrita');
  });
});
