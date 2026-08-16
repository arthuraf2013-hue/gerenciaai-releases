import { useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

/**
 * @param {{ sale: object, onConfirmar: (dados: { novaDataHora: string, novoTotal: string, motivo: string }) => void, onCancelar: () => void }} props
 */
export function EditHistoricoModal({ sale, onConfirmar, onCancelar }) {
  // Converte o horário UTC salvo pra um valor que o <input type="datetime-local">
  // entende, já em horário de Brasília — o campo mostra e recebe hora local,
  // a conversão pra UTC acontece no backend.
  const dataLocalInicial = sale.finalizada_em
    ? new Date(sale.finalizada_em + 'Z').toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', 'T')
    : '';

  const [novaDataHora, setNovaDataHora] = useState(dataLocalInicial);
  const [novoTotal, setNovoTotal] = useState(sale.total?.toFixed(2) ?? '');
  const [motivo, setMotivo] = useState('');
  useEscToClose(onCancelar);

  function handleSubmit(e) {
    e.preventDefault();
    onConfirmar({ novaDataHora, novoTotal, motivo });
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <form onSubmit={handleSubmit}>
          <h2>✏️ Editar histórico da venda</h2>
          <p className="screen-hint" style={{ margin: '0 0 12px' }}>
            Corrige diretamente data/hora e valor de uma venda já no histórico. Fica registrado
            na auditoria com o valor antigo e o novo. Se essa venda fizer parte de um grupo de
            PDVs sincronizados, a correção é enviada pro grupo também.
          </p>
          <label>
            Data e hora (horário de Brasília)
            <input type="datetime-local" value={novaDataHora} onChange={(e) => setNovaDataHora(e.target.value)} required />
          </label>
          <label style={{ marginTop: 12 }}>
            Valor total (R$)
            <input type="number" step="0.01" min="0" value={novoTotal} onChange={(e) => setNovoTotal(e.target.value)} required />
          </label>
          <label style={{ marginTop: 12 }}>
            Motivo (opcional)
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex: corrigindo horário registrado errado" />
          </label>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={onCancelar}>✖️ Cancelar</button>
            <button type="submit" className="btn-primary">💾 Salvar correção</button>
          </div>
        </form>
      </div>
    </div>
  );
}
