import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

const METODO_LABEL = {
  dinheiro: 'Dinheiro', cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito',
  pix: 'Pix', fiado: 'Fiado', outro: 'Outro',
};

/**
 * @param {{ sessionId: string, onClosed: () => void, onCancel: () => void }} props
 */
export function CloseCashModal({ sessionId, onClosed, onCancel }) {
  useEscToClose(onCancel);
  const { currentUser } = useSession();
  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [valorInformado, setValorInformado] = useState('');
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.pdv.cash.getSummary({ sessionId }).then((result) => {
      if (!result || !Array.isArray(result.porMetodo)) {
        setSummary(null);
        setLoadError(result?.error || 'Não foi possível carregar o resumo do caixa.');
        return;
      }
      setSummary(result);
    });
  }, [sessionId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const result = await window.pdv.cash.close({
        sessionId, operadorId: currentUser.id, valorInformado: Number(valorInformado) || 0,
      });
      if (!result.ok) {
        setError(result.error);
      } else {
        setResultado(result);
      }
    } catch (err) {
      setError(`Erro inesperado ao fechar o caixa: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  }

  if (resultado) {
    const diff = resultado.diferenca;
    return (
      <div className="modal-overlay">
        <div className="modal-card">
          <h2><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="money" size={18} /> Caixa fechado</span></h2>
          <p>Valor esperado: <strong>R$ {resultado.valorEsperado.toFixed(2)}</strong></p>
          <p className={diff === 0 ? 'io-message' : 'modal-error'}>
            {diff === 0 ? 'Sem diferença — caixa bateu certinho.' :
              diff > 0 ? `Sobrou R$ ${diff.toFixed(2)} em relação ao esperado.` :
                `Faltou R$ ${Math.abs(diff).toFixed(2)} em relação ao esperado.`}
          </p>
          <button className="btn-primary" onClick={onClosed}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> Concluir</span></button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay">
      <form className="modal-card" onSubmit={handleSubmit}>
        <h2><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="money" size={18} /> Fechar caixa</span></h2>
        {loadError && <p className="modal-error">{loadError}</p>}
        {summary && (
          <div className="cash-summary">
            <div><span>Abertura</span><strong>R$ {summary.valorAbertura.toFixed(2)}</strong></div>
            {summary.porMetodo.map((m) => (
              <div key={m.metodo}><span>{METODO_LABEL[m.metodo] || m.metodo}</span><strong>R$ {m.total.toFixed(2)}</strong></div>
            ))}
            {summary.totalDevolvidoEmDinheiro > 0 && (
              <div><span>Devoluções (em dinheiro)</span><strong>- R$ {summary.totalDevolvidoEmDinheiro.toFixed(2)}</strong></div>
            )}
            <div className="cash-summary-total"><span>Esperado em dinheiro</span><strong>R$ {summary.valorEsperado.toFixed(2)}</strong></div>
          </div>
        )}
        <label>
          Valor contado no caixa agora (R$)
          <input type="number" step="0.01" min="0" value={valorInformado} onChange={(e) => setValorInformado(e.target.value)} autoFocus required />
        </label>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span></button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Fechando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="money" size={15} /> Fechar caixa</span>}
          </button>
        </div>
      </form>
    </div>
  );
}
