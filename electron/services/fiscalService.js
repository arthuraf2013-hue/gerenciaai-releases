const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const secrets = require('./secretsService');

function getFiscalConfig() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM fiscal_config WHERE id = ?').get('default');
  return {
    ...row,
    certificado_senha: secrets.decrypt(row.certificado_senha),
    csc_token: secrets.decrypt(row.csc_token),
    endereco: JSON.parse(row.endereco_json || '{}'),
  };
}

/** Nunca devolve a senha do certificado/token CSC para o renderer. */
function getFiscalConfigPublic() {
  const config = getFiscalConfig();
  const { certificado_senha, csc_token, ...safe } = config;
  return {
    ...safe,
    temCertificadoConfigurado: !!config.certificado_path,
    temCscConfigurado: !!config.csc_token,
  };
}

function updateFiscalConfig(payload) {
  const db = getDb();
  const current = getFiscalConfig();

  db.prepare(
    `UPDATE fiscal_config SET
       cnpj = ?, inscricao_estadual = ?, razao_social = ?, nome_fantasia = ?,
       regime_tributario = ?, uf = ?, municipio_codigo_ibge = ?, endereco_json = ?,
       certificado_path = ?, certificado_senha = ?, ambiente = ?, serie_nfce = ?,
       csc_id = ?, csc_token = ?
     WHERE id = 'default'`
  ).run(
    payload.cnpj ?? current.cnpj,
    payload.inscricaoEstadual ?? current.inscricao_estadual,
    payload.razaoSocial ?? current.razao_social,
    payload.nomeFantasia ?? current.nome_fantasia,
    payload.regimeTributario ?? current.regime_tributario,
    payload.uf ?? current.uf,
    payload.municipioCodigoIbge ?? current.municipio_codigo_ibge,
    payload.endereco ? JSON.stringify(payload.endereco) : current.endereco_json,
    payload.certificadoPath !== undefined ? payload.certificadoPath : current.certificado_path,
    payload.certificadoSenha !== undefined ? secrets.encrypt(payload.certificadoSenha) : secrets.encrypt(current.certificado_senha),
    payload.ambiente ?? current.ambiente,
    payload.serieNfce ?? current.serie_nfce,
    payload.cscId !== undefined ? payload.cscId : current.csc_id,
    payload.cscToken !== undefined ? secrets.encrypt(payload.cscToken) : secrets.encrypt(current.csc_token)
  );

  return { ok: true };
}

function configuracaoCompleta(config) {
  const faltando = [];
  if (!config.cnpj) faltando.push('CNPJ');
  if (!config.inscricao_estadual) faltando.push('Inscrição Estadual');
  if (!config.uf) faltando.push('UF');
  if (!config.regime_tributario) faltando.push('Regime tributário');
  if (!config.municipio_codigo_ibge) faltando.push('Código IBGE do município');
  if (!config.endereco?.logradouro || !config.endereco?.numero || !config.endereco?.bairro || !config.endereco?.cep) {
    faltando.push('Endereço completo (logradouro, número, bairro, CEP)');
  }
  if (!config.certificado_path) faltando.push('Certificado digital');
  if (!config.csc_token) faltando.push('CSC (Código de Segurança do Contribuinte)');
  return faltando;
}

/**
 * Ponto de emissão de NFC-e. DELIBERADAMENTE NÃO IMPLEMENTADO ainda —
 * ver README, seção "Fiscal". Emitir uma NFC-e de verdade exige:
 *   1) assinar o XML com o certificado digital (A1/A3) da empresa;
 *   2) montar o XML no layout 4.00 exigido pela SEFAZ do estado (uf);
 *   3) transmitir ao webservice correto (varia por estado/grupo de estados);
 *   4) tratar autorização, rejeição, contingência e cancelamento;
 *   5) gerar o QR Code da NFC-e usando o CSC do estado.
 * Fingir que isso funciona sem testar contra o ambiente de homologação
 * real geraria documentos fiscais inválidos — por isso este método apenas
 * valida a configuração e explica o que falta, em vez de simular sucesso.
 */
async function emitirNFCe(saleId) {
  const db = getDb();
  const config = getFiscalConfig();
  const faltando = configuracaoCompleta(config);

  if (faltando.length > 0) {
    return {
      ok: false,
      error: `Configuração fiscal incompleta. Faltando: ${faltando.join(', ')}. Preencha em Configurações → Fiscal.`,
    };
  }

  // Registra a tentativa como pendente para manter o rastro, mesmo sem
  // conseguir emitir de verdade ainda.
  const id = randomUUID();
  db.prepare(
    `INSERT INTO nfce_emitidas (id, sale_id, status, ambiente) VALUES (?, ?, 'pendente', ?)`
  ).run(id, saleId, config.ambiente);

  return {
    ok: false,
    error: 'Emissão de NFC-e ainda não implementada nesta versão — a configuração está completa, ' +
      'mas falta desenvolver e testar a assinatura/transmissão do XML contra a SEFAZ. ' +
      'Ver README para o que fazer a seguir.',
  };
}

function listNfceForSale(saleId) {
  const db = getDb();
  return db.prepare('SELECT * FROM nfce_emitidas WHERE sale_id = ? ORDER BY criado_em DESC').all(saleId);
}

module.exports = { getFiscalConfigPublic, updateFiscalConfig, emitirNFCe, listNfceForSale };
