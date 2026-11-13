// Lembra onde a janela do GerenciaAI estava (monitor, posição, tamanho,
// maximizada ou não, tela cheia) e reabre exatamente assim.
// Fica em %APPDATA%\GerenciaAI\janela.json (app.getPath('userData')).
//
// A escolha da posição é pura (sem Electron) para dar para testar:
// ver tests/janela.test.js. Mesma ideia do player do Vértice.
const fs = require('fs');

const PADRAO = { width: 1280, height: 800 };
const MENOR = { width: 1024, height: 700 }; // = minWidth/minHeight da janela (main.js)
// Quanto da janela precisa cair dentro de um monitor para valer a posição salva.
const VISIVEL_MIN = { width: 200, height: 120 };

const numero = (v) => typeof v === 'number' && Number.isFinite(v);

function estadoValido(e) {
  return !!e && numero(e.x) && numero(e.y) && numero(e.width) && numero(e.height)
    && e.width >= 200 && e.height >= 150;
}

function lerEstado(arquivo) {
  try {
    const e = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    return estadoValido(e) ? e : null;
  } catch {
    return null;
  }
}

function salvarEstado(arquivo, estado) {
  try {
    // Grava num temporário e troca: se a energia cair no meio, o arquivo antigo continua inteiro.
    const tmp = `${arquivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(estado));
    fs.renameSync(tmp, arquivo);
    return true;
  } catch (err) {
    console.error('[janela] não consegui salvar a posição da janela:', err.message);
    return false;
  }
}

function areaComum(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, w), height: Math.max(0, h) };
}

const mesmasMedidas = (a, b) => !!a && !!b
  && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Tamanho que cabe na área, centralizado nela. */
function centralizar(tamanho, area) {
  const width = Math.min(Math.max(tamanho.width, MENOR.width), area.width);
  const height = Math.min(Math.max(tamanho.height, MENOR.height), area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** O monitor salvo, se ele estiver ligado agora (pelo id, ou pelas mesmas medidas). */
function monitorSalvo(estado, monitores) {
  if (!estado) return null;
  return monitores.find((m) => estado.displayId !== undefined && m.id === estado.displayId)
    || monitores.find((m) => mesmasMedidas(m.bounds, estado.displayBounds))
    || null;
}

/**
 * Decide onde abrir a janela.
 * @param estado o que foi salvo da última vez (ou null)
 * @param monitores [{ id, bounds, workArea }] como o Electron informa agora
 * @param principal o monitor principal
 * @returns { x, y, width, height, maximized, fullscreen, displayId }
 */
function escolherPosicao(estado, monitores, principal) {
  if (!estadoValido(estado)) {
    // Primeira vez: o tamanho de sempre, centralizado no monitor principal.
    return { ...centralizar(PADRAO, principal.workArea), maximized: false, fullscreen: false, displayId: principal.id };
  }
  const modo = { maximized: !!estado.maximized, fullscreen: !!estado.fullscreen };

  // 1) A posição salva ainda aparece em algum monitor: abre exatamente lá.
  const onde = monitores.find((m) => {
    const comum = areaComum(estado, m.workArea);
    return comum.width >= VISIVEL_MIN.width && comum.height >= VISIVEL_MIN.height;
  });
  if (onde) {
    const width = Math.min(estado.width, onde.workArea.width);
    const height = Math.min(estado.height, onde.workArea.height);
    return { x: estado.x, y: estado.y, width, height, ...modo, displayId: onde.id };
  }

  // 2) O monitor mudou de lugar (resolução, ordem): procura o mesmo monitor
  //    pelo id ou pelas medidas. 3) Foi desligado/desconectado: o principal.
  const alvo = monitorSalvo(estado, monitores) || principal;
  return { ...centralizar(estado, alvo.workArea), ...modo, displayId: alvo.id };
}

/**
 * Liga a janela ao arquivo: salva sempre que ela muda (com folga de 0,8 s)
 * e ao fechar. Devolve salvarAgora() para quem encerra o app sem evento de
 * fechar (instalar atualização, app.exit).
 */
function lembrarJanela(win, screen, arquivo) {
  let timer = null;
  const salvarAgora = () => {
    clearTimeout(timer);
    // Minimizada não diz nada sobre onde abrir: fica o último estado bom.
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const monitor = screen.getDisplayMatching(win.getBounds());
    salvarEstado(arquivo, {
      // getNormalBounds: a posição "de janela" mesmo maximizada, para que
      // ao desmaximizar ela volte para onde estava.
      ...win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      displayId: monitor.id,
      displayBounds: monitor.bounds,
    });
  };
  const adiar = () => {
    clearTimeout(timer);
    timer = setTimeout(salvarAgora, 800);
  };
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, adiar);
  win.on('close', salvarAgora);
  win.on('session-end', salvarAgora); // Windows desligando
  return salvarAgora;
}

module.exports = { escolherPosicao, monitorSalvo, mesmasMedidas, centralizar, lerEstado, salvarEstado, lembrarJanela, PADRAO, MENOR };
