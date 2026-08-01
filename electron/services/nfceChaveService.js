/**
 * Chave de acesso — identificador único de 44 dígitos de toda NF-e/NFC-e.
 * Layout confirmado contra várias fontes independentes (Manual de
 * Orientação ao Contribuinte v6.00, blog Focus NFe, Webmania,
 * cnpjcpf.com.br) — todas descrevem exatamente a mesma estrutura e o
 * mesmo algoritmo, então a confiança aqui é alta. Mesmo assim, TESTE
 * contra o ambiente de homologação real antes de confiar em produção
 * — não tive como validar contra uma chave real emitida de verdade.
 *
 * Composição (44 dígitos):
 *   cUF (2) + AAMM (4) + CNPJ (14) + mod (2) + série (3) + número (9)
 *   + tpEmis (1) + cNF (8) + cDV (1)
 */

/** Código do IBGE por UF — usado no campo cUF da chave e no XML. */
const CODIGO_UF = {
  AC: 12, AL: 27, AP: 16, AM: 13, BA: 29, CE: 23, DF: 53, ES: 32, GO: 52,
  MA: 21, MT: 51, MS: 50, MG: 31, PA: 15, PB: 25, PR: 41, PE: 26, PI: 22,
  RJ: 33, RN: 24, RS: 43, RO: 11, RR: 14, SC: 42, SP: 35, SE: 28, TO: 17,
};

/** Dígito verificador da chave — módulo 11, pesos 2 a 9 da direita pra
 * esquerda, ciclando. Resto 0 ou 1 vira DV=0. */
function calcularDVChaveAcesso(chave43) {
  if (!/^\d{43}$/.test(chave43)) throw new Error('A chave (sem o DV) precisa ter exatamente 43 dígitos numéricos.');
  let soma = 0;
  let peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return (resto === 0 || resto === 1) ? 0 : 11 - resto;
}

/** Monta a chave de acesso completa de 44 dígitos. */
function montarChaveAcesso({ uf, dataEmissao, cnpj, modelo = '65', serie, numero, tpEmis = '1', codigoNumerico }) {
  const cUF = CODIGO_UF[uf];
  if (!cUF) throw new Error(`UF desconhecida: "${uf}".`);

  const data = dataEmissao instanceof Date ? dataEmissao : new Date(dataEmissao);
  const aamm = String(data.getFullYear()).slice(2) + String(data.getMonth() + 1).padStart(2, '0');

  const cnpjLimpo = String(cnpj).replace(/\D/g, '').padStart(14, '0');
  if (cnpjLimpo.length !== 14) throw new Error('CNPJ precisa ter 14 dígitos.');

  const serieFmt = String(serie).padStart(3, '0');
  const numeroFmt = String(numero).padStart(9, '0');
  const cNFFmt = String(codigoNumerico).padStart(8, '0');

  const chave43 = `${cUF}${aamm}${cnpjLimpo}${modelo}${serieFmt}${numeroFmt}${tpEmis}${cNFFmt}`;
  if (chave43.length !== 43) {
    throw new Error(`Chave (sem DV) ficou com ${chave43.length} dígitos, deveria ter 43 — confira os parâmetros.`);
  }

  const dv = calcularDVChaveAcesso(chave43);
  return chave43 + dv;
}

/** Gera um código numérico aleatório de 8 dígitos (cNF) — obrigatório
 * e deve mudar a cada nota, é o que evita que duas notas idênticas
 * (mesmo número/série) gerem a mesma chave por acidente. */
function gerarCodigoNumericoAleatorio() {
  return String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

module.exports = { CODIGO_UF, calcularDVChaveAcesso, montarChaveAcesso, gerarCodigoNumericoAleatorio };
