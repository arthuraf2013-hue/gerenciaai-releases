// Caixas do grupo como extensão um do outro: produtos, clientes e fiado
// iguais em todos (grupoReplicaService), com o Firestore trocado por um falso.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { setDbForTesting } = require('../electron/db/database');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const replica = require('../electron/services/grupoReplicaService');
const productService = require('../electron/services/productService');
const customerService = require('../electron/services/customerService');

const CPF = '529.982.247-25';

function grupoFalso() {
  const colecoes = { produtos: new Map(), clientes: new Map(), fiado: new Map() };
  return {
    colecoes,
    async lerTodos(_g, c) { return new Map([...colecoes[c]].map(([k, v]) => [k, { ...v }])); },
    async gravarLote(_g, c, itens) { for (const { docId, dados } of itens) colecoes[c].set(docId, { ...dados }); },
    escutar() { return () => {}; },
  };
}

function caixa({ semGrupo = false } = {}) {
  replica.parar(); // cada caixa é um processo: começa sem ter juntado com o grupo
  const ctx = freshTestDb();
  ctx.entrarNoGrupo = () => ctx.db.prepare(`UPDATE sync_state SET grupo_sincronizacao_id = 'g-1' WHERE id = 'default'`).run();
  if (!semGrupo) ctx.entrarNoGrupo();
  ctx.usar = () => setDbForTesting(ctx.db);
  return ctx;
}

/** O que a escuta do caixa faria agora: tudo que está no grupo. */
function receberTudo(g) {
  for (const c of ['produtos', 'clientes', 'fiado']) replica.receber(c, 'g-1', new Map(g.colecoes[c]));
}

const produto = (db, filtro, ...args) => db.prepare(`SELECT * FROM products WHERE ${filtro}`).get(...args);
const contar = (db, sql, ...args) => db.prepare(sql).get(...args).n;

test('caixa novo recebe o catálogo do grupo sem duplicar o que já tinha (casa pelo código de barras)', async () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);

  const a = caixa();
  assert.equal(productService.upsert({ nome: 'Coca 2L', preco: 12, codigoBarras: '7894900011517' }).ok, true);
  assert.equal(productService.upsert({ nome: 'Pão francês', preco: 0.9, unidade: 'un' }).ok, true);
  await replica.sincronizarTudo();
  assert.equal(g.colecoes.produtos.size, 2);
  const docCoca = [...g.colecoes.produtos].find(([, d]) => d.codigoBarras === '7894900011517')[0];

  // O caixa B já tinha a Coca (outro id, preço velho) e um produto só dele,
  // de antes de entrar no grupo.
  const b = caixa({ semGrupo: true });
  productService.upsert({ nome: 'COCA COLA 2 LITROS', preco: 10, codigoBarras: '7894900011517' });
  productService.upsert({ nome: 'Água 500ml', preco: 3, codigoBarras: '7891234567895' });
  const cocaB = produto(b.db, 'codigo_barras = ?', '7894900011517').id;
  b.entrarNoGrupo();
  await replica.sincronizarTudo();

  assert.equal(contar(b.db, `SELECT COUNT(*) n FROM products WHERE codigo_barras = '7894900011517'`), 1, 'sem Coca duplicada');
  const coca = produto(b.db, 'id = ?', cocaB);
  assert.equal(coca.preco, 12, 'ficou com o cadastro do grupo');
  assert.equal(coca.nome, 'Coca 2L');
  assert.equal(replica.paraGrupo(cocaB), docCoca, 'o estoque do grupo usa o id do grupo');
  assert.ok(produto(b.db, `nome = 'Pão francês'`), 'recebeu o produto que não tinha');
  assert.equal(g.colecoes.produtos.size, 3, 'publicou só a Água (a Coca casou)');

  // A recebe a Água do B
  a.usar();
  receberTudo(g);
  assert.ok(produto(a.db, `codigo_barras = '7891234567895'`));
  assert.equal(contar(a.db, 'SELECT COUNT(*) n FROM products'), 3);
});

test('preço, cadastro e exclusão num caixa chegam no outro; o mais novo vence', async () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Coxinha', preco: 6 });
  await replica.sincronizarTudo();
  const b = caixa();
  await replica.sincronizarTudo();
  assert.equal(produto(b.db, 'id = ?', id).preco, 6);

  // A muda o preço (qualquer caminho: aqui, direto no banco -- o trigger pega)
  a.usar();
  a.db.prepare('UPDATE products SET preco = 7.5 WHERE id = ?').run(id);
  await replica.enviarPendentes();
  b.usar();
  receberTudo(g);
  assert.equal(produto(b.db, 'id = ?', id).preco, 7.5);
  assert.equal(contar(b.db, 'SELECT COUNT(*) n FROM grupo_replica_pendente'), 0, 'o que veio do grupo não volta para a fila');

  // B muda depois: vale o do B nos dois
  await new Promise((r) => setTimeout(r, 5));
  productService.upsert({ id, nome: 'Coxinha de frango', preco: 8 });
  await replica.enviarPendentes();
  a.usar();
  receberTudo(g);
  assert.equal(produto(a.db, 'id = ?', id).preco, 8);
  assert.equal(produto(a.db, 'id = ?', id).nome, 'Coxinha de frango');

  // A exclui: some do B também
  assert.equal(productService.deactivate(id).ok !== false, true);
  await replica.enviarPendentes();
  b.usar();
  receberTudo(g);
  assert.equal(produto(b.db, 'id = ?', id).ativo, 0);
});

test('dois caixas que cadastraram o mesmo produto antes de se verem ficam com um só', async () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  // Os dois entram no grupo ainda vazio e, cada um sem ver o outro (sem
  // internet), cadastra o mesmo produto.
  const a = caixa();
  await replica.sincronizarTudo();
  const b = caixa();
  await replica.sincronizarTudo();
  a.usar();
  productService.upsert({ nome: 'Guaraná', preco: 5, codigoBarras: '7891991000826' });
  await replica.enviarPendentes();
  b.usar();
  b.db.prepare(`INSERT INTO products (id, nome, preco, unidade, codigo_barras) VALUES (?, 'Guarana', 4.5, 'un', '7891991000826')`).run(randomUUID());
  await replica.enviarPendentes();
  assert.equal(g.colecoes.produtos.size, 2);

  // Agora os dois se veem
  receberTudo(g);
  a.usar();
  receberTudo(g);
  b.usar();
  receberTudo(g);
  const docsVivos = [...g.colecoes.produtos].filter(([, d]) => !d.excluido).map(([id]) => id);
  assert.equal(docsVivos.length, 1, 'um documento vira lápide');
  for (const ctx of [a, b]) {
    ctx.usar();
    assert.equal(contar(ctx.db, `SELECT COUNT(*) n FROM products WHERE codigo_barras = '7891991000826' AND ativo = 1`), 1);
    const local = produto(ctx.db, `codigo_barras = '7891991000826'`).id;
    assert.equal(replica.paraGrupo(local), docsVivos[0], 'os dois caixas usam o mesmo contador de estoque');
  }
});

test('clientes e fiado iguais em todos os caixas: o cliente paga em qualquer um', async () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  const a = caixa();
  const { id: mariaA } = customerService.upsert({ nome: 'Maria Souza', cpf: CPF, telefone: '81 99999-0000' });
  customerService.registrarDivida({ customerId: mariaA, valor: 50, saleId: null, operadorId: a.operadorId });
  await replica.sincronizarTudo();
  assert.equal(g.colecoes.clientes.size, 1);
  assert.equal(g.colecoes.fiado.size, 1);

  const b = caixa({ semGrupo: true });
  // B já tinha a Maria (mesmo CPF), com outra dívida de 30
  const { id: mariaB } = customerService.upsert({ nome: 'Maria', cpf: CPF });
  customerService.registrarDivida({ customerId: mariaB, valor: 30, saleId: null, operadorId: b.operadorId });
  b.entrarNoGrupo();
  await replica.sincronizarTudo();
  assert.equal(contar(b.db, 'SELECT COUNT(*) n FROM customers'), 1, 'casou pelo CPF');
  assert.equal(customerService.getSaldoFiado(mariaB), 80);

  // A recebe a dívida feita no B; B recebe um pagamento feito no A
  a.usar();
  receberTudo(g);
  assert.equal(customerService.getSaldoFiado(mariaA), 80);
  assert.equal(customerService.registrarPagamento({ customerId: mariaA, valor: 20, operadorId: a.operadorId }).ok, true);
  await replica.enviarPendentes();
  b.usar();
  receberTudo(g);
  assert.equal(customerService.getSaldoFiado(mariaB), 60);
  // receber de novo não duplica
  receberTudo(g);
  assert.equal(customerService.getSaldoFiado(mariaB), 60);
  const lancamentoDeFora = b.db.prepare(`SELECT * FROM customer_credit_movements WHERE tipo = 'pagamento'`).get();
  assert.equal(lancamentoDeFora.sale_id, null);
  assert.match(lancamentoDeFora.motivo, /caixa|outro caixa/);

  // limite de fiado definido no A vale no B
  a.usar();
  customerService.definirLimiteFiado({ customerId: mariaA, limite: 100, operadorId: a.adminId });
  await replica.enviarPendentes();
  b.usar();
  receberTudo(g);
  assert.equal(b.db.prepare('SELECT limite_fiado FROM customers WHERE id = ?').get(mariaB).limite_fiado, 100);
});

test('lançamento do fiado que chega antes do cliente espera o cliente', () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  const b = caixa();
  const fiado = new Map([['f-1', { clienteDoc: 'cli-x', tipo: 'divida', valor: 15, criadoEm: '2026-11-15 10:00:00' }]]);
  replica.receber('fiado', 'g-1', fiado);
  assert.equal(customerService.getSaldoFiado('cli-x'), 0);
  replica.receber('clientes', 'g-1', new Map([['cli-x', { nome: 'João', ativo: true, versaoMs: Date.now() }]]));
  assert.equal(customerService.getSaldoFiado('cli-x'), 15, 'entrou quando o cliente chegou');
});

test('caixa que acabou de entrar não publica a cópia dele antes de casar com o grupo', async () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  replica.parar();
  const a = caixa();
  productService.upsert({ nome: 'Coca 2L', preco: 12, codigoBarras: '7894900011517' });
  await replica.sincronizarTudo();
  replica.parar(); // o "computador" B é outro processo
  const b = caixa({ semGrupo: true });
  productService.upsert({ nome: 'Coca velha', preco: 10, codigoBarras: '7894900011517' });
  b.entrarNoGrupo();
  // Alguém edita um produto no B enquanto ele ainda está juntando: nada sai.
  productService.upsert({ nome: 'Água', preco: 3 });
  assert.equal((await replica.enviarPendentes()).esperando, true);
  assert.equal(g.colecoes.produtos.size, 1);
  await replica.sincronizarTudo();
  assert.equal(g.colecoes.produtos.size, 2, 'só a Água entrou; a Coca casou com a do grupo');
  assert.equal(produto(b.db, `codigo_barras = '7894900011517'`).preco, 12, 'vale o preço do grupo');
});

test('documento estranho do grupo não entra', () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  const b = caixa();
  replica.mesclar('produtos', 'g-1', new Map([
    ['p-1', { nome: '', preco: 1, versaoMs: 5 }],
    ['p-2', { nome: 'X', preco: -3, versaoMs: 5 }],
    ['p-3', { nome: 'Sem preço', versaoMs: 5 }],
  ]));
  assert.equal(contar(b.db, 'SELECT COUNT(*) n FROM products'), 0);
  replica.receberFiado('g-1', new Map([
    ['f-1', { clienteDoc: 'c', tipo: 'presente', valor: 10 }],
    ['f-2', { clienteDoc: 'c', tipo: 'divida', valor: -10 }],
  ]));
  assert.equal(contar(b.db, 'SELECT COUNT(*) n FROM customer_credit_movements'), 0);
});

test('sem grupo, nada vai para lugar nenhum', async () => {
  const g = grupoFalso();
  replica._definirBackendParaTeste(g);
  replica.parar();
  freshTestDb();
  productService.upsert({ nome: 'Solo', preco: 1 });
  assert.deepEqual(await replica.enviarPendentes(), { ok: true, grupo: false });
  assert.equal(g.colecoes.produtos.size, 0);
});

test('mesclar produtos leva TODO o histórico (antes falhava se o produto estava em pedido de compra, orçamento...)', () => {
  const { db, adminId } = freshTestDb();
  const manter = createProduct(db, { nome: 'Coca' });
  const remover = createProduct(db, { nome: 'Coca (duplicado)' });
  db.prepare(`INSERT INTO product_cost_history (id, product_id, tipo, qtd_antes, custo_antes, qtd_movimento, custo_movimento, custo_depois, origem)
              VALUES (?, ?, 'entrada', 0, 1, 5, 2, 2, 'abastecimento')`).run(randomUUID(), remover);
  const r = productService.mergeProducts({ manterId: manter, removerId: remover, currentOperatorId: adminId });
  assert.equal(r.ok, true, r.error);
  assert.equal(contar(db, 'SELECT COUNT(*) n FROM products WHERE id = ?', remover), 0);
  assert.equal(contar(db, 'SELECT COUNT(*) n FROM product_cost_history WHERE product_id = ?', manter), 1);
});

test('fila do grupo esvazia depois de enviar e salvar muitos produtos não multiplica as gravações (cota do Firestore)', async () => {
  let gravacoes = 0;
  const g = grupoFalso();
  const gravar = g.gravarLote;
  g.gravarLote = async (grupo, c, itens) => { gravacoes += itens.length; return gravar(grupo, c, itens); };
  replica._definirBackendParaTeste(g);
  const a = caixa();
  // Cada upsert também pede um envio (productSyncService.pushProduct), todos juntos.
  for (let i = 0; i < 30; i++) productService.upsert({ nome: `Produto ${i}`, preco: i + 1 });
  await replica.sincronizarTudo();
  await new Promise((ok) => setImmediate(ok));
  await replica.enviarPendentes();
  assert.equal(contar(a.db, 'SELECT COUNT(*) n FROM grupo_replica_pendente'), 0, 'a fila esvaziou');
  assert.equal(gravacoes, 30, 'cada produto gravado uma vez');
  for (let i = 0; i < 3; i++) await replica.enviarPendentes();
  assert.equal(gravacoes, 30, 'nada reenviado nos ciclos seguintes');
});
