const { SignedXml } = require('xml-crypto');

/**
 * Assina digitalmente o XML da NFC-e — sem isso, a SEFAZ rejeita a
 * nota de cara (assinatura é obrigatória, não é opcional). Segue
 * exatamente o padrão exigido pelo Manual de Orientação do
 * Contribuinte (MOC) da NFe/NFCe:
 * - Canonicalização C14N "clássica" (não a exclusiva — é um erro
 *   comum usar a errada e a SEFAZ recusar sem dizer claramente por quê)
 * - SHA-1 pro digest e RSA-SHA1 pra assinatura (sim, ainda é SHA-1 —
 *   é o que o padrão exige, mesmo sendo datado)
 * - Referencia o elemento <infNFe> pelo atributo Id dele
 * - <Signature> fica dentro de <NFe>, depois de </infNFe>, como irmão
 *
 * @param {string} xmlNFe XML já montado (gerarXmlNFCe), sem assinatura
 * @param {{ chavePrivadaPem: string, certificadoPem: string }} certificado
 * @returns {string} o mesmo XML, com o bloco <Signature> adicionado
 */
function assinarXmlNFCe(xmlNFe, { chavePrivadaPem, certificadoPem }) {
  const sig = new SignedXml({
    privateKey: chavePrivadaPem,
    publicCert: certificadoPem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    getKeyInfoContent: SignedXml.getKeyInfoContent,
  });

  sig.addReference({
    xpath: "//*[local-name(.)='infNFe']",
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });

  sig.computeSignature(xmlNFe, {
    // A assinatura vai dentro de <NFe>, logo depois de </infNFe> —
    // não no fim do documento inteiro (que ficaria fora de <NFe>).
    location: { reference: "//*[local-name(.)='infNFe']", action: 'after' },
  });

  return sig.getSignedXml();
}

module.exports = { assinarXmlNFCe };
