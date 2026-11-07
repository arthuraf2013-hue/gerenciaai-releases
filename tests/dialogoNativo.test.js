const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { opcoesDoDialogo, registrarDialogosNativos } = require('../electron/dialogoNativo');

// alert/confirm do Chromium travam a digitação no Windows; a interface usa o
// diálogo do Electron e o foco volta para a página depois.

function montar(botaoEscolhido, { falhar = false } = {}) {
  let ouvinte = null;
  const focos = [];
  const win = { isDestroyed: () => false, focus: () => focos.push('janela'), webContents: { focus: () => focos.push('pagina') } };
  registrarDialogosNativos({
    ipcMain: { on: (canal, fn) => { assert.equal(canal, 'dialogo:nativo'); ouvinte = fn; } },
    dialog: { showMessageBoxSync: (_w, o) => { if (falhar) throw new Error('x'); return typeof botaoEscolhido === 'function' ? botaoEscolhido(o) : botaoEscolhido; } },
    BrowserWindow: { fromWebContents: () => win },
  });
  const chamar = (payload) => { const ev = { sender: {} }; ouvinte(ev, payload); return ev.returnValue; };
  return { chamar, focos };
}

test('confirm: OK = true, Cancelar/fechar = false; o foco volta para a página', () => {
  const ok = montar(0);
  assert.equal(ok.chamar({ tipo: 'confirm', mensagem: 'Cancelar a venda?' }), true);
  assert.deepEqual(ok.focos, ['janela', 'pagina']);
  assert.equal(montar(1).chamar({ tipo: 'confirm', mensagem: 'x' }), false);
  assert.equal(montar(0, { falhar: true }).chamar({ tipo: 'confirm', mensagem: 'x' }), false, 'erro nunca confirma');
});

test('alert: só OK; mensagem vira texto e tem limite', () => {
  let opcoes = null;
  const a = montar((o) => { opcoes = o; return 0; });
  assert.equal(a.chamar({ tipo: 'alert', mensagem: 'Salvo.' }), true);
  assert.deepEqual(opcoes.buttons, ['OK']);
  assert.equal(opcoesDoDialogo({ tipo: 'confirm', mensagem: 'x'.repeat(9000) }).opcoes.message.length, 4000);
  assert.equal(opcoesDoDialogo({ tipo: 'qualquer', mensagem: null }).tipo, 'alert');
});

test('a interface troca window.alert/confirm pelo diálogo do Electron', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.jsx'), 'utf8');
  assert.match(main, /window\.confirm = \(mensagem\) => window\.pdv\.dialogo\.confirmar\(mensagem\)/);
  assert.match(main, /window\.alert = \(mensagem\) => window\.pdv\.dialogo\.alerta\(mensagem\)/);
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8');
  assert.match(preload, /sendSync\('dialogo:nativo'/);
  const principal = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  assert.match(principal, /registrarDialogosNativos\(\)/);
  assert.match(principal, /win\.on\('focus', \(\) => \{ if \(!win\.isDestroyed\(\)\) win\.webContents\.focus\(\); \}\)/);
});
