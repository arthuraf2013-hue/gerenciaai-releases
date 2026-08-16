import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

/**
 * @param {{ titulo: string, valorInicial: string, placeholder?: string, onConfirmar: (valor: string) => void, onCancelar: () => void }} props
 */
export function PromptModal({ titulo, valorInicial, placeholder, onConfirmar, onCancelar }) {
  const [valor, setValor] = useState(valorInicial || '');
  useEscToClose(onCancelar);

  // Se o mesmo modal for reaberto com um valor inicial diferente (ex:
  // preço de outro item), reflete isso no campo.
  useEffect(() => { setValor(valorInicial || ''); }, [valorInicial]);

  function handleSubmit(e) {
    e.preventDefault();
    onConfirmar(valor);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <form onSubmit={handleSubmit}>
          <h2>{titulo}</h2>
          <input
            autoFocus
            className="prompt-modal-input"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            placeholder={placeholder}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={onCancelar}>✖️ Cancelar</button>
            <button type="submit" className="btn-primary">✅ OK</button>
          </div>
        </form>
      </div>
    </div>
  );
}
