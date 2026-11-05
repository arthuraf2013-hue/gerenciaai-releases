import { createRoot } from 'react-dom/client';
import { db, firestoreFns as F } from '../../firebase-config.js';
import PainelMesas from './PainelMesas.jsx';

/**
 * Ponte entre as telas antigas (JS puro: garcom.js, pdv.js) e o painel de
 * mesas em React. Devolve a função de desmontar, no mesmo padrão das outras
 * telas do app.
 */
export function montarPainelMesas(container, { loja, modo, aoSemPainel }) {
  // Elemento próprio para o React: a tela antiga pode trocar o innerHTML do
  // container (troca de aba, volta para a tela antiga) sem quebrar nada.
  const host = document.createElement('div');
  host.className = 'pm-host';
  container.appendChild(host);
  const raiz = createRoot(host);
  raiz.render(<PainelMesas loja={loja} modo={modo} aoSemPainel={aoSemPainel} />);
  let desmontado = false;
  return () => {
    if (desmontado) return;
    desmontado = true;
    // Desmontar no meio de um render do React (troca de aba disparada por ele) dá aviso; adia um tique.
    setTimeout(() => { raiz.unmount(); host.remove(); }, 0);
  };
}

/**
 * O computador desta loja publica as mesas para o celular? (GerenciaAI do
 * computador atualizado, regras do Firestore publicadas, e a loja tem mesa
 * cadastrada.) `aoMudar(true|false)` -- só chama com resposta do servidor
 * (ou do cache, se já soube antes).
 */
export function observarPainelDisponivel(installId, aoMudar) {
  return F.onSnapshot(
    F.doc(db, 'installations', installId, 'mesas_ao_vivo', 'atual'),
    (snap) => {
      if (!snap.exists()) {
        if (!snap.metadata.fromCache) aoMudar(false);
        return;
      }
      const mesas = snap.data()?.mesas;
      aoMudar(Array.isArray(mesas) && mesas.length > 0);
    },
    () => aoMudar(false)
  );
}
