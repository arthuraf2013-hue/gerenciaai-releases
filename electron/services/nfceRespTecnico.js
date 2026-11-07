/**
 * Responsável técnico pelo sistema emissor (grupo <infRespTec> da NFC-e,
 * NT 2018.005). É a empresa que desenvolve o GerenciaAI -- não a loja --,
 * por isso fica no código e vale para todas as instalações. PE e várias
 * outras UFs exigem (rejeição 972 sem ele); PE não exige o CSRT (o código
 * de credenciamento do software), então só os dados abaixo.
 *
 * Sem CNPJ válido (14 dígitos) o grupo não vai na nota.
 */
const RESPONSAVEL_TECNICO = {
  cnpj: '',
  contato: '',
  email: '',
  fone: '',
};

module.exports = { RESPONSAVEL_TECNICO };
