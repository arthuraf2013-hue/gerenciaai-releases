const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const updateService = require('../electron/services/updateService');

// Fora do Electron de verdade (rodando com node --test, como aqui),
// updateService cai pro mesmo diretório ".data" usado pelo resto do
// código nesse cenário (ver comentário em caminhoMarcadorAtualizacao) —
// é o que permite testar a gravação/leitura do marcador sem precisar
// simular app.getPath('userData').
const CAMINHO_MARCADOR = path.join(__dirname, '../.data', 'atualizacao-pendente.json');

function limparMarcador() {
  try { fs.unlinkSync(CAMINHO_MARCADOR); } catch { /* já não existia */ }
}

test.beforeEach(limparMarcador);
test.after(limparMarcador);

// O marcador de atualização pendente é o que permite detectar, na
// próxima abertura do app, se uma atualização baixada de fato foi
// aplicada -- ver o comentário completo em updateService.js sobre o
// incidente que motivou isso (app "sumindo" no meio de uma atualização
// que não terminou de se aplicar direito).

test('marcarAtualizacaoPendente grava um marcador com a versão esperada e um timestamp', () => {
  updateService.marcarAtualizacaoPendente('0.6.0');
  assert.equal(fs.existsSync(CAMINHO_MARCADOR), true);
  const conteudo = JSON.parse(fs.readFileSync(CAMINHO_MARCADOR, 'utf-8'));
  assert.equal(conteudo.versaoEsperada, '0.6.0');
  assert.equal(typeof conteudo.iniciadoEm, 'number');
});

test('marcarAtualizacaoPendente não grava nada se não recebe uma versão', () => {
  updateService.marcarAtualizacaoPendente(null);
  assert.equal(fs.existsSync(CAMINHO_MARCADOR), false);
});

test('verificarAtualizacaoFoiAplicada não faz nada (e não lança erro) quando não existe marcador', () => {
  assert.doesNotThrow(() => updateService.verificarAtualizacaoFoiAplicada());
});

test('verificarAtualizacaoFoiAplicada apaga o marcador mesmo com JSON corrompido, sem lançar erro', () => {
  fs.mkdirSync(path.dirname(CAMINHO_MARCADOR), { recursive: true });
  fs.writeFileSync(CAMINHO_MARCADOR, '{ isso não é um json válido');
  assert.doesNotThrow(() => updateService.verificarAtualizacaoFoiAplicada());
  assert.equal(fs.existsSync(CAMINHO_MARCADOR), false);
});

test('verificarAtualizacaoFoiAplicada apaga o marcador quando falta o campo versaoEsperada', () => {
  fs.mkdirSync(path.dirname(CAMINHO_MARCADOR), { recursive: true });
  fs.writeFileSync(CAMINHO_MARCADOR, JSON.stringify({ iniciadoEm: Date.now() }));
  assert.doesNotThrow(() => updateService.verificarAtualizacaoFoiAplicada());
  assert.equal(fs.existsSync(CAMINHO_MARCADOR), false);
});

/**
 * Fora do Electron de verdade não dá pra saber a "versão atual" do app
 * (não existe app.getVersion() nesse contexto) -- por isso a função cai
 * no caminho seguro de "não dá pra concluir nada" e não dispara o
 * reporte de erro nem a nova tentativa de atualização. O que ESSE teste
 * garante é a parte que independe disso: o marcador é sempre consumido
 * (apagado) depois de lido, pra não ficar checando pra sempre. O
 * caminho que de fato compara com a versão instalada e reporta a falha
 * só é exercitado dentro do app empacotado de verdade.
 */
test('verificarAtualizacaoFoiAplicada consome (apaga) um marcador válido sem lançar erro', () => {
  updateService.marcarAtualizacaoPendente('0.6.0');
  assert.equal(fs.existsSync(CAMINHO_MARCADOR), true);
  assert.doesNotThrow(() => updateService.verificarAtualizacaoFoiAplicada());
  assert.equal(fs.existsSync(CAMINHO_MARCADOR), false);
});
