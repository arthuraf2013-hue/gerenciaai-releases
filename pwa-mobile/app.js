import { auth, authFns } from './firebase-config.js';
import { getLojaAtiva, listarLojas, definirLojaAtiva, removerLoja } from './store.js';
import * as pairing from './pairing.js';
import * as garcom from './garcom.js';
import * as consulta from './consulta.js';

const root = document.getElementById('app');
let desmontarAtual = () => {};

function trocarTela(montador, ctx) {
  desmontarAtual();
  desmontarAtual = montador(root, ctx) || (() => {});
}

function abrirLojaAtiva() {
  const loja = getLojaAtiva();
  if (!loja) {
    trocarTela(pairing.mount, { onPareado: abrirLojaAtiva });
    return;
  }
  const modulo = loja.tipo === 'garcom' ? garcom : consulta;
  trocarTela(modulo.mount, {
    loja,
    lojas: listarLojas(),
    onTrocarLoja: (installId) => { definirLojaAtiva(installId); abrirLojaAtiva(); },
    onParearOutra: () => trocarTela(pairing.mount, { onPareado: abrirLojaAtiva }),
    onEsquecerLoja: () => { removerLoja(loja.installId); abrirLojaAtiva(); },
  });
}

function mostrarCarregando() {
  root.innerHTML = `<div class="tela-carregando"><div class="spinner"></div><p>Carregando...</p></div>`;
}

async function iniciar() {
  mostrarCarregando();

  // Garante que sempre exista uma sessão (anônima é suficiente pra ler
  // as regras do Firestore) antes de decidir qual tela mostrar --
  // sessão anônima do Firebase Auth persiste sozinha entre visitas
  // (browserLocalPersistence é o padrão na web), então só re-autentica
  // de fato na primeira visita deste navegador.
  authFns.onAuthStateChanged(auth, (user) => {
    if (!user) return; // aguarda o signInAnonymously abaixo terminar
    abrirLojaAtiva();
  }, (err) => {
    console.error('[app] falha na autenticação', err);
    root.innerHTML = `<div class="tela-erro-fatal"><p>Não foi possível conectar. Confira sua internet e recarregue a página.</p></div>`;
  });

  if (!auth.currentUser) {
    try {
      await authFns.signInAnonymously(auth);
    } catch (err) {
      console.error('[app] signInAnonymously falhou', err);
      // Se já tem loja salva localmente, ainda vale tentar mostrar a
      // tela mesmo sem confirmar auth (o Firestore vai recusar escrita,
      // mas os dados em cache/offline continuam visíveis).
      if (getLojaAtiva()) abrirLojaAtiva();
      else root.innerHTML = `<div class="tela-erro-fatal"><p>Sem internet pra parear pela primeira vez. Conecte e tente de novo.</p></div>`;
    }
  }
}

iniciar();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[app] service worker não registrou', err);
    });
  });
}
