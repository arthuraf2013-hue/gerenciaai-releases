import { useEffect, useState } from 'react';
import { SessionProvider, useSession } from './context/SessionContext';
import { ProfileProvider } from './context/ProfileContext';
import { AppShell } from './components/layout/AppShell';
import { ChangePinScreen } from './components/auth/ChangePinScreen';
import { FloatingTutor } from './components/layout/FloatingTutor';
import { LicenseGate } from './components/layout/LicenseGate';
import { UpdateGate } from './components/layout/UpdateGate';
import './styles/theme.css';

function LoginScreen() {
  const { login } = useSession();
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    window.pdv.auth.listActiveUsers({}).then((list) => {
      if (!Array.isArray(list)) {
        setLoadError(list?.error || 'Não foi possível carregar a lista de operadores.');
        return;
      }
      setUsers(list);
    });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    const result = await login(userId, pin);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="login-screen">
      <form className="modal-card" onSubmit={handleSubmit}>
        <img src="/logo-mark.svg" alt="GerenciaAI" width="48" height="48" className="auth-logo" />
        <h1>Entrar no caixa</h1>
        <label>
          Operador
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">Selecione...</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
        <label>
          PIN
          <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} required autoFocus />
        </label>
        {loadError && <p className="modal-error">{loadError}</p>}
        {error && <p className="modal-error">{error}</p>}
        <button className="btn-primary" type="submit">Entrar</button>
      </form>
    </div>
  );
}

function Gate() {
  const { currentUser, clearPinTemporario } = useSession();
  if (!currentUser) return <LoginScreen />;
  if (currentUser.pinTemporario) return <ChangePinScreen onChanged={clearPinTemporario} />;
  return (
    <>
      <AppShell />
      <FloatingTutor />
    </>
  );
}

export default function App() {
  useEffect(() => {
    const tema = localStorage.getItem('gerenciaai:tema');
    if (tema === 'escuro') document.documentElement.setAttribute('data-theme', 'dark');
  }, []);

  return (
    <UpdateGate>
      <LicenseGate>
        <SessionProvider>
          <ProfileProvider>
            <Gate />
          </ProfileProvider>
        </SessionProvider>
      </LicenseGate>
    </UpdateGate>
  );
}
