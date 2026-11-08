/**
 * Contas da cozinha usadas no cadastro de pratos e insumos (ProductForm,
 * FichaTecnicaEditor, IngredientManager). Sem React aqui, para os testes
 * (tests/cozinhaUtils.test.js).
 *
 * Regra que segura tudo: o banco guarda a quantidade da ficha técnica SEMPRE
 * na unidade do insumo e POR PORÇÃO (dish_ingredients.quantidade), porque é
 * isso que a venda desconta (ingredientService.descontarPorVenda). A tela é
 * que deixa digitar em g/ml e para a receita inteira -- e converte na hora de
 * salvar.
 */

/** Unidades de insumo, com o nome que aparece na tela. */
export const UNIDADES_INSUMO = [
  { valor: 'kg', rotulo: 'Quilo (kg)' },
  { valor: 'g', rotulo: 'Grama (g)' },
  { valor: 'l', rotulo: 'Litro (l)' },
  { valor: 'ml', rotulo: 'Mililitro (ml)' },
  { valor: 'un', rotulo: 'Unidade (un)' },
];

// Fator para levar 1 da unidade até a unidade-base da família (g ou ml).
const FATOR = { kg: 1000, g: 1, l: 1000, ml: 1, un: 1 };
const FAMILIA = { kg: 'massa', g: 'massa', l: 'volume', ml: 'volume', un: 'unidade' };

/** Unidades em que dá para digitar uma quantidade de um insumo guardado em `base`. */
export function unidadesCompativeis(base) {
  const familia = FAMILIA[base];
  if (familia === 'massa') return ['g', 'kg'];
  if (familia === 'volume') return ['ml', 'l'];
  return [base || 'un'];
}

/** Converte `qtd` de uma unidade para outra da mesma família (g↔kg, ml↔l). */
export function converter(qtd, de, para) {
  const n = Number(qtd);
  if (!Number.isFinite(n)) return NaN;
  if (de === para) return n;
  if (!FAMILIA[de] || FAMILIA[de] !== FAMILIA[para]) return NaN;
  return (n * FATOR[de]) / FATOR[para];
}

/** Arredonda sem lixo de ponto flutuante (0.1 + 0.2). */
export function arred(n, casas = 4) {
  const f = 10 ** casas;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/**
 * Melhor unidade para MOSTRAR uma quantidade guardada em `base`:
 * 0,15 kg aparece como 150 g; 1,5 kg continua 1,5 kg.
 */
export function unidadeParaMostrar(qtdBase, base) {
  const n = Number(qtdBase);
  if (base === 'kg' && n > 0 && n < 1) return 'g';
  if (base === 'l' && n > 0 && n < 1) return 'ml';
  return base || 'un';
}

/**
 * Custo por unidade do insumo a partir da compra ("paguei R$ 25,90 por 5 kg").
 * A quantidade pode vir em outra unidade da mesma família (comprou 500 g de
 * um insumo controlado em kg).
 */
export function custoPorUnidade({ valorPago, quantidade, unidadeComprada, unidadeBase }) {
  const valor = Number(valorPago);
  const qtdBase = converter(quantidade, unidadeComprada || unidadeBase, unidadeBase);
  if (!(valor >= 0) || !(qtdBase > 0)) return null;
  return arred(valor / qtdBase, 4);
}

/**
 * Linha da tela da ficha técnica → quantidade POR PORÇÃO na unidade do insumo.
 * `rendimento` = quantas porções a receita digitada rende (mínimo 1).
 */
export function quantidadePorPorcao({ quantidade, unidade, unidadeBase, rendimento = 1 }) {
  const total = converter(quantidade, unidade || unidadeBase, unidadeBase);
  const porcoes = Math.max(1, Number(rendimento) || 1);
  if (!(total > 0)) return null;
  return arred(total / porcoes, 6);
}

/** O inverso: quantidade guardada (por porção, unidade do insumo) → linha da tela. */
export function linhaParaTela({ quantidadePorPorcao: qtd, unidadeBase, rendimento = 1 }) {
  const porcoes = Math.max(1, Number(rendimento) || 1);
  const totalBase = Number(qtd) * porcoes;
  const unidade = unidadeParaMostrar(totalBase, unidadeBase);
  return { quantidade: arred(converter(totalBase, unidadeBase, unidade), 3), unidade };
}

/**
 * Custo de uma porção a partir das linhas da tela.
 * linhas: [{ quantidade, unidade, unidadeBase, custoUnitario }]
 */
export function custoDaPorcao(linhas, rendimento = 1) {
  let total = 0;
  for (const l of linhas || []) {
    const qtd = quantidadePorPorcao({ quantidade: l.quantidade, unidade: l.unidade, unidadeBase: l.unidadeBase, rendimento });
    if (qtd && Number(l.custoUnitario) >= 0) total += qtd * Number(l.custoUnitario);
  }
  return arred(total, 4);
}

/**
 * CMV (custo da mercadoria vendida) em % do preço -- a régua do restaurante.
 * Faixas usuais: até 30% saudável, até 38% atenção, acima disso caro.
 */
export function avaliarCmv(custo, preco) {
  const c = Number(custo);
  const p = Number(preco);
  if (!(c > 0) || !(p > 0)) return null;
  const percentual = arred((c / p) * 100, 1);
  const faixa = percentual <= 30 ? 'bom' : percentual <= 38 ? 'atencao' : 'alto';
  return { percentual, faixa, lucro: arred(p - c, 2) };
}

/** Preço para o custo ficar em `alvo`% do preço (ex.: 30%), arredondado para ,90. */
export function precoSugerido(custo, alvo = 30) {
  const c = Number(custo);
  const a = Number(alvo);
  if (!(c > 0) || !(a > 0 && a < 100)) return null;
  const bruto = arred(c / (a / 100), 2); // 8,97 / 0,3 = 29,900000000000002 sem isso
  // Termina em ,90 (o centavo de cardápio), sem nunca baixar o preço da conta.
  const comNoventa = Math.floor(bruto) + 0.9;
  return arred(comNoventa >= bruto ? comNoventa : comNoventa + 1, 2);
}

/** Situação do estoque de um insumo para a lista. */
export function situacaoEstoque({ estoque_atual: atual, estoque_minimo: minimo }) {
  const a = Number(atual) || 0;
  const m = Number(minimo) || 0;
  if (a <= 0) return 'sem';
  if (m > 0 && a <= m) return 'acabando';
  return 'ok';
}

/** "1,5 kg", "150 g", "3 un" -- número no formato brasileiro, sem zeros sobrando. */
export function formatarQuantidade(qtd, unidade) {
  const n = Number(qtd);
  if (!Number.isFinite(n)) return '—';
  const texto = n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  return unidade ? `${texto} ${unidade}` : texto;
}

export function formatarReais(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.1 ? 4 : 2 });
}

/** Número digitado no formato brasileiro ("1,5") ou com ponto ("1.5"). */
export function lerNumero(texto) {
  if (typeof texto === 'number') return texto;
  const t = String(texto ?? '').trim();
  if (!t) return NaN;
  // "1.234,56" → 1234.56 ; "1,5" → 1.5 ; "1.5" → 1.5
  const normal = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(normal);
  return Number.isFinite(n) ? n : NaN;
}
