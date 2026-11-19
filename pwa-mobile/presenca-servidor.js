import { auth, db, firestoreFns as F } from './firebase-config.js';

/**
 * "O computador da loja está no ar?" pela presença no Realtime Database
 * (lado de lá: electron/services/presencaService.js). O Firebase marca
 * `on: false` sozinho quando o computador cai, então o computador não
 * precisa mais gravar um sinal de vida no Firestore a cada 25-30 s (era o
 * que mais gastava a cota). Leitura simples (REST), sem conexão aberta: não
 * conta no limite de conexões do plano grátis.
 *
 * Depois da primeira resposta "no ar", avisa o computador (dispositivos/{uid}
 * .recursos.presenca) que este celular já olha a presença -- enquanto algum
 * celular não avisar, o computador mantém o sinal de vida antigo.
 */

const RTDB_URL = 'https://gerenciaai-licencas-default-rtdb.firebaseio.com';
const INTERVALO_MS = 20 * 1000;
const VALIDADE_MS = 60 * 1000;
const declarados = new Set();

export function presencaValida(p, agoraMs = Date.now()) {
  return !!p && p.on === true && agoraMs - p.lidoEmMs < VALIDADE_MS;
}

function declarar(installId) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const chave = `${installId}/${uid}`;
  if (declarados.has(chave)) return;
  declarados.add(chave);
  F.setDoc(F.doc(db, 'installations', installId, 'dispositivos', uid), { recursos: { presenca: 1 } }, { merge: true })
    .catch(() => declarados.delete(chave));
}

/** Lê a presença a cada 20 s (e ao voltar para o app). `aoMudar({ on, lidoEmMs })`. */
export function observarPresenca(installId, aoMudar) {
  let ativo = true;
  let relogio = null;
  let lendo = false;
  async function ler() {
    if (!ativo || lendo) return;
    lendo = true;
    try {
      const controle = new AbortController();
      const t = setTimeout(() => controle.abort(), 8000);
      const r = await fetch(`${RTDB_URL}/presenca/${encodeURIComponent(installId)}.json`, { signal: controle.signal, cache: 'no-store' })
        .finally(() => clearTimeout(t));
      if (r.ok && ativo) {
        const d = await r.json();
        const p = { on: d?.on === true, lidoEmMs: Date.now() };
        aoMudar(p);
        if (p.on) declarar(installId);
      }
    } catch { /* sem internet ou banco ainda não criado: vale o sinal antigo */ }
    lendo = false;
    if (ativo) { clearTimeout(relogio); relogio = setTimeout(ler, INTERVALO_MS); }
  }
  const aoVoltar = () => { if (document.visibilityState === 'visible') ler(); };
  document.addEventListener('visibilitychange', aoVoltar);
  ler();
  return () => { ativo = false; clearTimeout(relogio); document.removeEventListener('visibilitychange', aoVoltar); };
}
