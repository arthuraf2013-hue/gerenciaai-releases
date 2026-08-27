const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
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

// getNomeNegocio -- usado pra personalizar a saudação do bot do WhatsApp
// com o nome do negócio do cliente (nome_fantasia já existente, usado
// também no <xFant> da NFC-e).

test('getNomeNegocio retorna null quando nome_fantasia ainda não foi preenchido', () => {
  freshTestDb();
  assert.equal(fiscalService.getNomeNegocio(), null);
});

test('getNomeNegocio retorna o nome fantasia já configurado', () => {
  const { adminId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, { nomeFantasia: 'Farmácia Boa Saúde' });
  assert.equal(fiscalService.getNomeNegocio(), 'Farmácia Boa Saúde');
});

test('getNomeNegocio recorta espaços em volta e trata string em branco como não preenchido', () => {
  const { adminId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, { nomeFantasia: '   ' });
  assert.equal(fiscalService.getNomeNegocio(), null);
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

/** Insere uma venda finalizada + uma linha de nfce_emitidas direto no
 * banco de teste — evita ter que passar por todo o ciclo de emissão
 * (que bateria na rede de verdade) só pra testar as regras de negócio
 * de cancelamento (status, prazo, autorização). */
function inserirNfceDeTeste(db, { operadorId, status = 'autorizada', criadoEm, protocolo = '135260000000001' }) {
  const saleId = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, finalizada_em)
     VALUES (?, (SELECT id FROM locations LIMIT 1), ?, 'finalizada', 10, datetime('now'))`
  ).run(saleId, operadorId);

  const nfceId = randomUUID();
  db.prepare(
    `INSERT INTO nfce_emitidas (id, sale_id, numero, serie, chave_acesso, protocolo_autorizacao, status, ambiente, criado_em)
     VALUES (?, ?, 1, '1', '35260800000000019100650010000000011234567890', ?, ?, 'homologacao', ?)`
  ).run(nfceId, saleId, protocolo, status, criadoEm || new Date().toISOString());

  return nfceId;
}

test('cancelarNFCe recusa sem autorização de gerente válida', async () => {
  const { db, operadorId } = freshTestDb();
  const nfceId = inserirNfceDeTeste(db, { operadorId });
  const result = await fiscalService.cancelarNFCe(nfceId, {
    justificativa: 'Cliente desistiu da compra, item devolvido no ato.',
    currentOperatorId: operadorId, candidateManagerId: null, pin: '0000',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /autorização/i);
});

test('cancelarNFCe recusa PIN errado do gerente', async () => {
  const { db, operadorId, gerenteId } = freshTestDb();
  const nfceId = inserirNfceDeTeste(db, { operadorId });
  const result = await fiscalService.cancelarNFCe(nfceId, {
    justificativa: 'Cliente desistiu da compra, item devolvido no ato.',
    currentOperatorId: operadorId, candidateManagerId: gerenteId, pin: 'pin-errado',
  });
  assert.equal(result.ok, false);
});

test('cancelarNFCe recusa NFC-e que não está autorizada', async () => {
  const { db, operadorId, gerenteId } = freshTestDb();
  const nfceId = inserirNfceDeTeste(db, { operadorId, status: 'pendente' });
  const result = await fiscalService.cancelarNFCe(nfceId, {
    justificativa: 'Cliente desistiu da compra, item devolvido no ato.',
    currentOperatorId: operadorId, candidateManagerId: gerenteId, pin: '1234',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /autorizada/i);
});

test('cancelarNFCe recusa fora do prazo legal de 24h', async () => {
  const { db, operadorId, gerenteId } = freshTestDb();
  const maisDe24hAtras = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const nfceId = inserirNfceDeTeste(db, { operadorId, criadoEm: maisDe24hAtras });
  const result = await fiscalService.cancelarNFCe(nfceId, {
    justificativa: 'Cliente desistiu da compra, item devolvido no ato.',
    currentOperatorId: operadorId, candidateManagerId: gerenteId, pin: '1234',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /prazo/i);
});

test('cancelarNFCe passa da checagem de autorização/prazo/status quando tudo é válido (falha só depois, na transmissão de rede)', async () => {
  const { db, adminId, operadorId, gerenteId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, { uf: 'SP', cnpj: '00000000000191' });
  const nfceId = inserirNfceDeTeste(db, { operadorId });
  const result = await fiscalService.cancelarNFCe(nfceId, {
    justificativa: 'Cliente desistiu da compra, item devolvido no ato.',
    currentOperatorId: operadorId, candidateManagerId: gerenteId, pin: '1234',
  });
  // Sem certificado configurado, cai no catch de "abrir certificado" --
  // o importante aqui é que passou de TODAS as checagens de negócio
  // (autorização, status, prazo) sem cair nelas primeiro.
  assert.equal(result.ok, false);
  assert.match(result.error, /certificado/i);
});

test('inutilizarNumeracao recusa gerente (só admin pode)', async () => {
  const { gerenteId } = freshTestDb();
  const result = await fiscalService.inutilizarNumeracao({
    serie: '1', numeroInicial: 10, numeroFinal: 12,
    justificativa: 'Numeração pulada por erro do app.',
    requestingUserId: gerenteId,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('inutilizarNumeracao valida a justificativa antes de tocar no certificado', async () => {
  const { adminId } = freshTestDb();
  fiscalService.updateFiscalConfig(adminId, { uf: 'SP', cnpj: '00000000000191' });
  const result = await fiscalService.inutilizarNumeracao({
    serie: '1', numeroInicial: 10, numeroFinal: 12,
    justificativa: 'curta',
    requestingUserId: adminId,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /15 caracteres/i);
});

test('reenviarNFCe aceita status "contingencia", não só "pendente"', async () => {
  const { db, operadorId } = freshTestDb();
  const nfceId = inserirNfceDeTeste(db, { operadorId, status: 'contingencia' });
  db.prepare(`UPDATE nfce_emitidas SET xml_path = '/tmp/xml-inexistente.xml' WHERE id = ?`).run(nfceId);
  const result = await fiscalService.reenviarNFCe(nfceId);
  // Não chega a transmitir de verdade (sem certificado configurado /
  // XML inexistente) — o que importa é que NÃO caiu no early-return de
  // "só dá pra reenviar as pendentes", que era o comportamento antigo.
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /só dá pra reenviar/i);
});

test('listNfcePendentesOuContingencia traz as duas situações, não só pendente', () => {
  const { db, operadorId } = freshTestDb();
  inserirNfceDeTeste(db, { operadorId, status: 'pendente' });
  inserirNfceDeTeste(db, { operadorId, status: 'contingencia' });
  inserirNfceDeTeste(db, { operadorId, status: 'autorizada' });
  const lista = fiscalService.listNfcePendentesOuContingencia();
  assert.equal(lista.length, 2);
  assert.deepEqual(lista.map((n) => n.status).sort(), ['contingencia', 'pendente']);
});
