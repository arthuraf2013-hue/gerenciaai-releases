import { useEffect } from 'react';
import { useToque } from '../../context/ToqueContext';
import { campoDeTexto, quantoRolar, toqueDeDedo } from '../../utils/tecladoSistema';

// Teclado de toque do Windows nos campos de texto (cadastro de produto,
// cliente, usuário...), no modo toque. Os campos de número continuam
// com o nosso teclado numérico (TecladoNumerico.jsx).
//
// Só sobe quando a pessoa TOCA no campo com o dedo: quem clica com o
// mouse ou chega pelo Tab no teclado físico não ganha teclado na tela.
// Enquanto ele está aberto, a tela ganha espaço embaixo (--teclado-sistema)
// e rola o campo para cima do teclado.

function rolador(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function TecladoDoSistema() {
  const { ativo } = useToque();

  useEffect(() => {
    const tela = window.pdv?.tela;
    if (!ativo || !tela?.tecladoSistema || !tela?.aoMudarTecladoSistema) return undefined;

    const raiz = document.documentElement;
    let aberto = false; // pedimos para mostrar e não escondemos ainda
    let jaApareceu = false; // o Windows já mostrou desde o último "mostrar"
    let altura = 0;
    let tocado = { el: null, quando: 0 };
    let timerEsconder = null;

    const pedir = (acao) => Promise.resolve(tela.tecladoSistema(acao)).catch(() => null);

    function deixarCampoAVista() {
      const el = document.activeElement;
      if (!altura || !campoDeTexto(el)) return;
      // Espera o espaço extra embaixo (CSS) entrar antes de medir.
      requestAnimationFrame(() => {
        const d = quantoRolar(el.getBoundingClientRect(), window.innerHeight, altura);
        if (d > 0) rolador(el)?.scrollBy({ top: d, behavior: 'smooth' });
      });
    }

    function mostrar() {
      clearTimeout(timerEsconder);
      if (aberto && altura > 0) { deixarCampoAVista(); return; }
      aberto = true;
      jaApareceu = false;
      pedir('mostrar');
    }

    function esconderDaquiAPouco() {
      clearTimeout(timerEsconder);
      // Espera o foco assentar: indo de um campo de texto para outro, fica.
      timerEsconder = setTimeout(() => {
        if (!aberto || campoDeTexto(document.activeElement)) return;
        aberto = false;
        pedir('esconder');
      }, 250);
    }

    function aoMudarArea({ altura: nova } = {}) {
      altura = Number(nova) > 0 ? Math.round(nova) : 0;
      if (altura > 0) jaApareceu = true;
      // Fechou pelo X do próprio teclado: o próximo toque no campo abre de novo.
      else if (jaApareceu) aberto = false;
      raiz.style.setProperty('--teclado-sistema', `${altura}px`);
      raiz.classList.toggle('teclado-sistema-aberto', altura > 0);
      deixarCampoAVista();
    }

    function alvoDoToque(alvo) {
      if (!(alvo instanceof Element)) return null;
      const label = alvo.closest('label');
      if (label && !campoDeTexto(alvo) && label.control) return label.control;
      return alvo;
    }

    function aoTocar(e) {
      if (!toqueDeDedo(e.pointerType)) return;
      const el = alvoDoToque(e.target);
      if (!campoDeTexto(el)) return;
      tocado = { el, quando: Date.now() };
      // Tocou de novo no campo que já tinha o foco (não há focusin).
      if (el === document.activeElement) mostrar();
    }

    function aoFocar(e) {
      const el = e.target;
      if (campoDeTexto(el)) {
        const tocouAgora = tocado.el === el && Date.now() - tocado.quando < 1200;
        if (tocouAgora || aberto) mostrar();
      } else if (aberto) {
        esconderDaquiAPouco();
      }
    }

    function aoSair() {
      if (aberto) esconderDaquiAPouco();
    }

    const pararDeOuvir = tela.aoMudarTecladoSistema(aoMudarArea);
    document.addEventListener('pointerdown', aoTocar, true);
    document.addEventListener('focusin', aoFocar);
    document.addEventListener('focusout', aoSair);
    pedir('preparar'); // já sobe o processo: o primeiro toque não espera

    return () => {
      clearTimeout(timerEsconder);
      pararDeOuvir?.();
      document.removeEventListener('pointerdown', aoTocar, true);
      document.removeEventListener('focusin', aoFocar);
      document.removeEventListener('focusout', aoSair);
      if (aberto) pedir('esconder');
      raiz.style.removeProperty('--teclado-sistema');
      raiz.classList.remove('teclado-sistema-aberto');
    };
  }, [ativo]);

  return null;
}
