import { useEffect } from 'react';

/**
 * Fecha um modal/subtela apertando Esc, sem precisar clicar no botão
 * de fechar. `ativo` controla se o listener está ligado — passe a
 * condição que já decide se aquele modal está aberto (ex: `!!editing`),
 * assim o hook pode ficar sempre chamado no topo do componente (regra
 * dos hooks), mesmo quando o modal em si só é montado condicionalmente.
 */
export function useEscToClose(onClose, ativo = true) {
  useEffect(() => {
    if (!ativo) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, ativo]);
}
