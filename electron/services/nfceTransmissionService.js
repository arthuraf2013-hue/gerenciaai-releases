const https = require('https');
const { getWebserviceUrls } = require('./nfceWebserviceUrls');

/**
 * Monta o envelope SOAP 1.2 exigido pelo webservice NFeAutorizacao4.
 * `indSinc=1` (síncrono) é o padrão pra NFC-e — diferente da NFe
 * "grande", a SEFAZ processa e devolve o resultado na mesma resposta,
 * sem precisar de uma segunda chamada de consulta de recibo depois.
 */
function montarEnvelopeAutorizacao(xmlNFeAssinado, idLote) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <enviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
        <idLote>${idLote}</idLote>
        <indSinc>1</indSinc>
        ${xmlNFeAssinado}
      </enviNFe>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
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
  const pegar = (tag) => {
    const m = xmlResposta.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : null;
  };
  return {
    cStat: pegar('cStat'),
    xMotivo: pegar('xMotivo'),
    protocoloAutorizacao: pegar('nProt'),
    chaveAcessoRetornada: pegar('chNFe'),
  };
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
    return {
      ok: false,
      erroComunicacao: true,
      error: `A SEFAZ recusou a conexão (HTTP ${resposta.statusCode}) — confira se o certificado está correto e dentro da validade.`,
    };
  }

  const resultado = extrairResultado(resposta.corpo);
  const autorizada = resultado.cStat === '100';

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
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
      ${envEventoAssinado}
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

/** Envelope SOAP 1.2 pro webservice NFeInutilizacao4. */
function montarEnvelopeInutilizacao(inutNFeAssinado) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">
      ${inutNFeAssinado}
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
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
    registrado: resultado.cStat === '135',
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
  montarEnvelopeAutorizacao, enviarSoapComCertificado, extrairResultado, enviarNFCe,
  enviarEventoNFCe, enviarInutilizacaoNFCe,
};
