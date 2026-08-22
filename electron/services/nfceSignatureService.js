// xml-crypto só é usado por instalações que emitem NFC-e -- carregado sob
// demanda dentro de assinarXmlGenerico, não no topo do arquivo, mesma
// convenção de node-forge em nfceCertificateService.js.

/**
 * Assina digitalmente um XML de NFC-e — sem isso, a SEFAZ rejeita
 * qualquer documento (NFe, evento ou inutilização) de cara, assinatura
 * é obrigatória em todos os três, não só na emissão. Segue exatamente
 * o padrão exigido pelo Manual de Orientação do Contribuinte (MOC) da
 * NFe/NFCe, igual pros três tipos de documento:
 * - Canonicalização C14N "clássica" (não a exclusiva — é um erro
 *   comum usar a errada e a SEFAZ recusar sem dizer claramente por quê)
 * - SHA-1 pro digest e RSA-SHA1 pra assinatura (sim, ainda é SHA-1 —
 *   é o que o padrão exige, mesmo sendo datado)
 * - Referencia o elemento identificado pelo atributo Id dele
 *   (infNFe pra emissão, infEvento pra cancelamento, infInut pra
 *   inutilização — só isso muda entre os três)
 * - <Signature> fica como irmão do elemento referenciado, logo depois
 *   dele
 *
 * @param {string} xmlOriginal XML já montado, sem assinatura
 * @param {{ chavePrivadaPem: string, certificadoPem: string }} certificado
 * @param {string} elementoLocalName nome do elemento com o Id a assinar
 * @returns {string} o mesmo XML, com o bloco <Signature> adicionado
 */
function assinarXmlGenerico(xmlOriginal, { chavePrivadaPem, certificadoPem }, elementoLocalName) {
  const { SignedXml } = require('xml-crypto');
  const sig = new SignedXml({
    privateKey: chavePrivadaPem,
    publicCert: certificadoPem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    getKeyInfoContent: SignedXml.getKeyInfoContent,
  });

  sig.addReference({
    xpath: `//*[local-name(.)='${elementoLocalName}']`,
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });

  sig.computeSignature(xmlOriginal, {
    location: { reference: `//*[local-name(.)='${elementoLocalName}']`, action: 'after' },
  });

  return sig.getSignedXml();
}

function assinarXmlNFCe(xmlNFe, certificado) {
  return assinarXmlGenerico(xmlNFe, certificado, 'infNFe');
}

/** Assina o evento de cancelamento (110111) — referencia <infEvento>. */
function assinarXmlEvento(xmlEvento, certificado) {
  return assinarXmlGenerico(xmlEvento, certificado, 'infEvento');
}

/** Assina o pedido de inutilização de numeração — referencia <infInut>. */
function assinarXmlInutilizacao(xmlInut, certificado) {
  return assinarXmlGenerico(xmlInut, certificado, 'infInut');
}

module.exports = { assinarXmlNFCe, assinarXmlEvento, assinarXmlInutilizacao };
