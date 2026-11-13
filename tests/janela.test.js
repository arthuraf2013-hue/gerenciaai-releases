const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../electron/janela');

const principal = { id: 1, bounds: { x: 0, y: 0, width: 1366, height: 768 }, workArea: { x: 0, y: 0, width: 1366, height: 728 } };
const direita = { id: 2, bounds: { x: 1366, y: 0, width: 1920, height: 1080 }, workArea: { x: 1366, y: 0, width: 1920, height: 1040 } };

test('primeira vez: tamanho padrão centralizado no principal', () => {
  const p = J.escolherPosicao(null, [principal], principal);
  assert.equal(p.width, 1280);
  assert.equal(p.height, 728, 'não passa da área útil');
  assert.equal(p.x, 43);
  assert.equal(p.maximized, false);
});

test('reabre exatamente onde estava, no segundo monitor, maximizada', () => {
  const salvo = { x: 1500, y: 40, width: 1400, height: 900, maximized: true, displayId: 2, displayBounds: direita.bounds };
  const p = J.escolherPosicao(salvo, [principal, direita], principal);
  assert.deepEqual([p.x, p.y, p.width, p.height, p.maximized, p.displayId], [1500, 40, 1400, 900, true, 2]);
});

test('monitor desligado: centraliza no principal; mudou de lugar: acha pelo id', () => {
  const salvo = { x: 1500, y: 40, width: 1400, height: 900, displayId: 2, displayBounds: direita.bounds };
  const p = J.escolherPosicao(salvo, [principal], principal);
  assert.equal(p.displayId, 1);
  assert.ok(p.x >= 0 && p.x + p.width <= 1366 && p.y + p.height <= 728);
  const movido = { ...direita, bounds: { ...direita.bounds, x: -1920 }, workArea: { ...direita.workArea, x: -1920 } };
  const q = J.escolherPosicao(salvo, [principal, movido], principal);
  assert.equal(q.displayId, 2);
  assert.ok(q.x < 0, 'vai para o mesmo monitor, agora à esquerda');
});

test('salva e lê de volta; arquivo estragado vira null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janela-'));
  const arq = path.join(dir, 'janela.json');
  assert.equal(J.salvarEstado(arq, { x: 10, y: 20, width: 1200, height: 800, maximized: false }), true);
  assert.equal(J.lerEstado(arq).width, 1200);
  fs.writeFileSync(arq, '{quebrado');
  assert.equal(J.lerEstado(arq), null);
});

test('lembrarJanela grava ao fechar e ignora janela minimizada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janela-'));
  const arq = path.join(dir, 'janela.json');
  const ouvintes = {};
  let minimizada = false;
  const win = {
    on: (ev, fn) => { ouvintes[ev] = fn; }, isDestroyed: () => false, isMinimized: () => minimizada,
    getBounds: () => ({ x: 1400, y: 0, width: 1300, height: 900 }), getNormalBounds: () => ({ x: 1400, y: 0, width: 1300, height: 900 }),
    isMaximized: () => true, isFullScreen: () => false,
  };
  const screen = { getDisplayMatching: () => direita };
  J.lembrarJanela(win, screen, arq);
  ouvintes.close();
  assert.deepEqual(J.lerEstado(arq), { x: 1400, y: 0, width: 1300, height: 900, maximized: true, fullscreen: false, displayId: 2, displayBounds: direita.bounds });
  minimizada = true;
  fs.writeFileSync(arq, JSON.stringify({ x: 1, y: 1, width: 1100, height: 750 }));
  ouvintes.close();
  assert.equal(J.lerEstado(arq).x, 1, 'minimizada não sobrescreve');
});
