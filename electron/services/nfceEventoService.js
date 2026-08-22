const { CODIGO_UF } = require('./nfceChaveService');
const { escapeXml, fmtDataHora } = require('./nfceXmlService');

/**
 * Gera o XML do evento de CANCELAMENTO de uma NFC-e já autorizada
 * (tpEvento 110111, layout de evento 1.00) — só monta o XML; quem
 * assina é nfceSignatureService.assinarXmlEvento e quem transmite é
 * nfceTransmissionService.enviarEventoNFCe (o ciclo completo é
 * orquestrado por fiscalService.cancelarNFCe, igual emitirNFCe faz pra
 * emissão).
 *
 * A regra "só cancela dentro do prazo legal" (Ajuste SINIEF 07/05 —
 * tipicamente até o fim do dia seguinte à autorização, mas o prazo
 * exato varia por UF) fica em fiscalService.js: é regra de negócio, não
 * faz parte de montar o XML. Depois do prazo, o caminho correto deixa
 * de ser cancelamento e passa a ser carta de correção/outro
 * procedimento — fora do escopo deste app por enquanto.
 *
 * IMPORTANTE (mesmo aviso do resto do módulo fiscal): a estrutura
 * abaixo segue o schema oficial do evento de cancelamento (MOC NFe/NFCe
 * v6.00, evEpec/evCancNFe), mas nunca foi validada contra um XSD real
 * nem contra um ambiente de homologação de verdade — teste antes de
 * confiar em produção.
 */

const VERSAO_EVENTO = '1.00';
const TP_EVENTO_CANCELAMENTO = '110111';
const SEQ_EVENTO_CANCELAMENTO = 1; // sempre 1 -- este app nunca reenvia o mesmo cancelamento com sequencial maior

/**
 * @param {{ chaveAcesso: string, uf: string, cnpj: string, ambiente: string, protocoloAutorizacao: string, justificativa: string, dataEvento?: Date }} params
 */
function gerarXmlCancelamento({ chaveAcesso, uf, cnpj, ambiente, protocoloAutorizacao, justificativa, dataEvento }) {
  const cUF = CODIGO_UF[uf];
  if (!cUF) throw new Error(`UF desconhecida: "${uf}".`);
  if (!chaveAcesso || chaveAcesso.length !== 44) throw new Error('Chave de acesso inválida para cancelamento.');
  if (!protocoloAutorizacao) throw new Error('Protocolo de autorização é obrigatório para cancelar.');

  const justificativaLimpa = (justificativa || '').trim();
  if (justificativaLimpa.length < 15) {
    throw new Error('A justificativa do cancelamento precisa ter pelo menos 15 caracteres (exigência da SEFAZ).');
  }

  const tpAmb = ambiente === 'producao' ? '1' : '2';
  const dhEvento = fmtDataHora(dataEvento || new Date(), uf);
  const cnpjLimpo = String(cnpj).replace(/\D/g, '').padStart(14, '0');
  const nSeqEvento = String(SEQ_EVENTO_CANCELAMENTO).padStart(2, '0');
  const idEvento = `ID${TP_EVENTO_CANCELAMENTO}${chaveAcesso}${nSeqEvento}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="${VERSAO_EVENTO}">
  <idLote>1</idLote>
  <evento versao="${VERSAO_EVENTO}">
    <infEvento Id="${idEvento}">
      <cOrgao>${cUF}</cOrgao>
      <tpAmb>${tpAmb}</tpAmb>
      <CNPJ>${escapeXml(cnpjLimpo)}</CNPJ>
      <chNFe>${chaveAcesso}</chNFe>
      <dhEvento>${dhEvento}</dhEvento>
      <tpEvento>${TP_EVENTO_CANCELAMENTO}</tpEvento>
      <nSeqEvento>${nSeqEvento}</nSeqEvento>
      <verEvento>${VERSAO_EVENTO}</verEvento>
      <detEvento versao="${VERSAO_EVENTO}">
        <descEvento>Cancelamento</descEvento>
        <nProt>${escapeXml(protocoloAutorizacao)}</nProt>
        <xJust>${escapeXml(justificativaLimpa)}</xJust>
      </detEvento>
    </infEvento>
  </evento>
</envEvento>`;

  return { xml, idEvento };
}

module.exports = { gerarXmlCancelamento, TP_EVENTO_CANCELAMENTO };
