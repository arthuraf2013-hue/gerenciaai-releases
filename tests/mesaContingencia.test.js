const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { freshTestDb, createProduct } = require('./helpers/testDb');

// Contingência: o servidor das mesas cai no meio do expediente e o caixa
// continua (abre, lança, recebe, limpa, abre de novo); o servidor volta e
// recebe tudo, na ordem, sem duplicar.
const G = 'grupo-mesa-contingencia-01';
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
const cont = require('../electron/services/mesaContingenciaService');
const cozinha = require('../electron/services/cozinhaService');
const DEV = 'caixa-dev';
const add = (saleId, productId, quantidade = 1, extra = {}) => chamar('sale:addItem', { saleId, productId, quantidade, locationId: local.locationId, deviceId: DEV, ...extra });

let s1; // venda da mesa 1 no servidor (aberta antes de cair)
const impressas = [];

test('online: abre a mesa 1 no servidor e a cópia fica guardada no caixa', async () => {
  const r = await chamar('table:open', { tableId: S.mesas['1'], pessoas: 2 });
  assert.equal(r.ok, true, r.error);
  s1 = r.saleId;
  assert.equal((await add(s1, local.suco)).ok, true);
  await cont.atualizarEspelho({ forcar: true });
  const copia = cont._lerEspelho('lista');
  assert.equal(copia.find((m) => m.id === S.mesas['1']).sale_id, s1);
  const carrinho = cont._lerEspelho(`cart:${s1}`);
  assert.equal(carrinho.items.length, 1);
  assert.equal(carrinho.items[0].produtoDoc, 'doc-suco', 'a cópia já traz o produto do grupo (para receber sem o servidor)');
});

test('o servidor cai: as mesas continuam aparecendo (pela cópia) e dá para lançar', async () => {
  // Cozinha deste caixa ligada (impressora de rede): o que for lançado sem o servidor sai aqui.
  cozinha.getConfig = ((orig) => () => ({ ...orig(), ativa: true }))(cozinha.getConfig);
  cozinha.enviarParaImpressora = async (comanda) => { impressas.push(comanda); };
  await servidor({ cmd: 'desligar' });

  const lista = await chamar('table:list', {});
  assert.ok(Array.isArray(lista), lista?.error);
  assert.ok(lista.every((m) => m.offline), 'marcadas como cópia');
  assert.equal(lista.find((m) => m.id === S.mesas['1']).status, 'ocupada');

  const r = await add(s1, local.caldinho);
  assert.equal(r.ok, true, r.error);
  assert.ok(cont.ehProvisorio(r.itemId));
  assert.equal(r.novoTotal, 20);
  const cart = await chamar('table:getCart', { saleId: s1 });
  assert.deepEqual(cart.items.map((i) => i.nome), ['Suco', 'Caldinho de charque']);
  assert.equal(cont.resumo().pendentes, 1);

  // Não suportado sem o servidor: explica, não trava a tela.
  const juntar = await chamar('table:juntar', { tableId: S.mesas['1'], mesaIds: [S.mesas['2']] });
  assert.equal(juntar.ok, false);
  assert.match(juntar.error, /Sem o servidor/);

  await new Promise((ok) => setTimeout(ok, 2700));
  assert.equal(impressas.length, 1, 'a cozinha daqui recebeu o caldinho');
  assert.equal(impressas[0].subtitulo, 'SEM SERVIDOR (contingência)');
  assert.deepEqual(impressas[0].itens.map((i) => i.nome), ['Caldinho de charque']);
});

let s4temp;
test('sem o servidor: abre outra mesa e lança', async () => {
  const r = await chamar('table:open', { tableId: S.mesas['4'], pessoas: 1 });
  assert.equal(r.ok, true, r.error);
  assert.ok(cont.ehProvisorio(r.saleId));
  s4temp = r.saleId;
  assert.equal((await add(s4temp, local.agua)).ok, true);
  const item = (await chamar('table:getCart', { saleId: s4temp })).items[0];
  const mais = await chamar('sale:ajustarQuantidade', { saleId: s4temp, saleItemId: item.id, delta: 1, locationId: local.locationId, deviceId: DEV });
  assert.equal(mais.ok, true, mais.error);
  assert.equal(mais.quantidade, 2);
});

let vendaLocal;
let s1bTemp;
test('sem o servidor: recebe a mesa 1 neste caixa, limpa e abre de novo para outro cliente', async () => {
  const p = await mc.puxarParaPagar({ tableId: S.mesas['1'], usuarioId: 'cx-operador' });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.offline, true);
  vendaLocal = p.saleId;
  const itens = db.prepare('SELECT product_id, preco_unitario FROM sale_items WHERE sale_id = ? ORDER BY rowid').all(vendaLocal);
  assert.deepEqual(itens.map((i) => i.product_id), [local.suco, local.caldinho]);
  cashService.openSession({ locationId: local.locationId, operadorId: 'cx-operador', valorAbertura: 0 });
  assert.equal(saleService.addPayment({ saleId: vendaLocal, metodo: 'dinheiro', valor: 20 }).ok, true);
  // Restaurante: sem servidor e sem nuvem, a conta fecha e a baixa do grupo vai na fila.
  db.prepare("UPDATE business_profile SET perfil_ativo = 'restaurante', config_json = '{}' WHERE id = 'default'").run();
  require('../electron/services/licenseService').getLicenseFirestore = () => { throw Object.assign(new Error('sem internet'), { code: 'unavailable' }); };
  const fim = await saleService.finalizeSaleComVerificacaoDeGrupo(vendaLocal);
  assert.equal(fim.ok, true, fim.error);
  assert.equal(db.prepare('SELECT status FROM sales WHERE id = ?').get(vendaLocal).status, 'finalizada');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM estoque_grupo_pendente').get().n >= 1, 'a baixa do grupo ficou na fila');
  mc.aoFinalizarVenda(vendaLocal);

  let lista = await chamar('table:list', {});
  assert.equal(lista.find((m) => m.id === S.mesas['1']).status, 'aguardando_limpeza');
  assert.equal((await chamar('table:markCleaned', { tableId: S.mesas['1'] })).ok, true);
  const nova = await chamar('table:open', { tableId: S.mesas['1'], pessoas: 1 });
  assert.equal(nova.ok, true, nova.error);
  s1bTemp = nova.saleId;
  assert.equal((await add(s1bTemp, local.suco)).ok, true);
  lista = await chamar('table:list', {});
  assert.equal(lista.find((m) => m.id === S.mesas['1']).sale_id, s1bTemp);
  assert.equal(cont.resumo().pendentes, 8);
});

test('o servidor volta: a fila vai na ordem, ids trocados, e o servidor fica igual ao caixa', async () => {
  const r = await servidor({ cmd: 'religar', porta: S.porta });
  assert.equal(r.ok, true);
  cont.anotarSucesso();
  const d = await cont.drenar();
  assert.equal(d.erros, 0, JSON.stringify(cont.resumo().erros));
  assert.equal(d.restantes, 0);
  assert.equal(cont.resumo().pendentes, 0);

  // Mesa 1, primeira conta: transferida para a venda deste caixa, com suco + caldinho.
  const v1 = (await sqlNoServidor('SELECT status, transferida_para_venda_id, total FROM sales WHERE id = ?', s1))[0];
  assert.deepEqual([v1.status, v1.transferida_para_venda_id, v1.total], ['transferida', vendaLocal, 20]);
  // O caldinho que a cozinha daqui já imprimiu chega marcado (a do servidor não imprime de novo).
  const cald = (await sqlNoServidor('SELECT enviado_cozinha FROM sale_items WHERE sale_id = ? AND product_id = ?', s1, S.ids.caldinho))[0];
  assert.equal(cald.enviado_cozinha, 1);
  // Mesa 1 de novo aberta, com o suco do segundo cliente.
  const m1 = await mesaDoServidor(S.mesas['1']);
  assert.equal(m1.status, 'ocupada');
  assert.notEqual(m1.sale_id, s1);
  assert.deepEqual((await sqlNoServidor('SELECT product_id, quantidade FROM sale_items WHERE sale_id = ? AND cancelado = 0', m1.sale_id)).map((i) => [i.product_id, i.quantidade]), [[S.ids.suco, 1]]);
  // Mesa 4: aberta com 2 águas.
  const m4 = await mesaDoServidor(S.mesas['4']);
  assert.equal(m4.status, 'ocupada');
  assert.deepEqual((await sqlNoServidor('SELECT product_id, quantidade FROM sale_items WHERE sale_id = ? AND cancelado = 0', m4.sale_id)).map((i) => [i.product_id, i.quantidade]), [[S.ids.agua, 2]]);
  // No caixa: fechamento concluído e a cópia já é a do servidor de novo.
  assert.equal(db.prepare('SELECT estado FROM mesa_remota_fechamentos WHERE sale_id = ?').get(vendaLocal).estado, 'feito');
  const lista = await chamar('table:list', {});
  assert.ok(lista.every((m) => !m.offline));
  assert.equal(lista.find((m) => m.id === S.mesas['4']).sale_id, m4.sale_id);
});

test('repetir uma operação (resposta perdida) não aplica de novo', async () => {
  const op = db.prepare("SELECT * FROM mesa_fila_offline WHERE canal = 'sale:addItem' AND estado = 'feito' ORDER BY seq DESC LIMIT 1").get();
  const args = JSON.parse(op.args_json);
  args.saleId = db.prepare('SELECT real_id FROM mesa_ids_offline WHERE temp_id = ?').get(args.saleId)?.real_id || args.saleId;
  const antes = (await sqlNoServidor('SELECT COUNT(*) AS n, TOTAL(quantidade) AS q FROM sale_items'))[0];
  const r = await mc.chamarNoServidor('sale:addItem', args, op.usuario_id, { opId: op.id });
  assert.equal(r.repetida, true);
  const depois = (await sqlNoServidor('SELECT COUNT(*) AS n, TOTAL(quantidade) AS q FROM sale_items'))[0];
  assert.deepEqual(depois, antes);
});

test('o servidor recusa uma operação: fica marcada com o motivo e as que dependem dela também', async () => {
  await servidor({ cmd: 'desligar' });
  cont.anotarFalha();
  // Mesa 2 aberta sem o servidor; enquanto isso alguém (outra máquina) reservou a mesa 2 lá.
  const r = await chamar('table:open', { tableId: S.mesas['2'], pessoas: 1 });
  assert.equal(r.ok, true, r.error);
  assert.equal((await add(r.saleId, local.agua)).ok, true);
  await servidor({ cmd: 'run', sql: "UPDATE restaurant_tables SET status = 'aguardando_limpeza' WHERE id = ?", params: [S.mesas['2']] });
  await servidor({ cmd: 'religar', porta: S.porta });
  cont.anotarSucesso();
  const d = await cont.drenar();
  assert.equal(d.erros, 2);
  const erros = cont.resumo().erros;
  assert.match(erros[0].erro, /aguardando limpeza/);
  assert.match(erros[1].erro, /recusou/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'contingencia_recusada'").get());
  assert.equal(cont.descartarErros().ok, true);
  assert.equal(cont.resumo().erros.length, 0);
});
