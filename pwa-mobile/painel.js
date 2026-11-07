import { tokenValido, lerPainel, fraseDaChamada } from './painel-util.js';

/**
 * Painel de senhas para TV / digital signage (Vértice): painel.html?p=<token>.
 * Só LÊ paineis_chamada/{token}, publicado pelo computador da loja
 * (electron/services/chamadaService.js) quando algo muda. O token de 32
 * caracteres é o acesso -- "Gerar novo link" no computador invalida o antigo.
 *
 * Senha chamada (ou "chamar de novo"): aparece grande por alguns segundos,
 * toca o aviso e fala o número (se ligado no modelo). Navegador de TV
 * costuma bloquear som até alguém tocar na tela: o painel mostra
 * "Toque para ativar o som" uma vez.
 *
 * Tudo que vem do Firestore passa por lerPainel (tipos conferidos) e
 * escapeHtml antes de ir para o HTML.
 */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};

const raiz = document.getElementById('painel');
const DURACAO_DESTAQUE_MS = 9000;

function escapeHtml(t) {
  const div = document.createElement('div');
  div.textContent = t ?? '';
  return div.innerHTML;
}

function aviso(titulo, texto) {
  raiz.innerHTML = `<div class="painel-aviso"><h1>${escapeHtml(titulo)}</h1><p>${escapeHtml(texto)}</p></div>`;
}

let somLiberado = false;
let audioCtx = null;
function liberarSom() {
  somLiberado = true;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { /* sem áudio */ }
  document.getElementById('ativar-som')?.remove();
}

function tocarAviso() {
  if (!audioCtx) return;
  const nota = (freq, inicio) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    const t = audioCtx.currentTime + inicio;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.65);
  };
  nota(784, 0); nota(1047, 0.35);
}

function falar(frase) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(frase);
    u.lang = 'pt-BR';
    u.rate = 0.95;
    const voz = window.speechSynthesis.getVoices().find((v) => /pt[-_]BR/i.test(v.lang));
    if (voz) u.voice = voz;
    window.speechSynthesis.speak(u);
  } catch { /* sem voz */ }
}

function relogio() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

let ultimoSeq = null;
let destaqueAte = 0;
let timerDestaque = null;
let dados = null;

function desenhar() {
  if (!dados) return;
  if (!dados.ativo) { aviso('Painel desligado', 'Ligue o painel de senhas no computador da loja (Configurações → Senhas).'); return; }
  const m = dados.modelo;
  const st = document.documentElement.style;
  st.setProperty('--fundo', m.corFundo);
  st.setProperty('--texto', m.corTexto);
  st.setProperty('--destaque', m.corDestaque);
  st.setProperty('--preparando', m.corPreparando);
  const cartao = (s, i) => `<div class="pronto ${i === 0 ? 'primeiro' : ''}"><b>${Number(s.n)}</b>${s.nome ? `<span>${escapeHtml(s.nome)}</span>` : ''}</div>`;
  const chip = (s) => `<span class="chip">${Number(s.n)}${s.nome ? `<small>${escapeHtml(s.nome)}</small>` : ''}</span>`;
  const destaque = dados.ultimaChamada && Date.now() < destaqueAte ? dados.ultimaChamada : null;
  raiz.className = `painel ${m.layout === 'so_prontos' ? 'so-prontos' : ''}`;
  raiz.innerHTML = `
    <header class="topo"><span class="loja">${escapeHtml(m.titulo || dados.nomeLoja)}</span><span class="hora" id="hora">${relogio()}</span></header>
    <main class="corpo">
      ${m.layout === 'so_prontos' ? '' : `<section class="col-preparo"><h2>${escapeHtml(m.tituloPreparando)}</h2>
        <div class="chips">${dados.preparando.length ? dados.preparando.map(chip).join('') : '<p class="vazio">Nenhum pedido em preparo.</p>'}</div></section>`}
      <section class="col-prontos"><h2>${escapeHtml(m.tituloProntos)}</h2>
        <div class="prontos">${dados.prontos.length ? dados.prontos.map(cartao).join('') : '<p class="vazio">Nenhuma senha chamada agora.</p>'}</div></section>
    </main>
    ${m.mensagem ? `<footer class="rodape">${escapeHtml(m.mensagem)}</footer>` : ''}
    ${destaque ? `<div class="destaque" role="alert"><div class="caixa">
      <div class="rotulo">${escapeHtml(m.tituloChamada)}</div>
      <div class="numero">${Number(destaque.n)}</div>
      ${destaque.nome ? `<div class="nome">${escapeHtml(destaque.nome)}</div>` : ''}
      <div class="instrucao">${escapeHtml(m.mensagemChamada)}</div></div></div>` : ''}
    ${!somLiberado && (m.som || m.falarSenha) ? '<button id="ativar-som" class="ativar-som">Toque para ativar o som</button>' : ''}`;
  document.getElementById('ativar-som')?.addEventListener('click', () => { liberarSom(); desenhar(); });
}

function aoMudar(novo) {
  dados = novo;
  const u = novo?.ultimaChamada;
  if (u && ultimoSeq !== null && u.seq !== ultimoSeq) {
    destaqueAte = Date.now() + DURACAO_DESTAQUE_MS;
    clearTimeout(timerDestaque);
    timerDestaque = setTimeout(desenhar, DURACAO_DESTAQUE_MS + 50);
    if (somLiberado && novo.modelo.som) tocarAviso();
    if (somLiberado && novo.modelo.falarSenha) setTimeout(() => falar(fraseDaChamada(u)), novo.modelo.som ? 900 : 0);
  }
  ultimoSeq = u ? u.seq : (ultimoSeq ?? '');
  desenhar();
}

(async () => {
  const token = new URLSearchParams(location.search).get('p') || '';
  if (!tokenValido(token)) { aviso('Link do painel inválido', 'Copie o link de novo em Configurações → Senhas, no computador da loja.'); return; }
  document.addEventListener('click', liberarSom, { once: true });
  setInterval(() => { const h = document.getElementById('hora'); if (h) h.textContent = relogio(); }, 15000);
  try {
    const { initializeApp } = await import('firebase/app');
    const F = await import('firebase/firestore');
    const app = initializeApp(FIREBASE_CONFIG, 'painel');
    const db = F.getFirestore(app);
    F.onSnapshot(F.doc(db, 'paineis_chamada', token), (snap) => {
      if (!snap.exists()) { aviso('Painel ainda sem dados', 'Ligue o painel em Configurações → Senhas no computador da loja. Esta tela atualiza sozinha.'); return; }
      aoMudar(lerPainel(snap.data()));
    }, () => aviso('Sem conexão com a loja', 'Confira a internet desta tela. O painel volta sozinho.'));
  } catch (err) {
    console.error('[painel]', err);
    aviso('Não foi possível abrir o painel', 'Confira a internet desta tela.');
  }
})();
