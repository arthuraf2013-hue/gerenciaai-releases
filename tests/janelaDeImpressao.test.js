// Toda impressão passa por uma janela invisível que SEMPRE fecha. Antes,
// impressora sem resposta deixava a janela aberta para sempre e o app não
// encerrava ao fechar (ficava no Gerenciador de Tarefas sem janela).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let comportamento = 'ok';
const janelas = [];
class JanelaFalsa {
  constructor(opcoes) {
    this.opcoes = opcoes;
    this.destruida = false;
    this.ouvintes = {};
    janelas.push(this);
    this.webContents = {
      print: (_op, cb) => {
        if (comportamento === 'ok') setImmediate(() => cb(true, ''));
        if (comportamento === 'falha') setImmediate(() => cb(false, 'Print job failed'));
        // 'mudo': a impressora nunca responde
      },
    };
  }
  on(ev, fn) { this.ouvintes[ev] = fn; }
  isDestroyed() { return this.destruida; }
  destroy() { if (this.destruida) return; this.destruida = true; this.ouvintes.closed?.(); }
  loadURL() { return comportamento === 'carga' ? Promise.reject(new Error('ERR_FAILED')) : Promise.resolve(); }
}
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: JanelaFalsa };
  return loadOriginal.call(this, request, parent, isMain);
};
const { imprimirEmJanelaInvisivel } = require('../electron/services/printService');

test('imprimiu: devolve ok e fecha a janela', async () => {
  comportamento = 'ok';
  const r = await imprimirEmJanelaInvisivel('<p>oi</p>', { silent: true });
  assert.deepEqual(r, { ok: true, motivo: '' });
  assert.equal(janelas.at(-1).destruida, true);
  assert.deepEqual(janelas.at(-1).opcoes.webPreferences, { sandbox: true, javascript: false });
});

test('impressora que nunca responde: o prazo fecha a janela mesmo assim', async () => {
  comportamento = 'mudo';
  const r = await imprimirEmJanelaInvisivel('<p>oi</p>', { silent: true }, { prazoMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não respondeu/);
  assert.equal(janelas.at(-1).destruida, true);
});

test('falha da impressora ou do carregamento: fecha e conta o motivo', async () => {
  comportamento = 'falha';
  assert.deepEqual(await imprimirEmJanelaInvisivel('x', { silent: true }), { ok: false, motivo: 'Print job failed' });
  assert.equal(janelas.at(-1).destruida, true);
  comportamento = 'carga';
  const r = await imprimirEmJanelaInvisivel('x', { silent: true });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ERR_FAILED/);
  assert.equal(janelas.at(-1).destruida, true);
});

