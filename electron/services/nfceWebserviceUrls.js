/**
 * Endereços dos webservices de autorização de NFC-e, por UF.
 *
 * Confirmado na fonte oficial (https://dfe-portal.svrs.rs.gov.br/Nfce/Servicos)
 * em 04/08/2026. Esses endereços MUDAM de tempos em tempos (o Ceará,
 * por exemplo, migrou pra SVRS em maio de 2025) — antes de ir pra
 * produção de verdade, vale conferir de novo na fonte oficial se
 * ainda bate, especialmente se já faz um tempo desde que isso foi
 * escrito.
 *
 * A maioria dos estados usa o serviço COMPARTILHADO da SVRS (Sefaz
 * Virtual do Rio Grande do Sul) em vez de manter webservice próprio —
 * inclusive Pernambuco. Só uma minoria de estados maiores mantém
 * infraestrutura própria (SP, RS, PR, GO, MT, MS, AM, confirmados
 * abaixo). Qualquer UF não listada explicitamente cai no fallback da
 * SVRS — na prática cobre a grande maioria dos estados, mas VALE
 * CONFIRMAR o caso específico antes de emitir de verdade.
 */
const WEBSERVICES_POR_UF = {
  AM: {
    producao: { autorizacao: 'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeAutorizacao4', retAutorizacao: 'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeRetAutorizacao4' },
    homologacao: { autorizacao: 'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeAutorizacao4', retAutorizacao: 'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeRetAutorizacao4' },
  },
  GO: {
    producao: { autorizacao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4', retAutorizacao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4' },
    homologacao: { autorizacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4', retAutorizacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4' },
  },
  MS: {
    producao: { autorizacao: 'https://nfce.sefaz.ms.gov.br/ws/NFeAutorizacao4', retAutorizacao: 'https://nfce.sefaz.ms.gov.br/ws/NFeRetAutorizacao4' },
    homologacao: { autorizacao: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeAutorizacao4', retAutorizacao: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeRetAutorizacao4' },
  },
  MT: {
    producao: { autorizacao: 'https://nfce.sefaz.mt.gov.br/nfcews/services/NfeAutorizacao4', retAutorizacao: 'https://nfce.sefaz.mt.gov.br/nfcews/services/NfeRetAutorizacao4' },
    homologacao: { autorizacao: 'https://homologacao.sefaz.mt.gov.br/nfcews/services/NfeAutorizacao4', retAutorizacao: 'https://homologacao.sefaz.mt.gov.br/nfcews/services/NfeRetAutorizacao4' },
  },
  PR: {
    producao: { autorizacao: 'https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4', retAutorizacao: 'https://nfce.sefa.pr.gov.br/nfce/NFeRetAutorizacao4' },
    homologacao: { autorizacao: 'https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4', retAutorizacao: 'https://homologacao.nfce.sefa.pr.gov.br/nfce/NFeRetAutorizacao4' },
  },
  RS: {
    producao: { autorizacao: 'https://nfce.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', retAutorizacao: 'https://nfce.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx' },
    homologacao: { autorizacao: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', retAutorizacao: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx' },
  },
  SP: {
    producao: { autorizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx', retAutorizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx' },
    homologacao: { autorizacao: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx', retAutorizacao: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx' },
  },
};

const SVRS = {
  producao: { autorizacao: 'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', retAutorizacao: 'https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx' },
  homologacao: { autorizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', retAutorizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx' },
};

/** UFs confirmadas usando a SVRS (a lista completa de todas as UFs
 * que usam SVRS é maior — a maioria dos estados sem webservice
 * próprio cai aqui pelo fallback abaixo de qualquer forma). PE é o
 * caso confirmado que motivou essa implementação. */
const UFS_CONFIRMADAS_SVRS = ['PE', 'BA', 'MG', 'CE', 'ES', 'RJ'];

function getWebserviceUrls(uf, ambiente) {
  const ambienteChave = ambiente === 'producao' ? 'producao' : 'homologacao';
  const config = WEBSERVICES_POR_UF[uf];
  if (config) return config[ambienteChave];
  // Fallback: SVRS cobre a maioria dos estados que não mantêm
  // webservice próprio — inclusive PE, confirmado.
  return SVRS[ambienteChave];
}

module.exports = { getWebserviceUrls, WEBSERVICES_POR_UF, UFS_CONFIRMADAS_SVRS };
