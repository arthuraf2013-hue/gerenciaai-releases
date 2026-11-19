const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const iu = require('../electron/instanciaUnica');

const MIN = 60 * 1000;
const vivo = () => true;
const morto = () => false;
const ehApp = () => true;
const outroApp = () => false;

test('instância com batida recente: espera (ela mesma mostra a janela)', () => {
  const agora = 10 * MIN;
  const estado = { pid: 4321, fase: 'aberta', batida: agora - 20 * 1000 };
  assert.equal(iu.decidir({ estado, agora, meuPid: 1, vivo, mesmoApp: ehApp }), 'esperar');
});

test('instância aberta sem batida há mais de 1 min e ainda viva: encerra', () => {
  const agora = 10 * MIN;
  const estado = { pid: 4321, fase: 'aberta', batida: agora - 2 * MIN };
  assert.equal(iu.decidir({ estado, agora, meuPid: 1, vivo, mesmoApp: ehApp }), 'encerrar');
});

test('travada fechando: 20 s já bastam; abrindo (migração do banco), folga de 3 min', () => {
  const agora = 10 * MIN;
  assert.equal(iu.decidir({ estado: { pid: 9, fase: 'saindo', batida: agora - 30 * 1000 }, agora, meuPid: 1, vivo, mesmoApp: ehApp }), 'encerrar');
  assert.equal(iu.decidir({ estado: { pid: 9, fase: 'iniciando', batida: agora - 2 * MIN }, agora, meuPid: 1, vivo, mesmoApp: ehApp }), 'esperar');
  assert.equal(iu.decidir({ estado: { pid: 9, fase: 'iniciando', batida: agora - 4 * MIN }, agora, meuPid: 1, vivo, mesmoApp: ehApp }), 'encerrar');
});

test('nunca encerra: processo já morto, pid de outro programa, o próprio pid ou sem arquivo', () => {
  const agora = 10 * MIN;
  const velho = { pid: 4321, fase: 'aberta', batida: 0 };
  assert.equal(iu.decidir({ estado: velho, agora, meuPid: 1, vivo: morto, mesmoApp: ehApp }), 'esperar');
  assert.equal(iu.decidir({ estado: velho, agora, meuPid: 1, vivo, mesmoApp: outroApp }), 'esperar');
  assert.equal(iu.decidir({ estado: velho, agora, meuPid: 4321, vivo, mesmoApp: ehApp }), 'esperar');
  assert.equal(iu.decidir({ estado: null, agora, meuPid: 1, vivo, mesmoApp: ehApp }), 'esperar');
});

test('batimento grava o pid e a fase; fechando para de bater', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const arquivo = iu.arquivoDaInstancia(dir);
  const b = iu.iniciarBatimento({ arquivo, pid: 777 });
  try {
    let e = iu.lerInstancia(arquivo);
    assert.equal(e.pid, 777);
    assert.equal(e.fase, 'iniciando');
    b.fase('aberta');
    assert.equal(iu.lerInstancia(arquivo).fase, 'aberta');
  } finally {
    b.saindo();
  }
  const e = iu.lerInstancia(arquivo);
  assert.equal(e.fase, 'saindo');
  assert.ok(Date.now() - e.batida < 5000);
  fs.writeFileSync(arquivo, 'lixo');
  assert.equal(iu.lerInstancia(arquivo), null);
});

test('destravar: processo morto no arquivo não é encerrado nem reabre', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const arquivo = iu.arquivoDaInstancia(dir);
  fs.writeFileSync(arquivo, JSON.stringify({ pid: 2 ** 22 + 12345, fase: 'aberta', batida: 0 }));
  assert.equal(iu.destravarInstanciaPresa({ arquivo, execPath: process.execPath }), false);
});

test('main.js: foca a janela principal, fecha o app junto com ela e tem saída de segurança', () => {
  // Sem \r: no Windows o arquivo tem fim de linha CRLF.
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf-8').replace(/\r/g, '');
  assert.doesNotMatch(src, /getAllWindows\(\)\[0\]|janelas\[0\]/);
  assert.match(src, /destravarInstanciaPresa/);
  assert.match(src, /win === janelaPrincipal[^\n]*app\.quit\(\)/);
  assert.match(src, /setTimeout\(mostrar, 10000\)/);
  assert.match(src, /render-process-gone/);
  assert.match(src, /app\.exit\(0\);\n  \}, 10000\)/);
});
