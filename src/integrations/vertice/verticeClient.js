import { VERTICE_FIREBASE_CONFIG, verticeConfigurado } from './verticeConfig';

// Instância única do módulo do Vértice, carregada só quando o projeto do
// Vértice está configurado (o SDK de Auth do Firebase só entra aqui).
// O nome do caixa vai para o Vértice (aparece em Empresa › Integrações).

let instancia = null;
let carregando = null;
let pararPonte = null;

export function verticeDisponivel() {
  return verticeConfigurado(VERTICE_FIREBASE_CONFIG);
}

export async function obterVertice() {
  if (!verticeDisponivel()) return null;
  if (instancia) return instancia;
  if (!carregando) {
    carregando = (async () => {
      const [{ createVerticeSync }, { iniciarPonteSenhas }] = await Promise.all([import('./verticeSync'), import('./ponteSenhas')]);
      let terminal = 'Caixa';
      try {
        const s = await window.pdv.settings.get();
        terminal = String(s?.location?.nome || 'Caixa').slice(0, 40);
      } catch { /* nome padrão */ }
      const vx = createVerticeSync({ firebaseConfig: VERTICE_FIREBASE_CONFIG, terminal, appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '' });
      vx.start();
      pararPonte = iniciarPonteSenhas(vx);
      instancia = vx;
      return vx;
    })().catch((err) => {
      console.warn('[vertice] não iniciou', err?.message || err);
      carregando = null;
      return null;
    });
  }
  return carregando;
}

/** Ao abrir o app: só liga se este caixa já foi conectado antes (não cria conta à toa). */
export function iniciarVerticeSePareado() {
  try {
    if (verticeDisponivel() && localStorage.getItem('vertice:device')) obterVertice();
  } catch { /* sem armazenamento */ }
}

export function _pararParaTeste() { pararPonte?.(); }
