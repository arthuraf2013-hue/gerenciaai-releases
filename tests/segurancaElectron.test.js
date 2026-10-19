const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { urlExternaPermitida, navegacaoPermitida, resolverDentroDe, CSP_APP } = require('../electron/seguranca');

test('só abre fora do app endereços web, e-mail, telefone e WhatsApp', () => {
  for (const ok of ['https://wa.me/5581999999999?text=oi', 'http://exemplo.com', 'mailto:a@b.com', 'tel:+5581', 'whatsapp://send?phone=1']) assert.equal(urlExternaPermitida(ok), true, ok);
  for (const ruim of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'smb://servidor/x', 'ms-msdt:/id', 'app://app/index.html', 'qualquer coisa', null]) assert.equal(urlExternaPermitida(ruim), false, String(ruim));
});

test('a janela só navega dentro do app (e no Vite em desenvolvimento)', () => {
  assert.equal(navegacaoPermitida('app://app/index.html'), true);
  assert.equal(navegacaoPermitida('https://evil.example/'), false);
  assert.equal(navegacaoPermitida('app://outro/index.html'), false);
  assert.equal(navegacaoPermitida('file:///etc/passwd'), false);
  assert.equal(navegacaoPermitida('http://localhost:5173/'), false);
  assert.equal(navegacaoPermitida('http://localhost:5173/', { isDev: true }), true);
});

test('app:// não serve arquivo fora de dist/ (barra codificada, ponto-ponto, byte nulo)', () => {
  const dist = path.join(__dirname, '..', 'dist');
  assert.equal(resolverDentroDe(dist, '/'), path.join(dist, 'index.html'));
  assert.equal(resolverDentroDe(dist, '/assets/index.js'), path.join(dist, 'assets', 'index.js'));
  for (const ataque of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/electron/main.js', '/..%5c..%5cpackage.json', '/a%00.js', '/%E0%A4%A']) {
    assert.equal(resolverDentroDe(dist, ataque), null, ataque);
  }
});

test('CSP da interface não permite script inline nem de fora', () => {
  assert.match(CSP_APP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(CSP_APP, /script-src[^;]*unsafe-(inline|eval)/);
  assert.match(CSP_APP, /base-uri 'none'/);
});
