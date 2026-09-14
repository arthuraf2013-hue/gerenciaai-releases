const test = require('node:test');
const assert = require('node:assert/strict');
const sessionService = require('../electron/services/sessionService');

test('resolverUsuarioLogado devolve null pra uma janela que nunca fez login', () => {
  const resultado = sessionService.resolverUsuarioLogado({ sender: { id: 999001 } });
  assert.equal(resultado, null);
});

test('iniciarSessao + resolverUsuarioLogado devolvem o usuário logado nesta janela', () => {
  sessionService.iniciarSessao(999002, { id: 'user-abc', nome: 'Fulano', role: 'gerente' });
  const resultado = sessionService.resolverUsuarioLogado({ sender: { id: 999002 } });
  assert.equal(resultado.id, 'user-abc');
  assert.equal(resultado.role, 'gerente');
  sessionService.encerrarSessao(999002);
});

test('encerrarSessao limpa a sessão -- a janela volta a não ter usuário logado', () => {
  sessionService.iniciarSessao(999003, { id: 'user-xyz', nome: 'Ciclana', role: 'admin' });
  sessionService.encerrarSessao(999003);
  const resultado = sessionService.resolverUsuarioLogado({ sender: { id: 999003 } });
  assert.equal(resultado, null);
});

test('sessões de janelas diferentes são isoladas -- login numa não vaza pra outra', () => {
  sessionService.iniciarSessao(999004, { id: 'user-A', nome: 'A', role: 'operador' });
  sessionService.iniciarSessao(999005, { id: 'user-B', nome: 'B', role: 'admin' });

  assert.equal(sessionService.resolverUsuarioLogado({ sender: { id: 999004 } }).id, 'user-A');
  assert.equal(sessionService.resolverUsuarioLogado({ sender: { id: 999005 } }).id, 'user-B');

  sessionService.encerrarSessao(999004);
  sessionService.encerrarSessao(999005);
});

test('um segundo login na MESMA janela sobrescreve a sessão anterior (troca de operador)', () => {
  sessionService.iniciarSessao(999006, { id: 'user-antigo', nome: 'Antigo', role: 'operador' });
  sessionService.iniciarSessao(999006, { id: 'user-novo', nome: 'Novo', role: 'gerente' });

  const resultado = sessionService.resolverUsuarioLogado({ sender: { id: 999006 } });
  assert.equal(resultado.id, 'user-novo');
  sessionService.encerrarSessao(999006);
});

test('resolverUsuarioLogado devolve null quando o event não tem sender (chamada fora de uma janela)', () => {
  assert.equal(sessionService.resolverUsuarioLogado({}), null);
  assert.equal(sessionService.resolverUsuarioLogado(undefined), null);
});
