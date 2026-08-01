const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getDb } = require('../db/database');
const secrets = require('./secretsService');
const { gerarXmlNFCe } = require('./nfceXmlService');

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
 * Ponto de emissão de NFC-e. Gera o XML completo (estrutura, valores,
 * chave de acesso) e salva em disco — mas AINDA NÃO assina
 * digitalmente nem transmite pra SEFAZ. Ver README, seção "Fiscal",
 * pra entender exatamente o que falta e por quê:
 *   1) assinar o XML com o certificado digital (A1/A3) da empresa —
 *      próxima fase, precisa de teste com o certificado real;
 *   2) transmitir ao webservice correto (varia por estado/grupo);
 *   3) tratar autorização, rejeição, contingência e cancelamento;
 *   4) gerar o QR Code (depende do CSC e da URL específica do estado).
 * Fingir que isso já emite de verdade sem testar contra o ambiente de
 * homologação real geraria documentos fiscais inválidos — por isso
 * este método gera e guarda o XML como "pendente", em vez de simular
 * autorização.
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

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'finalizada') {
    return { ok: false, error: 'Só é possível emitir NFC-e de uma venda já finalizada (com pagamento).' };
  }

  const items = db.prepare(
    `SELECT si.*, p.nome, p.sku, p.codigo_barras, p.ncm, p.cfop, p.cst_csosn, p.origem_mercadoria, p.unidade
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ?`
  ).all(saleId);
  const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);

  const numero = config.proximo_numero_nfce || 1;

  let xml, chaveAcesso;
  try {
    ({ xml, chaveAcesso } = gerarXmlNFCe({
      config, sale, items, payments, numero, dataEmissao: new Date(sale.finalizada_em),
    }));
  } catch (err) {
    return { ok: false, error: `Erro ao montar o XML: ${err.message}` };
  }

  // Salva o XML em disco, separado por ambiente (nunca mistura teste
  // com produção, mesmo que troque a config depois).
  const pastaDestino = path.join(app.getPath('userData'), 'nfce', config.ambiente);
  fs.mkdirSync(pastaDestino, { recursive: true });
  const xmlPath = path.join(pastaDestino, `${chaveAcesso}.xml`);
  fs.writeFileSync(xmlPath, xml, 'utf-8');

  const id = randomUUID();
  db.prepare(
    `INSERT INTO nfce_emitidas (id, sale_id, numero, serie, chave_acesso, status, ambiente, xml_path)
     VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)`
  ).run(id, saleId, numero, config.serie_nfce, chaveAcesso, config.ambiente, xmlPath);

  // Só incrementa o número DEPOIS de gerar com sucesso — se desse erro
  // antes, o número não é "queimado" à toa.
  db.prepare(`UPDATE fiscal_config SET proximo_numero_nfce = ? WHERE id = 'default'`).run(numero + 1);

  return {
    ok: true,
    xmlGerado: true,
    transmitido: false,
    numero,
    chaveAcesso,
    xmlPath,
    aviso: 'XML gerado e salvo com sucesso — mas ainda NÃO foi assinado nem transmitido pra SEFAZ ' +
      '(essa parte ainda está em desenvolvimento). A venda já está registrada normalmente independente disso.',
  };
}

function listNfceForSale(saleId) {
  const db = getDb();
  return db.prepare('SELECT * FROM nfce_emitidas WHERE sale_id = ? ORDER BY criado_em DESC').all(saleId);
}

module.exports = { getFiscalConfigPublic, updateFiscalConfig, emitirNFCe, listNfceForSale };
