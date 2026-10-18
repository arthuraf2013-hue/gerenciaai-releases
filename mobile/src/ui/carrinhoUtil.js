import { totalItemCentavos } from '../services/base.js';

export const CARRINHO_VAZIO = Object.freeze({ itens: [], descontoCentavos: 0, pinGerenteDesconto: null, cliente: null });

/** Mesma regra de arredondamento da finalização (services/vendas.js). */
export function totalDoCarrinho(itens) {
  return itens.reduce((s, i) => s + totalItemCentavos(i.precoCentavos, i.qtdMil), 0);
}
