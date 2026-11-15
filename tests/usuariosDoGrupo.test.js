const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { setDbForTesting } = require('../electron/db/database');
const { freshTestDb, createProduct, addStock, createSuporteUser } = require('./helpers/testDb');
const userSyncService = require('../electron/services/userSyncService');
const userService = require('../electron/services/userService');
const authService = require('../electron/services/authService');
const stockSyncService = require('../electron/services/stockSyncService');

// Firestore falso: os documentos do grupo, com a mesma checagem das regras.
function grupoFalso() {
  const docs = new Map();
  let foraDoAr = false;
  const gravados = [];
  return {
    docs, gravados,
    derrubar(v = true) { foraDoAr = v; },
    async lerTodos() {
      if (foraDoAr) throw new Error('sem internet');
      return new Map([...docs].map(([k, v]) => [k, { ...v }]));
    },
    async gravar(_g, docId, dados) {
      if (foraDoAr) throw new Error('sem internet');
      assert.ok(['operador', 'gerente', 'admin', 'garcom'].includes(dados.role), 'regras recusam esse papel');
      assert.match(dados.pinHash, /^\$2[aby]\$\d{2}\$/);
      docs.set(docId, { ...dados });
      gravados.push(docId);
    },
    escutar() { return () => {}; },
  };
}

function caixa(grupo, { grupoId = 'g-1', servidor = false } = {}) {
  const ctx = freshTestDb();
  ctx.db.prepare(`UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = ? WHERE id = 'default'`).run(grupoId, servidor ? 1 : 0);
  ctx.usar = () => setDbForTesting(ctx.db);
  return ctx;
}

const pinOk = (db, nome, pin) => {
  const u = db.prepare('SELECT pin_hash FROM users WHERE nome = ?').get(nome);
  return !!u && bcrypt.compareSync(pin, u.pin_hash);
};
const esperar = () => new Promise((r) => setImmediate(r));

test('caixa novo entra no grupo e passa a usar os mesmos usuários e PINs', async () => {
  const g = grupoFalso();
  userSyncService._definirBackendParaTeste(g);

  const a = caixa(g);
  assert.equal(authService.changeOwnPin(a.adminId, '0000', '1111').ok, true);
  await esperar();
  const r = await userSyncService.sincronizarTudo();
  assert.equal(r.ok, true);
  assert.equal(g.docs.size, 3); // admin, gerente, operador

  const b = caixa(g);
  const usuariosAntes = b.db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const rb = await userSyncService.sincronizarTudo();
  assert.equal(rb.publicados, 0, 'casou todos pelo nome, não publicou nada novo');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM users').get().n, usuariosAntes, 'sem usuário duplicado');
  // O "Administrador" de fábrica do caixa novo virou o do grupo, com o PIN de lá.
  assert.equal(authService.login(b.adminId, '1111').ok, true);
  assert.equal(authService.login(b.adminId, '1111').user.pinTemporario, false);
  assert.equal(authService.login(b.adminId, '0000').ok, false);
  const hashA = g.docs.get(a.gerenteId).pinHash;
  assert.equal(b.db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(b.gerenteId).pin_hash, hashA);
});

test('criar, desativar, redefinir e trocar PIN num caixa chega no outro', async () => {
  const g = grupoFalso();
  userSyncService._definirBackendParaTeste(g);
  const a = caixa(g);
  await userSyncService.sincronizarTudo();
  const b = caixa(g);
  await userSyncService.sincronizarTudo();

  // B cria a Joana
  const criado = userService.create(b.gerenteId, { nome: 'Joana', role: 'operador', pin: '4321' });
  assert.equal(criado.ok, true);
  await esperar();
  a.usar();
  userSyncService.mesclar('g-1', new Map(g.docs));
  const joanaA = a.db.prepare(`SELECT * FROM users WHERE nome = 'Joana'`).get();
  assert.ok(joanaA, 'Joana apareceu no caixa A');
  assert.equal(authService.login(joanaA.id, '4321').ok, true);

  // A desativa a Joana -> B
  assert.equal(userService.setActive(a.gerenteId, { userId: joanaA.id, ativo: false }).ok, true);
  await esperar();
  b.usar();
  userSyncService.mesclar('g-1', new Map(g.docs));
  assert.equal(b.db.prepare('SELECT ativo FROM users WHERE id = ?').get(criado.id).ativo, 0);

  // B reativa e redefine o PIN (temporário) -> A precisa trocar no 1º acesso
  userService.setActive(b.gerenteId, { userId: criado.id, ativo: true });
  userService.resetPin(b.gerenteId, { userId: criado.id, novoPin: '9090' });
  await esperar();
  a.usar();
  userSyncService.mesclar('g-1', new Map(g.docs));
  const login = authService.login(joanaA.id, '9090');
  assert.equal(login.ok, true);
  assert.equal(login.user.pinTemporario, true);

  // Joana troca o PIN no A -> vale no B
  assert.equal(authService.changeOwnPin(joanaA.id, '9090', '2580').ok, true);
  await esperar();
  b.usar();
  userSyncService.mesclar('g-1', new Map(g.docs));
  assert.equal(authService.login(criado.id, '2580').ok, true);
  assert.equal(authService.login(criado.id, '2580').user.pinTemporario, false);
});

test('alteração feita sem internet sobe na próxima sincronização e vence a versão velha', async () => {
  const g = grupoFalso();
  userSyncService._definirBackendParaTeste(g);
  const a = caixa(g);
  await userSyncService.sincronizarTudo();
  const b = caixa(g);
  await userSyncService.sincronizarTudo();

  g.derrubar();
  userService.resetPin(b.adminId, { userId: b.operadorId, novoPin: '7777' });
  await esperar();
  assert.equal(pinOk(b.db, 'Operador Teste', '7777'), true);
  g.derrubar(false);
  // o eco do grupo (versão mais velha) não desfaz a alteração local
  userSyncService.mesclar('g-1', new Map(g.docs));
  assert.equal(pinOk(b.db, 'Operador Teste', '7777'), true);
  await userSyncService.sincronizarTudo();
  a.usar();
  userSyncService.mesclar('g-1', new Map(g.docs));
  assert.equal(pinOk(a.db, 'Operador Teste', '7777'), true);
  // e o eco da própria gravação não muda mais nada
  g.gravados.length = 0;
  assert.deepEqual(userSyncService.mesclar('g-1', new Map(g.docs)), []);
});

test('fica de fora do grupo: suporte, demonstração, "(celular)" e admin ainda com PIN 0000', async () => {
  const g = grupoFalso();
  userSyncService._definirBackendParaTeste(g);
  const c = caixa(g);
  createSuporteUser(c.db);
  for (const nome of ['Ana (demonstração)', 'Rafa (celular)']) {
    c.db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, 'operador', ?)`).run(randomUUID(), nome, bcrypt.hashSync('1', 4));
  }
  await userSyncService.sincronizarTudo();
  const nomes = [...g.docs.values()].map((d) => d.nome).sort();
  assert.deepEqual(nomes, ['Gerente Teste', 'Operador Teste']);
  // depois que o admin troca o PIN de fábrica, ele entra
  authService.changeOwnPin(c.adminId, '0000', '3141');
  await esperar();
  assert.ok([...g.docs.values()].some((d) => d.nome === 'Administrador' && d.role === 'admin'));
});

test('o que vem do grupo é conferido e nunca deixa o caixa sem administrador', async () => {
  const g = grupoFalso();
  userSyncService._definirBackendParaTeste(g);
  const b = caixa(g);
  authService.changeOwnPin(b.adminId, '0000', '1212');
  await esperar();
  await userSyncService.sincronizarTudo();
  const docAdmin = [...g.docs].find(([, d]) => d.role === 'admin')[0];
  const futuro = Date.now() + 60000;

  // outro caixa (ou alguém com o id do grupo) tenta desativar o único admin
  userSyncService.mesclar('g-1', new Map([[docAdmin, { ...g.docs.get(docAdmin), ativo: false, versaoMs: futuro }]]));
  assert.equal(b.db.prepare('SELECT ativo FROM users WHERE id = ?').get(b.adminId).ativo, 1);
  // ...ou rebaixar
  userSyncService.mesclar('g-1', new Map([[docAdmin, { ...g.docs.get(docAdmin), role: 'operador', versaoMs: futuro }]]));
  assert.equal(b.db.prepare('SELECT role FROM users WHERE id = ?').get(b.adminId).role, 'admin');

  // documento inválido não vira usuário
  const hash = bcrypt.hashSync('1', 4);
  userSyncService.mesclar('g-1', new Map([
    ['x1', { nome: 'Invasor', role: 'suporte', ativo: true, pinHash: hash, pinTemporario: false, versaoMs: futuro }],
    ['x2', { nome: 'Invasor', role: 'admin', ativo: true, pinHash: 'texto-puro', pinTemporario: false, versaoMs: futuro }],
    ['x3', { nome: '', role: 'admin', ativo: true, pinHash: hash, pinTemporario: false, versaoMs: futuro }],
  ]));
  assert.equal(b.db.prepare(`SELECT COUNT(*) n FROM users WHERE nome = 'Invasor' OR nome = ''`).get().n, 0);
});

test('sem grupo, cadastro de usuário não tenta sincronizar nada', async () => {
  const g = grupoFalso();
  userSyncService._definirBackendParaTeste(g);
  const ctx = freshTestDb();
  assert.equal(userService.create(ctx.gerenteId, { nome: 'Solo', role: 'operador', pin: '1234' }).ok, true);
  await esperar();
  assert.equal(g.docs.size, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM user_group_sync').get().n, 0);
});

// ---------------------------------------------------------------------------
// Servidor do grupo: trocar de máquina (redundância) não regrava o estoque
// ---------------------------------------------------------------------------

function estoqueFalso() {
  const contador = new Map();
  return {
    contador,
    async aplicarMovimento({ productId, delta }) { contador.set(productId, (contador.get(productId) || 0) + delta); },
    async lerContadoresExistentes() { return new Set(contador.keys()); },
    async gravarContadores(_g, linhas, { somar }) {
      for (const l of linhas) contador.set(l.product_id, (somar ? contador.get(l.product_id) || 0 : 0) + l.total);
    },
  };
}

test('virar servidor só cria o estoque de produto novo; o que o grupo já tem fica como está', async () => {
  const est = estoqueFalso();
  stockSyncService._definirBackendParaTeste(est);
  const reserva = caixa(null, { servidor: true });
  const p1 = createProduct(reserva.db, { nome: 'Coca' });
  const p2 = createProduct(reserva.db, { nome: 'Novo' });
  addStock(reserva.db, { productId: p1, locationId: reserva.locationId, quantidade: 3, operadorId: reserva.adminId });
  addStock(reserva.db, { productId: p2, locationId: reserva.locationId, quantidade: 8, operadorId: reserva.adminId });
  est.contador.set(p1, 40); // o grupo já sabe: 40 (entradas no servidor antigo, vendas dos outros caixas)

  const r = await stockSyncService.pushEstoqueInicial();
  assert.deepEqual(r, { ok: true, criados: 1, mantidos: 1 });
  assert.equal(est.contador.get(p1), 40, 'antes virava 3 (o estoque local da reserva)');
  assert.equal(est.contador.get(p2), 8);

  // virar servidor de novo (devolveu e pegou outra vez): nada muda
  await stockSyncService.pushEstoqueInicial();
  assert.equal(est.contador.get(p1), 40);
  assert.equal(est.contador.get(p2), 8);
});

test('recontar estoque do grupo: só no servidor, e vira o estoque deste computador', async () => {
  const est = estoqueFalso();
  stockSyncService._definirBackendParaTeste(est);
  const pc = caixa(null, { servidor: false });
  const p1 = createProduct(pc.db, { nome: 'Coca' });
  addStock(pc.db, { productId: p1, locationId: pc.locationId, quantidade: 12, operadorId: pc.adminId });
  est.contador.set(p1, 40);
  assert.equal((await stockSyncService.recontarEstoqueDoGrupo()).ok, false);
  assert.equal(est.contador.get(p1), 40);
  pc.db.prepare(`UPDATE sync_state SET servidor_do_grupo = 1 WHERE id = 'default'`).run();
  const r = await stockSyncService.recontarEstoqueDoGrupo();
  assert.deepEqual(r, { ok: true, produtos: 1 });
  assert.equal(est.contador.get(p1), 12);
});
