const test = require('node:test');
const assert = require('node:assert/strict');
const {
  montarConteudoQrCode, montarUrlQrCode, formatarChaveAcesso, VERSAO_QRCODE,
} = require('../electron/services/nfceQrCodeService');

const CHAVE = '35260800000000019100650010000000011234567890';

test('VERSAO_QRCODE é "3" (layout obrigatório em produção desde 01/09/2025, NT 2025.001)', () => {
  assert.equal(VERSAO_QRCODE, '3');
});

test('montarConteudoQrCode monta chave|3|tpAmb, tpAmb=2 pra homologação', () => {
  assert.equal(montarConteudoQrCode({ chaveAcesso: CHAVE, ambiente: 'homologacao' }), `${CHAVE}|3|2`);
});

test('montarConteudoQrCode usa tpAmb=1 pra produção', () => {
  assert.equal(montarConteudoQrCode({ chaveAcesso: CHAVE, ambiente: 'producao' }), `${CHAVE}|3|1`);
});

test('montarConteudoQrCode rejeita chave que não tem 44 dígitos', () => {
  assert.throws(() => montarConteudoQrCode({ chaveAcesso: '123', ambiente: 'homologacao' }), /44 dígitos/);
});

test('montarUrlQrCode devolve null sem URL de consulta configurada', () => {
  assert.equal(montarUrlQrCode({ chaveAcesso: CHAVE, ambiente: 'homologacao', urlConsulta: null }), null);
  assert.equal(montarUrlQrCode({ chaveAcesso: CHAVE, ambiente: 'homologacao', urlConsulta: '' }), null);
});

test('montarUrlQrCode monta a URL completa', () => {
  const url = montarUrlQrCode({ chaveAcesso: CHAVE, ambiente: 'producao', urlConsulta: 'https://www.nfce.fazenda.sp.gov.br/qrcode' });
  assert.equal(url, `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${CHAVE}|3|1`);
});

test('montarUrlQrCode tolera URL de consulta salva com barra ou query já no fim', () => {
  const comBarra = montarUrlQrCode({ chaveAcesso: CHAVE, ambiente: 'homologacao', urlConsulta: 'https://exemplo.gov.br/nfce/qrcode/' });
  assert.equal(comBarra, `https://exemplo.gov.br/nfce/qrcode?p=${CHAVE}|3|2`);

  const comQuery = montarUrlQrCode({ chaveAcesso: CHAVE, ambiente: 'homologacao', urlConsulta: 'https://exemplo.gov.br/nfce/qrcode?p=' });
  assert.equal(comQuery, `https://exemplo.gov.br/nfce/qrcode?p=${CHAVE}|3|2`);
});

test('formatarChaveAcesso separa em grupos de 4 dígitos', () => {
  assert.equal(formatarChaveAcesso(CHAVE), '3526 0800 0000 0001 9100 6500 1000 0000 0112 3456 7890');
});

test('formatarChaveAcesso não quebra com valor vazio/nulo', () => {
  assert.equal(formatarChaveAcesso(null), '');
  assert.equal(formatarChaveAcesso(undefined), '');
});
