import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

const ATALHOS = [
  { tecla: 'Tab', descricao: 'Move o foco pro próximo campo ou botão da tela.' },
  { tecla: 'Shift+Tab', descricao: 'Move o foco pro campo ou botão anterior.' },
  { tecla: '↑ ↓', descricao: 'Navega entre os itens do menu lateral, e entre os resultados de uma busca (como a de Ctrl+K).' },
  { tecla: 'Enter', descricao: 'Confirma o item selecionado, ou salva o formulário focado.' },
  { tecla: 'Esc', descricao: 'Fecha a janela ou o menu aberto no momento, sem salvar.' },
  { tecla: 'Ctrl+K', descricao: 'Busca rápida — pula direto pra qualquer tela do sistema.' },
  { tecla: 'F2', descricao: 'Finaliza a venda (dentro do PDV).' },
  { tecla: 'F4', descricao: 'Cancela o item selecionado no carrinho (dentro do PDV).' },
  { tecla: '?', descricao: 'Abre esta ajuda de atalhos, de qualquer tela.' },
];

export function KeyboardHelpModal({ onClose }) {
  useEscToClose(onClose);
  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ width: 'min(560px, 94vw)' }}>
        <h2>⌨️ Atalhos de teclado</h2>
        <p className="screen-hint" style={{ margin: '0 0 12px' }}>
          O sistema todo funciona sem mouse — esses são os atalhos que valem em qualquer tela.
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {ATALHOS.map((a) => (
            <li key={a.tecla} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--color-border)' }}>
              <span className="keyboard-key" style={{ minWidth: 90, textAlign: 'center' }}>{a.tecla}</span>
              <span style={{ flex: 1 }}>{a.descricao}</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}><Icon name="close" size={15} /> Fechar</button>
        </div>
      </div>
    </div>
  );
}

/** Instale uma vez, perto da raiz do app — abre a ajuda ao apertar
 * "?", contanto que o foco não esteja num campo de digitação (senão
 * digitar uma interrogação de verdade num texto abriria o modal
 * sem querer). */
export function useKeyboardHelpShortcut() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== '?') return;
      const alvo = e.target;
      const estaDigitando = alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.tagName === 'SELECT' || alvo.isContentEditable;
      if (estaDigitando) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { open, close: () => setOpen(false) };
}
