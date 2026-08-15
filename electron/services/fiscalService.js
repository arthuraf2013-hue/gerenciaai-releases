const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const secrets = require('./secretsService');
const { gerarXmlNFCe } = require('./nfceXmlService');
const { carregarCertificado } = require('./nfceCertificateService');
const { assinarXmlNFCe } = require('./nfceSignatureService');
const { enviarNFCe } = require('./nfceTransmissionService');
const { montarConteudoQrCode, montarUrlQrCode } = require('./nfceQrCodeService');

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

function updateFiscalConfig(requestingUserId, payload) {
  // Mesmo nível de acesso da aba Fiscal em Configurações (só admin) —
  // guarda também no backend, não só escondendo o botão na tela.
  const guard = require('./authService').requireRole(requestingUserId, ['admin']);
  if (!guard.ok) return guard;

  const db = getDb();
  const current = getFiscalConfig();

  db.prepare(
    `UPDATE fiscal_config SET
       cnpj = ?, inscricao_estadual = ?, razao_social = ?, nome_fantasia = ?,
       regime_tributario = ?, uf = ?, municipio_codigo_ibge = ?, endereco_json = ?,
       certificado_path = ?, certificado_senha = ?, ambiente = ?, serie_nfce = ?,
       csc_id = ?, csc_token = ?, qr_code_url = ?
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
    payload.cscToken !== undefined ? secrets.encrypt(payload.cscToken) : secrets.encrypt(current.csc_token),
    payload.qrCodeUrl !== undefined ? (payload.qrCodeUrl || null) : current.qr_code_url
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
  // CSC NÃO é mais exigido aqui — desde o layout 3.00 do QR Code (NT
  // 2025.001, obrigatório em produção desde 01/09/2025), o CSC deixou
  // de ser usado até pro QR Code (que era o único lugar que usava,
  // neste app) — ver electron/services/nfceQrCodeService.js. Manter
  // isso como exigência bloquearia emissão de NFC-e válida por causa
  // de um campo que a própria SEFAZ não pede mais.
  return faltando;
}

/**
 * Ponto de emissão de NFC-e. Faz o ciclo completo: gera o XML
 * (estrutura, valores, chave de acesso), assina digitalmente com o
 * certificado A1 configurado, grava em disco como "pendente", transmite
 * pra SEFAZ (síncrono — indSinc=1, padrão pra NFC-e) e atualiza o
 * status conforme a resposta (autorizada/rejeitada). Se a transmissão
 * falhar por comunicação (rede fora, SEFAZ indisponível), a NFC-e fica
 * registrada como "pendente" — já assinada e com o XML salvo — pronta
 * pra reenviar depois via `reenviarNFCe`, sem "queimar" o número.
 *
 * O que este ciclo NÃO cobre ainda (ver conversa com o Arthur em
 * 14/08/2026 — a documentação antiga deste arquivo dizia que nada
 * disso tinha sido feito, o que não é mais verdade; só o que segue
 * abaixo continua faltando de fato):
 *   1) cancelamento de NFC-e já autorizada;
 *   2) inutilização de numeração pulada;
 *   3) contingência (emissão offline quando a SEFAZ está fora do ar).
 * Cada uma dessas é uma peça de SOAP/XML própria (evento, não
 * autorização) e ainda não foi implementada — tratada como próxima
 * fase, não como algo que "já deveria funcionar".
 *
 * IMPORTANTE mesmo com o que já existe: nunca foi testado contra um
 * ambiente de homologação real da SEFAZ (certificado, CNPJ e CSC de
 * teste de verdade) — só foi possível validar aqui, isoladamente, a
 * estrutura do XML, a assinatura (formato exigido pelo MOC) e o
 * cálculo da chave de acesso. Teste em homologação antes de confiar em
 * produção.
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

  // Carrega o certificado e assina ANTES de gravar qualquer coisa —
  // se o certificado estiver com problema (senha errada, vencido,
  // arquivo sumiu), o número da NFC-e não é "queimado" à toa.
  let certificado, xmlAssinado;
  try {
    const senhaDescriptografada = secrets.decrypt(config.certificado_senha);
    certificado = carregarCertificado(config.certificado_path, senhaDescriptografada);
    if (certificado.validoAte.getTime() < Date.now()) {
      return { ok: false, error: `O certificado digital venceu em ${certificado.validoAte.toLocaleDateString('pt-BR')} — renove antes de emitir.` };
    }
    xmlAssinado = assinarXmlNFCe(xml, certificado);
  } catch (err) {
    return { ok: false, error: `Não foi possível assinar o XML com o certificado configurado: ${err.message}` };
  }

  // Só a partir daqui grava de verdade — o XML já está assinado, e o
  // número só é incrementado depois de garantir que chegou até aqui.
  // 'electron' carregado sob demanda -- ver comentário em attachmentService.js.
  const { app } = require('electron');
  const pastaDestino = path.join(app.getPath('userData'), 'nfce', config.ambiente);
  fs.mkdirSync(pastaDestino, { recursive: true });
  const xmlPath = path.join(pastaDestino, `${chaveAcesso}.xml`);
  fs.writeFileSync(xmlPath, xmlAssinado, 'utf-8');

  const id = randomUUID();
  db.prepare(
    `INSERT INTO nfce_emitidas (id, sale_id, numero, serie, chave_acesso, status, ambiente, xml_path)
     VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)`
  ).run(id, saleId, numero, config.serie_nfce, chaveAcesso, config.ambiente, xmlPath);
  db.prepare(`UPDATE fiscal_config SET proximo_numero_nfce = ? WHERE id = 'default'`).run(numero + 1);

  // Transmite pra SEFAZ — isso PODE falhar por rede/indisponibilidade
  // sem que seja um erro de verdade: a NFC-e já está gerada, assinada
  // e registrada como 'pendente' aqui, dá pra tentar de novo depois
  // (função separada, reenviarNFCe) sem perder o número nem o XML.
  try {
    const resultadoTransmissao = await enviarNFCe({ xmlNFeAssinado: xmlAssinado, config, certificado, idLote: numero });

    if (!resultadoTransmissao.ok) {
      return {
        ok: true, xmlGerado: true, assinado: true, transmitido: false, numero, chaveAcesso, xmlPath, id,
        aviso: `XML gerado, assinado e salvo — mas não foi possível transmitir agora (${resultadoTransmissao.error}). Continua registrada como pendente, pode tentar reenviar depois.`,
      };
    }

    const novoStatus = resultadoTransmissao.autorizada ? 'autorizada' : 'rejeitada';
    const qrCodeConteudo = resultadoTransmissao.autorizada ? montarConteudoQrCode({ chaveAcesso, ambiente: config.ambiente }) : null;
    db.prepare(
      `UPDATE nfce_emitidas SET status = ?, protocolo_autorizacao = ?, motivo_rejeicao = ?, qr_code_conteudo = ? WHERE id = ?`
    ).run(novoStatus, resultadoTransmissao.protocoloAutorizacao || null, resultadoTransmissao.autorizada ? null : resultadoTransmissao.motivo, qrCodeConteudo, id);

    return {
      ok: true, xmlGerado: true, assinado: true, transmitido: true,
      autorizada: resultadoTransmissao.autorizada, numero, chaveAcesso, xmlPath, id,
      protocoloAutorizacao: resultadoTransmissao.protocoloAutorizacao,
      motivo: resultadoTransmissao.motivo,
      qrCodeUrl: resultadoTransmissao.autorizada ? montarUrlQrCode({ chaveAcesso, ambiente: config.ambiente, urlConsulta: config.qr_code_url }) : null,
    };
  } catch (err) {
    // erro de comunicação de verdade (rede fora, timeout) -- a NFC-e
    // continua 'pendente', registrada, pronta pra reenviar.
    return {
      ok: true, xmlGerado: true, assinado: true, transmitido: false, numero, chaveAcesso, xmlPath, id,
      aviso: `XML gerado, assinado e salvo — mas a transmissão falhou (${err.message}). Continua pendente, pode tentar reenviar depois.`,
    };
  }
}

/** Tenta transmitir de novo uma NFC-e que ficou 'pendente' (já
 * assinada, só não conseguiu falar com a SEFAZ da primeira vez). */
async function reenviarNFCe(nfceId) {
  const db = getDb();
  const nfce = db.prepare('SELECT * FROM nfce_emitidas WHERE id = ?').get(nfceId);
  if (!nfce) return { ok: false, error: 'NFC-e não encontrada.' };
  if (nfce.status !== 'pendente') return { ok: false, error: `Essa NFC-e já está com status "${nfce.status}" — só dá pra reenviar as pendentes.` };

  const config = getFiscalConfig();
  let certificado;
  try {
    const senhaDescriptografada = secrets.decrypt(config.certificado_senha);
    certificado = carregarCertificado(config.certificado_path, senhaDescriptografada);
  } catch (err) {
    return { ok: false, error: `Não foi possível abrir o certificado: ${err.message}` };
  }

  const xmlAssinado = fs.readFileSync(nfce.xml_path, 'utf-8');

  try {
    const resultadoTransmissao = await enviarNFCe({ xmlNFeAssinado: xmlAssinado, config, certificado, idLote: nfce.numero });
    if (!resultadoTransmissao.ok) return { ok: false, error: resultadoTransmissao.error };

    const novoStatus = resultadoTransmissao.autorizada ? 'autorizada' : 'rejeitada';
    const qrCodeConteudo = resultadoTransmissao.autorizada ? montarConteudoQrCode({ chaveAcesso: nfce.chave_acesso, ambiente: config.ambiente }) : null;
    db.prepare(
      `UPDATE nfce_emitidas SET status = ?, protocolo_autorizacao = ?, motivo_rejeicao = ?, qr_code_conteudo = ? WHERE id = ?`
    ).run(novoStatus, resultadoTransmissao.protocoloAutorizacao || null, resultadoTransmissao.autorizada ? null : resultadoTransmissao.motivo, qrCodeConteudo, nfceId);

    return {
      ok: true, autorizada: resultadoTransmissao.autorizada,
      protocoloAutorizacao: resultadoTransmissao.protocoloAutorizacao, motivo: resultadoTransmissao.motivo,
      qrCodeUrl: resultadoTransmissao.autorizada ? montarUrlQrCode({ chaveAcesso: nfce.chave_acesso, ambiente: config.ambiente, urlConsulta: config.qr_code_url }) : null,
    };
  } catch (err) {
    return { ok: false, error: `Transmissão falhou de novo: ${err.message}` };
  }
}

function listNfceForSale(saleId) {
  const db = getDb();
  return db.prepare('SELECT * FROM nfce_emitidas WHERE sale_id = ? ORDER BY criado_em DESC').all(saleId);
}

/** A NFC-e mais recente de uma venda (pode ter mais de uma linha se
 * teve rejeição e reemissão) — usada pelo recibo impresso, que só
 * precisa mostrar o estado atual, não o histórico completo. */
function getNfceMaisRecente(saleId) {
  const db = getDb();
  return db.prepare('SELECT * FROM nfce_emitidas WHERE sale_id = ? ORDER BY criado_em DESC LIMIT 1').get(saleId) || null;
}

/** URL do QR Code pra uma NFC-e já autorizada — usa a config atual
 * (ambiente, URL de consulta), não a config no momento da emissão, já
 * que a URL de consulta pode ter sido preenchida DEPOIS de emitir. */
function getQrCodeUrlParaNfce(nfce) {
  if (!nfce || nfce.status !== 'autorizada' || !nfce.chave_acesso) return null;
  const config = getFiscalConfig();
  return montarUrlQrCode({ chaveAcesso: nfce.chave_acesso, ambiente: nfce.ambiente || config.ambiente, urlConsulta: config.qr_code_url });
}

/**
 * Livro de controlados eletrônico — farmácia precisa prestar contas
 * de venda de medicamentos controlados (psicotrópicos etc) pra
 * vigilância sanitária/SNGPC periodicamente. Isso já era um trabalho
 * manual chato (procurar venda por venda quais tinham produto
 * controlado) — aqui já sai pronto, filtrado por período, com o
 * cliente vinculado quando teve.
 */
function livroDeControlados({ locationId, dataInicio, dataFim }) {
  const db = getDb();
  return db.prepare(
    `SELECT s.finalizada_em, si.quantidade, p.nome as produtoNome, p.custom_fields,
       c.nome as clienteNome, c.cpf as clienteCpf, u.nome as operadorNome
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users u ON u.id = s.operador_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0
       AND json_extract(p.custom_fields, '$.controlado') = 1
       AND date(s.finalizada_em, '-3 hours') BETWEEN date(?) AND date(?)
     ORDER BY s.finalizada_em`
  ).all(locationId, dataInicio, dataFim).map((r) => {
    const custom = JSON.parse(r.custom_fields || '{}');
    return {
      dataHora: r.finalizada_em, quantidade: r.quantidade, produtoNome: r.produtoNome,
      principioAtivo: custom.principio_ativo || null,
      clienteNome: r.clienteNome, clienteCpf: r.clienteCpf, operadorNome: r.operadorNome,
    };
  });
}

module.exports = {
  getFiscalConfigPublic, updateFiscalConfig, emitirNFCe, reenviarNFCe,
  listNfceForSale, getNfceMaisRecente, getQrCodeUrlParaNfce, livroDeControlados,
};
