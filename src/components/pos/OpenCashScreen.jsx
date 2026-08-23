import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';

/**
 * @param {{ locationId: string, onOpened: () => void }} props
 */
export function OpenCashScreen({ locationId, onOpened }) {
  const { currentUser } = useSession();
  const [valorAbertura, setValorAbertura] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const result = await window.pdv.cash.open({
        locationId,
        operadorId: currentUser.id,
        valorAbertura: Number(valorAbertura) || 0,
      });
      if (!result.ok) {
        setError(result.error);
      } else {
        onOpened();
      }
    } catch (err) {
      setError(`Erro inesperado ao abrir o caixa: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="modal-card" onSubmit={handleSubmit}>
        <h1><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="money" size={20} /> Abrir caixa</span></h1>
        <p className="modal-subtitle">
          Informe quanto em dinheiro está no caixa agora, antes da primeira venda do turno.
        </p>
        <label>
          Valor de abertura (R$)
          <input
            type="number" step="0.01" min="0"
            value={valorAbertura}
            onChange={(e) => setValorAbertura(e.target.value)}
            autoFocus required
          />
        </label>
        {error && <p className="modal-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={saving}>
          {saving ? 'Abrindo...' : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="money" size={15} /> Abrir caixa e começar a vender</span>
          )}
        </button>
      </form>
    </div>
  );
}
