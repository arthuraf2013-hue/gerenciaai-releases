// Utilitários compartilhados pelas telas do PDV móvel (pdv*.js).

const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function formatarMoeda(v) {
  return fmtMoeda.format(Number(v) || 0);
}

/** Quantidade como o operador lê: "2", "0,750" (fracionado em kg/l). */
function formatarQuantidade(q, unidade = 'un') {
  const n = Number(q) || 0;
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: unidadeFracionada(unidade) ? 3 : 0, maximumFractionDigits: 3 });
}

const UNIDADES_FRACIONADAS = ['kg', 'g', 'l', 'lt', 'ml', 'm', 'm2', 'm²', 'm3', 'cm'];
function unidadeFracionada(unidade) {
  return UNIDADES_FRACIONADAS.includes(String(unidade || '').toLowerCase());
}

function arred2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/** Aceita "12,50", "12.50", "1.234,56". */
function lerNumero(texto) {
  const s = String(texto ?? '').trim();
  if (!s) return NaN;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return Number(normal);
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const METODOS = {
  dinheiro: { rotulo: 'Dinheiro', icone: 'dinheiro' },
  cartao_credito: { rotulo: 'Crédito', icone: 'cartao' },
  cartao_debito: { rotulo: 'Débito', icone: 'cartao' },
  pix: { rotulo: 'Pix', icone: 'pix' },
  fiado: { rotulo: 'Fiado', icone: 'caderno' },
};

/** "YYYY-MM-DD HH:MM:SS" (UTC sem fuso, formato NOW_SYNCED do desktop) ou
 * Timestamp do Firestore -> Date. */
function paraData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (typeof valor === 'string') return new Date(valor.endsWith('Z') ? valor : `${valor.replace(' ', 'T')}Z`);
  return null;
}

function formatarDataHora(valor) {
  const d = paraData(valor);
  return d ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function mostrarToast(texto, tipo = 'info') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const toast = document.createElement('div');
  toast.className = `toast ${tipo === 'erro' ? 'toast-erro' : ''}`;
  toast.setAttribute('role', 'status');
  toast.textContent = texto;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), tipo === 'erro' ? 4000 : 2500);
}

/** Bottom sheet (mesmo visual dos modais do app do garçom). Devolve
 * { el, fechar }. Fecha tocando fora (se `fecharTocandoFora`) e chama
 * onFechar uma vez. Fechamento síncrono de propósito (sem mexer em
 * history): abrir outro sheet logo depois de fechar um nunca corre o
 * risco de um "voltar" atrasado fechar o novo. */
function abrirSheet(html, { onFechar, classe = '', fecharTocandoFora = true } = {}) {
  const fundo = document.createElement('div');
  fundo.className = 'modal-fundo';
  fundo.innerHTML = `<div class="modal-caixa ${classe}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(fundo);
  let fechado = false;
  const fechar = () => {
    if (fechado) return;
    fechado = true;
    fundo.remove();
    onFechar?.();
  };
  if (fecharTocandoFora) fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
  return { el: fundo.querySelector('.modal-caixa'), fechar };
}

// Bipe curto (WebAudio) -- leitura de código ok/erro.
let audioCtx = null;
function bipe(tipo = 'ok') {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const ganho = audioCtx.createGain();
    osc.frequency.value = tipo === 'ok' ? 1650 : 320;
    ganho.gain.value = 0.08;
    osc.connect(ganho).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (tipo === 'ok' ? 0.08 : 0.25));
  } catch { /* sem áudio, sem bipe */ }
}

function vibrar(ms = 15) {
  try { navigator.vibrate?.(ms); } catch { /* opcional */ }
}

// --- armazenamento local (por loja) ---

function lerJSON(chave, padrao) {
  try {
    const bruto = localStorage.getItem(chave);
    return bruto ? JSON.parse(bruto) : padrao;
  } catch {
    return padrao;
  }
}
function gravarJSON(chave, valor) {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* armazenamento cheio/bloqueado */ }
}

const PREFS_PADRAO = { telaInicial: 'vender', layout: 'grade', vibrar: true, bipe: true, mostrarEstoque: true };
function lerPrefs() {
  return { ...PREFS_PADRAO, ...lerJSON('gerenciaai_pdv_prefs', {}) };
}
function gravarPrefs(prefs) {
  gravarJSON('gerenciaai_pdv_prefs', prefs);
}

export {
  formatarMoeda, formatarQuantidade, unidadeFracionada, arred2, lerNumero, escapeHtml, normalizar, METODOS,
  paraData, formatarDataHora, mostrarToast, abrirSheet, bipe, vibrar, lerJSON, gravarJSON, lerPrefs, gravarPrefs,
};
