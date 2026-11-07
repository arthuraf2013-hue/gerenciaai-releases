/**
 * QR Code impresso no DANFE-NFCe e o grupo <infNFeSupl> do XML.
 *
 * Layout 3 (NT 2025.001, Manual do DANFE NFC-e e QR Code 6.00):
 *   on-line:     <url>?p=<chave>|3|<tpAmb>
 *   contingência off-line (tpEmis=9):
 *                <url>?p=<chave>|3|<tpAmb>|<dia>|<vNF>|<tpIdDest>|<idDest>|<assinatura>
 *     dia        = dia da dhEmi, 2 dígitos;
 *     vNF        = total com ponto decimal, sem milhar (ex.: 60.90);
 *     tpIdDest/idDest = 1 CNPJ, 2 CPF, 3 estrangeiro -- vazios quando a nota
 *                  não identifica o consumidor (só os separadores);
 *     assinatura = RSA-SHA1 em Base64 dos parâmetros 1 a 7 COM os "|", com a
 *                  chave do MESMO certificado que assina a nota (substitui o
 *                  hash com CSC da versão 2). Errada = rejeição 583.
 *   Conferido em 11/2026 contra o manual 6.00 e implementações autorizadas em
 *   homologação (sped-nfe QRCode::get300, DFe.NET ObterUrlQrCode3).
 *
 * O <infNFeSupl> é OBRIGATÓRIO na NFC-e (sem ele: rejeição 394/395) e leva o
 * QR (URL completa) e a URL de consulta por chave (urlChave, rejeição 878 se
 * divergir da tabela da UF). Os endereços por UF ficam aqui com valor padrão
 * e podem ser trocados em Configurações → Fiscal (mudam de tempos em tempos).
 */

const VERSAO_QRCODE = '3';

// Consulta da NFC-e via QR Code, por UF (Portal NFC-e -- Desenvolvedor →
// "URL por UF utilizada QR code", nfce.encat.org/desenvolvedor/qrcode,
// conferido em 11/2026). Só as UFs confirmadas; nas demais a loja informa.
const URL_QRCODE_POR_UF = {
  PE: { producao: 'http://nfce.sefaz.pe.gov.br/nfce/consulta', homologacao: 'http://nfcehomolog.sefaz.pe.gov.br/nfce/consulta' },
};

// Consulta por chave de acesso (urlChave), por UF e ambiente -- tabela usada
// pelo sped-nfe (storage/uri_consulta_nfce.json), conferida em 11/2026. PE é
// o mesmo endereço nos dois ambientes, SEM "http://" (a SVRS compara o texto).
const URL_CHAVE_POR_UF = {
  producao: {
    AC: 'www.sefaznet.ac.gov.br/nfce/consulta', AL: 'www.sefaz.al.gov.br/nfce/consulta', AP: 'www.sefaz.ap.gov.br/nfce/consulta',
    AM: 'www.sefaz.am.gov.br/nfce/consulta', BA: 'http://www.sefaz.ba.gov.br/nfce/consulta', CE: 'www.sefaz.ce.gov.br/nfce/consulta',
    DF: 'www.fazenda.df.gov.br/nfce/consulta', ES: 'www.sefaz.es.gov.br/nfce/consulta', GO: 'www.sefaz.go.gov.br/nfce/consulta',
    MA: 'www.sefaz.ma.gov.br/nfce/consulta', MG: 'https://portalsped.fazenda.mg.gov.br/portalnfce', MS: 'http://www.dfe.ms.gov.br/nfce/consulta',
    MT: 'http://www.sefaz.mt.gov.br/nfce/consultanfce', PA: 'www.sefa.pa.gov.br/nfce/consulta', PB: 'www.sefaz.pb.gov.br/nfce/consulta',
    PE: 'nfce.sefaz.pe.gov.br/nfce/consulta', PI: 'www.sefaz.pi.gov.br/nfce/consulta', PR: 'http://www.fazenda.pr.gov.br/nfce/consulta',
    RJ: 'www.fazenda.rj.gov.br/nfce/consulta', RN: 'www.set.rn.gov.br/nfce/consulta', RO: 'www.sefin.ro.gov.br/nfce/consulta',
    RR: 'www.sefaz.rr.gov.br/nfce/consulta', RS: 'www.sefaz.rs.gov.br/nfce/consulta', SC: 'https://sat.sef.sc.gov.br/nfce/consulta',
    SE: 'http://www.nfce.se.gov.br/nfce/consulta', SP: 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica', TO: 'www.sefaz.to.gov.br/nfce/consulta',
  },
  homologacao: {
    AC: 'www.sefaznet.ac.gov.br/nfce/consulta', AL: 'www.sefaz.al.gov.br/nfce/consulta', AP: 'www.sefaz.ap.gov.br/nfce/consulta',
    AM: 'www.sefaz.am.gov.br/nfce/consulta', BA: 'http://hinternet.sefaz.ba.gov.br/nfce/consulta', CE: 'www.sefaz.ce.gov.br/nfce/consulta',
    DF: 'www.fazenda.df.gov.br/nfce/consulta', ES: 'www.sefaz.es.gov.br/nfce/consulta', GO: 'www.nfce.go.gov.br/post/ver/214413/consulta-nfc-e-homologacao',
    MA: 'www.sefaz.ma.gov.br/nfce/consulta', MG: 'https://hportalsped.fazenda.mg.gov.br/portalnfce', MS: 'http://www.dfe.ms.gov.br/nfce/consulta',
    MT: 'http://homologacao.sefaz.mt.gov.br/nfce/consultanfce', PA: 'www.sefa.pa.gov.br/nfce/consulta', PB: 'www.sefaz.pb.gov.br/nfcehom',
    PE: 'nfce.sefaz.pe.gov.br/nfce/consulta', PI: 'www.sefaz.pi.gov.br/nfce/consulta', PR: 'http://www.fazenda.pr.gov.br/nfce/consulta',
    RJ: 'www.fazenda.rj.gov.br/nfce/consulta', RN: 'www.set.rn.gov.br/nfce/consulta', RO: 'www.sefin.ro.gov.br/nfce/consulta',
    RR: 'www.sefaz.rr.gov.br/nfce/consulta', RS: 'www.sefaz.rs.gov.br/nfce/consulta', SC: 'https://hom.sat.sef.sc.gov.br/nfce/consulta',
    SE: 'http://www.hom.nfe.se.gov.br/nfce/consulta', SP: 'https://www.homologacao.nfce.fazenda.sp.gov.br/NFCeConsultaPublica',
    TO: 'http://homologacao.sefaz.to.gov.br/nfce/consulta.jsf',
  },
};

function amb(ambiente) {
  return ambiente === 'producao' ? 'producao' : 'homologacao';
}

/** URL de consulta do QR: a configurada pela loja ou a padrão da UF. */
function urlQrCodeDaUf({ uf, ambiente, urlConfigurada }) {
  const conf = String(urlConfigurada || '').trim();
  if (conf) return conf;
  return URL_QRCODE_POR_UF[uf]?.[amb(ambiente)] || null;
}

/** urlChave: a configurada pela loja ou a da tabela. */
function urlChaveDaUf({ uf, ambiente, urlConfigurada }) {
  const conf = String(urlConfigurada || '').trim();
  if (conf) return conf;
  return URL_CHAVE_POR_UF[amb(ambiente)][uf] || null;
}

/** Conteúdo (sem a URL base) que vai depois do "?p=" -- on-line. */
function montarConteudoQrCode({ chaveAcesso, ambiente }) {
  if (!/^\d{44}$/.test(String(chaveAcesso || ''))) {
    throw new Error('Chave de acesso inválida para montar o QR Code (precisa de 44 dígitos).');
  }
  const tpAmb = ambiente === 'producao' ? '1' : '2';
  return `${chaveAcesso}|${VERSAO_QRCODE}|${tpAmb}`;
}

/**
 * Conteúdo da contingência off-line (tpEmis=9), versão 3. `assinar(texto)`
 * devolve a assinatura RSA-SHA1 em Base64 (nfceSignatureService.assinarTexto).
 */
function montarConteudoQrCodeContingencia({ chaveAcesso, ambiente, dia, vNF, destinatario, assinar }) {
  const base = montarConteudoQrCode({ chaveAcesso, ambiente });
  if (!/^\d{2}$/.test(String(dia || ''))) throw new Error('Dia da emissão inválido para o QR Code da contingência.');
  const valor = Number(vNF);
  if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor da nota inválido para o QR Code da contingência.');
  let tp = '';
  let id = '';
  const doc = String(destinatario || '').replace(/\D/g, '');
  if (doc.length === 14) { tp = '1'; id = doc; } else if (doc.length === 11) { tp = '2'; id = doc; }
  const assinado = `${base}|${dia}|${valor.toFixed(2)}|${tp}|${id}`;
  if (typeof assinar !== 'function') throw new Error('Sem certificado para assinar o QR Code da contingência.');
  const assinatura = String(assinar(assinado) || '').replace(/\s+/g, '');
  if (!assinatura) throw new Error('Não foi possível assinar o QR Code da contingência.');
  return `${assinado}|${assinatura}`;
}

/** URL completa do QR Code: base + "?p=" + conteúdo. Sem URL, null. */
function montarUrlQrCodeDeConteudo({ conteudo, urlConsulta }) {
  if (!urlConsulta || !conteudo) return null;
  const base = String(urlConsulta).trim().replace(/\?.*$/, '').replace(/\/$/, '');
  return `${base}?p=${conteudo}`;
}

/** Compatibilidade: URL do QR on-line. */
function montarUrlQrCode({ chaveAcesso, ambiente, urlConsulta }) {
  if (!urlConsulta) return null;
  return montarUrlQrCodeDeConteudo({ conteudo: montarConteudoQrCode({ chaveAcesso, ambiente }), urlConsulta });
}

/** Chave de acesso em grupos de 4 dígitos (exibição no recibo). */
function formatarChaveAcesso(chaveAcesso) {
  return String(chaveAcesso || '').replace(/(\d{4})(?=\d)/g, '$1 ');
}

module.exports = {
  VERSAO_QRCODE, URL_QRCODE_POR_UF, URL_CHAVE_POR_UF,
  montarConteudoQrCode, montarConteudoQrCodeContingencia, montarUrlQrCode, montarUrlQrCodeDeConteudo,
  urlQrCodeDaUf, urlChaveDaUf, formatarChaveAcesso,
};
