import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const TOUR_SEEN_KEY = 'gerenciaai:posTourSeen';

const STEPS = [
  {
    selector: '.pos-search-row',
    title: 'Buscar produtos',
    text: 'Digite o nome do produto aqui, ou aponte o leitor de código de barras direto pro produto — os dois funcionam ao mesmo tempo, sem precisar clicar em nada antes.',
  },
  {
    selector: '.category-browser',
    title: 'Categorias',
    text: 'Clique numa categoria pra ver a grade de produtos dela. Categorias novas aparecem sozinhas assim que um produto é cadastrado com aquele nome.',
  },
  {
    selector: '.cart-list',
    title: 'Carrinho',
    text: 'Os itens da venda aparecem aqui. Clique numa linha pra selecionar — assim dá pra usar o atalho F4 pra cancelar aquele item específico. Se um produto estiver com estoque baixo ou validade próxima, aparece um ícone de alerta colorido ao lado — clique nele pra ver o motivo.',
  },
  {
    selector: '.pos-attach-btn',
    title: 'Anexar receita',
    text: 'Anexe a foto ou o PDF de uma receita aqui. Se a IA estiver configurada (em Configurações), ela consegue até reconhecer os medicamentos e adicionar ao carrinho sozinha.',
  },
  {
    selector: '.pos-pay-btn',
    title: 'Pagamento',
    text: 'Aceita dinheiro, cartão, Pix (com QR Code de verdade) e mais — inclusive dividindo o valor entre métodos diferentes na mesma venda. Dá pra vincular um cliente (acumula pontos de fidelidade), resgatar pontos como desconto, e pedir um desconto extra autorizado por um gerente.',
  },
  {
    selector: '.pos-shortcuts-hint',
    title: 'Atalhos de teclado',
    text: 'F2 finaliza a venda. F4 cancela o item selecionado no carrinho. Esc fecha qualquer janela aberta. Ajuda bastante a agilizar o dia a dia.',
  },
  {
    selector: '.help-btn-training',
    title: 'Apresentação de treinamento',
    text: 'Esse ícone de formatura abre uma apresentação completa, com todos os recursos do sistema explicados devagar — bom pra quando alguém novo começar a trabalhar aqui.',
  },
  {
    selector: '.tutor-fab',
    title: 'IA tutora',
    text: 'O robô no canto da tela tira dúvida sobre qualquer parte do sistema em texto — pode até colar uma mensagem de erro pra entender o que ela significa.',
  },
];

/**
 * @param {{ forceOpen: boolean, onClose: () => void }} props
 */
export function PosTour({ forceOpen, onClose }) {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const tooltipRef = useRef(null);
  const [tooltipHeight, setTooltipHeight] = useState(210);

  useEffect(() => {
    if (forceOpen) {
      setStepIndex(0);
      setOpen(true);
      return;
    }
    const jaViu = localStorage.getItem(TOUR_SEEN_KEY);
    if (!jaViu) {
      setStepIndex(0);
      setOpen(true);
    }
  }, [forceOpen]);

  useEffect(() => {
    if (!open) return;
    const step = STEPS[stepIndex];
    function updateRect() {
      const el = document.querySelector(step.selector);
      setRect(el ? el.getBoundingClientRect() : null);
    }
    updateRect();
    window.addEventListener('resize', updateRect);
    return () => window.removeEventListener('resize', updateRect);
  }, [open, stepIndex]);

  // Mede a altura de verdade do balão a cada passo — textos maiores (como
  // o de Pagamento) não cabem no espaço fixo que os passos mais curtos
  // usavam, e um valor chutado deixava o balão vazar pra fora da tela.
  useLayoutEffect(() => {
    if (tooltipRef.current) setTooltipHeight(tooltipRef.current.offsetHeight);
  }, [stepIndex, rect, open]);

  function finish() {
    localStorage.setItem(TOUR_SEEN_KEY, '1');
    setOpen(false);
    onClose?.();
  }

  function next() {
    if (stepIndex >= STEPS.length - 1) return finish();
    setStepIndex((i) => i + 1);
  }

  function prev() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  if (!open) return null;
  const step = STEPS[stepIndex];

  const spotlightStyle = rect ? {
    position: 'fixed',
    top: rect.top - 6, left: rect.left - 6,
    width: rect.width + 12, height: rect.height + 12,
    borderRadius: 10,
    boxShadow: '0 0 0 9999px rgba(10, 26, 24, 0.72)',
    pointerEvents: 'none',
    transition: 'all 0.2s ease',
    zIndex: 300,
  } : {
    position: 'fixed', inset: 0, background: 'rgba(10, 26, 24, 0.72)', zIndex: 300,
  };

  const TOOLTIP_WIDTH = 320;
  const GAP = 14;
  const MARGIN = 16;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Tenta embaixo do elemento primeiro (mais natural pra leitura); se não
   * couber, tenta em cima; se também não couber (elemento perto do topo
   * E do fundo — tela muito baixa), tenta nas laterais. Isso evita o bug
   * de antes: quando o elemento apontado fica perto de uma borda (como o
   * robô da IA tutora, fixo no canto inferior direito), só clampar a
   * posição "embaixo" pra caber na tela acabava colocando o balão em
   * cima do próprio elemento que ele está explicando.
   */
  function computeTooltipPosition() {
    if (!rect) {
      return { top: window.innerHeight / 2 - tooltipHeight / 2, left: window.innerWidth / 2 - TOOLTIP_WIDTH / 2 };
    }

    const espacoAbaixo = window.innerHeight - rect.bottom;
    const espacoAcima = rect.top;
    const espacoDireita = window.innerWidth - rect.right;
    const espacoEsquerda = rect.left;
    const precisaVertical = tooltipHeight + GAP + MARGIN;
    const precisaHorizontal = TOOLTIP_WIDTH + GAP + MARGIN;

    if (espacoAbaixo >= precisaVertical) {
      return { top: rect.bottom + GAP, left: clamp(rect.left, MARGIN, window.innerWidth - TOOLTIP_WIDTH - MARGIN) };
    }
    if (espacoAcima >= precisaVertical) {
      return { top: rect.top - tooltipHeight - GAP, left: clamp(rect.left, MARGIN, window.innerWidth - TOOLTIP_WIDTH - MARGIN) };
    }
    if (espacoEsquerda >= precisaHorizontal) {
      return { top: clamp(rect.top, MARGIN, window.innerHeight - tooltipHeight - MARGIN), left: rect.left - TOOLTIP_WIDTH - GAP };
    }
    if (espacoDireita >= precisaHorizontal) {
      return { top: clamp(rect.top, MARGIN, window.innerHeight - tooltipHeight - MARGIN), left: rect.right + GAP };
    }
    // Não coube em nenhum lado sem cobrir o elemento — centraliza na tela.
    return { top: window.innerHeight / 2 - tooltipHeight / 2, left: window.innerWidth / 2 - TOOLTIP_WIDTH / 2 };
  }

  const { top: tooltipTop, left: tooltipLeft } = computeTooltipPosition();

  return (
    <>
      <div style={spotlightStyle} />
      <div ref={tooltipRef} className="tour-tooltip" style={{ top: tooltipTop, left: tooltipLeft }}>
        <span className="tour-step-count">{stepIndex + 1} / {STEPS.length}</span>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button className="btn-link" onClick={finish}>Pular tour</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {stepIndex > 0 && <button className="btn-secondary" onClick={prev}>Voltar</button>}
            <button className="btn-primary" onClick={next}>{stepIndex === STEPS.length - 1 ? 'Concluir' : 'Próximo'}</button>
          </div>
        </div>
      </div>
    </>
  );
}
