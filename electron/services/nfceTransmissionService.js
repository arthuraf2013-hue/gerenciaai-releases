const https = require('https');
const { getWebserviceUrls } = require('./nfceWebserviceUrls');

/**
 * Monta o envelope SOAP 1.2 exigido pelo webservice NFeAutorizacao4.
 * `indSinc=1` (síncrono) é o padrão pra NFC-e — diferente da NFe
 * "grande", a SEFAZ processa e devolve o resultado na mesma resposta,
 * sem precisar de uma segunda chamada de consulta de recibo depois.
 */
// O documento vai DENTRO do envelope: sem declaração <?xml?> (XML inválido
// no meio do SOAP) e sem espaço/quebra entre as tags da mensagem (rejeição
// 588). O envelope em si é montado já compacto.
function documentoParaEnvelope(xml) {
  return String(xml).replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/, '').trim();
}

function montarEnvelopeAutorizacao(xmlNFeAssinado, idLote) {
  const lote = String(Number(idLote) || 1).slice(0, 15);
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
    + '<soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
    + `<enviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>${lote}</idLote><indSinc>1</indSinc>${documentoParaEnvelope(xmlNFeAssinado)}</enviNFe>`
    + '</nfeDadosMsg></soap12:Body></soap12:Envelope>';
}

/**
 * Envia o SOAP request via HTTPS com o certificado do contribuinte
 * como certificado CLIENTE (mTLS) — a SEFAZ exige isso pra aceitar a
 * conexão, além da assinatura dentro do XML. É o mesmo certificado
 * dos dois usos, só que aqui autentica a CONEXÃO, lá autentica o
 * DOCUMENTO.
 */
function enviarSoapComCertificado({ url, envelopeSoap, chavePrivadaPem, certificadoPem, soapAction, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const bodyBuffer = Buffer.from(envelopeSoap, 'utf-8');

    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      key: chavePrivadaPem,
      cert: certificadoPem,
      // A cadeia de certificação da SEFAZ é pública e confiável (ICP-Brasil
      // raiz já reconhecida) — não precisa de CA customizada aqui.
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="' + soapAction + '"',
        'Content-Length': bodyBuffer.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      let dados = '';
      res.on('data', (chunk) => { dados += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, corpo: dados }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('A SEFAZ não respondeu a tempo (timeout).')); });
    req.on('error', (err) => reject(err));
    req.write(bodyBuffer);
    req.end();
  });
}

/** Extrai os campos importantes da resposta XML da SEFAZ — sem
 * depender de um parser XML completo pra isso, os campos são simples
 * o suficiente pra pegar com regex de forma confiável. */
function extrairResultado(xmlResposta) {
  const texto = String(xmlResposta || '');
  // A resposta síncrona tem DOIS cStat: o do lote (104 "Lote processado",
  // em retEnviNFe) e o da nota (100 autorizada, ou a rejeição, em
  // protNFe/infProt). No evento é igual: 128 no lote, 135 em
  // retEvento/infEvento. Vale o de dentro quando existe -- pegar o primeiro
  // fazia toda nota autorizada parecer recusada.
  const bloco = (tag) => {
    const m = texto.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`));
    return m ? m[1] : null;
  };
  const interno = bloco('infProt') || bloco('infEvento') || bloco('infInut');
  const pegar = (tag, fonte) => {
    const m = String(fonte || '').match(new RegExp(`<(?:[\\w-]+:)?${tag}>([^<]*)</(?:[\\w-]+:)?${tag}>`));
    return m ? m[1] : null;
  };
  const de = (tag) => (interno != null ? pegar(tag, interno) : null) ?? pegar(tag, texto);
  return {
    cStat: de('cStat'),
    xMotivo: de('xMotivo'),
    protocoloAutorizacao: de('nProt'),
    chaveAcessoRetornada: de('chNFe'),
    cStatLote: pegar('cStat', texto),
  };
}

/** Texto do SOAP Fault (soap12:Reason/Text), se a resposta for um. */
function motivoDoSoapFault(corpo) {
  const t = String(corpo || '');
  if (!/<(?:[\w-]+:)?Fault[\s>]/.test(t)) return null;
  const m = t.match(/<(?:[\w-]+:)?Text[^>]*>([^<]*)<\/(?:[\w-]+:)?Text>/) || t.match(/<faultstring>([^<]*)<\/faultstring>/);
  return (m ? m[1] : 'erro no formato da mensagem').trim().slice(0, 300);
}

/**
 * Envia a NFC-e assinada pra SEFAZ e devolve o resultado — autorizada
 * (cStat 100), rejeitada (qualquer outro código, com o motivo), ou
 * erro de comunicação (rede, timeout, certificado recusado).
 *
 * NUNCA lança exceção por rejeição da SEFAZ (isso é uma resposta
 * válida e esperada, não uma falha do sistema) — só por problema de
 * comunicação de verdade (rede fora, certificado inválido, etc), que
 * o chamador precisa decidir separado como tratar.
 */
async function enviarNFCe({ xmlNFeAssinado, config, certificado, idLote = 1 }) {
  const urls = getWebserviceUrls(config.uf, config.ambiente);
  const envelope = montarEnvelopeAutorizacao(xmlNFeAssinado, idLote);

  const resposta = await enviarSoapComCertificado({
    url: urls.autorizacao,
    envelopeSoap: envelope,
    chavePrivadaPem: certificado.chavePrivadaPem,
    certificadoPem: certificado.certificadoPem,
    soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
  });

  if (resposta.statusCode !== 200) {
    // SOAP Fault = a SEFAZ LEU a mensagem e recusou o formato: é recusa da
    // nota, não falta de conexão -- não pode virar contingência (o documento
    // sairia inválido do mesmo jeito).
    const fault = motivoDoSoapFault(resposta.corpo);
    if (fault) {
      return { ok: true, autorizada: false, cStat: null, motivo: `A SEFAZ recusou a mensagem: ${fault}`, xmlRespostaCompleto: resposta.corpo };
    }
    return {
      ok: false,
      erroComunicacao: true,
      error: `A SEFAZ recusou a conexão (HTTP ${resposta.statusCode}) — confira se o certificado está correto e dentro da validade.`,
    };
  }

  const resultado = extrairResultado(resposta.corpo);
  // 150 = autorizada fora de prazo (comum ao transmitir a contingência): também é autorização.
  const autorizada = require('./rejeicoesSefaz').autorizado(resultado.cStat);

  return {
    ok: true, // a COMUNICAÇÃO funcionou -- autorizada ou não é outra checagem
    autorizada,
    cStat: resultado.cStat,
    motivo: resultado.xMotivo,
    protocoloAutorizacao: resultado.protocoloAutorizacao,
    xmlRespostaCompleto: resposta.corpo,
  };
}

/** Envelope SOAP 1.2 pro webservice NFeRecepcaoEvento4 — usado pra
 * cancelamento (evento 110111) e, no futuro, qualquer outro evento de
 * NFC-e (carta de correção não existe pra NFC-e, mas outros eventos
 * como EPEC existem — só cancelamento está implementado por enquanto). */
function montarEnvelopeEvento(envEventoAssinado) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
    + `<soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${documentoParaEnvelope(envEventoAssinado)}</nfeDadosMsg></soap12:Body>`
    + '</soap12:Envelope>';
}

/** Envelope SOAP 1.2 pro webservice NFeInutilizacao4. */
function montarEnvelopeInutilizacao(inutNFeAssinado) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
    + `<soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">${documentoParaEnvelope(inutNFeAssinado)}</nfeDadosMsg></soap12:Body>`
    + '</soap12:Envelope>';
}

/**
 * Envia o evento de cancelamento assinado pra SEFAZ — mesma lógica de
 * sucesso/rejeição/erro-de-comunicação de enviarNFCe acima, só que
 * cStat 135 (evento registrado e vinculado à NFC-e) é o "autorizado"
 * aqui, em vez de 100.
 */
async function enviarEventoNFCe({ envEventoAssinado, config, certificado }) {
  const urls = getWebserviceUrls(config.uf, config.ambiente);
  const envelope = montarEnvelopeEvento(envEventoAssinado);

  const resposta = await enviarSoapComCertificado({
    url: urls.recepcaoEvento,
    envelopeSoap: envelope,
    chavePrivadaPem: certificado.chavePrivadaPem,
    certificadoPem: certificado.certificadoPem,
    soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
  });

  if (resposta.statusCode !== 200) {
    return {
      ok: false, erroComunicacao: true,
      error: `A SEFAZ recusou a conexão (HTTP ${resposta.statusCode}) — confira se o certificado está correto e dentro da validade.`,
    };
  }

  const resultado = extrairResultado(resposta.corpo);
  return {
    ok: true,
    // 155 = cancelamento homologado fora de prazo: também vale como registrado.
    registrado: ['135', '155'].includes(resultado.cStat),
    cStat: resultado.cStat,
    motivo: resultado.xMotivo,
    protocolo: resultado.protocoloAutorizacao,
    xmlRespostaCompleto: resposta.corpo,
  };
}

/**
 * Envia o pedido de inutilização assinado pra SEFAZ — cStat 102
 * (inutilização homologada) é o "sucesso" aqui.
 */
async function enviarInutilizacaoNFCe({ inutNFeAssinado, config, certificado }) {
  const urls = getWebserviceUrls(config.uf, config.ambiente);
  const envelope = montarEnvelopeInutilizacao(inutNFeAssinado);

  const resposta = await enviarSoapComCertificado({
    url: urls.inutilizacao,
    envelopeSoap: envelope,
    chavePrivadaPem: certificado.chavePrivadaPem,
    certificadoPem: certificado.certificadoPem,
    soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4/nfeInutilizacaoNF',
  });

  if (resposta.statusCode !== 200) {
    return {
      ok: false, erroComunicacao: true,
      error: `A SEFAZ recusou a conexão (HTTP ${resposta.statusCode}) — confira se o certificado está correto e dentro da validade.`,
    };
  }

  const resultado = extrairResultado(resposta.corpo);
  return {
    ok: true,
    homologada: resultado.cStat === '102',
    cStat: resultado.cStat,
    motivo: resultado.xMotivo,
    protocolo: resultado.protocoloAutorizacao,
    xmlRespostaCompleto: resposta.corpo,
  };
}

module.exports = {
  montarEnvelopeAutorizacao, montarEnvelopeEvento, montarEnvelopeInutilizacao, documentoParaEnvelope, motivoDoSoapFault,
  enviarSoapComCertificado, extrairResultado, enviarNFCe, enviarEventoNFCe, enviarInutilizacaoNFCe,
};
