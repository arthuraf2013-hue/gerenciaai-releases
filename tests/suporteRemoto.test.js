const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../electron/services/suporteRemotoProtocolo');

test('código tem 6 dígitos, nunca começa com zero, e varia', () => {
  const vistos = new Set();
  for (let i = 0; i < 200; i++) {
    const c = P.gerarCodigo();
    assert.match(c, /^[1-9]\d{5}$/, `código fora do formato: ${c}`);
    vistos.add(c);
  }
  assert.ok(vistos.size > 1, 'gerou sempre o mesmo código');
});

test('segredo não supervisionado: grupos de 4, sem caracteres ambíguos', () => {
  const s = P.gerarSegredoNaoSupervisionado();
  assert.match(s, /^[A-Z2-9]{4}(-[A-Z2-9]{4})+$/);
  assert.ok(!/[IO01]/.test(s), 'tem caractere ambíguo');
});

test('hash/verify: valor certo passa, errado não; sal diferente a cada hash', () => {
  const codigo = P.gerarCodigo();
  const h1 = P.hashSegredo(codigo);
  const h2 = P.hashSegredo(codigo);
  assert.notEqual(h1.sal, h2.sal, 'sal deveria ser aleatório por hash');
  assert.notEqual(h1.hash, h2.hash, 'hash deveria diferir com sal diferente');
  assert.equal(P.verificarSegredo(codigo, h1), true);
  assert.equal(P.verificarSegredo('000000', h1), false);
  assert.equal(P.verificarSegredo(codigo + '1', h1), false);
});

test('verify é resistente a entrada faltando', () => {
  assert.equal(P.verificarSegredo('', { sal: 'aa', hash: 'bb' }), false);
  assert.equal(P.verificarSegredo('123456', {}), false);
  assert.equal(P.verificarSegredo('123456', { sal: 'zz', hash: 'zz' }), false); // hex inválido -> false, sem lançar
});

test('limite de tentativas', () => {
  assert.deepEqual(P.avaliarTentativa(0, 5), { bloqueado: false, restantes: 5 });
  assert.deepEqual(P.avaliarTentativa(4, 5), { bloqueado: false, restantes: 1 });
  assert.deepEqual(P.avaliarTentativa(5, 5), { bloqueado: true, restantes: 0 });
  assert.deepEqual(P.avaliarTentativa(9, 5), { bloqueado: true, restantes: 0 });
});

test('validade do código', () => {
  const agora = 1_000_000_000_000;
  assert.equal(P.codigoValido(agora, agora), true);
  assert.equal(P.codigoValido(agora, agora + P.DURACAO_CODIGO_MS - 1), true);
  assert.equal(P.codigoValido(agora, agora + P.DURACAO_CODIGO_MS + 1), false);
  assert.equal(P.codigoValido(NaN, agora), false);
});

test('máquina de estados só deixa transição válida', () => {
  const { ESTADOS: E } = P;
  assert.equal(P.transicaoPermitida(E.OCIOSO, E.AGUARDANDO), true);
  assert.equal(P.transicaoPermitida(E.AGUARDANDO, E.NEGOCIANDO), true);
  assert.equal(P.transicaoPermitida(E.NEGOCIANDO, E.ATIVA), true);
  assert.equal(P.transicaoPermitida(E.ATIVA, E.ENCERRADA), true);
  // pular o código (NEGOCIANDO) e ir direto pra ATIVA a partir de AGUARDANDO: não
  assert.equal(P.transicaoPermitida(E.AGUARDANDO, E.ATIVA), false);
  // "autenticar" de novo numa sessão já ativa não reabre negociação
  assert.equal(P.transicaoPermitida(E.ATIVA, E.NEGOCIANDO), false);
  assert.equal(P.transicaoPermitida(E.OCIOSO, E.ATIVA), false);
  assert.equal(P.transicaoPermitida(E.ATIVA, E.ATIVA), true); // idempotente
});

test('fatiar e remontar arquivo bate byte a byte', () => {
  const crypto = require('crypto');
  for (const tam of [0, 1, P.CHUNK_BYTES - 1, P.CHUNK_BYTES, P.CHUNK_BYTES + 1, P.CHUNK_BYTES * 3 + 7]) {
    const buf = crypto.randomBytes(tam);
    const partes = P.fatiarBuffer(buf);
    assert.equal(partes.length, P.numeroDeFatias(tam), `nº de fatias errado pra ${tam}`);
    const volta = P.remontarPartes(partes);
    assert.equal(volta.length, buf.length, `tamanho errado pra ${tam}`);
    assert.ok(volta.equals(buf), `conteúdo diferente pra ${tam}`);
  }
});

test('sanitizarComando: corta no tamanho e tira byte nulo', () => {
  assert.equal(P.sanitizarComando('dir\0; rm'), 'dir; rm');
  assert.equal(P.sanitizarComando('a'.repeat(P.COMANDO_MAX_LEN + 50)).length, P.COMANDO_MAX_LEN);
  assert.equal(P.sanitizarComando(null), '');
});

test('correção só aceita ação conhecida, com rótulo', () => {
  assert.equal(P.correcaoValida('limpar_cache_busca'), true);
  assert.equal(P.correcaoValida('rm_rf_tudo'), false);
  for (const a of P.CORRECOES) assert.ok(P.ROTULO_CORRECAO[a], `sem rótulo pra ${a}`);
});
