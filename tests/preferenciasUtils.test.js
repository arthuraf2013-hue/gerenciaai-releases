// Montagem do menu personalizado e mescla das preferências (src/utils/preferencias.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildSync } = require('esbuild');

const saida = buildSync({ entryPoints: [path.join(__dirname, '../src/utils/preferencias.js')], bundle: true, format: 'cjs', platform: 'node', write: false });
const m = { exports: {} };
new Function('module', 'exports', 'require', saida.outputFiles[0].text)(m, m.exports, require);
const p = m.exports;

const ITENS = ['pos', 'history', 'caixa', 'delivery', 'products', 'settings'].map((id) => ({ id }));
const ids = (l) => l.map((i) => i.id);

test('menu: favoritos no topo na ordem escolhida, ocultos fora, o resto na ordem padrão', () => {
  const r = p.montarMenu(ITENS, { favoritos: ['caixa', 'pos'], ocultos: ['delivery'] });
  assert.deepEqual(ids(r.favoritos), ['caixa', 'pos']);
  assert.deepEqual(ids(r.resto), ['history', 'products', 'settings']);
  assert.deepEqual(ids(r.ocultos), ['delivery']);
});

test('menu: tela que a pessoa não pode ver (papel ou perfil) some até dos favoritos', () => {
  const r = p.montarMenu(ITENS.filter((i) => i.id !== 'settings'), { favoritos: ['settings', 'pos'], ocultos: ['settings'] });
  assert.deepEqual(ids(r.favoritos), ['pos']);
  assert.equal(r.ocultos.length, 0);
});

test('favoritar tira do oculto, ocultar tira do favorito, mover respeita os limites', () => {
  let menu = { favoritos: ['pos'], ocultos: ['caixa'] };
  menu = p.alternarFavorito(menu, 'caixa');
  assert.deepEqual(menu, { favoritos: ['pos', 'caixa'], ocultos: [] });
  menu = p.moverFavorito(menu, 'caixa', -1);
  assert.deepEqual(menu.favoritos, ['caixa', 'pos']);
  assert.deepEqual(p.moverFavorito(menu, 'caixa', -1), menu);
  menu = p.alternarOculto(menu, 'pos');
  assert.deepEqual(menu, { favoritos: ['caixa'], ocultos: ['pos'] });
  assert.deepEqual(p.alternarFavorito(menu, 'caixa'), { favoritos: [], ocultos: ['pos'] });
});

test('mescla: lixo e versão velha viram padrão, valores válidos ficam', () => {
  assert.deepEqual(p.mesclarPreferencias(null), {
    menu: { favoritos: [], ocultos: [] }, pdv: { categorias: 'faixa', recentes: true, foco: false },
    visual: { zoom: 1, densidade: 'auto', tema: null },
  });
  const r = p.mesclarPreferencias({ menu: { favoritos: ['pos', 'pos', 3] }, pdv: { categorias: 'nada', recentes: false }, visual: { zoom: 7, densidade: 'compacta', tema: 'escuro' } });
  assert.deepEqual(r.menu.favoritos, ['pos']);
  assert.equal(r.pdv.categorias, 'faixa');
  assert.equal(r.pdv.recentes, false);
  assert.equal(r.visual.zoom, 1);
  assert.equal(r.visual.densidade, 'compacta');
  assert.equal(r.visual.tema, 'escuro');
});

test('densidade automática e passos de letra', () => {
  assert.equal(p.densidadeEfetiva('auto', 1366), 'compacta');
  assert.equal(p.densidadeEfetiva('auto', 1920), 'confortavel');
  assert.equal(p.densidadeEfetiva('confortavel', 1366), 'confortavel');
  assert.equal(p.proximoZoom(1, +1), 1.1);
  assert.equal(p.proximoZoom(1.4, +1), 1.4);
  assert.equal(p.proximoZoom(0.9, -1), 0.9);
});

test('ajuste automático à tela: 1 na faixa de projeto, encolhe em tela pequena, amplia em tela grande', () => {
  const f = p.fatorAutomatico;
  assert.equal(f(1280, 720), 1);
  assert.equal(f(1600, 900), 1);
  assert.equal(f(1920, 1080), 1);
  assert.equal(f(1093, 600), 0.8); // notebook 1366x768 com escala de 125%
  assert.equal(f(1024, 576), 0.8);
  assert.equal(f(800, 500), 0.6);
  assert.equal(f(300, 200), 0.6); // nunca abaixo do mínimo
  assert.equal(f(2560, 1440), 1.3);
  assert.equal(f(3840, 2160), 2);
  assert.equal(f(7680, 4320), 2); // nunca acima do máximo
  assert.equal(f(1280, 600), 0.8); // só a altura é pequena: vale a menor proporção
  assert.equal(f(2560, 800), 1); // ultrawide baixo: não amplia pela largura
  assert.equal(f(NaN, 700), 1);
  assert.equal(f(0, 0), 1);
});
