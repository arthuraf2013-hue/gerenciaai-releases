import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { gravarModoToque, lerModoToque, toqueAtivo } from '../utils/toque';

// Modo toque do computador (ver src/utils/toque.js). Fica por fora da
// sessão porque a tela de login também precisa dele.

const ToqueContext = createContext({ modo: 'auto', ativo: false, definirModo: () => {} });

const CONSULTA = '(pointer: coarse)';

export function ToqueProvider({ children }) {
  const [modo, setModo] = useState(() => lerModoToque());
  const [ponteiroGrosso, setPonteiroGrosso] = useState(() => !!window.matchMedia?.(CONSULTA).matches);

  useEffect(() => {
    const mql = window.matchMedia?.(CONSULTA);
    if (!mql) return undefined;
    const aoMudar = () => setPonteiroGrosso(mql.matches);
    mql.addEventListener?.('change', aoMudar);
    return () => mql.removeEventListener?.('change', aoMudar);
  }, []);

  const ativo = toqueAtivo(modo, ponteiroGrosso);
  useEffect(() => {
    document.documentElement.classList.toggle('modo-toque', ativo);
  }, [ativo]);

  const definirModo = useCallback((novo) => { gravarModoToque(novo); setModo(novo); }, []);

  const valor = useMemo(() => ({ modo, ativo, ponteiroGrosso, definirModo }), [modo, ativo, ponteiroGrosso, definirModo]);
  return <ToqueContext.Provider value={valor}>{children}</ToqueContext.Provider>;
}

export function useToque() {
  return useContext(ToqueContext);
}
