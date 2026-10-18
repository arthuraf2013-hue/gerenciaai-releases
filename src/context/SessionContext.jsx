import { createContext, useContext, useState, useCallback } from 'react';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);

  const login = useCallback(async (userId, pin) => {
    const result = await window.pdv.auth.login({ userId, pin });
    if (result.ok) setCurrentUser(result.user);
    return result;
  }, []);

  // Encerra também a sessão do processo principal: sem isso, depois do
  // "Sair"/bloqueio por inatividade a janela continuava autorizada como o
  // usuário anterior até o próximo login.
  const logout = useCallback(() => {
    try { window.pdv.auth.logout().catch(() => {}); } catch { /* sem ponte (testes) */ }
    setCurrentUser(null);
  }, []);

  const clearPinTemporario = useCallback(() => {
    setCurrentUser((prev) => (prev ? { ...prev, pinTemporario: false } : prev));
  }, []);

  return (
    <SessionContext.Provider value={{ currentUser, login, logout, clearPinTemporario }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession precisa estar dentro de <SessionProvider>');
  return ctx;
}
