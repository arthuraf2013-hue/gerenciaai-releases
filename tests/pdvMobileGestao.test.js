const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct, addStock, createSuporteUser } = require('./helpers/testDb');
const gestao = require('../electron/services/pdvMobileGestaoService');
const pdvMobileConfigService = require('../electron/services/pdvMobileConfigService');

// Parte local (SQLite) da gestão de produtos pelo PDV móvel. A escuta do
// Firestore e a resposta pro celular dependem de rede (mesma limitação de
// pdvMobileSyncService.test.js); as regras de gestao_pdv estão em
// firestoreRules.test.js.

function loja() {
  const ctx = freshTestDb();
  ctx.produtoId = createProduct(ctx.db, { nome: 'Refrigerante', preco: 10, custo: 6 });
  addStock(ctx.db, { productId: ctx.produtoId, locationId: ctx.locationId, quantidade: 20, operadorId: ctx.adminId });
  const parear = (uid, userId) => ctx.db.prepare(
    `INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo, nome_dispositivo) VALUES (?, 'pdv', ?, 1, ?)`
  ).run(uid, userId, `Celular ${uid}`);
  parear('uid-gerente', ctx.gerenteId);
  parear('uid-operador', ctx.operadorId);
  return ctx;
}

const agora = Date.UTC(2026, 9, 23, 15, 0, 0);
const ts = (ms) => ({ toMillis: () => ms });

function pedido(tipo, extra = {}, uid = 'uid-gerente') {
  return { dispositivoUid: uid, status: 'novo', tipo, criadoEm: ts(agora - 5000), ...extra };
}

function executar(id, dados) {
  return gestao.executarPedido(id, dados, { agoraMs: agora });
}

function estoque(ctx, produtoId = ctx.produtoId) {
  return ctx.db.prepare('SELECT COALESCE(SUM(quantidade), 0) as t FROM stock_movements WHERE product_id = ? AND location_id = ?')
    .get(produtoId, ctx.locationId).t;
}

function auditoria(ctx, tipo) {
  return ctx.db.prepare('SELECT * FROM audit_log WHERE tipo_evento = ? ORDER BY rowid').all(tipo);
}

test('detalhe: celular de gerente vê custo, margem e estoque', () => {
  const ctx = loja();
  const r = executar('d1', pedido('detalhe', { produtoId: ctx.produtoId }));
  assert.ifError(r.erro);
  assert.equal(r.resultado.preco, 10);
  assert.equal(r.resultado.custo, 6);
  assert.equal(r.resultado.margem, 40);
  assert.equal(r.resultado.estoque, 20);
  // leitura não deixa registro de alteração
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM mobile_gestao_pedidos').get().c, 0);
});

test('operador de caixa não vê nem altera nada, mesmo pedindo direto', () => {
  const ctx = loja();
  for (const tipo of ['detalhe', 'preco', 'estoque', 'produto_novo']) {
    const r = executar(`op-${tipo}`, pedido(tipo, { produtoId: ctx.produtoId, preco: 1, movimento: 'entrada', quantidade: 1, motivo: 'x', nome: 'Novo' }, 'uid-operador'));
    assert.match(r.erro, /gerente ou administrador/);
  }
  assert.equal(ctx.db.prepare('SELECT preco FROM products WHERE id = ?').get(ctx.produtoId).preco, 10);
  assert.equal(estoque(ctx), 20);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
});

test('papel conferido na hora: gerente rebaixado a operador perde o acesso', () => {
  const ctx = loja();
  ctx.db.prepare(`UPDATE users SET role = 'operador' WHERE id = ?`).run(ctx.gerenteId);
  const r = executar('p-rebaixado', pedido('preco', { produtoId: ctx.produtoId, preco: 12, precoAnterior: 10 }));
  assert.match(r.erro, /gerente ou administrador/);
  assert.equal(ctx.db.prepare('SELECT preco FROM products WHERE id = ?').get(ctx.produtoId).preco, 10);
});

test('celular desconectado ou usuário desativado: recusado', () => {
  const ctx = loja();
  ctx.db.prepare(`UPDATE paired_devices SET ativo = 0 WHERE id = 'uid-gerente'`).run();
  assert.match(executar('x1', pedido('detalhe', { produtoId: ctx.produtoId })).erro, /não reconhecido/);
  ctx.db.prepare(`UPDATE paired_devices SET ativo = 1 WHERE id = 'uid-gerente'`).run();
  ctx.db.prepare(`UPDATE users SET ativo = 0 WHERE id = ?`).run(ctx.gerenteId);
  assert.match(executar('x2', pedido('detalhe', { produtoId: ctx.produtoId })).erro, /desativado/);
});

// saveConfig publica no Firestore em segundo plano; sem rede, o SDK
// segura o processo do teste por ~60 s. Aqui só interessa o que é gravado.
function semPublicar(fn) {
  const licenseService = require('../electron/services/licenseService');
  const original = licenseService.getLicenseFirestore;
  licenseService.getLicenseFirestore = () => { throw new Error('sem rede no teste'); };
  try { return fn(); } finally { licenseService.getLicenseFirestore = original; }
}

test('opção desligada em Configurações → Celular: nem gerente mexe', () => {
  const ctx = loja();
  const r = semPublicar(() => pdvMobileConfigService.saveConfig({
    permitirVenda: true, permitirMesas: true, metodosPagamento: ['dinheiro'], descontoMaximoPercentual: 0,
    gestaoProdutos: 'desligado', requestingUserId: ctx.adminId,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.config.gestaoProdutos, 'desligado');
  assert.match(executar('off', pedido('preco', { produtoId: ctx.produtoId, preco: 12, precoAnterior: 10 })).erro, /desligado/);
  assert.deepEqual(pdvMobileConfigService.dispositivosComGestao(), []);
});

test('lista publicada pro celular: só gerente/admin/suporte com a opção ligada; nunca operador', () => {
  const ctx = loja();
  const suporteId = createSuporteUser(ctx.db);
  ctx.db.prepare(`INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-suporte', 'pdv', ?, 1)`).run(suporteId);
  ctx.db.prepare(`INSERT INTO paired_devices (id, tipo, vinculo_user_id, ativo) VALUES ('uid-garcom', 'garcom', ?, 1)`).run(ctx.gerenteId);
  assert.deepEqual(pdvMobileConfigService.dispositivosComGestao(), ['uid-gerente', 'uid-suporte']);
  assert.equal(pdvMobileConfigService.getConfig().gestaoProdutos, 'gestao');
  assert.equal(pdvMobileConfigService.saveConfig({
    permitirVenda: true, metodosPagamento: ['dinheiro'], descontoMaximoPercentual: 0, gestaoProdutos: 'todos', requestingUserId: ctx.adminId,
  }).ok, false);
});

test('preço: altera pelo mesmo caminho da tela de Produtos, com histórico e Auditoria em nome do gerente', () => {
  const ctx = loja();
  ctx.db.prepare(`UPDATE products SET custom_fields = ?, ncm = '22021000', codigo_barras = '789123' WHERE id = ?`)
    .run(JSON.stringify({ lote: 'A1' }), ctx.produtoId);
  const r = executar('p1', pedido('preco', { produtoId: ctx.produtoId, preco: 12.5, precoAnterior: 10 }));
  assert.ifError(r.erro);
  assert.equal(r.resultado.produto.preco, 12.5);
  assert.equal(r.resultado.produto.margem, 52);

  const p = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(ctx.produtoId);
  assert.equal(p.preco, 12.5);
  // o upsert regrava a linha inteira: nada mais pode ter se perdido
  assert.equal(p.custo, 6);
  assert.equal(p.ncm, '22021000');
  assert.equal(p.codigo_barras, '789123');
  assert.deepEqual(JSON.parse(p.custom_fields), { lote: 'A1' });

  const hist = ctx.db.prepare('SELECT * FROM product_price_history WHERE product_id = ?').all(ctx.produtoId);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].operador_id, ctx.gerenteId);
  const aud = auditoria(ctx, 'preco_alterado_celular');
  assert.equal(aud.length, 1);
  assert.equal(aud[0].solicitante_id, ctx.gerenteId);
  assert.match(aud[0].motivo, /R\$ 10,00 → R\$ 12,50/);
  assert.match(aud[0].motivo, /Celular uid-gerente/);
});

test('preço: mesmo pedido entregue duas vezes só aplica uma (e devolve o mesmo resultado)', () => {
  const ctx = loja();
  const dados = pedido('preco', { produtoId: ctx.produtoId, preco: 12, precoAnterior: 10 });
  const a = executar('dup', dados);
  const b = executar('dup', dados);
  assert.deepEqual(b, a);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM product_price_history').get().c, 1);
  assert.equal(auditoria(ctx, 'preco_alterado_celular').length, 1);
});

test('preço: alguém mudou no computador enquanto o celular editava -> recusa sem passar por cima', () => {
  const ctx = loja();
  ctx.db.prepare('UPDATE products SET preco = 11 WHERE id = ?').run(ctx.produtoId);
  const r = executar('p-conflito', pedido('preco', { produtoId: ctx.produtoId, preco: 12, precoAnterior: 10 }));
  assert.match(r.erro, /mudou para R\$ 11,00/);
  assert.equal(ctx.db.prepare('SELECT preco FROM products WHERE id = ?').get(ctx.produtoId).preco, 11);
  // a recusa também fica registrada: reentrega não reavalia com outro resultado
  assert.deepEqual(executar('p-conflito', pedido('preco', { produtoId: ctx.produtoId, preco: 12, precoAnterior: 11 })), r);
});

test('preço: zero, negativo, absurdo ou igual ao atual são recusados', () => {
  const ctx = loja();
  assert.match(executar('z', pedido('preco', { produtoId: ctx.produtoId, preco: 0 })).erro, /maior que zero/);
  assert.match(executar('n', pedido('preco', { produtoId: ctx.produtoId, preco: -3 })).erro, /inválido/);
  assert.match(executar('a', pedido('preco', { produtoId: ctx.produtoId, preco: 5e9 })).erro, /inválido/);
  assert.match(executar('i', pedido('preco', { produtoId: ctx.produtoId, preco: 10 })).erro, /igual/);
  assert.match(executar('s', pedido('preco', { produtoId: ctx.produtoId, preco: 'abc' })).erro, /inválido/);
  assert.equal(ctx.db.prepare('SELECT preco FROM products WHERE id = ?').get(ctx.produtoId).preco, 10);
});

test('pedido que chega depois de 10 minutos é descartado (o celular já avisou que não valeu)', () => {
  const ctx = loja();
  const r = executar('velho', pedido('preco', { produtoId: ctx.produtoId, preco: 12, criadoEm: ts(agora - gestao.VALIDADE_PEDIDO_MS - 1000) }));
  assert.match(r.erro, /10 minutos/);
  assert.equal(ctx.db.prepare('SELECT preco FROM products WHERE id = ?').get(ctx.produtoId).preco, 10);
});

test('estoque: entrada e perda com motivo, em nome do gerente, com o uid do celular no movimento', () => {
  const ctx = loja();
  const e = executar('e1', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'entrada', quantidade: 12, motivo: 'Nota 55' }));
  assert.ifError(e.erro);
  assert.equal(e.resultado.produto.estoque, 32);
  const p = executar('e2', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'perda', quantidade: 2, motivo: 'Vencido' }));
  assert.ifError(p.erro);
  assert.equal(estoque(ctx), 30);

  const movs = ctx.db.prepare(`SELECT tipo, quantidade, operador_id, device_id, motivo FROM stock_movements WHERE device_id = 'uid-gerente' ORDER BY rowid`).all();
  assert.deepEqual(movs.map((m) => [m.tipo, m.quantidade]), [['entrada', 12], ['perda', -2]]);
  assert.ok(movs.every((m) => m.operador_id === ctx.gerenteId));
  assert.equal(auditoria(ctx, 'estoque_ajustado_celular').length, 2);
});

test('estoque: contagem calcula a diferença com o estoque do momento em que o pedido chega', () => {
  const ctx = loja();
  // vendeu 3 enquanto a pessoa contava: estoque real agora é 17
  addStock(ctx.db, { productId: ctx.produtoId, locationId: ctx.locationId, quantidade: -3, operadorId: ctx.adminId });
  const r = executar('c1', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'contagem', quantidade: 15, motivo: 'Inventário' }));
  assert.ifError(r.erro);
  assert.equal(estoque(ctx), 15);
  const mov = ctx.db.prepare(`SELECT tipo, quantidade FROM stock_movements WHERE device_id = 'uid-gerente'`).get();
  assert.deepEqual([mov.tipo, mov.quantidade], ['ajuste', -2]);
  assert.match(executar('c2', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'contagem', quantidade: 15, motivo: 'De novo' })).erro, /nada a corrigir/);
});

test('estoque: sem motivo, tipo inválido, quantidade zero ou serviço são recusados', () => {
  const ctx = loja();
  assert.match(executar('m1', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'entrada', quantidade: 1, motivo: '  ' })).erro, /motivo/);
  assert.match(executar('m2', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'apagar', quantidade: 1, motivo: 'x' })).erro, /inválido/);
  assert.match(executar('m3', pedido('estoque', { produtoId: ctx.produtoId, movimento: 'entrada', quantidade: 0, motivo: 'x' })).erro, /maior que zero/);
  const servicoId = createProduct(ctx.db, { nome: 'Corte', preco: 30, tipo: 'servico' });
  assert.match(executar('m4', pedido('estoque', { produtoId: servicoId, movimento: 'entrada', quantidade: 1, motivo: 'x' })).erro, /Serviço/);
  assert.equal(estoque(ctx), 20);
});

test('produto novo: cadastra com estoque inicial; reentrega não duplica', () => {
  const ctx = loja();
  const dados = pedido('produto_novo', { nome: 'Água 500 ml', preco: 3.5, custo: 1.2, unidade: 'un', codigoBarras: '7890001112223', estoqueInicial: 24, categoria: 'Bebidas' });
  const r = executar('n1', dados);
  assert.ifError(r.erro);
  assert.equal(r.resultado.produto.nome, 'Água 500 ml');
  assert.equal(r.resultado.produto.estoque, 24);
  assert.equal(r.resultado.produto.codigoBarras, '7890001112223');
  executar('n1', dados);
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) c FROM products WHERE nome = 'Água 500 ml'`).get().c, 1);
  assert.equal(estoque(ctx, r.resultado.produto.id), 24);
  assert.equal(auditoria(ctx, 'produto_cadastrado_celular').length, 1);
});

test('produto novo: código de barras que já é de outro produto é recusado com o nome do dono', () => {
  const ctx = loja();
  ctx.db.prepare(`UPDATE products SET codigo_barras = '789123' WHERE id = ?`).run(ctx.produtoId);
  const r = executar('n2', pedido('produto_novo', { nome: 'Outro', preco: 5, codigoBarras: '789123' }));
  assert.match(r.erro, /Refrigerante/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
});

test('produto novo: sem nome ou sem preço é recusado; unidade desconhecida vira "un"', () => {
  const ctx = loja();
  assert.match(executar('n3', pedido('produto_novo', { nome: 'A', preco: 5 })).erro, /nome/);
  assert.match(executar('n4', pedido('produto_novo', { nome: 'Pão', preco: 0 })).erro, /maior que zero/);
  const r = executar('n5', pedido('produto_novo', { nome: 'Pão', preco: 0.5, unidade: '<script>' }));
  assert.equal(r.resultado.produto.unidade, 'un');
});

test('tipo desconhecido e produto inexistente', () => {
  const ctx = loja();
  assert.match(executar('t1', pedido('apagar_tudo')).erro, /desconhecido/);
  assert.match(executar('t2', pedido('detalhe', { produtoId: 'nao-existe' })).erro, /não encontrado/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM mobile_gestao_pedidos').get().c, 0);
});
