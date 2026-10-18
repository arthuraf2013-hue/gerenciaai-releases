// Preferência DESTA máquina: mostrar (ou não) a faixa "Quem leva X também
// costuma levar Y" no PDV. Fica em localStorage (igual ao tema), porque cada
// terminal pode preferir um jeito. Ligada por padrão.
import { useEffect, useState } from 'react';

const CHAVE = 'gerenciaai:sugestaoCombo';
const EVENTO = 'gerenciaai:sugestaoCombo-mudou';

export function sugestaoComboLigada() {
  try { return localStorage.getItem(CHAVE) !== 'desligada'; } catch { return true; }
}

export function definirSugestaoCombo(ligada) {
  try { localStorage.setItem(CHAVE, ligada ? 'ligada' : 'desligada'); } catch { /* sem storage: vale só até fechar a tela */ }
  window.dispatchEvent(new CustomEvent(EVENTO, { detail: !!ligada }));
}

// Hook: [ligada, definir]. Atualiza todas as telas abertas ao mudar.
export function useSugestaoCombo() {
  const [ligada, setLigada] = useState(sugestaoComboLigada);
  useEffect(() => {
    const aoMudar = (e) => setLigada(!!e.detail);
    window.addEventListener(EVENTO, aoMudar);
    return () => window.removeEventListener(EVENTO, aoMudar);
  }, []);
  return [ligada, definirSugestaoCombo];
}
