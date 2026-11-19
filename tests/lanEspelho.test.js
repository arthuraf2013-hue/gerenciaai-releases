const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const armazem = require('../electron/services/lanArmazemService');
const espelho = require('../electron/services/lanEspelhoService');
const disjuntor = require('../electron/services/nuvemDisjuntorService');

const G = 'grupo-teste-0002';

// Nuvem falsa: guarda escutas e o que foi gravado.
function nuvemFalsa() {
  const n = { escutas: {}, gravados: [], contadores: new Map(), aoGravarContador: null };
  n.api = {
    escutarColecao: (_g, colecao, aoMudar) => { n.escutas[colecao] = aoMudar; return () => {}; },
    escutarVendas: (_g, _d, aoMudar) => { n.escutas.vendas = aoMudar; return () => {}; },
    escutarEstoque: (_g, aoMudar) => { n.escutas.estoque = aoMudar; return () => {}; },
    gravarLote: async (_g, itens) => { n.gravados.push(...itens.map((i) => [i.colecao, i.docId])); },
    subirContador: async (_g, produtoId, calcular) => {
      const atual = n.contadores.has(produtoId) ? n.contadores.get(produtoId) : null;
      const gravado = calcular(atual);
      if (n.aoGravarContador) n.aoGravarContador(produtoId, gravado);
      n.contadores.set(produtoId, gravado);
      return { gravado, nuvem: atual };
    },
  };
  return n;
}

test('espelho: fica pronto quando todas as coleções chegaram da nuvem uma vez', () => {
  freshTestDb();
  disjuntor._zerarParaTeste();
  const n = nuvemFalsa();
  espelho._definirNuvemParaTeste(n.api);
  espelho.iniciar(G);
  assert.equal(espelho.pronto(G), false);
  for (const c of ['produtos', 'clientes', 'fiado', 'usuarios']) n.escutas[c](new Map(c === 'produtos' ? [['p1', { nome: 'Arroz', versaoMs: 1 }]] : []));
  assert.equal(espelho.pronto(G), false, 'falta o estoque');
  n.escutas.estoque(new Map([['p1', 7]]));
  assert.equal(espelho.pronto(G), true);
  assert.equal(armazem.lerTodos(G, 'produtos').get('p1').nome, 'Arroz');
  assert.equal(armazem.lerContadores(G).get('p1'), 7);
  espelho.parar();
});

test('espelho: sobe o que os caixas gravaram, num lote, e só com cota', async () => {
  freshTestDb();
  disjuntor._zerarParaTeste();
  const n = nuvemFalsa();
  espelho._definirNuvemParaTeste(n.api);
  espelho.iniciar(G);
  armazem.gravar(G, 'produtos', [{ docId: 'p1', dados: { nome: 'A', versaoMs: 5 } }, { docId: 'p2', dados: { nome: 'B', versaoMs: 5 } }]);
  disjuntor.registrarFaltaDeCota({ tipo: 'escrita' });
  assert.equal(await espelho.subirPendentes(), 0, 'sem cota: fica na cópia');
  disjuntor.registrarEscritaOk();
  assert.equal(await espelho.subirPendentes(), 2);
  assert.deepEqual(n.gravados.sort(), [['produtos', 'p1'], ['produtos', 'p2']]);
  assert.equal(armazem.pendentesParaNuvem().length, 0);
  espelho.parar();
});

test('espelho: estoque soma a venda feita direto na nuvem e ignora o eco da própria subida', async () => {
  freshTestDb();
  disjuntor._zerarParaTeste();
  const n = nuvemFalsa();
  espelho._definirNuvemParaTeste(n.api);
  espelho.iniciar(G);
  n.contadores.set('p1', 10);
  n.escutas.estoque(new Map([['p1', 10]]));
  armazem.verificarEDebitar(G, [{ productId: 'p1', quantidade: 3 }], 'v1'); // venda na rede local: 7
  // Durante a subida, a escuta recebe o eco (o valor que esta cópia gravou).
  n.aoGravarContador = (produtoId, gravado) => n.escutas.estoque(new Map([[produtoId, gravado]]));
  await espelho.subirPendentes();
  assert.equal(n.contadores.get('p1'), 7);
  assert.equal(armazem.lerContadores(G).get('p1'), 7, 'o eco não contou como venda de outro caixa');
  // Um caixa fora da rede vendeu 2 direto na nuvem.
  n.aoGravarContador = null;
  n.contadores.set('p1', 5);
  n.escutas.estoque(new Map([['p1', 5]]));
  assert.equal(armazem.lerContadores(G).get('p1'), 5);
  // Venda daqui + outra direto na nuvem antes de subir: a subida soma as duas.
  armazem.verificarEDebitar(G, [{ productId: 'p1', quantidade: 1 }], 'v2'); // 4 aqui
  n.contadores.set('p1', 4); // fora da rede vendeu 1 (escuta ainda não chegou)
  await espelho.subirPendentes();
  assert.equal(n.contadores.get('p1'), 3);
  assert.equal(armazem.lerContadores(G).get('p1'), 3);
  // A escuta entrega em ordem e sempre termina no valor atual: a mudança
  // velha (4) e depois o eco da subida (3). No fim, nada a mais nem a menos.
  n.escutas.estoque(new Map([['p1', 4]]));
  n.escutas.estoque(new Map([['p1', 3]]));
  assert.equal(armazem.lerContadores(G).get('p1'), 3);
  espelho.parar();
});
