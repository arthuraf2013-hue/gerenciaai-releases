const fs = require('fs');
// node-forge só é usado por instalações que emitem NFC-e (certificado
// A1 configurado) -- carregado sob demanda dentro de carregarCertificado,
// não no topo do arquivo, pra não pagar esse custo de startup em toda
// instalação que não usa o módulo fiscal (mesma convenção de firebase/
// baileys, ver comentário equivalente em licenseService.js).

/**
 * Carrega um certificado A1 (.pfx/.p12) e devolve a chave privada e o
 * certificado em formato PEM, prontos pra assinar XML e pra usar como
 * certificado cliente (mTLS) na conexão HTTPS com a SEFAZ.
 *
 * Certificado A1 é o único tipo suportado — é um arquivo, dá pra
 * carregar direto. Certificado A3 (cartão/token físico) exigiria
 * integração com o driver do dispositivo (PKCS#11), fora do escopo
 * aqui — a grande maioria dos pequenos negócios usa A1 mesmo.
 */
function carregarCertificado(caminhoPfx, senha) {
  const forge = require('node-forge');
  const bufferPfx = fs.readFileSync(caminhoPfx);
  const p12Asn1 = forge.asn1.fromDer(bufferPfx.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);

  const bagsChave = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const bagChave = bagsChave[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!bagChave) throw new Error('Não achei a chave privada dentro do certificado — arquivo pode estar corrompido ou não é um .pfx válido.');

  const bagsCert = p12.getBags({ bagType: forge.pki.oids.certBag });
  const bagCert = bagsCert[forge.pki.oids.certBag]?.[0];
  if (!bagCert) throw new Error('Não achei o certificado dentro do arquivo .pfx.');

  const chavePrivadaPem = forge.pki.privateKeyToPem(bagChave.key);
  const certificadoPem = forge.pki.certificateToPem(bagCert.cert);

  // Dados úteis do certificado — validade, pra quem foi emitido, e o
  // CNPJ embutido (o padrão ICP-Brasil guarda o CNPJ no campo
  // subjectAltName ou no CN, dependendo do emissor).
  const validoAte = bagCert.cert.validity.notAfter;
  const nomeTitular = bagCert.cert.subject.getField('CN')?.value || null;

  return { chavePrivadaPem, certificadoPem, validoAte, nomeTitular, certificadoForge: bagCert.cert };
}

/** Só valida se o certificado consegue ser aberto com a senha
 * informada e ainda está dentro da validade — usado na tela de
 * Configurações, pra confirmar antes de salvar. */
function validarCertificado(caminhoPfx, senha) {
  try {
    const { validoAte, nomeTitular } = carregarCertificado(caminhoPfx, senha);
    const diasRestantes = Math.floor((validoAte.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (diasRestantes < 0) {
      return { ok: false, error: `Certificado vencido em ${validoAte.toLocaleDateString('pt-BR')}.` };
    }
    return { ok: true, nomeTitular, validoAte: validoAte.toISOString(), diasRestantes };
  } catch (err) {
    return { ok: false, error: 'Não foi possível abrir o certificado — confira o arquivo e a senha. (' + err.message + ')' };
  }
}

module.exports = { carregarCertificado, validarCertificado };
