const { CODIGO_UF } = require('./nfceChaveService');
const { escapeXml } = require('./nfceXmlService');

/**
 * Gera o XML de INUTILIZAÇÃO de uma faixa de numeração de NFC-e que
 * nunca foi usada (ex: pulou um número por erro no app, ou uma venda
 * foi cancelada antes da NFC-e sair e o número não pode ser
 * reaproveitado) — a SEFAZ exige declarar isso formalmente pra fechar
 * a sequência numérica, senão o "buraco" fica sem explicação oficial e
 * pode gerar questionamento depois. Só monta o XML; quem assina é
 * nfceSignatureService.assinarXmlInutilizacao e quem transmite é
 * nfceTransmissionService.enviarInutilizacaoNFCe (orquestrado por
 * fiscalService.inutilizarNumeracao).
 *
 * Diferente do cancelamento (que referencia uma NFC-e específica já
 * emitida), inutilização é só sobre a NUMERAÇÃO em si — não precisa
 * que nenhuma NFC-e tenha sido gerada pra esses números, é justamente
 * o contrário: numeração que NUNCA foi usada.
 *
 * Mesmo aviso do resto do módulo fiscal: estrutura segue o schema
 * oficial (MOC NFe/NFCe v6.00), mas nunca foi validada contra XSD real
 * nem contra homologação de verdade.
 */

const VERSAO_INUTILIZACAO = '4.00';

/**
 * @param {{ uf: string, cnpj: string, ambiente: string, serie: string, numeroInicial: number, numeroFinal: number, justificativa: string, ano?: number }} params
 */
function gerarXmlInutilizacao({ uf, cnpj, ambiente, serie, numeroInicial, numeroFinal, justificativa, ano }) {
  const cUF = CODIGO_UF[uf];
  if (!cUF) throw new Error(`UF desconhecida: "${uf}".`);

  const nIni = Number(numeroInicial);
  const nFin = Number(numeroFinal);
  if (!nIni || !nFin || nIni < 1 || nFin < nIni) {
    throw new Error('Faixa de numeração inválida — o número final precisa ser maior ou igual ao inicial.');
  }

  const justificativaLimpa = (justificativa || '').trim();
  if (justificativaLimpa.length < 15) {
    throw new Error('A justificativa da inutilização precisa ter pelo menos 15 caracteres (exigência da SEFAZ).');
  }

  const anoFinal = ano || new Date().getFullYear();
  const anoFmt = String(anoFinal).slice(2); // 2 dígitos, ex: 2026 -> "26"
  const tpAmb = ambiente === 'producao' ? '1' : '2';
  const cnpjLimpo = String(cnpj).replace(/\D/g, '').padStart(14, '0');
  const serieFmt = String(serie || '1').padStart(3, '0');
  const nIniFmt = String(nIni).padStart(9, '0');
  const nFinFmt = String(nFin).padStart(9, '0');
  const mod = '65';

  // Id: "ID" + cUF(2) + AA(2) + CNPJ(14) + mod(2) + série(3) + nNFIni(9) + nNFFin(9) = 43 caracteres.
  const idInut = `ID${cUF}${anoFmt}${cnpjLimpo}${mod}${serieFmt}${nIniFmt}${nFinFmt}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="${VERSAO_INUTILIZACAO}">
  <infInut Id="${idInut}">
    <tpAmb>${tpAmb}</tpAmb>
    <xServ>INUTILIZAR</xServ>
    <cUF>${cUF}</cUF>
    <ano>${anoFmt}</ano>
    <CNPJ>${escapeXml(cnpjLimpo)}</CNPJ>
    <mod>${mod}</mod>
    <serie>${escapeXml(String(Number(serie || '1')))}</serie>
    <nNFIni>${nIni}</nNFIni>
    <nNFFin>${nFin}</nNFFin>
    <xJust>${escapeXml(justificativaLimpa)}</xJust>
  </infInut>
</inutNFe>`;

  return { xml, idInut, ano: anoFinal };
}

module.exports = { gerarXmlInutilizacao };
