const test = require('node:test');
const assert = require('node:assert/strict');
const sefaz = require('../electron/services/rejeicoesSefaz');
const { crtDoRegime } = require('../electron/services/nfceXmlService');

test('CRT: MEI 4 (NT 2024.001), Simples 1, regime normal 3', () => {
  assert.equal(crtDoRegime('mei'), '4');
  assert.equal(crtDoRegime('simples_nacional'), '1');
  assert.equal(crtDoRegime('lucro_presumido'), '3');
  assert.equal(crtDoRegime('lucro_real'), '3');
});

test('SEFAZ: 100 e 150 são autorização; rejeição vira explicação com o que fazer', () => {
  assert.equal(sefaz.autorizado('100'), true);
  assert.equal(sefaz.autorizado('150'), true);
  assert.equal(sefaz.autorizado('204'), false);
  assert.match(sefaz.explicar('778', 'Rejeicao: Informado NCM inexistente'), /NCM.*Cadastro fiscal.*SEFAZ 778/);
  assert.match(sefaz.explicar('999', 'Erro nao catalogado'), /código 999.*suporte/);
  assert.match(sefaz.explicar('', ''), /não autorizou/);
});
