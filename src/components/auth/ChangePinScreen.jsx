import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';

/**
 * Bloqueia o acesso ao resto do app até o usuário trocar um PIN
 * temporário (o caso mais comum: PIN padrão "0000" do admin seedado
 * na primeira instalação). Sem isso, "0000" continuaria válido para
 * sempre — o ponto mais frágil de segurança do sistema.
 */
export function ChangePinScreen({ onChanged }) {
  const { currentUser } = useSession();
  const [pinAtual, setPinAtual] = useState('');
  const [novoPin, setNovoPin] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (novoPin !== confirmar) return setError('Os PINs não coincidem.');

    setSaving(true);
    const result = await window.pdv.auth.changeOwnPin({ userId: currentUser.id, pinAtual, novoPin });
    setSaving(false);
    if (!result.ok) return setError(result.error);
    onChanged();
  }

  return (
    <div className="login-screen">
      <form className="modal-card" onSubmit={handleSubmit}>
        <img src="/logo-mark.svg" alt="GerenciaAI" width="48" height="48" className="auth-logo" />
        <h1><Icon name="key" size={22} /> Troque seu PIN</h1>
        <p className="modal-subtitle">
          Este usuário ainda está com o PIN padrão. Defina um novo PIN antes de continuar.
        </p>
        <label>PIN atual
          <input type="password" inputMode="numeric" value={pinAtual} onChange={(e) => setPinAtual(e.target.value)} required autoFocus />
        </label>
        <label>Novo PIN (mín. 4 dígitos)
          <input type="password" inputMode="numeric" value={novoPin} onChange={(e) => setNovoPin(e.target.value)} required />
        </label>
        <label>Confirme o novo PIN
          <input type="password" inputMode="numeric" value={confirmar} onChange={(e) => setConfirmar(e.target.value)} required />
        </label>
        {error && <p className="modal-error">{error}</p>}
        <button className="btn-primary" type="submit" disabled={saving}>
          {saving ? 'Salvando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="key" size={15} /> Trocar PIN e continuar</span>}
        </button>
      </form>
    </div>
  );
}
