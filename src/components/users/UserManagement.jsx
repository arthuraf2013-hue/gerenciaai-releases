import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useProfile } from '../../context/ProfileContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import { usePromptModal } from '../../hooks/usePromptModal';
import { PromptModal } from '../common/PromptModal';
import Icon from '../common/Icon';

const ROTULO_PAPEL = { operador: 'Operador de caixa', gerente: 'Gerente', admin: 'Administrador', garcom: 'Garçom', suporte: 'Suporte' };

export function UserManagement() {
  const { currentUser } = useSession();
  const { profile } = useProfile();
  const { promptState, promptAsync, confirmarPrompt, cancelarPrompt } = usePromptModal();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  useEscToClose(() => setShowNew(false), showNew);
  const [novoNome, setNovoNome] = useState('');
  const [novoRole, setNovoRole] = useState('operador');
  const [novoPin, setNovoPin] = useState('');
  const [permissoesDe, setPermissoesDe] = useState(null);
  const podeMudarPermissao = ['admin', 'suporte'].includes(currentUser.role);

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

  if (!['gerente', 'admin', 'suporte'].includes(currentUser.role)) {
    return <div className="screen"><p className="modal-warning">Somente gerentes e administradores acessam esta tela.</p></div>;
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1><Icon name="users" size={22} /> Usuários</h1>
        <button className="btn-primary" onClick={() => setShowNew(true)}><Icon name="add" size={15} /> Novo usuário</button>
      </div>

      {error && <p className="modal-error">{error}</p>}

      {users.length === 0 ? (
        <p className="empty-state">Carregando...</p>
      ) : (
      <table className="data-table">
        <thead><tr><th>Nome</th><th>Papel</th><th>Status</th><th></th><th></th><th></th></tr></thead>
        <tbody>
          {users.map((u) => {
            const bloqueadoPraGerente = currentUser.role === 'gerente' && ['admin', 'suporte'].includes(u.role);
            return (
              <tr key={u.id}>
                <td>{u.nome}</td>
                <td>{ROTULO_PAPEL[u.role] || u.role}</td>
                <td>{u.ativo ? 'Ativo' : 'Inativo'}</td>
                <td>
                  {!bloqueadoPraGerente && <button className="btn-link" onClick={() => resetPin(u)}><Icon name="key" size={14} /> Resetar PIN</button>}
                </td>
                <td>
                  {podeMudarPermissao && u.role === 'gerente' && (
                    <button className="btn-link" onClick={() => setPermissoesDe(u)}><Icon name="lock" size={14} /> Permissões do ERP</button>
                  )}
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
            <h2><Icon name="add" size={18} /> Novo usuário</h2>
            <label>Nome
              <input value={novoNome} onChange={(e) => setNovoNome(e.target.value)} required autoFocus />
            </label>
            <label>Papel
              <select value={novoRole} onChange={(e) => setNovoRole(e.target.value)}>
                <option value="operador">Operador de caixa</option>
                {profile?.id === 'restaurante' && <option value="garcom">Garçom</option>}
                <option value="gerente">Gerente</option>
                {['admin', 'suporte'].includes(currentUser.role) && <option value="admin">Administrador</option>}
                {['admin', 'suporte'].includes(currentUser.role) && <option value="suporte">Suporte</option>}
              </select>
            </label>
            <label>PIN inicial
              <input type="password" inputMode="numeric" value={novoPin} onChange={(e) => setNovoPin(e.target.value)} required />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowNew(false)}><Icon name="close" size={15} /> Cancelar</button>
              <button type="submit" className="btn-primary"><Icon name="add" size={15} /> Criar</button>
            </div>
          </form>
        </div>
      )}
      {permissoesDe && <PermissoesErpModal usuario={permissoesDe} onClose={() => setPermissoesDe(null)} />}
      {promptState && (
        <PromptModal {...promptState} onConfirmar={confirmarPrompt} onCancelar={cancelarPrompt} />
      )}
    </div>
  );
}

/** Admin/suporte retira (ou devolve) áreas do ERP de um gerente. */
function PermissoesErpModal({ usuario, onClose }) {
  useEscToClose(onClose, true);
  const [catalogo, setCatalogo] = useState([]);
  const [valores, setValores] = useState(null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    Promise.all([window.pdv.permissoes.catalogo(), window.pdv.permissoes.doUsuario({ usuarioId: usuario.id })]).then(([cat, atual]) => {
      if (!Array.isArray(cat)) return setErro(cat?.error || 'Não foi possível carregar.');
      if (!atual?.ok) return setErro(atual?.error || 'Não foi possível carregar.');
      setCatalogo(cat);
      setValores(atual.permissoes);
    });
  }, [usuario.id]);
  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    const r = await window.pdv.permissoes.salvar({ usuarioId: usuario.id, permissoes: valores });
    setSalvando(false);
    if (!r?.ok) return setErro(r?.error || 'Não foi possível salvar.');
    onClose();
  }
  return (
    <div className="modal-overlay">
      <form className="modal-card" onSubmit={salvar}>
        <h2><Icon name="lock" size={18} /> Permissões do ERP — {usuario.nome}</h2>
        <p className="screen-hint">Desmarque o que este gerente não deve abrir. O resto do sistema continua igual. Fica registrado na Auditoria.</p>
        {erro && <p className="modal-error">{erro}</p>}
        {!valores ? <p className="empty-state">{erro ? '' : 'Carregando...'}</p> : catalogo.map((p) => (
          <label key={p.chave} className="nfe-opcao">
            <input type="checkbox" checked={!!valores[p.chave]} onChange={(e) => setValores({ ...valores, [p.chave]: e.target.checked })} />
            {p.rotulo}
          </label>
        ))}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={15} /> Cancelar</button>
          <button type="submit" className="btn-primary" disabled={!valores || salvando}><Icon name="save" size={15} /> {salvando ? 'Salvando...' : 'Salvar'}</button>
        </div>
      </form>
    </div>
  );
}
