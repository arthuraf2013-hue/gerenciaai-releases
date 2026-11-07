/**
 * alert() / confirm() da interface, com o diálogo do Electron.
 *
 * O alert/confirm do próprio Chromium no Windows deixa os campos de texto
 * sem aceitar digitação depois de fechar (bug do Electron: issues 20400 e
 * 41603). A loja via "as linhas de texto travadas" depois de confirmar um
 * cancelamento, e só voltava reiniciando (ou trocando de janela).
 * src/main.jsx troca window.alert e window.confirm por esta chamada
 * síncrona -- mesmo comportamento: a tela espera a resposta -- e depois do
 * diálogo o foco volta para a página.
 */

function opcoesDoDialogo(payload) {
  const tipo = payload && payload.tipo === 'confirm' ? 'confirm' : 'alert';
  const mensagem = String(payload && payload.mensagem != null ? payload.mensagem : '').slice(0, 4000);
  return tipo === 'confirm'
    ? { tipo, opcoes: { type: 'question', buttons: ['OK', 'Cancelar'], defaultId: 0, cancelId: 1, noLink: true, title: 'GerenciaAI', message: mensagem } }
    : { tipo, opcoes: { type: 'info', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true, title: 'GerenciaAI', message: mensagem } };
}

/** `deps` só para teste (ipcMain, dialog e BrowserWindow falsos). */
function registrarDialogosNativos(deps = require('electron')) {
  const { ipcMain, dialog, BrowserWindow } = deps;
  ipcMain.on('dialogo:nativo', (event, payload) => {
    const { tipo, opcoes } = opcoesDoDialogo(payload);
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      const botao = win ? dialog.showMessageBoxSync(win, opcoes) : dialog.showMessageBoxSync(opcoes);
      event.returnValue = tipo === 'confirm' ? botao === 0 : true;
    } catch (err) {
      console.error('[dialogo] falhou:', err && err.message);
      event.returnValue = tipo !== 'confirm'; // na dúvida, confirm = "Cancelar"
    } finally {
      if (win && !win.isDestroyed()) {
        win.focus();
        win.webContents.focus();
      }
    }
  });
}

module.exports = { opcoesDoDialogo, registrarDialogosNativos };
