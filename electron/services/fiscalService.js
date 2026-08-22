const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const timeService = require('./timeService');
const secrets = require('./secretsService');
const { gerarXmlNFCe } = require('./nfceXmlService');
const { carregarCertificado } = require('./nfceCertificateService');
const { assinarXmlNFCe, assinarXmlEvento, assinarXmlInutilizacao } = require('./nfceSignatureService');
const { enviarNFCe, enviarEventoNFCe, enviarInutilizacaoNFCe } = require('./nfceTransmissionService');
const { montarConteudoQrCode, montarUrlQrCode } = require('./nfceQrCodeService');
const { gerarXmlCancelamento } = require('./nfceEventoService');
const { gerarXmlInutilizacao } = require('./nfceInutilizacaoService');

// Prazo legal pra cancelar uma NFC-e já autorizada — Ajuste SINIEF 07/05
// prevê até 24h da autorização na maioria das UFs (algumas ampliam esse
// prazo, mas nenhuma reduz abaixo disso) — usar 24h aqui é o limite mais
// conservador possível, nunca vai bloquear um cancelamento que a SEFAZ
// aceitaria. Fora desse prazo, o caminho correto deixa de ser
// cancelamento e passa a ser outro procedimento fora do escopo deste app.
const PRAZO_CANCELAMENTO_HORAS = 24;

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
 * Se a transmissão falhar por COMUNICAÇÃO (SEFAZ fora do ar, sem
 * internet) — não por rejeição, que é uma resposta válida da SEFAZ —
 * este ciclo cai automaticamente em CONTINGÊNCIA (tpEmis=9, ver
 * comentário mais abaixo): a venda não pode esperar a SEFAZ voltar, o
 * cliente já saiu com o documento fiscal (mesmo que provisório), e a
 * transmissão de verdade acontece depois, sozinha, via o job periódico
 * de reenvio (ver reenviarPendentesEContingencia em main.js e
 * reenviarNFCe abaixo — a mesma função já cobre pendente E contingência).
 *
 * Cancelamento de NFC-e autorizada e inutilização de numeração pulada
 * (as outras duas peças que faltavam) ficam em cancelarNFCe e
 * inutilizarNumeracao, mais abaixo neste arquivo.
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

  // Transmite pra SEFAZ — isso PODE falhar por COMUNICAÇÃO (rede fora,
  // SEFAZ indisponível) sem que seja um erro de verdade: nesse caso a
  // venda não pode esperar, então cai automaticamente em contingência
  // (tpEmis=9) — regenera o XML com a mesma numeração, assina de novo
  // e entrega esse documento como válido, deixando a transmissão real
  // pro job periódico de reenvio (reenviarNFCe cobre esse status
  // também). Rejeição da SEFAZ (resposta chegou, só que negativa) NÃO
  // aciona contingência — é uma resposta válida, fica 'rejeitada'.
  let resultadoTransmissao;
  let erroComunicacao = null;
  try {
    resultadoTransmissao = await enviarNFCe({ xmlNFeAssinado: xmlAssinado, config, certificado, idLote: numero });
    if (!resultadoTransmissao.ok) erroComunicacao = resultadoTransmissao.error;
  } catch (err) {
    erroComunicacao = err.message;
  }

  if (erroComunicacao) {
    return entrarEmContingencia({ db, config, certificado, sale, items, payments, numero, id, chaveAcesso, erroComunicacao });
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
}

/**
 * Chamado quando a transmissão normal (tpEmis=1) falhou por
 * COMUNICAÇÃO — regenera o XML com tpEmis=9 (contingência), assina de
 * novo e grava por cima do registro 'pendente' já criado (mesmo id,
 * mesmo número — não "queima" um segundo número pra mesma venda). Não
 * tenta transmitir agora: contingência é justamente o documento sendo
 * usado SEM confirmação da SEFAZ no momento; a transmissão de verdade
 * fica pro job periódico (reenviarNFCe, chamado em loop por
 * main.js/reenviarPendentesEContingencia).
 */
function entrarEmContingencia({ db, config, certificado, sale, items, payments, numero, id, chaveAcesso, erroComunicacao }) {
  let xmlContingencia, chaveContingencia, xmlAssinadoContingencia;
  try {
    ({ xml: xmlContingencia, chaveAcesso: chaveContingencia } = gerarXmlNFCe({
      config, sale, items, payments, numero, dataEmissao: new Date(sale.finalizada_em),
      tpEmis: '9',
      justificativaContingencia: `Falha de comunicacao com a SEFAZ no momento da venda: ${String(erroComunicacao).slice(0, 200)}`,
    }));
    xmlAssinadoContingencia = assinarXmlNFCe(xmlContingencia, certificado);
  } catch (err) {
    // Não conseguiu nem montar/assinar a versão de contingência --
    // fica como 'pendente' mesmo (já gravada acima), só sem o
    // documento provisório pra entregar ao cliente agora.
    return {
      ok: true, xmlGerado: true, assinado: true, transmitido: false, numero, chaveAcesso, id,
      aviso: `XML gerado e salvo — mas a transmissão falhou (${erroComunicacao}) e não foi possível gerar a versão de contingência (${err.message}). Continua pendente, pode tentar reenviar depois.`,
    };
  }

  const { app } = require('electron');
  const pastaDestino = path.join(app.getPath('userData'), 'nfce', config.ambiente);
  fs.mkdirSync(pastaDestino, { recursive: true });
  const xmlPath = path.join(pastaDestino, `${chaveContingencia}.xml`);
  fs.writeFileSync(xmlPath, xmlAssinadoContingencia, 'utf-8');

  db.prepare(
    `UPDATE nfce_emitidas SET status = 'contingencia', chave_acesso = ?, xml_path = ?, transmitida_em_contingencia = 1 WHERE id = ?`
  ).run(chaveContingencia, xmlPath, id);

  return {
    ok: true, xmlGerado: true, assinado: true, transmitido: false, contingencia: true,
    numero, chaveAcesso: chaveContingencia, xmlPath, id,
    aviso: `A SEFAZ está indisponível (${erroComunicacao}) — NFC-e emitida em CONTINGÊNCIA. O documento já vale como comprovante fiscal; a confirmação com a SEFAZ acontece automaticamente assim que a conexão voltar.`,
  };
}

/** Tenta transmitir de novo uma NFC-e que ficou 'pendente' ou
 * 'contingencia' (já assinada, só não conseguiu falar com a SEFAZ da
 * primeira vez, ou foi emitida offline e precisa ser confirmada assim
 * que a conexão voltar — os dois casos reenviam o MESMO jeito, o
 * tpEmis já está gravado no XML salvo em disco). */
async function reenviarNFCe(nfceId) {
  const db = getDb();
  const nfce = db.prepare('SELECT * FROM nfce_emitidas WHERE id = ?').get(nfceId);
  if (!nfce) return { ok: false, error: 'NFC-e não encontrada.' };
  if (nfce.status !== 'pendente' && nfce.status !== 'contingencia') {
    return { ok: false, error: `Essa NFC-e já está com status "${nfce.status}" — só dá pra reenviar as pendentes ou em contingência.` };
  }

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

/**
 * Cancela uma NFC-e já autorizada (evento 110111) — dentro do prazo
 * legal, contado da AUTORIZAÇÃO (não da venda). Sempre exige
 * autorização de gerente/admin diferente do operador logado (mesmo
 * esquema de PIN + auditoria de cancelSale/applyManagerDiscount em
 * saleService.js/authService.authorizeManagerOverride) — cancelar uma
 * nota fiscal já entregue ao cliente é sensível demais pra depender só
 * do toggle "exigir autorização" das configurações de segurança
 * (esse toggle é sobre cancelamento de ITEM/VENDA antes do pagamento,
 * um contexto bem menos crítico). Ciclo igual ao de emissão: monta o
 * XML do evento, assina com o mesmo certificado configurado,
 * transmite, e só grava o cancelamento se a SEFAZ confirmar (cStat
 * 135) — rejeição do evento não cancela nada, a NFC-e continua
 * 'autorizada' normalmente.
 */
async function cancelarNFCe(nfceId, { justificativa, currentOperatorId, candidateManagerId, pin } = {}) {
  const { authorizeManagerOverride } = require('./authService');
  const db = getDb();

  const nfcePreCheck = db.prepare('SELECT sale_id FROM nfce_emitidas WHERE id = ?').get(nfceId);
  const auth = authorizeManagerOverride({
    candidateUserId: candidateManagerId, pin, currentOperatorId,
    tipoEvento: 'cancelamento_nfce', saleId: nfcePreCheck?.sale_id, motivo: justificativa,
  });
  if (!auth.ok) return auth;

  const nfce = db.prepare('SELECT * FROM nfce_emitidas WHERE id = ?').get(nfceId);
  if (!nfce) return { ok: false, error: 'NFC-e não encontrada.' };
  if (nfce.status !== 'autorizada') {
    return { ok: false, error: `Só é possível cancelar uma NFC-e autorizada — essa está com status "${nfce.status}".` };
  }
  if (!nfce.protocolo_autorizacao) {
    return { ok: false, error: 'NFC-e autorizada sem protocolo registrado — não é possível cancelar.' };
  }

  const autorizadaEm = new Date(nfce.criado_em);
  const horasDesdeAutorizacao = (Date.now() - autorizadaEm.getTime()) / (1000 * 60 * 60);
  if (horasDesdeAutorizacao > PRAZO_CANCELAMENTO_HORAS) {
    return {
      ok: false,
      error: `O prazo legal de cancelamento (${PRAZO_CANCELAMENTO_HORAS}h após a autorização) já passou. Procure outro procedimento fiscal (fora do escopo deste app).`,
    };
  }

  const config = getFiscalConfig();

  // Mesma ordem de inutilizarNumeracao: valida a justificativa (e o
  // resto dos dados do evento) ANTES de tocar no certificado — evita
  // pedir a senha do certificado à toa quando o problema é só um dado
  // de entrada inválido.
  let xmlEvento;
  try {
    ({ xml: xmlEvento } = gerarXmlCancelamento({
      chaveAcesso: nfce.chave_acesso,
      uf: config.uf,
      cnpj: config.cnpj,
      ambiente: config.ambiente,
      protocoloAutorizacao: nfce.protocolo_autorizacao,
      justificativa,
    }));
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let certificado, xmlEventoAssinado;
  try {
    const senhaDescriptografada = secrets.decrypt(config.certificado_senha);
    certificado = carregarCertificado(config.certificado_path, senhaDescriptografada);
    xmlEventoAssinado = assinarXmlEvento(xmlEvento, certificado);
  } catch (err) {
    return { ok: false, error: `Não foi possível abrir o certificado: ${err.message}` };
  }

  try {
    const resultado = await enviarEventoNFCe({ envEventoAssinado: xmlEventoAssinado, config, certificado });
    if (!resultado.ok) return { ok: false, error: resultado.error };
    if (!resultado.registrado) {
      return { ok: false, error: `A SEFAZ rejeitou o cancelamento (${resultado.cStat}): ${resultado.motivo}` };
    }

    db.prepare(
      `UPDATE nfce_emitidas SET status = 'cancelada', cancelamento_justificativa = ?, cancelamento_protocolo = ?, cancelada_em = ? WHERE id = ?`
    ).run(justificativa.trim(), resultado.protocolo, new Date().toISOString(), nfceId);

    return { ok: true, protocolo: resultado.protocolo, motivo: resultado.motivo };
  } catch (err) {
    return { ok: false, error: `Transmissão do cancelamento falhou: ${err.message}` };
  }
}

/**
 * Inutiliza uma faixa de numeração de NFC-e que nunca foi usada (ex:
 * pulou número por erro do app). Só admin — é um procedimento fiscal
 * raro e sem volta, não faz sentido deixar qualquer operador acionar.
 * Mesmo ciclo dos outros dois: monta XML, assina, transmite, só grava
 * 'homologada' se a SEFAZ confirmar (cStat 102).
 */
async function inutilizarNumeracao({ serie, numeroInicial, numeroFinal, justificativa, requestingUserId }) {
  const guard = require('./authService').requireRole(requestingUserId, ['admin']);
  if (!guard.ok) return guard;

  const config = getFiscalConfig();
  const db = getDb();

  // Valida a faixa/justificativa ANTES de tocar no certificado — não
  // faz sentido pedir a senha do certificado (ou falhar por causa dele)
  // se o problema é só um dado de entrada inválido.
  let xmlInut, ano;
  try {
    ({ xml: xmlInut, ano } = gerarXmlInutilizacao({
      uf: config.uf, cnpj: config.cnpj, ambiente: config.ambiente,
      serie: serie || config.serie_nfce, numeroInicial, numeroFinal, justificativa,
    }));
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let certificado, xmlInutAssinado;
  try {
    const senhaDescriptografada = secrets.decrypt(config.certificado_senha);
    certificado = carregarCertificado(config.certificado_path, senhaDescriptografada);
    xmlInutAssinado = assinarXmlInutilizacao(xmlInut, certificado);
  } catch (err) {
    return { ok: false, error: `Não foi possível abrir o certificado: ${err.message}` };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO nfce_inutilizacoes (id, ano, serie, numero_inicial, numero_final, justificativa, ambiente, status, requerente_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?)`
  ).run(id, ano, String(serie || config.serie_nfce), numeroInicial, numeroFinal, justificativa.trim(), config.ambiente, requestingUserId || null);

  try {
    const resultado = await enviarInutilizacaoNFCe({ inutNFeAssinado: xmlInutAssinado, config, certificado });
    if (!resultado.ok) {
      return { ok: true, id, transmitido: false, aviso: `Registrado, mas não foi possível transmitir agora (${resultado.error}). Continua pendente.` };
    }

    const novoStatus = resultado.homologada ? 'homologada' : 'rejeitada';
    db.prepare(
      `UPDATE nfce_inutilizacoes SET status = ?, protocolo = ?, motivo_rejeicao = ? WHERE id = ?`
    ).run(novoStatus, resultado.protocolo || null, resultado.homologada ? null : resultado.motivo, id);

    return { ok: true, id, transmitido: true, homologada: resultado.homologada, protocolo: resultado.protocolo, motivo: resultado.motivo };
  } catch (err) {
    return { ok: true, id, transmitido: false, aviso: `Registrado, mas a transmissão falhou (${err.message}). Continua pendente.` };
  }
}

/** Histórico de inutilizações — usado na tela de Configurações pra
 * mostrar o que já foi declarado, sem precisar consultar a SEFAZ. */
function listInutilizacoes() {
  const db = getDb();
  return db.prepare('SELECT * FROM nfce_inutilizacoes ORDER BY criado_em DESC').all();
}

/** NFC-e's pendentes ou em contingência — usado pelo job periódico de
 * reenvio automático (main.js) pra saber o que precisa tentar de novo. */
function listNfcePendentesOuContingencia() {
  const db = getDb();
  return db.prepare(`SELECT * FROM nfce_emitidas WHERE status IN ('pendente', 'contingencia') ORDER BY criado_em ASC`).all();
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
  // Sargable -- ver o mesmo comentário em dashboardService.js. O
  // json_extract continua varrendo linha por linha (não dá pra indexar
  // sem uma coluna gerada dedicada), mas pelo menos não escaneia mais
  // TAMBÉM o histórico inteiro de vendas por causa da data.
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
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
       AND s.finalizada_em >= ? AND s.finalizada_em < ?
     ORDER BY s.finalizada_em`
  ).all(locationId, inicioUtc, fimUtcExclusivo).map((r) => {
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
  cancelarNFCe, inutilizarNumeracao, listInutilizacoes, listNfcePendentesOuContingencia,
  listNfceForSale, getNfceMaisRecente, getQrCodeUrlParaNfce, livroDeControlados,
};
