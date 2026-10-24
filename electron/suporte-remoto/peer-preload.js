const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload da janela OCULTA de WebRTC do suporte remoto (lado do cliente).
 * Expõe só a ponte de sinalização e do canal de dados pro processo
 * principal -- nada do IPC normal do app (`window.pdv`). Toda decisão
 * sensível (conferir código, rodar shell, ler/gravar arquivo) acontece no
 * processo principal; esta janela só cuida do transporte WebRTC.
 */
contextBridge.exposeInMainWorld('suportePeer', {
  // main -> janela
  aoIniciar: (cb) => ipcRenderer.on('iniciar', (_e, d) => cb(d)),
  aoSinalRemoto: (cb) => ipcRenderer.on('sinal-remoto', (_e, d) => cb(d)),
  aoEnviarCanal: (cb) => ipcRenderer.on('enviar-canal', (_e, d) => cb(d)),
  // janela -> main
  enviarSinal: (d) => ipcRenderer.send('suporteRemotoPeer:sinal', d),
  mensagemDoCanal: (m) => ipcRenderer.send('suporteRemotoPeer:mensagem', m),
  evento: (d) => ipcRenderer.send('suporteRemotoPeer:evento', d),
});
