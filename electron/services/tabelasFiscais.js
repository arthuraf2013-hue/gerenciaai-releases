/**
 * Tabelas e contas fiscais puras (sem banco) usadas pelo assistente fiscal
 * e pelo DRE. Tudo aqui é ESTIMATIVA de apoio à gestão -- quem apura e
 * declara é o contador. Valores que mudam por lei ficam juntos aqui, com a
 * fonte, pra atualizar num lugar só.
 */

// Simples Nacional, Anexo I (comércio) -- LC 123/2006, redação da LC 155/2016.
// [limite superior da faixa (RBT12), alíquota nominal, parcela a deduzir]
const ANEXO_I = [
  [180000, 0.04, 0],
  [360000, 0.073, 5940],
  [720000, 0.095, 13860],
  [1800000, 0.107, 22500],
  [3600000, 0.143, 87300],
  [4800000, 0.19, 378000],
];

const LIMITE_SIMPLES = 4800000;
const SUBLIMITE_ICMS = 3600000; // acima disso, ICMS/ISS saem do DAS
const LIMITE_MEI_ANUAL = 81000; // LC 123, art. 18-A; projetos para subir ainda não aprovados (out/2026)
const TOLERANCIA_MEI = 0.2;     // até 20% acima: desenquadra só no ano seguinte

// DAS-MEI = 5% do salário mínimo (INSS) + R$ 1 de ICMS (comércio/indústria)
// e/ou R$ 5 de ISS (serviços). Salário mínimo por ano:
const SALARIO_MINIMO = { 2024: 1412, 2025: 1518, 2026: 1621 };

function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

/** Faixa e alíquota efetiva do Anexo I para uma RBT12.
 * Efetiva = (RBT12 × nominal − parcela a deduzir) / RBT12. */
function aliquotaEfetivaAnexoI(rbt12) {
  const r = Number(rbt12) || 0;
  if (r <= 0) return { faixa: 1, nominal: ANEXO_I[0][1], deduzir: 0, efetiva: ANEXO_I[0][1], acimaDoLimite: false };
  const idx = ANEXO_I.findIndex(([teto]) => r <= teto);
  const acimaDoLimite = idx === -1;
  const [, nominal, deduzir] = ANEXO_I[acimaDoLimite ? ANEXO_I.length - 1 : idx];
  return { faixa: acimaDoLimite ? 6 : idx + 1, nominal, deduzir, efetiva: arred((r * nominal - deduzir) / r, 6), acimaDoLimite };
}

/** Valor do DAS-MEI do ano. Ano sem salário mínimo conhecido usa o último
 * conhecido e avisa (`estimado`). */
function dasMei(ano, atividade = 'comercio') {
  const anos = Object.keys(SALARIO_MINIMO).map(Number).sort((a, b) => a - b);
  const anoUsado = SALARIO_MINIMO[ano] ? ano : anos.filter((a) => a <= ano).pop() || anos[0];
  const inss = arred(SALARIO_MINIMO[anoUsado] * 0.05);
  const extra = atividade === 'servicos' ? 5 : atividade === 'ambos' ? 6 : 1;
  return { valor: arred(inss + extra), inss, anoBase: anoUsado, estimado: anoUsado !== ano };
}

/** Limite do MEI no ano: proporcional aos meses de atividade quando a
 * empresa abriu naquele ano (R$ 6.750 por mês, contando o mês da abertura). */
function limiteMei(ano, dataAbertura) {
  let meses = 12;
  if (dataAbertura && /^\d{4}-\d{2}/.test(dataAbertura) && Number(dataAbertura.slice(0, 4)) === Number(ano)) {
    meses = 12 - Number(dataAbertura.slice(5, 7)) + 1;
  }
  const limite = arred((LIMITE_MEI_ANUAL / 12) * meses);
  return { limite, comTolerancia: arred(limite * (1 + TOLERANCIA_MEI)), meses };
}

// CFOP de VENDA do fornecedor que indica mercadoria com ICMS-ST já retido.
// Na revenda pelo Simples/MEI isso vira CFOP 5405 + CSOSN 500.
const CFOP_COMPRA_COM_ST = new Set(['5401', '5403', '5405', '6401', '6403', '6404']);

const CSOSN_VALIDOS = new Set(['101', '102', '103', '201', '202', '203', '300', '400', '500', '900']);
const CST_ICMS_VALIDOS = new Set(['00', '10', '20', '30', '40', '41', '50', '51', '60', '70', '90']);

module.exports = {
  ANEXO_I, LIMITE_SIMPLES, SUBLIMITE_ICMS, LIMITE_MEI_ANUAL, TOLERANCIA_MEI, SALARIO_MINIMO,
  aliquotaEfetivaAnexoI, dasMei, limiteMei, CFOP_COMPRA_COM_ST, CSOSN_VALIDOS, CST_ICMS_VALIDOS, arred,
};
