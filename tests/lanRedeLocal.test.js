const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { freshTestDb } = require('./helpers/testDb');

// Dois computadores de verdade: o servidor do grupo num processo (banco
// próprio) e este caixa aqui, falando por HTTP na máquina local.
const G = 'grupo-rede-local-01';
let filho;
let linhas = [];
let esperando = [];

function proximaLinha() {
  if (linhas.length) return Promise.resolve(linhas.shift());
  return new Promise((r) => esperando.push(r));
}
function comando(c) { filho.stdin.write(c + '\n'); return proximaLinha(); }

let porta; let codigo;
const cliente = require('../electron/services/lanClienteService');

test.before(async () => {
  filho = spawn(process.execPath, [path.join(__dirname, 'helpers', 'lanServidorFilho.js')], {
    env: { ...process.env, GRUPO_TESTE: G }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  filho.stdout.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (esperando.length) esperando.shift()(l); else linhas.push(l);
    }
  });
  ({ porta, codigo } = await proximaLinha());
  const { db } = freshTestDb();
  db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = 0 WHERE id = ?').run(G, 'default');
  require('../electron/services/pdvRegistryService').getOrCreateDeviceUid = () => 'caixa-teste-0002';
});
test.after(() => { filho?.kill(); });

test('ligar caixa: código errado não liga; o certo liga (e só uma vez)', async () => {
  const endereco = `127.0.0.1:${porta}`;
  let r = await cliente.parear({ codigo: 'ZZZZ-ZZZZ', endereco });
  assert.equal(r.ok, false);
  assert.match(r.error, /Código errado/);
  r = await cliente.parear({ codigo, endereco });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.servidor, 'SERVIDOR-TESTE');
  assert.equal((await comando('caixas')).caixas, 1);
  r = await cliente.parear({ codigo, endereco });
  assert.equal(r.ok, false, 'o código vale para um caixa só');
});

test('pedidos assinados: lê, grava e escuta o grupo pelo servidor', async () => {
  assert.equal((await cliente.ping()).hubNome, 'SERVIDOR-TESTE');
  await cliente.gravarLote('produtos', [{ docId: 'p1', dados: { nome: 'Arroz', preco: 7.5, versaoMs: 1 } }]);
  const todos = await cliente.lerTodos('produtos');
  assert.equal(todos.get('p1').nome, 'Arroz');
  const recebidos = [];
  let avisar;
  const chegou = new Promise((r) => { avisar = r; });
  const parar = cliente.escutar('produtos', (m) => { recebidos.push(...m.keys()); if (recebidos.includes('p2')) avisar(); });
  await new Promise((r) => setTimeout(r, 200));
  await cliente.gravarLote('produtos', [{ docId: 'p2', dados: { nome: 'Feijão', preco: 9, versaoMs: 1 } }]);
  await chegou;
  parar();
  assert.deepEqual(recebidos.slice(0, 2), ['p1', 'p2'], 'tudo primeiro, depois a mudança (pedido longo)');
});

test('estoque: duas vendas da última unidade ao mesmo tempo -- só uma passa', async () => {
  const [a, b] = await Promise.all([
    cliente.verificarEDebitar([{ productId: 'prod-ultima', quantidade: 1, nome: 'Última' }], 'venda-a'),
    cliente.verificarEDebitar([{ productId: 'prod-ultima', quantidade: 1, nome: 'Última' }], 'venda-b'),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const repetida = await cliente.verificarEDebitar([{ productId: 'prod-ultima', quantidade: 1 }], a.ok ? 'venda-a' : 'venda-b');
  assert.equal(repetida.repetido, true, 'resposta perdida + nova tentativa não debita de novo');
  assert.deepEqual((await comando('estoque')).estoque, [['prod-ultima', 0]]);
});

test('segurança: sem assinatura, assinatura errada ou pedido repetido são recusados', async () => {
  const cripto = require('../electron/services/lanCripto');
  const post = (cab, corpo = '{}') => new Promise((ok, erro) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: '/v1/ler', method: 'POST', headers: { 'Content-Type': 'application/json', ...cab } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => ok({ status: res.statusCode, corpo: s }));
    });
    req.on('error', erro); req.end(corpo);
  });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ 'x-caixa': 'caixa-teste-0002', 'x-ts': String(Date.now()), 'x-nonce': 'n1', 'x-assinatura': 'falsa' })).status, 401);
  const chave = cliente.config().chave;
  const corpo = JSON.stringify({ colecao: 'produtos' });
  const ass = cripto.assinarPedido(chave, { metodo: 'POST', caminho: '/v1/ler', corpo });
  const cab = { 'x-caixa': 'caixa-teste-0002', 'x-ts': ass.ts, 'x-nonce': ass.nonce, 'x-assinatura': ass.assinatura };
  assert.equal((await post(cab, corpo)).status, 200);
  assert.equal((await post(cab, corpo)).status, 401, 'o mesmo pedido de novo (replay)');
  const velho = cripto.assinarPedido(chave, { metodo: 'POST', caminho: '/v1/ler', corpo, agoraMs: Date.now() - 10 * 60 * 1000 });
  assert.equal((await post({ 'x-caixa': 'caixa-teste-0002', 'x-ts': velho.ts, 'x-nonce': velho.nonce, 'x-assinatura': velho.assinatura }, corpo)).status, 401, 'hora fora da janela');
});

test('código: 5 tentativas erradas invalidam', async () => {
  const novo = (await comando('codigo')).codigo;
  const endereco = `127.0.0.1:${porta}`;
  cliente.desligar();
  for (let i = 0; i < 5; i++) assert.equal((await cliente.parear({ codigo: 'YYYY-YYYY', endereco })).ok, false);
  const r = await cliente.parear({ codigo: novo, endereco });
  assert.equal(r.ok, false);
  assert.match(r.error, /expirado|muitas vezes/);
});

test('caixa em modo rede local: a réplica e o estoque do grupo passam pelo servidor', async () => {
  // Liga de novo (o teste anterior desligou este caixa).
  const novo = (await comando('codigo')).codigo;
  assert.equal((await cliente.parear({ codigo: novo, endereco: `127.0.0.1:${porta}` })).ok, true);
  const transporte = require('../electron/services/grupoTransporteService');
  transporte._definirModoParaTeste('lan');
  try {
    const { getDb } = require('../electron/db/database');
    const { createProduct } = require('./helpers/testDb');
    const id = createProduct(getDb(), { nome: 'Café do Caixa 2' });
    const replica = require('../electron/services/grupoReplicaService');
    const r = await replica.sincronizarTudo();
    assert.equal(r.ok, true, r.error);
    const noServidor = [...(await cliente.lerTodos('produtos')).values()].map((d) => d.nome);
    assert.ok(noServidor.includes('Café do Caixa 2'), 'o produto criado aqui chegou ao servidor');
    assert.ok(noServidor.includes('Arroz'), 'e o que estava no servidor foi lido');
    assert.ok(getDb().prepare(`SELECT 1 FROM products WHERE nome = 'Arroz'`).get(), 'o do servidor entrou neste caixa');

    const stock = require('../electron/services/stockSyncService');
    const semContador = await stock.verificarEDebitarEstoqueRemoto([{ productId: id, quantidade: 1, nome: 'Café do Caixa 2' }], { operacaoId: 'x1' });
    assert.equal(semContador.ok, true, 'produto sem contador no grupo não trava');
    const ultima = await stock.verificarEDebitarEstoqueRemoto([{ productId: 'prod-ultima', quantidade: 5, nome: 'Última' }], { operacaoId: 'x2' });
    assert.equal(ultima.ok, false);
    assert.equal(ultima.motivo, 'estoque_insuficiente');
    assert.match(ultima.error, /Última/);
  } finally {
    transporte._definirModoParaTeste('nuvem');
  }
});
