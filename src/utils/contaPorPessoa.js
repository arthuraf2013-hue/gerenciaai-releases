// Pagamento individual na mesa: quanto é a parte de cada pessoa.
//
// A parte segue a mesma conta do PaymentPanel para a mesa inteira
// (itens − descontos, + taxa de serviço), dividida na proporção do que
// cada um consumiu -- assim a soma das partes bate com o total da conta
// (fora o centavo do arredondamento, que fica para quem paga por último).

const arred = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Total a pagar da comanda inteira, igual ao do PaymentPanel. */
export function totalDaConta({ subtotalItens, desconto = 0, taxaServicoPercentual = 0 }) {
  const base = Math.max(0, (Number(subtotalItens) || 0) - (Number(desconto) || 0));
  return base + (taxaServicoPercentual > 0 ? base * (taxaServicoPercentual / 100) : 0);
}

/** Parte de uma pessoa: o que ela consumiu, com o desconto e a taxa na mesma proporção. */
export function valorDaPessoa({ subtotalPessoa, subtotalItens, desconto = 0, taxaServicoPercentual = 0 }) {
  const itens = Number(subtotalItens) || 0;
  if (!(itens > 0) || !(subtotalPessoa > 0)) return 0;
  const fator = totalDaConta({ subtotalItens: itens, desconto, taxaServicoPercentual }) / itens;
  return arred(subtotalPessoa * fator);
}

/**
 * Situação da pessoa na conta: 'sem-itens' | 'aberta' | 'parcial' | 'paga'.
 * falta: quanto ainda é dela pagar (nunca negativo).
 */
export function situacaoDaPessoa({ valor, pago = 0 }) {
  const falta = Math.max(0, arred(valor - (Number(pago) || 0)));
  if (!(valor > 0)) return { estado: pago > 0 ? 'paga' : 'sem-itens', falta: 0 };
  if (falta <= 0.005) return { estado: 'paga', falta: 0 };
  return { estado: pago > 0.005 ? 'parcial' : 'aberta', falta };
}
