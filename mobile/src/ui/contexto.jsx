import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ErroDeNegocio } from '../services/base.js';

const Ctx = createContext(null);
export const ProvedorApp = Ctx.Provider;
export function useApp() { return useContext(Ctx); }

/** Mensagens rápidas no topo. */
export function useToasts() {
  const [lista, setLista] = useState([]);
  const mostrar = useCallback((texto, tipo = 'info', ms = 3200) => {
    const id = Math.random().toString(36).slice(2);
    // Mensagem repetida substitui a anterior em vez de empilhar.
    setLista((l) => [...l.filter((t) => t.texto !== texto).slice(-1), { id, texto, tipo }]);
    setTimeout(() => setLista((l) => l.filter((t) => t.id !== id)), ms);
  }, []);
  return { lista, mostrar };
}

export function Toasts({ lista }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {lista.map((t) => <div key={t.id} className={`toast ${t.tipo}`}>{t.texto}</div>)}
    </div>
  );
}

/**
 * Roda uma ação mostrando o erro de regra de negócio na tela. Erro
 * inesperado vira mensagem genérica (e vai pro console) -- nunca some
 * em silêncio.
 */
export function useTentar() {
  const { toast } = useApp();
  return useCallback(async (fn, { sucesso } = {}) => {
    try {
      const r = await fn();
      if (sucesso) toast(sucesso, 'ok');
      return r;
    } catch (err) {
      if (err instanceof ErroDeNegocio) toast(err.message, 'erro', 4500);
      else {
        console.error(err);
        toast(`Algo deu errado: ${err?.message || err}`, 'erro', 6000);
      }
      return undefined;
    }
  }, [toast]);
}

/** Carrega dados assíncronos; `recarregar()` busca de novo. */
export function useCarregar(fn, deps = []) {
  const [estado, setEstado] = useState({ dados: null, carregando: true, erro: null });
  const vivo = useRef(true);
  const [versao, setVersao] = useState(0);
  useEffect(() => () => { vivo.current = false; }, []);
  useEffect(() => {
    let cancelado = false;
    setEstado((e) => ({ ...e, carregando: true }));
    Promise.resolve().then(fn).then(
      (dados) => { if (!cancelado && vivo.current) setEstado({ dados, carregando: false, erro: null }); },
      (erro) => { console.error(erro); if (!cancelado && vivo.current) setEstado({ dados: null, carregando: false, erro }); },
    );
    return () => { cancelado = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, versao]);
  return { ...estado, recarregar: () => setVersao((v) => v + 1) };
}

export function useDebounce(valor, ms = 200) {
  const [v, setV] = useState(valor);
  useEffect(() => { const t = setTimeout(() => setV(valor), ms); return () => clearTimeout(t); }, [valor, ms]);
  return v;
}

export function podeGerenciar(usuario) {
  return usuario?.papel === 'admin' || usuario?.papel === 'gerente';
}

/** Resumo do modo terminal (fila pro computador, erros, catálogo). null enquanto carrega. */
export function useResumoTerminal(servicos) {
  const [resumo, setResumo] = useState(null);
  useEffect(() => {
    if (!servicos?.terminal) return undefined;
    let vivo = true;
    const atualizar = () => servicos.terminal.resumo().then((r) => { if (vivo) setResumo(r); }).catch(() => {});
    atualizar();
    const tirarA = servicos.terminal.aoMudar(atualizar);
    const tirarB = servicos.licenca.aoMudar(atualizar);
    const t = setInterval(atualizar, 30000);
    return () => { vivo = false; tirarA(); tirarB(); clearInterval(t); };
  }, [servicos]);
  return resumo;
}
