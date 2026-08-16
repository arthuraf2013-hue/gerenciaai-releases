import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import { usePromptModal } from '../../hooks/usePromptModal';
import { PromptModal } from '../common/PromptModal';

export function UserManagement() {
  const { currentUser } = useSession();
  const { promptState, promptAsync, confirmarPrompt, cancelarPrompt } = usePromptModal();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  useEscToClose(() => setShowNew(false), showNew);
  const [novoNome, setNovoNome] = useState('');
  const [novoRole, setNovoRole] = useState('operador');
  const [novoPin, setNovoPin] = useState('');

  async function reload() {
    const result = await window.pdv.users.listAll({ requestingUserId: currentUser.id });
    if (!result.ok) return setError(result.error);
    setUsers(result.users);
  }

  useEffect(() => { reload(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    const result = await window.pdv.users.create({
      requestingUserId: currentUser.id, nome: novoNome, role: novoRole, pin: novoPin,
    });
    if (!result.ok) return setError(result.error);
    setShowNew(false);
    setNovoNome(''); setNovoPin(''); setNovoRole('operador');
    reload();
  }

  async function toggleActive(user) {
    const result = await window.pdv.users.setActive({
      requestingUserId: currentUser.id, userId: user.id, ativo: user.ativo ? false : true,
    });
    if (!result.ok) return setError(result.error);
    reload();
  }

  async function resetPin(user) {
    const novo = await promptAsync(`Novo PIN para ${user.nome} (mín. 4 dígitos):`);
    if (!novo) return;
    const result = await window.pdv.users.resetPin({ requestingUserId: currentUser.id, userId: user.id, novoPin: novo });
    if (!result.ok) setError(result.error);
  }

  if (!['gerente', 'admin'].includes(currentUser.role)) {
    return <div className="screen"><p className="modal-warning">Somente gerentes e administradores acessam esta tela.</p></div>;
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>👥 Usuários</h1>
        <button className="btn-primary" onClick={() => setShowNew(true)}>➕ Novo usuário</button>
      </div>

      {error && <p className="modal-error">{error}</p>}

      {users.length === 0 ? (
        <p className="empty-state">Carregando...</p>
      ) : (
      <table className="data-table">
        <thead><tr><th>Nome</th><th>Papel</th><th>Status</th><th></th><th></th></tr></thead>
        <tbody>
          {users.map((u) => {
            const bloqueadoPraGerente = currentUser.role === 'gerente' && u.role === 'admin';
            return (
              <tr key={u.id}>
                <td>{u.nome}</td>
                <td>{u.role}</td>
                <td>{u.ativo ? 'Ativo' : 'Inativo'}</td>
                <td>
                  {!bloqueadoPraGerente && <button className="btn-link" onClick={() => resetPin(u)}>🔑 Resetar PIN</button>}
                </td>
                <td>
                  {!bloqueadoPraGerente && (
                    <button className="btn-link-danger" onClick={() => toggleActive(u)}>
                      {u.ativo ? 'Desativar' : 'Reativar'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}

      {showNew && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={handleCreate}>
            <h2>➕ Novo usuário</h2>
            <label>Nome
              <input value={novoNome} onChange={(e) => setNovoNome(e.target.value)} required autoFocus />
            </label>
            <label>Papel
              <select value={novoRole} onChange={(e) => setNovoRole(e.target.value)}>
                <option value="operador">Operador de caixa</option>
                <option value="gerente">Gerente</option>
                {currentUser.role === 'admin' && <option value="admin">Administrador</option>}
              </select>
            </label>
            <label>PIN inicial
              <input type="password" inputMode="numeric" value={novoPin} onChange={(e) => setNovoPin(e.target.value)} required />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowNew(false)}>✖️ Cancelar</button>
              <button type="submit" className="btn-primary">➕ Criar</button>
            </div>
          </form>
        </div>
      )}
      {promptState && (
        <PromptModal {...promptState} onConfirmar={confirmarPrompt} onCancelar={cancelarPrompt} />
      )}
    </div>
  );
}
