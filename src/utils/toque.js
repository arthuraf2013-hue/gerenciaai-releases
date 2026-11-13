// Modo toque: tela touch (totem, tablet, monitor de toque no caixa).
//
// É do COMPUTADOR, não do usuário: o mesmo monitor de toque serve o caixa
// da manhã e o da noite, e a tela de login (antes de saber quem é) já
// precisa estar no tamanho de dedo. Por isso fica no localStorage e não
// no user_preferences.
//
// 'auto' liga quando o ponteiro PRINCIPAL é grosso (dedo) -- notebook com
// tela de toque mas usado com mouse/touchpad continua no modo normal.

export const CHAVE_TOQUE = 'gerenciaai:toque';
export const MODOS_TOQUE = ['auto', 'sim', 'nao'];

export function lerModoToque(armazenamento = globalThis.localStorage) {
  try {
    const v = armazenamento?.getItem(CHAVE_TOQUE);
    return MODOS_TOQUE.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function gravarModoToque(modo, armazenamento = globalThis.localStorage) {
  if (!MODOS_TOQUE.includes(modo)) return;
  try { armazenamento?.setItem(CHAVE_TOQUE, modo); } catch { /* sem localStorage: vale só agora */ }
}

/** @param {'auto'|'sim'|'nao'} modo @param {boolean} ponteiroGrosso */
export function toqueAtivo(modo, ponteiroGrosso) {
  if (modo === 'sim') return true;
  if (modo === 'nao') return false;
  return !!ponteiroGrosso;
}

// ---------------------------------------------------------------------------
// Teclado numérico da tela: a lógica do que cada tecla faz, separada do
// componente para dar para testar sem navegador.
//
// estado = { texto, substituir }
//   texto       o que aparece no visor ("12," enquanto a pessoa digita)
//   substituir  true logo depois de abrir num campo já preenchido: o
//               primeiro número troca o valor inteiro (como na maquininha),
//               em vez de grudar no fim ("45,90" + 5 = "5", não "45,905").
// opcoes = { decimal: boolean, casas?: number, maxLength?: number }
//   casas  quantas casas depois da vírgula (2 para dinheiro, 3 para kg).
// ---------------------------------------------------------------------------

export function iniciarTeclado(valorAtual) {
  const bruto = String(valorAtual ?? '');
  // type="number" devolve "45.9"; campo de texto já vem com vírgula.
  const texto = bruto.includes(',') ? bruto : bruto.replace('.', ',');
  return { texto, substituir: texto !== '' };
}

export function aplicarTecla(estado, tecla, { decimal = false, casas = 2, maxLength } = {}) {
  let { texto } = estado;
  const { substituir } = estado;

  if (tecla === 'limpar') return { texto: '', substituir: false };

  if (tecla === 'apagar') {
    return { texto: substituir ? '' : texto.slice(0, -1), substituir: false };
  }

  if (tecla === ',') {
    if (!decimal) return estado;
    if (substituir) return { texto: '0,', substituir: false };
    if (texto.includes(',')) return estado;
    return { texto: (texto === '' ? '0' : texto) + ',', substituir: false };
  }

  if (/^\d$/.test(tecla)) {
    if (substituir) texto = '';
    // Não passa das casas que o campo aceita (o navegador recusaria).
    const virgula = texto.indexOf(',');
    if (virgula >= 0 && texto.length - virgula - 1 >= casas) return { texto, substituir: false };
    if (maxLength > 0 && texto.length >= maxLength) return { texto, substituir: false };
    // "0" seguido de número vira o número ("07" -> "7"), menos em PIN/código.
    if (decimal && texto === '0') texto = '';
    return { texto: texto + tecla, substituir: false };
  }

  return estado;
}

/**
 * O valor que vai para o campo de verdade.
 * type="number" só aceita ponto e não aceita "12." (o navegador apaga o
 * campo inteiro) -- por isso a vírgula do fim fica só no visor.
 */
export function valorParaCampo(texto, tipoCampo) {
  if (tipoCampo !== 'number') return texto;
  const comPonto = texto.replace(',', '.');
  return comPonto.endsWith('.') ? comPonto.slice(0, -1) : comPonto;
}

/**
 * Que campos ganham o teclado numérico e se aceitam vírgula.
 * Recebe só o que importa do <input> (para dar para testar sem DOM).
 * @returns {null | { decimal: boolean, casas?: number }}
 */
export function campoNumerico({ tag, type, inputMode, step, readOnly, disabled }) {
  if (tag !== 'INPUT' || readOnly || disabled) return null;
  const modo = (inputMode || '').toLowerCase();
  if (type === 'number') {
    // Sem step o navegador só aceita inteiro (step padrão = 1).
    // step="0.01" -> 2 casas; step="0.001" (kg) -> 3; "any" -> 3.
    const passo = String(step ?? '');
    if (passo.includes('.')) return { decimal: true, casas: passo.split('.')[1].length };
    if (modo === 'decimal' || passo === 'any') return { decimal: true, casas: 3 };
    return { decimal: false };
  }
  if (type === 'text' || type === 'password' || type === 'tel' || !type) {
    if (modo === 'decimal') return { decimal: true, casas: 3 };
    if (modo === 'numeric' || type === 'tel') return { decimal: false };
  }
  return null;
}
