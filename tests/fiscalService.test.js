const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const fiscalService = require('../electron/services/fiscalService');

// A aba Fiscal só aparece em Configurações, que é admin-only no menu — o
// backend precisa recusar qualquer outro papel também, não só confiar que
// a tela escondeu o link.

test('updateFiscalConfig recusa gerente', () => {
  const { gerenteId } = freshTestDb();
  const result = fiscalService.updateFiscalConfig(gerenteId, { cnpj: '00000000000191' });
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('updateFiscalConfig recusa operador', () => {
  const { operadorId } = freshTestDb();
  const result = fiscalService.updateFiscalConfig(operadorId, { cnpj: '00000000000191' });
  assert.equal(result.ok, false);
});

test('updateFiscalConfig funciona pra admin e o valor realmente é salvo', () => {
  const { adminId } = freshTestDb();
  const result = fiscalService.updateFiscalConfig(adminId, { cnpj: '00000000000191' });
  assert.equal(result.ok, true);
  assert.equal(fiscalService.getFiscalConfigPublic().cnpj, '00000000000191');
});

test('updateFiscalConfig salva a URL de consulta do QR Code', () => {
  const { adminId } = freshTestDb();
  const result = fiscalService.updateFiscalConfig(adminId, { qrCodeUrl: 'https://www.nfce.fazenda.sp.gov.br/qrcode' });
  assert.equal(result.ok, true);
  assert.equal(fiscalService.getFiscalConfigPublic().qr_code_url, 'https://www.nfce.fazenda.sp.gov.br/qrcode');
});

// CSC deixou de ser exigido pra emitir (layout 3.00 do QR Code, NT
// 2025.001, não usa mais CSC) — configuração completa sem CSC não pode
// mais travar em "Configuração fiscal incompleta". Preenche tudo que
// `configuracaoCompleta` ainda cobra, SEM csc, e confirma que o erro que
// vem de `emitirNFCe` é por venda não existir (passou da checagem de
// config) e não por config incompleta.
test('emitirNFCe não exige mais CSC pra passar da checagem de configuração completa', () => {
  const { adminId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, {
    cnpj: '00000000000191', inscricaoEstadual: '123456', uf: 'SP', regimeTributario: 'simples_nacional',
    municipioCodigoIbge: '3550308', certificadoPath: '/tmp/certificado-inexistente.pfx',
    endereco: { logradouro: 'Rua Teste', numero: '1', bairro: 'Centro', cep: '00000000', municipio: 'São Paulo' },
  });
  return fiscalService.emitirNFCe('venda-que-nao-existe').then((result) => {
    assert.equal(result.ok, false);
    assert.match(result.error, /Venda não encontrada/);
    assert.doesNotMatch(result.error, /incompleta/i);
  });
});

test('getNfceMaisRecente devolve null quando a venda não tem nenhuma NFC-e', () => {
  freshTestDb();
  assert.equal(fiscalService.getNfceMaisRecente('venda-sem-nfce'), null);
});

test('getQrCodeUrlParaNfce devolve null se não tiver URL de consulta configurada, mesmo autorizada', () => {
  freshTestDb();
  const nfce = { status: 'autorizada', chave_acesso: '35260800000000019100650010000000011234567890', ambiente: 'homologacao' };
  assert.equal(fiscalService.getQrCodeUrlParaNfce(nfce), null);
});

test('getQrCodeUrlParaNfce devolve null se a NFC-e não estiver autorizada, mesmo com URL configurada', () => {
  const { adminId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, { qrCodeUrl: 'https://www.nfce.fazenda.sp.gov.br/qrcode' });
  const nfce = { status: 'pendente', chave_acesso: '35260800000000019100650010000000011234567890', ambiente: 'homologacao' };
  assert.equal(fiscalService.getQrCodeUrlParaNfce(nfce), null);
});

test('getQrCodeUrlParaNfce monta a URL certa quando autorizada e com URL de consulta configurada', () => {
  const { adminId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, { qrCodeUrl: 'https://www.nfce.fazenda.sp.gov.br/qrcode' });
  const chave = '35260800000000019100650010000000011234567890';
  const nfce = { status: 'autorizada', chave_acesso: chave, ambiente: 'homologacao' };
  assert.equal(
    fiscalService.getQrCodeUrlParaNfce(nfce),
    `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${chave}|3|2`
  );
});
