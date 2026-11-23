// Garçons das mesas: o gerente vincula, a mesa mostra a etiqueta e a nota e a
// pré-nota saem com o garçom; o que outra conta lançou continua com quem
// lançou e a hora (nov/2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const svc = require('../electron/services/mesaAtendentesService');
const tableService = require('../electron/services/tableService');
const saleService = require('../electron/services/saleService');
const estudio = require('../electron/services/estudioImpressaoService');
const printService = require('../electron/services/printService');
const layout = require('../electron/services/impressaoLayout');

function cenario() {
  const ctx = freshTestDb();
  const usuario = (nome, role) => {
    const id = randomUUID();
    ctx.db.prepare('INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, ?, ?)').run(id, nome, role, 'x');
    return id;
  };
  const ana = usuario('Ana', 'garcom');
  const bruno = usuario('Bruno', 'garcom');
  const mesa = (numero) => tableService.createTable({ locationId: ctx.locationId, numero }).id;
  const m1 = mesa('1');
  const m2 = mesa('2');
  const m3 = mesa('3');
  const prato = createProduct(ctx.db, { nome: 'Charque', preco: 40 });
  const cerveja = createProduct(ctx.db, { nome: 'Cerveja', preco: 12 });
  for (const p of [prato, cerveja]) addStock(ctx.db, { productId: p, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  const vincular = (userId, tableIds) => {
    const r = svc.definirMesasDoAtendente({ userId, tableIds, locationId: ctx.locationId, operadorId: ctx.gerenteId });
    assert.equal(r.ok, true, r.error);
    return r;
  };
  return { ...ctx, ana, bruno, m1, m2, m3, prato, cerveja, vincular };
}

test('vincular: só garçom/operador ativo, só mesa do local; troca a lista inteira do garçom e registra na Auditoria', () => {
  const c = cenario();
  assert.equal(svc.definirMesasDoAtendente({ userId: c.gerenteId, tableIds: [c.m1], locationId: c.locationId }).ok, false, 'gerente não é vinculado');
  assert.equal(svc.definirMesasDoAtendente({ userId: c.ana, tableIds: ['nao-existe'], locationId: c.locationId }).ok, false);
  assert.equal(svc.definirMesasDoAtendente({ userId: 'ninguem', tableIds: [c.m1], locationId: c.locationId }).ok, false);

  c.vincular(c.ana, [c.m1, c.m2]);
  c.vincular(c.bruno, [c.m2]);
  let p = svc.painel({ locationId: c.locationId });
  assert.deepEqual(p.atendentes.map((a) => a.nome), ['Ana', 'Bruno', 'Operador Teste']);
  assert.ok(p.atendentes.every((a) => ['Garçom', 'Operador'].includes(a.papel)));
  assert.equal(p.vinculos.length, 3);

  c.vincular(c.ana, [c.m3]);
  p = svc.painel({ locationId: c.locationId });
  assert.deepEqual(p.vinculos.filter((v) => v.userId === c.ana).map((v) => v.tableId), [c.m3], 'troca, não soma');
  const auditoria = c.db.prepare("SELECT motivo, solicitante_id FROM audit_log WHERE tipo_evento = 'mesa_garcons' ORDER BY rowid").all();
  assert.equal(auditoria.length, 3);
  assert.equal(auditoria[0].solicitante_id, c.gerenteId);
  assert.match(auditoria[0].motivo, /Mesas de Ana: Mesa 1, Mesa 2/);

  assert.equal(svc.limparTodos({ locationId: c.locationId, operadorId: c.gerenteId }).removidos, 2);
  assert.equal(svc.painel({ locationId: c.locationId }).vinculos.length, 0);
});

test('etiqueta: a lista de mesas traz os garçons; a principal junta os das mesas unidas; inativo some', () => {
  const c = cenario();
  c.vincular(c.ana, [c.m1]);
  c.vincular(c.bruno, [c.m2]);
  let lista = tableService.listTables(c.locationId);
  const da = (id) => lista.find((t) => t.id === id).atendentes.map((a) => a.nome);
  assert.deepEqual(da(c.m1), ['Ana']);
  assert.deepEqual(da(c.m3), []);

  tableService.openTable({ tableId: c.m1, locationId: c.locationId, operadorId: c.operadorId });
  const juntou = tableService.juntarMesas({ tableId: c.m1, mesaIds: [c.m2], currentOperatorId: c.operadorId });
  assert.notEqual(juntou?.ok, false, juntou?.error);
  lista = tableService.listTables(c.locationId);
  assert.deepEqual(da(c.m1), ['Ana', 'Bruno'], 'mesa principal mostra os garçons do grupo');

  c.db.prepare('UPDATE users SET ativo = 0 WHERE id = ?').run(c.bruno);
  lista = tableService.listTables(c.locationId);
  assert.deepEqual(da(c.m1), ['Ana']);
});

test('pré-nota: sai o garçom e só os itens de OUTRA conta saem com quem lançou e a hora', async () => {
  const c = cenario();
  c.vincular(c.ana, [c.m1]);
  const { saleId } = tableService.openTable({ tableId: c.m1, locationId: c.locationId, operadorId: c.ana });
  const add = (productId, extra) => assert.equal(saleService.addItem({ saleId, productId, locationId: c.locationId, quantidade: 1, deviceId: 'd', ...extra }).ok, true);
  add(c.prato, { operadorId: c.ana, origem: 'app_garcom' });
  add(c.cerveja, { operadorId: c.operadorId });
  add(c.cerveja, { operadorId: c.operadorId, origem: 'qr_mesa' });

  const d = estudio.dadosDaConta(saleId).dados;
  assert.deepEqual(d.garcons, ['Ana']);
  const porItem = d.itens.map((i) => [i.nome, i.quem]);
  assert.deepEqual(porItem, [['Charque', null], ['Cerveja', 'Operador Teste'], ['Cerveja', 'QR da mesa']]);

  const r = await estudio.htmlDaPreNota({ saleId });
  assert.equal(r.ok, true, r.error);
  assert.match(r.html, /Garçom: Ana/);
  assert.match(r.html, /class="hora">\d\d:\d\d<\/span> <span class="quem">· Operador Teste<\/span>/);
  assert.match(r.html, /<span class="quem">· QR da mesa<\/span>/);
  assert.doesNotMatch(r.html, /· Ana/, 'item do próprio garçom não repete o nome');

  // Sem hora por item ligada, o item de outra conta continua com a hora.
  const semHora = layout.montarPreNota({ mostrarHoraItem: false }, d);
  assert.match(semHora, /class="hora">\d\d:\d\d<\/span> <span class="quem">· Operador/);
  // Desligado no estúdio: nada de garçom nem de quem lançou.
  const desligado = layout.montarPreNota({ mostrarGarcons: false }, d);
  assert.doesNotMatch(desligado, /Garçom:|class="quem"/);
});

test('sem garçom vinculado a nota e a pré-nota ficam como sempre foram', async () => {
  const c = cenario();
  const { saleId } = tableService.openTable({ tableId: c.m1, locationId: c.locationId, operadorId: c.operadorId });
  assert.equal(saleService.addItem({ saleId, productId: c.prato, locationId: c.locationId, quantidade: 1, deviceId: 'd', operadorId: c.ana }).ok, true);
  const d = estudio.dadosDaConta(saleId).dados;
  assert.deepEqual(d.garcons, []);
  assert.equal(d.itens[0].quem, null);
  const r = await estudio.htmlDaPreNota({ saleId });
  assert.doesNotMatch(r.html, /Garçom|class="quem"/);
});

test('nota: a foto dos garçons fica na venda ao fechar -- reimpressão sai igual mesmo trocando o vínculo', () => {
  const c = cenario();
  c.vincular(c.ana, [c.m1]);
  c.vincular(c.bruno, [c.m1]);
  const { saleId } = tableService.openTable({ tableId: c.m1, locationId: c.locationId, operadorId: c.operadorId });
  assert.equal(saleService.addItem({ saleId, productId: c.prato, locationId: c.locationId, quantidade: 1, deviceId: 'd', operadorId: c.ana }).ok, true);
  assert.equal(saleService.addItem({ saleId, productId: c.cerveja, locationId: c.locationId, quantidade: 1, deviceId: 'd', operadorId: c.operadorId }).ok, true);
  saleService.addPayment({ saleId, metodo: 'dinheiro', valor: 52, detalhes: {} });
  assert.equal(saleService.finalizeSale(saleId).ok, true);
  tableService.liberarMesaDaVenda(saleId);
  svc.limparTodos({ locationId: c.locationId });

  assert.deepEqual(svc.atendentesDaVenda(c.db, saleId).map((a) => a.nome), ['Ana', 'Bruno']);
  const sale = c.db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  const items = c.db.prepare('SELECT si.*, p.nome FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? ORDER BY si.rowid').all(saleId);
  const { garcons, itens } = svc.garconsDaNota(c.db, saleId, items);
  assert.deepEqual(garcons, ['Ana', 'Bruno']);
  const html = printService.buildReceiptHtml(sale, itens, [], { nome: 'Loja' }, 80, '', null, null, null, { mesa: 'Mesa 1', garcons });
  assert.match(html, /Garçons: Ana e Bruno/);
  assert.match(html, /<span class="quem">· Operador Teste<\/span>/);
  assert.equal((html.match(/class="quem"/g) || []).length, 1, 'só o item da outra conta');

  // Balcão: nada muda.
  const balcao = printService.buildReceiptHtml(sale, itens, [], { nome: 'Loja' }, 80, '', null, null, null, { mesa: null, garcons });
  assert.doesNotMatch(balcao, /Garçons|class="quem"/);
});

test('grupo de caixas: a conta que vai para o caixa leva os garçons e a nota do caixa sai com eles', () => {
  const c = cenario();
  c.vincular(c.ana, [c.m1]);
  const { saleId } = tableService.openTable({ tableId: c.m1, locationId: c.locationId, operadorId: c.operadorId });
  const cart = tableService.getTableCart(saleId);
  assert.deepEqual(cart.atendentes.map((a) => a.nome), ['Ana'], 'tela da mesa mostra o garçom');

  // A foto gravada a partir da conta recebida (como no importarConta do caixa).
  const outra = saleService.openSale({ locationId: c.locationId, operadorId: c.operadorId }).id;
  svc.gravarAtendentesDaVenda(c.db, outra, [{ nome: 'Ana', id: c.ana }, { nome: '  ' }, { nome: 'Zé de fora', id: null }]);
  assert.deepEqual(svc.atendentesDaVenda(c.db, outra).map((a) => a.nome), ['Ana', 'Zé de fora']);
});

test('celular: a lista de mesas leva os nomes dos garçons', () => {
  const c = cenario();
  c.vincular(c.ana, [c.m2]);
  const mesas = require('../electron/services/mesaCelularService').montarMesas(c.db, c.locationId);
  assert.deepEqual(mesas.find((m) => m.id === c.m2).garcons, ['Ana']);
  assert.deepEqual(mesas.find((m) => m.id === c.m1).garcons, []);
});

test('prévia do estúdio mostra o garçom e o item lançado pelo caixa', async () => {
  freshTestDb();
  const nota = await estudio.previa({ tipo: 'nota', config: estudio.getConfig('nota') });
  assert.match(nota.html, /Garçom: Marcos/);
  assert.match(nota.html, /· Carla/);
  const pre = await estudio.previa({ tipo: 'prenota', config: estudio.getConfig('prenota') });
  assert.match(pre.html, /Garçom: Marcos/);
});

test('IPC: garçons das mesas é só de gestão; no grupo, o servidor executa com o usuário de quem pediu', async () => {
  const canais = require('../electron/services/mesaCompartilhadaService');
  void canais;
  const fonte = require('fs').readFileSync(require.resolve('../electron/ipc/handlers.js'), 'utf8');
  for (const canal of ['table:atendentes', 'table:vincularAtendente', 'table:limparAtendentes']) {
    const linha = fonte.split('\n').find((l) => l.includes(`safeHandle('${canal}'`));
    assert.ok(linha && /guardRole\(event, PAPEIS_GESTAO\)/.test(linha), `${canal} protegido`);
  }
  const api = require('fs').readFileSync(require.resolve('../src/utils/mesasApi.js'), 'utf8');
  for (const m of ['atendentes', 'vincularAtendente', 'limparAtendentes']) assert.match(api, new RegExp(`'${m}'`));
  const servidor = require('fs').readFileSync(require.resolve('../electron/services/mesaCompartilhadaService.js'), 'utf8');
  for (const canal of ['table:atendentes', 'table:vincularAtendente', 'table:limparAtendentes']) {
    assert.match(servidor, new RegExp(`'${canal}': \\{ (ler: true, )?gestao: true`));
  }
});
