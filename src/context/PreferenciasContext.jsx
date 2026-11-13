import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from './SessionContext';
import { useToque } from './ToqueContext';
import { mesclarPreferencias, PREFERENCIAS_PADRAO, densidadeEfetiva, ZOOM_OPCOES } from '../utils/preferencias';

// Preferências de tela de quem está logado (menu, PDV, letra, densidade, tema).
// Gravadas por usuário no banco (prefs:get / prefs:set -- preferenciasService),
// então o caixa da manhã e o da noite podem ter o mesmo computador do jeito
// de cada um. Sai do login: tudo volta ao padrão (tela de login sem zoom).

const PreferenciasContext = createContext(null);

export function PreferenciasProvider({ children }) {
  const { currentUser } = useSession();
  const { ativo: toque } = useToque();
  const [prefs, setPrefs] = useState(PREFERENCIAS_PADRAO);
  const [carregado, setCarregado] = useState(false);
  const [larguraJanela, setLarguraJanela] = useState(() => window.innerWidth);

  useEffect(() => {
    let ignorar = false;
    setCarregado(false);
    if (!currentUser?.id) { setPrefs(PREFERENCIAS_PADRAO); return undefined; }
    window.pdv.prefs.get().then((salvo) => {
      if (ignorar) return;
      setPrefs(mesclarPreferencias(salvo));
      setCarregado(true);
    }).catch(() => { if (!ignorar) { setPrefs(PREFERENCIAS_PADRAO); setCarregado(true); } });
    return () => { ignorar = true; };
  }, [currentUser?.id]);

  useEffect(() => {
    const aoRedimensionar = () => setLarguraJanela(window.innerWidth);
    window.addEventListener('resize', aoRedimensionar);
    return () => window.removeEventListener('resize', aoRedimensionar);
  }, []);

  // Letra (tudo cresce junto, como o Ctrl+ do navegador) e densidade.
  const logado = !!currentUser?.id;
  const zoom = logado && ZOOM_OPCOES.includes(prefs.visual.zoom) ? prefs.visual.zoom : 1;
  // No app (Electron) o zoom é o da página: innerWidth já vem dividido.
  // Fora dele (prévia no navegador) cai no zoom por CSS.
  const zoomNativo = typeof window.pdv?.tela?.setZoom === 'function';
  // Tela de toque pede espaço para o dedo: o compacto não vale nela.
  const densidade = toque ? 'confortavel' : densidadeEfetiva(prefs.visual.densidade, zoomNativo ? larguraJanela : larguraJanela / zoom);
  useEffect(() => {
    const raiz = document.documentElement;
    if (zoomNativo) window.pdv.tela.setZoom(zoom);
    else raiz.style.zoom = zoom === 1 ? '' : String(zoom);
    raiz.classList.toggle('densidade-compacta', logado && densidade === 'compacta');
  }, [zoom, densidade, logado, zoomNativo]);

  // Tema por usuário: quem escolheu fica com o seu; quem nunca escolheu
  // segue o do computador (gerenciaai:tema, como sempre foi).
  useEffect(() => {
    if (!logado || !carregado || !prefs.visual.tema) return;
    document.documentElement.setAttribute('data-theme', prefs.visual.tema === 'escuro' ? 'dark' : 'light');
    try { localStorage.setItem('gerenciaai:tema', prefs.visual.tema); } catch { /* sem localStorage */ }
  }, [logado, carregado, prefs.visual.tema]);

  const atualizar = useCallback((grupo, mudancas) => {
    setPrefs((prev) => ({ ...prev, [grupo]: { ...prev[grupo], ...mudancas } }));
    window.pdv.prefs.set({ [grupo]: mudancas }).catch(() => { /* fica só nesta sessão */ });
  }, []);

  const restaurar = useCallback((grupo) => {
    setPrefs((prev) => ({ ...prev, [grupo]: PREFERENCIAS_PADRAO[grupo] }));
    window.pdv.prefs.set({ [grupo]: null }).catch(() => {});
  }, []);

  const valor = useMemo(() => ({ prefs, carregado, atualizar, restaurar, densidade, zoom }), [prefs, carregado, atualizar, restaurar, densidade, zoom]);
  return <PreferenciasContext.Provider value={valor}>{children}</PreferenciasContext.Provider>;
}

export function usePreferencias() {
  const ctx = useContext(PreferenciasContext);
  if (!ctx) throw new Error('usePreferencias precisa estar dentro de <PreferenciasProvider>');
  return ctx;
}
