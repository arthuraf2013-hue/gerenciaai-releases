const test = require('node:test');
const assert = require('node:assert/strict');
const { pedidoNovo, marcaParaMs } = require('../electron/services/sincronizacaoForcadaService');

// Botão "Forçar atualização dos dados" (Central): o pedido vale enquanto for
// mais novo que a última resposta da máquina (sincronizacaoFeitaEm), e não
// repete dentro da mesma execução.
test('pedido de sincronização: atende só o que ainda não foi respondido', () => {
  assert.equal(pedidoNovo(null, null, null), false, 'sem pedido, nada');
  assert.equal(pedidoNovo(1500, null, null), true, 'pedido sem resposta nenhuma (inclusive feito com o app fechado)');
  assert.equal(pedidoNovo(1500, 1600, null), false, 'a máquina já respondeu depois do pedido');
  assert.equal(pedidoNovo(1500, 1500, null), false, 'resposta no mesmo instante conta como respondido');
  assert.equal(pedidoNovo(2000, 1600, null), true, 'pedido novo depois da última resposta');
  assert.equal(pedidoNovo(2000, 1600, 2000), false, 'o mesmo pedido não repete enquanto roda');
  assert.equal(pedidoNovo(2500, 1600, 2000), true, 'outro pedido, mais novo, atende');
});

test('pedido de sincronização: lê Timestamp do Firestore e data', () => {
  assert.equal(marcaParaMs({ toMillis: () => 42 }), 42);
  assert.equal(marcaParaMs(new Date(7)), 7);
  assert.equal(marcaParaMs(null), null);
  assert.equal(marcaParaMs('lixo'), null);
});
