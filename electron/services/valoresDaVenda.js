// Valores de uma venda FINALIZADA, num lugar só (revisão nov/2026).
//
// saleService.finalizeSale SOMA a taxa de serviço em sales.total na hora de
// fechar. Então, numa venda finalizada:
//   líquido (o que o cliente pagou)  = total − desconto − desconto_gerente
//   taxa de serviço em R$            = líquido × p / (100 + p)
//   valor dos itens já com desconto  = líquido − taxa
// O erro que isto corrige: relatórios (DRE, BI, fluxo de caixa, imposto
// estimado, exportação contábil) multiplicavam o líquido por (1 + p) de
// novo, contando a taxa duas vezes. Venda ABERTA é outra conta (a taxa
// ainda não está no total): ver saleService.addPayment/finalizeSale.

/** Expressão SQL do líquido de uma venda finalizada (`a` = alias com ponto, ex.: 's.'). */
const sqlLiquido = (a = '') => `(${a}total - ${a}desconto - ${a}desconto_gerente)`;

/** Expressão SQL da taxa de serviço em R$ que já está dentro de sales.total. */
const sqlTaxaServico = (a = '') =>
  `(CASE WHEN COALESCE(${a}taxa_servico_percentual, 0) > 0
     THEN ${sqlLiquido(a)} * ${a}taxa_servico_percentual / (100.0 + ${a}taxa_servico_percentual) ELSE 0 END)`;

/** O mesmo em JS, para uma linha de sales já finalizada. */
function valoresDaVendaFinalizada(sale) {
  const liquido = (Number(sale.total) || 0) - (Number(sale.desconto) || 0) - (Number(sale.desconto_gerente) || 0);
  const p = Number(sale.taxa_servico_percentual) || 0;
  const taxa = p > 0 ? (liquido * p) / (100 + p) : 0;
  return { liquido, taxaServico: taxa, itensComDesconto: liquido - taxa };
}

module.exports = { sqlLiquido, sqlTaxaServico, valoresDaVendaFinalizada };
