import { useEffect, useRef, useState } from 'react';
import { PreferenciasProvider } from './context/PreferenciasContext';
import { ToqueProvider } from './context/ToqueContext';
import { TecladoNumerico } from './components/common/TecladoNumerico';
import { SessionProvider, useSession } from './context/SessionContext';
import { ProfileProvider } from './context/ProfileContext';
import { AppShell } from './components/layout/AppShell';
import { ChangePinScreen } from './components/auth/ChangePinScreen';
import { FloatingTutor } from './components/layout/FloatingTutor';
import { LicenseGate } from './components/layout/LicenseGate';
import { UpdateGate } from './components/layout/UpdateGate';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
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
      if (list.length === 1) setUserId(list[0].id);
    });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!userId) { setError('Toque no seu nome para escolher o operador.'); return; }
    const result = await login(userId, pin);
    if (!result.ok) setError(result.error);
  }

  // Até 12 operadores: um cartão por pessoa (um toque, sem abrir lista).
  // Mais que isso, a lista de sempre.
  const emCartoes = users.length > 0 && users.length <= 12;
  const pinRef = useRef(null);
  function escolher(id) {
    setUserId(id);
    setError('');
    setPin('');
    pinRef.current?.focus();
  }

  return (
    <div className="login-screen">
      <form className={emCartoes ? 'modal-card login-card login-card-cartoes' : 'modal-card login-card'} onSubmit={handleSubmit}>
        <img src="/logo-mark.svg" alt="GerenciaAI" width="48" height="48" className="auth-logo" />
        <h1>Entrar no caixa</h1>
        {emCartoes ? (
          <div className="login-operadores" role="radiogroup" aria-label="Operador">
            {users.map((u) => (
              <button
                type="button" key={u.id} role="radio" aria-checked={userId === u.id}
                className={userId === u.id ? 'login-operador ativo' : 'login-operador'}
                onClick={() => escolher(u.id)}
              >
                <span className="login-operador-inicial" aria-hidden="true">{(u.nome || '?').trim().charAt(0).toUpperCase()}</span>
                <span className="login-operador-nome">{u.nome}</span>
              </button>
            ))}
          </div>
        ) : (
          <label>
            Operador
            <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
              <option value="">Selecione...</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
            </select>
          </label>
        )}
        <label>
          PIN
          <input
            ref={pinRef} type="password" inputMode="numeric" value={pin} data-teclado-enviar="Entrar"
            onChange={(e) => setPin(e.target.value)} required autoFocus={!emCartoes}
            placeholder={emCartoes && !userId ? 'Toque no seu nome acima' : undefined}
          />
        </label>
        {loadError && <p className="modal-error">{loadError}</p>}
        {error && <p className="modal-error">{error}</p>}
        <button className="btn-primary login-entrar" type="submit">Entrar</button>
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

  useEffect(() => {
    // Erros de código assíncrono/event handler — o Error Boundary do
    // React só pega erro de renderização, não esses.
    function onErro(event) {
      window.pdv?.error?.report({
        mensagem: event.error?.message || event.message, stack: event.error?.stack, contexto: 'renderer-window-error',
      });
    }
    function onPromiseRejeitada(event) {
      const err = event.reason;
      window.pdv?.error?.report({
        mensagem: err?.message || String(err), stack: err?.stack, contexto: 'renderer-promise-rejeitada',
      });
    }
    window.addEventListener('error', onErro);
    window.addEventListener('unhandledrejection', onPromiseRejeitada);
    return () => {
      window.removeEventListener('error', onErro);
      window.removeEventListener('unhandledrejection', onPromiseRejeitada);
    };
  }, []);

  return (
    <ErrorBoundary>
      <ToqueProvider>
      <UpdateGate>
        <LicenseGate>
          <SessionProvider>
            <ProfileProvider>
              <PreferenciasProvider>
                <Gate />
              </PreferenciasProvider>
            </ProfileProvider>
          </SessionProvider>
        </LicenseGate>
      </UpdateGate>
      <TecladoNumerico />
      </ToqueProvider>
    </ErrorBoundary>
  );
}
