const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const armazem = require('../electron/services/lanArmazemService');

const G = 'grupo-teste-0001';
const esperar = () => new Promise((r) => setImmediate(r));

test('cópia do grupo: gravar substitui, feed traz só o que mudou depois', () => {
  freshTestDb();
  armazem.gravar(G, 'produtos', [{ docId: 'p1', dados: { nome: 'Arroz', versaoMs: 10 } }, { docId: 'p2', dados: { nome: 'Feijão', versaoMs: 10 } }]);
  const tudo = armazem.mudancasDesde(G, 'produtos', 0);
  assert.equal(tudo.docs.length, 2);
  armazem.gravar(G, 'produtos', [{ docId: 'p1', dados: { nome: 'Arroz 5kg', versaoMs: 5 } }]); // caixa grava: substitui (quem decide é quem lê)
  const depois = armazem.mudancasDesde(G, 'produtos', tudo.seq);
  assert.deepEqual(depois.docs.map(([id, d]) => [id, d.nome]), [['p1', 'Arroz 5kg']]);
  assert.equal(armazem.lerTodos(G, 'produtos').get('p1').nome, 'Arroz 5kg');
  assert.equal(armazem.pendentesParaNuvem().length, 2, 'os dois esperam subir');
  assert.throws(() => armazem.gravar(G, 'qualquercoisa', []), /coleção/);
});

test('cópia do grupo: da nuvem só entra o mais novo (e o eco do que subiu é ignorado)', () => {
  freshTestDb();
  armazem.gravar(G, 'clientes', [{ docId: 'c1', dados: { nome: 'Ana', versaoMs: 200 } }]);
  assert.equal(armazem.aplicarDaNuvem(G, 'clientes', new Map([['c1', { nome: 'Ana velha', versaoMs: 100 }]])), 0);
  assert.equal(armazem.aplicarDaNuvem(G, 'clientes', new Map([['c1', { nome: 'Ana', versaoMs: 200 }]])), 0, 'eco');
  assert.equal(armazem.aplicarDaNuvem(G, 'clientes', new Map([['c1', { nome: 'Ana Maria', versaoMs: 300 }], ['c2', { nome: 'Bia', atualizadoEm: { seconds: 5 } }]])), 2);
  assert.equal(armazem.lerTodos(G, 'clientes').get('c1').nome, 'Ana Maria');
  assert.equal(armazem.pendentesParaNuvem().length, 0, 'o que veio da nuvem não sobe de volta');
});

test('cópia do grupo: subida só tira a marca se o documento não mudou no meio', () => {
  freshTestDb();
  armazem.gravar(G, 'fiado', [{ docId: 'f1', dados: { valor: 10 } }]);
  const pend = armazem.pendentesParaNuvem();
  armazem.gravar(G, 'fiado', [{ docId: 'f1', dados: { valor: 12 } }]); // mudou enquanto subia
  armazem.marcarNaNuvem(pend);
  assert.equal(armazem.pendentesParaNuvem().length, 1);
  armazem.marcarNaNuvem(armazem.pendentesParaNuvem());
  assert.equal(armazem.pendentesParaNuvem().length, 0);
});

test('escuta em processo: tudo primeiro, depois só as mudanças', async () => {
  freshTestDb();
  armazem.gravar(G, 'usuarios', [{ docId: 'u1', dados: { nome: 'Caixa 1', versaoMs: 1 } }]);
  const vistos = [];
  const parar = armazem.escutar(G, 'usuarios', (m) => vistos.push([...m.keys()]));
  await esperar();
  armazem.gravar(G, 'usuarios', [{ docId: 'u2', dados: { nome: 'Caixa 2', versaoMs: 1 } }]);
  await esperar();
  parar();
  armazem.gravar(G, 'usuarios', [{ docId: 'u3', dados: { nome: 'x', versaoMs: 1 } }]);
  await esperar();
  assert.deepEqual(vistos, [['u1'], ['u2']]);
});

test('vendas do período pelo diaISO', () => {
  freshTestDb();
  armazem.gravar(G, 'vendas', [
    { docId: 'v1', dados: { diaISO: '2026-11-17', total: 10 } },
    { docId: 'v2', dados: { diaISO: '2026-11-18', total: 20 } },
    { docId: 'v3', dados: { diaISO: '2026-11-19', total: 30 } },
  ]);
  assert.deepEqual(armazem.vendasDoPeriodo(G, '2026-11-18', '2026-11-19').map((v) => v.id).sort(), ['v2', 'v3']);
});

test('estoque: débito confere tudo e debita junto; sem contador não trava; operação repetida não debita de novo', () => {
  freshTestDb();
  assert.equal(armazem.aplicarMovimento(G, { productId: 'a', movimentoId: 'm0', delta: 3 }).aplicado, false, 'sem contador: movimento não cria um');
  armazem.gravarContadores(G, [{ product_id: 'a', total: 0 }, { product_id: 'b', total: 0 }], { somar: true });
  armazem.aplicarMovimento(G, { productId: 'a', movimentoId: 'm1', delta: 3 });
  assert.equal(armazem.aplicarMovimento(G, { productId: 'a', movimentoId: 'm1', delta: 3 }).aplicado, false, 'movimento vale uma vez');
  armazem.aplicarMovimento(G, { productId: 'b', movimentoId: 'm2', delta: 1 });
  let r = armazem.verificarEDebitar(G, [{ productId: 'a', quantidade: 2 }, { productId: 'b', quantidade: 2, nome: 'Bolo' }], 'op1');
  assert.equal(r.ok, false);
  assert.match(r.faltando[0], /Bolo \(pede 2, tem 1\)/);
  assert.equal(armazem.lerContadores(G).get('a'), 3, 'nada debitado se um item falta');
  const semContador = armazem.verificarEDebitar(G, [{ productId: 'zz', quantidade: 1 }], 'op0');
  assert.equal(semContador.ok, true, 'produto que o grupo ainda não controla não trava a venda');
  assert.equal(armazem.lerContadores(G).has('zz'), false, 'e não ganha contador de mentira');
  r = armazem.verificarEDebitar(G, [{ productId: 'a', quantidade: 2 }, { productId: 'b', quantidade: 1 }], 'op2');
  assert.equal(r.ok, true);
  assert.equal(armazem.verificarEDebitar(G, [{ productId: 'a', quantidade: 2 }, { productId: 'b', quantidade: 1 }], 'op2').repetido, true);
  assert.equal(armazem.lerContadores(G).get('a'), 1);
  assert.equal(armazem.lerContadores(G).get('b'), 0);
  assert.equal(armazem.verificarEDebitar(G, [{ productId: 'a', quantidade: 2 }], 'op3').ok, false, 'a última unidade não sai duas vezes');
});

test('estoque: conta da subida soma o que outro caixa debitou direto na nuvem', () => {
  // daqui 10, já espelhado 12, nuvem 11 (alguém fora da rede vendeu 1): grava 9
  assert.deepEqual(armazem.contaDaSubida({ local: 10, espelhado: 12, nuvem: 11, absoluto: false }), { gravar: 9, somarAqui: -1 });
  // contador que a nuvem tinha e a cópia nunca viu: soma as variações daqui ao valor de lá
  assert.deepEqual(armazem.contaDaSubida({ local: -2, espelhado: null, nuvem: 50, absoluto: false }), { gravar: 48, somarAqui: 50 });
  // ninguém tinha: vale o daqui
  assert.deepEqual(armazem.contaDaSubida({ local: 5, espelhado: null, nuvem: null, absoluto: false }), { gravar: 5, somarAqui: 0 });
  // recontagem: vence a daqui
  assert.deepEqual(armazem.contaDaSubida({ local: 30, espelhado: 12, nuvem: 7, absoluto: true }), { gravar: 30, somarAqui: 0 });
});

test('estoque: valor novo da nuvem (venda de caixa fora da rede) soma a diferença aqui', () => {
  freshTestDb();
  armazem.contadorDaNuvem(G, 'a', 20); // primeira vez: vira o valor daqui
  assert.equal(armazem.lerContadores(G).get('a'), 20);
  armazem.verificarEDebitar(G, [{ productId: 'a', quantidade: 5 }], 'op');
  armazem.contadorDaNuvem(G, 'a', 18); // fora da rede venderam 2
  assert.equal(armazem.lerContadores(G).get('a'), 13);
  const [linha] = armazem.contadoresPendentes();
  const conta = armazem.contaDaSubida({ local: linha.quantidade, espelhado: linha.espelhado, nuvem: 18, absoluto: false });
  assert.deepEqual(conta, { gravar: 13, somarAqui: 0 });
  armazem.contadorSubiu(linha, { gravado: conta.gravar, somarAqui: conta.somarAqui });
  assert.equal(armazem.contadoresPendentes().length, 0);
  armazem.contadorDaNuvem(G, 'a', 13); // eco da própria subida
  assert.equal(armazem.lerContadores(G).get('a'), 13);
});
