const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { freshTestDb, createProduct } = require('./helpers/testDb');

// Mesa compartilhada: o servidor do grupo num processo (banco próprio, as
// mesas são dele) e este caixa aqui, ligado pela rede local na própria máquina.
const G = 'grupo-mesa-compartilhada-01';
let filho;
const fila = [];
const esperando = [];
function proxima() {
  if (fila.length) return Promise.resolve(fila.shift());
  return new Promise((r) => esperando.push(r));
}
async function servidor(c) { filho.stdin.write(JSON.stringify(c) + '\n'); return (await proxima()).r; }
const sqlNoServidor = (sql, ...params) => servidor({ cmd: 'sql', sql, params });

let S; // { porta, codigo, mesas, ids, locationId } do servidor
let db; let local;
const mc = require('../electron/services/mesaCompartilhadaService');
const cliente = require('../electron/services/lanClienteService');
const saleService = require('../electron/services/saleService');
const cashService = require('../electron/services/cashService');

// Timer ativo: as esperas de rede usam unref (sem isso o teste acaba no meio).
const manterVivo = setInterval(() => {}, 1000);

test.before(async () => {
  filho = spawn(process.execPath, [path.join(__dirname, 'helpers', 'mesaServidorFilho.js')], {
    env: { ...process.env, GRUPO_TESTE: G }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  filho.stdout.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (esperando.length) esperando.shift()(l); else fila.push(l);
    }
  });
  S = await proxima();

  ({ db } = freshTestDb());
  local = {};
  db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = 0 WHERE id = ?').run(G, 'default');
  require('../electron/services/pdvRegistryService').getOrCreateDeviceUid = () => 'caixa-mesa-0002';
  const usuario = (id, nome, role, pin, doc) => {
    db.prepare('INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, ?, ?)').run(id, nome, role, bcrypt.hashSync(pin, 4));
    db.prepare('INSERT INTO user_group_sync (user_id, grupo_id, doc_id, versao_ms) VALUES (?, ?, ?, 1)').run(id, G, doc);
  };
  usuario('cx-operador', 'Geyse', 'operador', '1111', 'doc-operador');
  usuario('cx-gerente', 'Gerente', 'gerente', '2222', 'doc-gerente');
  const produto = (nome, preco, doc) => {
    const id = createProduct(db, { nome, preco });
    db.prepare(`INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id, versao_ms) VALUES ('produtos', ?, ?, ?, 1)`).run(id, G, doc);
    return id;
  };
  local.suco = produto('Suco', 8, 'doc-suco');
  local.caldinho = produto('Caldinho de charque', 12, 'doc-caldinho');
  local.agua = produto('Água', 4, 'doc-agua');
  db.prepare(`INSERT INTO customers (id, nome) VALUES ('cx-cliente', 'Maria')`).run();
  db.prepare(`INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id, versao_ms) VALUES ('clientes', 'cx-cliente', ?, 'doc-maria', 1)`).run(G);
  local.locationId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

  const r = await cliente.parear({ codigo: S.codigo, endereco: `127.0.0.1:${S.porta}` });
  assert.equal(r.ok, true, r.error);
});
test.after(() => { clearInterval(manterVivo); mc.pararEscuta(); filho?.kill(); });

const chamar = (canal, args, usuario = 'cx-operador') => mc.chamar(canal, args, usuario);
const mesaDoServidor = async (id) => (await sqlNoServidor('SELECT * FROM restaurant_tables WHERE id = ?', id))[0];

test('caixa ligado: as mesas que aparecem são as do servidor', async () => {
  assert.equal(mc.ativa(), true);
  const st = await mc.status();
  assert.equal(st.online, true, st.erro);
  assert.equal(st.servidor, 'PDV1-SERVIDOR');
  assert.equal(st.motivo, null, 'caixa ligado e usando as mesas do servidor: sem aviso');
  const lista = await chamar('table:list', { locationId: 'ignorado' });
  assert.deepEqual(lista.map((m) => m.numero), ['1', '2', '3', '4']);
  assert.ok(lista.every((m) => m.status === 'livre' && m.fechando_aqui === false));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM restaurant_tables').get().c, 0, 'nada de mesa criada neste caixa');
});

test('abrir, lançar, mudar e cancelar item pelo caixa: tudo acontece no servidor, com os ids de lá', async () => {
  const aberta = await chamar('table:open', { tableId: S.mesas['1'], pessoas: 2, operadorId: 'qualquer' });
  assert.equal(aberta.ok, true, aberta.error);
  const venda = (await sqlNoServidor('SELECT * FROM sales WHERE id = ?', aberta.saleId))[0];
  assert.equal(venda.operador_id, 'srv-operador', 'quem abriu é o usuário logado no caixa, no id do servidor');

  let r = await chamar('sale:addItem', { saleId: aberta.saleId, productId: local.caldinho, quantidade: 2, pessoaNumero: 1, deviceId: 'cx' });
  assert.equal(r.ok, true, r.error);
  const itemCaldinho = r.itemId;
  r = await chamar('sale:addItem', { saleId: aberta.saleId, productId: local.suco, quantidade: 1, pessoaNumero: 2, deviceId: 'cx' });
  assert.equal(r.ok, true, r.error);
  r = await chamar('sale:addItem', { saleId: aberta.saleId, productId: local.agua, quantidade: 1, deviceId: 'cx' });
  const itemAgua = r.itemId;
  const itens = await sqlNoServidor('SELECT product_id, quantidade FROM sale_items WHERE sale_id = ? ORDER BY rowid', aberta.saleId);
  assert.deepEqual(itens.map((i) => i.product_id), [S.ids.caldinho, S.ids.suco, S.ids.agua]);
  const estoqueNoServidor = (await sqlNoServidor('SELECT SUM(quantidade) AS t FROM stock_movements WHERE product_id = ?', S.ids.caldinho))[0].t;
  assert.equal(estoqueNoServidor, 48, 'estoque local baixou no servidor (onde a cozinha está)');

  assert.equal((await chamar('sale:setItemNote', { saleItemId: itemCaldinho, observacao: 'sem pimenta' })).ok, true);
  r = await chamar('table:renomearPessoa', { tableId: S.mesas['1'], numero: 1, nome: 'Ana' });
  assert.equal(r.ok, true, r.error);
  r = await chamar('table:vincularCliente', { tableId: S.mesas['1'], numero: 2, customerId: 'cx-cliente' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pessoas[1].clienteId, 'cx-cliente', 'cliente volta com o id deste caixa');
  assert.equal((await sqlNoServidor('SELECT customer_id FROM sale_people WHERE sale_id = ? AND numero = 2', aberta.saleId))[0].customer_id, 'srv-cliente');

  r = await chamar('sale:cancelItem', { saleId: aberta.saleId, saleItemId: itemAgua, candidateManagerId: 'cx-gerente', pin: '2222', motivo: 'pediu errado', deviceId: 'cx' });
  assert.equal(r.ok, true, r.error);
  const cart = await chamar('table:getCart', { saleId: aberta.saleId });
  assert.deepEqual(cart.items.map((i) => i.nome), ['Caldinho de charque', 'Suco']);
  assert.equal(cart.total, 32);
  assert.equal(cart.pessoas[0].nome, 'Ana');
  assert.equal(cart.items[0].observacao, 'sem pimenta');

  const lista = await chamar('table:list', {});
  assert.equal(lista.find((m) => m.id === S.mesas['1']).status, 'ocupada');
});

test('caixa não mexe em venda que não é de mesa, nem cria mesa sem ser gerente', async () => {
  const r = await chamar('sale:addItem', { saleId: 'venda-qualquer', productId: local.suco, quantidade: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /não é de uma mesa/);
  const c = await chamar('table:create', { numero: '99' });
  assert.equal(c.ok, false);
  assert.match(c.error, /permissão/);
  const g = await chamar('table:create', { numero: '99' }, 'cx-gerente');
  assert.equal(g.ok, true, g.error);
  assert.equal((await chamar('table:delete', { tableId: g.id }, 'cx-gerente')).ok, true);
});

test('produto que ainda não chegou no servidor: aviso claro, nada lançado', async () => {
  const novo = createProduct(db, { nome: 'Novidade', preco: 5 });
  const saleId = (await mesaDoServidor(S.mesas['1'])).sale_id;
  const r = await chamar('sale:addItem', { saleId, productId: novo, quantidade: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ainda não chegou no servidor/);
});

let vendaServidor1; let vendaLocal1;

test('fechar a conta no caixa: a mesa trava no servidor e a conta vem para cá, sem mexer no estoque daqui', async () => {
  vendaServidor1 = (await mesaDoServidor(S.mesas['1'])).sale_id;
  const r = await mc.puxarParaPagar({ tableId: S.mesas['1'], usuarioId: 'cx-operador' });
  assert.equal(r.ok, true, r.error);
  vendaLocal1 = r.saleId;
  assert.equal(r.rotulo, 'Mesa 1');
  const mesa = await mesaDoServidor(S.mesas['1']);
  assert.equal(mesa.fechando_caixa_id, 'caixa-mesa-0002');
  assert.ok(mesa.fechando_caixa_nome);

  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(vendaLocal1);
  assert.equal(venda.status, 'aberta');
  assert.equal(venda.total, 32);
  assert.equal(venda.operador_id, 'cx-operador');
  const itens = db.prepare('SELECT product_id, quantidade, preco_unitario, pessoa_numero, observacao, enviado_cozinha FROM sale_items WHERE sale_id = ? ORDER BY rowid').all(vendaLocal1);
  assert.deepEqual(itens.map((i) => i.product_id), [local.caldinho, local.suco], 'produtos com os ids deste caixa');
  assert.equal(itens[0].observacao, 'sem pimenta');
  assert.equal(itens[0].enviado_cozinha, 1, 'a cozinha já recebeu (no servidor): não sai de novo');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM stock_movements WHERE sale_id = ?').get(vendaLocal1).c, 0);
  const pessoas = db.prepare('SELECT numero, nome, customer_id FROM sale_people WHERE sale_id = ? ORDER BY numero').all(vendaLocal1);
  assert.deepEqual(pessoas.map((p) => [p.numero, p.nome, p.customer_id]), [[1, 'Ana', null], [2, 'Maria', 'cx-cliente']]);
  assert.equal(db.prepare('SELECT numero FROM sale_mesas WHERE sale_id = ? AND principal = 1').get(vendaLocal1).numero, '1');
  const balcao = saleService.getOrOpenCurrentSale({ locationId: local.locationId, operadorId: 'cx-operador' });
  assert.notEqual(balcao.saleId, vendaLocal1, 'a conta trazida não vira o carrinho do balcão');
  const cozinhaDaqui = require('../electron/services/kitchenService').listActiveItems(local.locationId);
  assert.ok(!cozinhaDaqui.some((i) => i.sale_id === vendaLocal1), 'nem aparece na cozinha deste caixa');

  const lista = await chamar('table:list', {});
  const m1 = lista.find((m) => m.id === S.mesas['1']);
  assert.equal(m1.fechando_aqui, true);
  assert.equal(m1.venda_local_id, vendaLocal1, 'voltar à mesa retoma a mesma conta');
  const de2 = await mc.puxarParaPagar({ tableId: S.mesas['1'], usuarioId: 'cx-operador' });
  assert.equal(de2.saleId, vendaLocal1, 'pedir de novo não duplica a conta');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM mesa_remota_fechamentos').get().c, 1);
});

test('mesa travada: ninguém mexe nela (caixa, tela do servidor, celular)', async () => {
  let r = await chamar('sale:addItem', { saleId: vendaServidor1, productId: local.suco, quantidade: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /sendo paga no/);
  r = await chamar('table:transfer', { fromTableId: S.mesas['1'], toTableId: S.mesas['3'] });
  assert.equal(r.ok, false);
  const tela = await servidor({ cmd: 'trava', canal: 'sale:addPayment', payload: { saleId: vendaServidor1, metodo: 'dinheiro', valor: 32 } });
  assert.equal(tela.ok, false, 'receber no servidor a conta que o caixa está recebendo cobraria duas vezes');
  assert.match(tela.error, /Mesa 1 está sendo paga/);
  assert.equal((await servidor({ cmd: 'trava', canal: 'table:list', payload: {} })), null, 'ver a lista continua normal');
  assert.match(await servidor({ cmd: 'celular', dados: { tipo: 'lancar', mesaId: S.mesas['1'] } }), /sendo paga/);
  assert.equal(await servidor({ cmd: 'celular', dados: { tipo: 'lancar', mesaId: S.mesas['2'] } }), null);
  // Leitura continua passando (a tela do caixa mostra a comanda).
  assert.equal((await chamar('table:getCart', { saleId: vendaServidor1 })).total, 32);
});

test('recebeu no caixa: venda daqui finalizada, a do servidor vira "transferida" e a mesa é liberada', async () => {
  // Pedido pelo QR durante o pagamento (não passa pela trava): não pode sumir.
  const qr = await servidor({ cmd: 'addItemDireto', args: { saleId: vendaServidor1, productId: S.ids.suco, quantidade: 1 } });
  assert.equal(qr.ok, true, qr.error);

  cashService.openSession({ locationId: local.locationId, operadorId: 'cx-operador', valorAbertura: 0 });
  assert.equal(saleService.addPayment({ saleId: vendaLocal1, metodo: 'dinheiro', valor: 32 }).ok, true);
  assert.equal(saleService.finalizeSale(vendaLocal1).ok, true);
  mc.aoFinalizarVenda(vendaLocal1);
  await mc.processarFila();

  const f = db.prepare('SELECT * FROM mesa_remota_fechamentos WHERE sale_id = ?').get(vendaLocal1);
  assert.equal(f.estado, 'feito', f.erro);
  assert.match(f.aviso, /1 item/);
  const velha = (await sqlNoServidor('SELECT status, transferida_para_venda_id, total FROM sales WHERE id = ?', vendaServidor1))[0];
  assert.equal(velha.status, 'transferida');
  assert.equal(velha.transferida_para_venda_id, vendaLocal1);
  assert.equal(velha.total, 32);
  const mesa = await mesaDoServidor(S.mesas['1']);
  assert.equal(mesa.fechando_caixa_id, null);
  assert.equal(mesa.status, 'ocupada', 'o suco do QR ficou numa comanda nova na mesa');
  assert.notEqual(mesa.sale_id, vendaServidor1);
  const nova = await sqlNoServidor('SELECT product_id FROM sale_items WHERE sale_id = ? AND cancelado = 0', mesa.sale_id);
  assert.deepEqual(nova.map((i) => i.product_id), [S.ids.suco]);
  const resumo = (await sqlNoServidor(`SELECT COUNT(*) AS c FROM sales WHERE status = 'finalizada'`))[0].c;
  assert.equal(resumo, 0, 'no servidor nada conta como venda (relatórios só contam finalizada)');
  const caixa = cashService.getSessionSummary(cashService.getOpenSession(local.locationId).id);
  assert.equal(caixa.porMetodo.find((m) => m.metodo === 'dinheiro').total, 32, 'o dinheiro entrou no caixa que recebeu');
  const auditoria = await sqlNoServidor(`SELECT tipo_evento FROM audit_log WHERE sale_id = ? ORDER BY rowid`, vendaServidor1);
  assert.ok(auditoria.some((a) => a.tipo_evento === 'mesa_fechada_em_outro_caixa'));

  // Repetir (resposta perdida) não faz nada de novo.
  db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'concluir' WHERE sale_id = ?`).run(vendaLocal1);
  await mc.processarFila();
  assert.equal(db.prepare('SELECT estado FROM mesa_remota_fechamentos WHERE sale_id = ?').get(vendaLocal1).estado, 'feito');
  assert.equal((await sqlNoServidor(`SELECT COUNT(*) AS c FROM sales WHERE status = 'transferida'`))[0].c, 1);
});

test('desistiu de receber (sem pagamento): a cópia some daqui e a mesa destrava no servidor', async () => {
  const aberta = await chamar('table:open', { tableId: S.mesas['2'] });
  await chamar('sale:addItem', { saleId: aberta.saleId, productId: local.suco, quantidade: 3 });
  const r = await mc.puxarParaPagar({ tableId: S.mesas['2'], usuarioId: 'cx-operador' });
  assert.equal(r.ok, true, r.error);
  assert.equal((await mesaDoServidor(S.mesas['2'])).fechando_caixa_id, 'caixa-mesa-0002');

  saleService.addPayment({ saleId: r.saleId, metodo: 'dinheiro', valor: 5 });
  const comPagamento = await mc.devolverMesa({ saleId: r.saleId });
  assert.equal(comPagamento.ok, false, 'já recebeu parte aqui: termina aqui');
  db.prepare('DELETE FROM payments WHERE sale_id = ?').run(r.saleId);

  const d = await mc.devolverMesa({ saleId: r.saleId });
  assert.equal(d.ok, true, d.error);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sales WHERE id = ?').get(r.saleId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE sale_id = ?').get(r.saleId).c, 0);
  const mesa = await mesaDoServidor(S.mesas['2']);
  assert.equal(mesa.fechando_caixa_id, null);
  assert.equal(mesa.sale_id, aberta.saleId, 'a comanda continua no servidor, intacta');
  assert.equal((await chamar('sale:addItem', { saleId: aberta.saleId, productId: local.agua, quantidade: 1 })).ok, true, 'e volta a aceitar pedido');
});

test('mesa com pagamento já recebido no servidor: fecha lá (o dinheiro tem que bater com quem recebeu)', async () => {
  const saleId = (await mesaDoServidor(S.mesas['2'])).sale_id;
  await servidor({ cmd: 'pagarAqui', saleId, valor: 10 });
  const r = await mc.puxarParaPagar({ tableId: S.mesas['2'], usuarioId: 'cx-operador' });
  assert.equal(r.ok, false);
  assert.match(r.error, /já tem pagamento recebido no servidor/);
  assert.equal((await mesaDoServidor(S.mesas['2'])).fechando_caixa_id, null, 'não ficou travada');
});

test('gerente do servidor destrava mesa presa; caixa que recebe depois avisa do conflito', async () => {
  const aberta = await chamar('table:open', { tableId: S.mesas['3'] });
  await chamar('sale:addItem', { saleId: aberta.saleId, productId: local.caldinho, quantidade: 1 });
  const r = await mc.puxarParaPagar({ tableId: S.mesas['3'], usuarioId: 'cx-operador' });
  assert.equal(r.ok, true, r.error);
  assert.equal((await servidor({ cmd: 'destravar', tableId: S.mesas['3'] })).ok, true);
  assert.equal((await mesaDoServidor(S.mesas['3'])).fechando_caixa_id, null);
  // O servidor cancela a mesa (achou que o caixa tinha desistido)...
  await servidor({ cmd: 'run', sql: `UPDATE sales SET status = 'cancelada' WHERE id = ?`, params: [aberta.saleId] });
  // ... mas o caixa recebeu.
  saleService.addPayment({ saleId: r.saleId, metodo: 'dinheiro', valor: 12 });
  assert.equal(saleService.finalizeSale(r.saleId).ok, true);
  mc.aoFinalizarVenda(r.saleId);
  await mc.processarFila();
  const f = db.prepare('SELECT estado, aviso FROM mesa_remota_fechamentos WHERE sale_id = ?').get(r.saleId);
  assert.equal(f.estado, 'feito');
  assert.match(f.aviso, /também foi cancelada no servidor/);
});

test('telas do caixa ficam sabendo na hora quando uma mesa muda no servidor', async () => {
  const { versao } = await cliente.pedido('/v1/mesas/versao', { desde: -1, esperarMs: 0 });
  const esperando = cliente.pedido('/v1/mesas/versao', { desde: versao, esperarMs: 8000 }, { timeoutMs: 15000 });
  await new Promise((ok) => setTimeout(ok, 300));
  await servidor({ cmd: 'run', sql: `UPDATE restaurant_tables SET nome = 'Varanda' WHERE id = ?`, params: [S.mesas['4']] });
  const inicio = Date.now();
  const r = await esperando;
  assert.ok(r.versao > versao);
  assert.ok(Date.now() - inicio < 3000, 'avisou logo, sem esperar o tempo todo');
});

test('"só deste caixa": volta a usar as mesas locais', async () => {
  mc.definirModo('local');
  assert.equal(mc.ativa(), false);
  const r = await chamar('table:list', {});
  assert.equal(r.ok, false);
  mc.definirModo('servidor');
  assert.equal(mc.ativa(), true);
});

test('banco antigo: o CHECK de sales.status passa a aceitar "transferida" sem perder venda, índice nem gatilho', () => {
  const fs = require('fs');
  const { atualizarCheckStatusDeVendasParaIncluirTransferida } = require('../electron/db/database');
  const velho = new Database(':memory:');
  velho.function('NOW_SYNCED', () => '2026-11-19 12:00:00');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'electron', 'db', 'schema.sql'), 'utf8')
    .replace("CHECK (status IN ('aberta','finalizada','cancelada','transferida'))", "CHECK (status IN ('aberta','finalizada','cancelada'))");
  velho.exec(schema);
  velho.pragma('foreign_keys = ON');
  velho.exec(`ALTER TABLE sales ADD COLUMN coluna_nova_qualquer TEXT DEFAULT 'x'`);
  const loc = velho.prepare('SELECT id FROM locations LIMIT 1').get()?.id || 'loc';
  if (!velho.prepare('SELECT 1 FROM locations').get()) velho.prepare(`INSERT INTO locations (id, nome) VALUES ('loc', 'Loja')`).run();
  velho.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES ('u1', 'U', 'admin', 'x')`).run();
  velho.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES ('v1', ?, 'u1', 'finalizada', 10)`).run(loc);
  velho.prepare(`INSERT INTO products (id, nome, preco) VALUES ('p1', 'P', 10)`).run();
  velho.prepare(`INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES ('i1', 'v1', 'p1', 1, 10)`).run();
  assert.throws(() => velho.prepare(`INSERT INTO sales (id, location_id, operador_id, status) VALUES ('t0', ?, 'u1', 'transferida')`).run(loc), /CHECK/);
  const indicesAntes = velho.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'sales' AND type IN ('index', 'trigger') ORDER BY name`).all().map((r) => r.name);
  assert.throws(() => velho.prepare(`UPDATE sales SET status = 'transferida' WHERE id = 'v1'`).run(), /CHECK/);

  atualizarCheckStatusDeVendasParaIncluirTransferida(velho);

  assert.ok(velho.prepare(`SELECT sql FROM sqlite_master WHERE name = 'sales'`).get().sql.includes("'transferida'"));
  const indicesDepois = velho.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'sales' AND type IN ('index', 'trigger') ORDER BY name`).all().map((r) => r.name);
  assert.deepEqual(indicesDepois, indicesAntes);
  assert.equal(velho.prepare(`SELECT coluna_nova_qualquer FROM sales WHERE id = 'v1'`).get().coluna_nova_qualquer, 'x');
  velho.prepare(`UPDATE sales SET status = 'transferida' WHERE id = 'v1'`).run();
  assert.throws(() => velho.prepare(`UPDATE sales SET status = 'qualquer' WHERE id = 'v1'`).run(), /CHECK/);
  assert.deepEqual(velho.pragma('foreign_key_check'), []);
  assert.equal(velho.pragma('foreign_keys', { simple: true }), 1, 'chaves estrangeiras ligadas de novo');
  assert.throws(() => velho.prepare(`INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES ('i2', 'nao-existe', 'p1', 1, 1)`).run(), /FOREIGN KEY/);
  // Rodar de novo não faz nada.
  atualizarCheckStatusDeVendasParaIncluirTransferida(velho);
  assert.equal(velho.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 1);
});

test('estoque no servidor: o caixa consulta o saldo do servidor pela rede (contador menos as vendas abertas lá)', async () => {
  await servidor({ cmd: 'run', sql: `INSERT OR REPLACE INTO lan_estoque (grupo_id, produto_id, quantidade) VALUES (?, 'doc-suco', 20)`, params: [G] });
  const abertoNoServidor = (await sqlNoServidor(
    `SELECT COALESCE(SUM(si.quantidade), 0) AS q FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.status = 'aberta' AND si.cancelado = 0 AND si.product_id = ?`, S.ids.suco))[0].q;
  const r = await cliente.saldosDeEstoque();
  assert.equal(r.saldos['doc-suco'], 20 - abertoNoServidor);
  const es = require('../electron/services/estoqueServidorService');
  es.invalidar();
  assert.equal(es.apontado(), true);
  assert.equal(await es.saldoParaLancar(local.suco), 20 - abertoNoServidor, 'id do caixa traduzido para o do grupo');
  assert.equal(await es.saldoParaLancar(local.agua), null, 'sem contador no grupo: não trava');
});

test('suporte: o caixa busca a configuração da loja e confere os cadastros com o servidor pela rede', async () => {
  const cfg = await cliente.pedido('/v1/suporte/config-loja', {});
  assert.ok(Array.isArray(cfg.tabelas.business_profile));
  assert.equal(cfg.tabelas.products, undefined);
  const ping = await cliente.pedido('/v1/ping', {});
  assert.ok('versao' in ping);
  const r = await require('../electron/services/suporteService').conferir();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.servidor, false);
  assert.ok(r.produtos && typeof r.produtos.noGrupo === 'number');
});

test('rede local: a varredura acha o servidor do grupo e ignora quem é de outro grupo', async () => {
  const achados = await cliente.varrerRede(G, { enderecos: ['127.0.0.1'], porta: S.porta, timeoutMs: 2000 });
  assert.equal(achados.length, 1);
  assert.equal(achados[0].endereco, `127.0.0.1:${S.porta}`);
  assert.equal(achados[0].nome, 'PDV1-SERVIDOR');
  const outro = await cliente.varrerRede('outro-grupo', { enderecos: ['127.0.0.1'], porta: S.porta, timeoutMs: 2000 });
  assert.deepEqual(outro, []);
});

test('suporte logado no caixa (fora do grupo) vê e mexe nas mesas como o suporte do servidor; outro usuário fora do grupo só olha', async () => {
  db.prepare("INSERT INTO users (id, nome, role, pin_hash) VALUES ('cx-suporte', 'Suporte', 'suporte', ?)").run(bcrypt.hashSync('9999', 4));
  db.prepare("INSERT INTO users (id, nome, role, pin_hash) VALUES ('cx-novo', 'Joana', 'operador', ?)").run(bcrypt.hashSync('3333', 4));

  const lista = await chamar('table:list', {}, 'cx-suporte');
  assert.ok(Array.isArray(lista) && lista.length >= 4, 'suporte vê as mesas do servidor');
  assert.ok(Array.isArray(await chamar('table:list', {}, 'cx-novo')), 'só olhar não depende de usuário');

  const criada = await chamar('table:create', { numero: '90' }, 'cx-suporte');
  assert.equal(criada.ok, true, criada.error);
  const mesa = (await sqlNoServidor("SELECT id FROM restaurant_tables WHERE numero = '90'"))[0];
  const negado = await chamar('table:open', { tableId: mesa.id, pessoas: 1 }, 'cx-novo');
  assert.equal(negado.ok, false);
  assert.match(negado.error, /Joana ainda não é do grupo/);

  const aberta = await chamar('table:open', { tableId: mesa.id, pessoas: 1 }, 'cx-suporte');
  assert.equal(aberta.ok, true, aberta.error);
  const venda = (await sqlNoServidor('SELECT operador_id FROM sales WHERE id = ?', aberta.saleId))[0];
  assert.equal(venda.operador_id, 'srv-suporte', 'no servidor, quem abriu é o suporte de lá');
});
