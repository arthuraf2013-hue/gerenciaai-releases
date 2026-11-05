import { auth, authFns } from './firebase-config.js';
import { getLojaAtiva, listarLojas, definirLojaAtiva, removerLoja } from './store.js';
import * as pairing from './pairing.js';
import * as garcom from './garcom.js';
import * as consulta from './consulta.js';
import * as pdv from './pdv.js';

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
  // 'pdv' = PDV móvel (vender + mesas + histórico, configurável pela loja);
  // 'garcom' = só lançar pedido; 'consulta' = só ver dados da loja.
  const modulo = loja.tipo === 'pdv' ? pdv : loja.tipo === 'garcom' ? garcom : consulta;
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
    // Código de erro na tela (não só no console) pelo mesmo motivo de
    // pairing.js -- reduz uma rodada inteira de "abre o F12 e me manda
    // o que aparece" pra só um print de celular.
    const detalhe = err?.code ? ` (código: ${err.code})` : '';
    root.innerHTML = `<div class="tela-erro-fatal"><p>Não foi possível conectar${detalhe}. Confira sua internet e recarregue a página.</p></div>`;
  });

  if (!auth.currentUser) {
    try {
      await authFns.signInAnonymously(auth);
    } catch (err) {
      console.error('[app] signInAnonymously falhou', err);
      // Se já tem loja salva localmente, ainda vale tentar mostrar a
      // tela mesmo sem confirmar auth (o Firestore vai recusar escrita,
      // mas os dados em cache/offline continuam visíveis).
      if (getLojaAtiva()) {
        abrirLojaAtiva();
      } else {
        const detalhe = err?.code ? ` (código: ${err.code})` : '';
        root.innerHTML = `<div class="tela-erro-fatal"><p>Sem internet pra parear pela primeira vez${detalhe}. Conecte e tente de novo.</p></div>`;
      }
    }
  }
}

iniciar();

// Service worker só no app publicado (npm run build) -- no `npm run dev`
// ele guardaria arquivos de desenvolvimento e atrapalharia.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(acompanharAtualizacao).catch((err) => {
      console.warn('[app] service worker não registrou', err);
    });
  });
}

/** Versão nova baixada fica esperando: o app avisa e só troca quando a
 * pessoa tocar em "Atualizar" (nunca no meio de um pedido ou venda). */
function acompanharAtualizacao(reg) {
  if (!reg) return;
  const avisar = () => { if (reg.waiting && navigator.serviceWorker.controller) mostrarAvisoDeAtualizacao(reg); };
  avisar();
  reg.addEventListener('updatefound', () => {
    const nova = reg.installing;
    if (!nova) return;
    nova.addEventListener('statechange', () => { if (nova.state === 'installed') avisar(); });
  });
  let recarregando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recarregando) return;
    recarregando = true;
    window.location.reload();
  });
  // Celular que fica o dia todo aberto: confere de hora em hora se saiu versão nova.
  setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
}

function mostrarAvisoDeAtualizacao(reg) {
  if (document.getElementById('aviso-atualizacao')) return;
  const aviso = document.createElement('div');
  aviso.id = 'aviso-atualizacao';
  aviso.className = 'aviso-atualizacao';
  aviso.setAttribute('role', 'status');
  aviso.innerHTML = `
    <span>Versão nova do app pronta.</span>
    <button type="button" class="btn-primario btn-pequeno" id="btn-atualizar-app">Atualizar</button>
    <button type="button" class="btn-icone" id="btn-depois-app" aria-label="Depois">✕</button>
  `;
  document.body.appendChild(aviso);
  aviso.querySelector('#btn-atualizar-app').addEventListener('click', () => {
    if (reg.waiting) reg.waiting.postMessage('atualizar');
    else window.location.reload();
  });
  aviso.querySelector('#btn-depois-app').addEventListener('click', () => aviso.remove());
}
