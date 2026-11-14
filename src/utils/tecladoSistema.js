// Teclado do próprio Windows (o de toque) nos campos de texto, no modo toque.
//
// Com um teclado físico ligado no computador (o caso do caixa), o Windows
// não sobe o teclado de toque sozinho quando se toca num campo. Então o
// app pede: tocou com o dedo num campo de TEXTO (nome, descrição, e-mail),
// o processo principal mostra o teclado do Windows; saiu para um botão ou
// para um campo de número (que tem o nosso teclado numérico), ele esconde.
//
// Aqui fica só a decisão, sem navegador, para dar para testar.

import { campoNumerico } from './toque';

const TIPOS_TEXTO = new Set(['text', 'search', 'email', 'url', 'password']);

/**
 * O campo é de digitar texto (e não de número)?
 * Recebe o elemento (ou um objeto com os mesmos campos, nos testes).
 */
export function campoDeTexto(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.dataset && 'semTeclado' in el.dataset) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const tipo = String(el.getAttribute?.('type') || 'text').toLowerCase();
  if (!TIPOS_TEXTO.has(tipo)) return false;
  const modo = String(el.getAttribute?.('inputmode') || '').toLowerCase();
  // "none": o campo já tem teclado da tela (o nosso numérico, ou o PIN do login).
  if (modo === 'none') return false;
  return !campoNumerico({ tag, type: tipo, inputMode: modo, step: el.getAttribute?.('step'), readOnly: el.readOnly, disabled: el.disabled });
}

/** Toque de dedo ou caneta -- mouse e touchpad não chamam o teclado. */
export function toqueDeDedo(pointerType) {
  return pointerType === 'touch' || pointerType === 'pen';
}

/**
 * Quanto rolar para o campo sair de baixo do teclado do Windows.
 * @param {{top:number,bottom:number}} campo     getBoundingClientRect() do campo
 * @param {number} alturaJanela                   window.innerHeight
 * @param {number} alturaTeclado                  quanto do fundo da janela o teclado cobre
 * @param {number} folga                          espaço entre o campo e o teclado
 * @returns {number} pixels para rolar para baixo (0 = já está visível)
 */
export function quantoRolar(campo, alturaJanela, alturaTeclado, folga = 16) {
  if (!(alturaTeclado > 0)) return 0;
  const limite = alturaJanela - alturaTeclado - folga;
  if (campo.bottom <= limite) return 0;
  // Nunca a ponto de esconder o topo do campo lá em cima.
  return Math.max(0, Math.min(campo.bottom - limite, campo.top - folga));
}
