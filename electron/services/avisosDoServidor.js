// Avisos para as telas (pedido novo do QR/vitrine, chamar garçom, pedir a
// conta, celular que entrou na mesa). Nesta máquina vão direto para as
// janelas; os caixas apontados para o servidor (mesa compartilhada) recebem
// pela mesma espera de mudança das mesas (/v1/mesas/versao, com `avisosDesde`).
// Fica só em memória: aviso velho não interessa depois de reiniciar.

const MAX = 50;
const estado = { seq: 0, lista: [] };

function enviarAsJanelas(evento, dados) {
  try {
    const { BrowserWindow } = require('electron');
    for (const janela of BrowserWindow.getAllWindows?.() || []) {
      if (!janela.isDestroyed()) janela.webContents.send(evento, dados);
    }
  } catch { /* sem Electron (teste) */ }
}

/** Aviso novo: mostra aqui e guarda para os caixas buscarem. */
function registrar(evento, dados) {
  estado.seq += 1;
  estado.lista.push({ seq: estado.seq, evento, dados, em: Date.now() });
  if (estado.lista.length > MAX) estado.lista.splice(0, estado.lista.length - MAX);
  enviarAsJanelas(evento, dados);
  // A tela de mesas recarrega os indicadores dos quadrados.
  enviarAsJanelas('mesas:mudou', { origem: 'qr', tipo: evento });
  return estado.seq;
}

/** Avisos depois de `desde` (só os dos últimos 2 minutos). desde < 0: só o número atual. */
function desde(n) {
  const d = Number(n);
  if (!Number.isFinite(d) || d < 0) return { seq: estado.seq, avisos: [] };
  const limite = Date.now() - 2 * 60 * 1000;
  return { seq: estado.seq, avisos: estado.lista.filter((a) => a.seq > d && a.em >= limite).map(({ evento, dados }) => ({ evento, dados })) };
}

module.exports = { registrar, desde, enviarAsJanelas };
