import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';

/**
 * Usado para qualquer ação sensível (cancelar item, cancelar venda).
 * O próprio operador logado é excluído da lista de possíveis
 * autorizadores — a verificação real e definitiva acontece no
 * processo principal (authService), este componente só evita que o
 * operador perca tempo tentando se autorizar.
 *
 * @param {{ title: string, onConfirm: (candidateId: string, pin: string, motivo: string) => Promise<{ok:boolean,error?:string}>, onClose: () => void }} props
 */
export function ManagerAuthModal({ title, onConfirm, onClose }) {
  const { currentUser } = useSession();
  const [managers, setManagers] = useState([]);
  const [candidateId, setCandidateId] = useState('');
  const [pin, setPin] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    window.pdv.auth.listActiveUsers({ excludeUserId: currentUser?.id }).then((users) => {
      if (!Array.isArray(users)) {
        setLoadError(users?.error || 'Não foi possível carregar a lista de gerentes/admins.');
        return;
      }
      setManagers(users.filter((u) => u.role === 'gerente' || u.role === 'admin'));
    });
  }, [currentUser]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!candidateId) return setError('Selecione quem está autorizando.');
    if (!pin) return setError('Informe o PIN.');

    setLoading(true);
    const result = await onConfirm(candidateId, pin, motivo);
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      setPin('');
      return;
    }
    onClose();
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal-card" onSubmit={handleSubmit}>
        <h2>{title}</h2>
        <p className="modal-subtitle">
          Esta ação exige autorização de um gerente — diferente do operador do caixa atual.
        </p>

        {managers.length === 0 ? (
          <p className="modal-warning">Nenhum outro gerente/admin ativo disponível para autorizar.</p>
        ) : (
          <label>
            Autorizado por
            <select value={candidateId} onChange={(e) => setCandidateId(e.target.value)} required>
              <option value="">Selecione...</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.nome} ({m.role})</option>
              ))}
            </select>
          </label>
        )}

        <label>
          PIN do autorizador
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            required
          />
        </label>

        <label>
          Motivo (opcional)
          <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex: item errado, cliente desistiu..." />
        </label>

        {error && <p className="modal-error">{error}</p>}
        {loadError && <p className="modal-error">{loadError}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-danger" disabled={loading || managers.length === 0}>
            {loading ? 'Verificando...' : 'Confirmar autorização'}
          </button>
        </div>
      </form>
    </div>
  );
}
