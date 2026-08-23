import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

/** Troca de operador sem precisar fechar o app e voltar pra tela de
 * login — útil pra troca de turno no meio do dia (um operador passa o
 * caixa pro outro). Reaproveita o mesmo `login()` da tela de entrada:
 * ao confirmar, a sessão troca de usuário na hora — inclusive se o
 * novo operador tiver PIN temporário pendente, o app já pede a troca
 * de PIN automaticamente, do mesmo jeito que no login normal (é o
 * `Gate` do App.jsx que decide isso, olhando pro usuário atual).
 *
 * @param {{ onClose: () => void, onSwitched: () => void }} props
 */
export function SwitchUserModal({ onClose, onSwitched }) {
  useEscToClose(onClose);
  const { currentUser, login } = useSession();
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    window.pdv.auth.listActiveUsers({ excludeUserId: currentUser?.id }).then((list) => {
      if (!Array.isArray(list)) {
        setLoadError(list?.error || 'Não foi possível carregar a lista de operadores.');
        return;
      }
      setUsers(list);
    });
  }, [currentUser]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!userId) return setError('Selecione o operador.');
    if (!pin) return setError('Informe o PIN.');

    setLoading(true);
    const result = await login(userId, pin);
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      setPin('');
      return;
    }
    onSwitched?.();
    onClose();
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal-card" onSubmit={handleSubmit}>
        <h2><Icon name="user" size={18} /> Trocar de operador</h2>
        <p className="modal-subtitle">
          Encerra a sessão de {currentUser?.nome} neste caixa e entra com outro operador.
        </p>

        {users.length === 0 && !loadError ? (
          <p className="modal-subtitle">Nenhum outro operador ativo disponível.</p>
        ) : (
          <label>
            Operador
            <select value={userId} onChange={(e) => setUserId(e.target.value)} required autoFocus>
              <option value="">Selecione...</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
            </select>
          </label>
        )}

        <label>
          PIN
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </label>

        {error && <p className="modal-error">{error}</p>}
        {loadError && <p className="modal-error">{loadError}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={15} /> Cancelar</button>
          <button type="submit" className="btn-primary" disabled={loading || users.length === 0}>
            {loading ? 'Entrando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="refresh" size={15} /> Trocar</span>}
          </button>
        </div>
      </form>
    </div>
  );
}
