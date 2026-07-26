let audioCtx = null;

/** Toca um beep curto de confirmação — só se a preferência estiver
 * ligada (padrão: ligado). Usa a Web Audio API pra sintetizar o som na
 * hora, sem precisar empacotar nenhum arquivo de áudio no app. */
export function playBeep() {
  if (localStorage.getItem('gerenciaai:somAoAdicionar') === 'desligado') return;

  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // Ambiente sem suporte a áudio (raro) — nunca deixa isso quebrar a venda.
  }
}

export function isBeepEnabled() {
  return localStorage.getItem('gerenciaai:somAoAdicionar') !== 'desligado';
}

export function setBeepEnabled(enabled) {
  localStorage.setItem('gerenciaai:somAoAdicionar', enabled ? 'ligado' : 'desligado');
}
