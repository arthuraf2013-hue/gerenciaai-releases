const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Pasta temporária própria: o teste não depende de poder criar/apagar arquivo
// dentro do repositório (pastas protegidas do Windows, antivírus) nem briga com
// outro processo de teste rodando em paralelo.
const PASTA_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gerenciaai-marcador-'));
process.env.GERENCIAAI_MARCADOR_DIR = PASTA_TEMP;
const updateService = require('../electron/services/updateService');

// Fora do Electron de verdade (rodando com node --test, como aqui),
// updateService cai pro mesmo diretório ".data" usado pelo resto do
// código nesse cenário (ver comentário em caminhoMarcadorAtualizacao) —
// é o que permite testar a gravação/leitura do marcador sem precisar
// simular app.getPath('userData').
const CAMINHO_MARCADOR = path.join(PASTA_TEMP, 'atualizacao-pendente.json');

function limparMarcador() {
  try { fs.unlinkSync(CAMINHO_MARCADOR); } catch { /* já não existia */ }
}

test.beforeEach(limparMarcador);
test.after(() => { limparMarcador(); try { fs.rmSync(PASTA_TEMP, { recursive: true, force: true }); } catch { /* ok */ } });

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

// ------------------------------------------------------------
// Segurar/liberar instalação pela Central
// ------------------------------------------------------------
const { freshTestDb } = require('./helpers/testDb');

test('decidirRetencao: segura só a versão pedida, "*" segura todas, obrigatória vence o pedido', () => {
  const { decidirRetencao } = updateService;
  const so103 = { segurada: true, versao: '1.0.3' };
  assert.deepEqual(decidirRetencao({ alvo: '1.0.3', controle: so103 }), { retida: true, ignoradaPorObrigatoria: false });
  // Saiu a 1.0.4 (a correção): o pedido era só pra 1.0.3, então a nova instala.
  assert.equal(decidirRetencao({ alvo: '1.0.4', controle: so103 }).retida, false);
  assert.equal(decidirRetencao({ alvo: '1.0.4', controle: { segurada: true, versao: '*' } }).retida, true);
  assert.equal(decidirRetencao({ alvo: null, controle: { segurada: true, versao: '*' } }).retida, true);
  assert.equal(decidirRetencao({ alvo: '1.0.3', controle: { segurada: false, versao: null } }).retida, false);
  assert.deepEqual(decidirRetencao({ alvo: '1.0.3', controle: so103, obrigatoriaBloqueando: true }), { retida: false, ignoradaPorObrigatoria: true });
});

test('aplicarControleDaInstalacao grava o pedido da Central localmente (vale offline) e libera ao desmarcar', () => {
  freshTestDb();
  assert.deepEqual(updateService.lerControleAtualizacao(), { segurada: false, versao: null, motivo: null });
  updateService.aplicarControleDaInstalacao({ atualizacaoSegurada: true, atualizacaoSeguradaVersao: '1.0.3', atualizacaoSeguradaMotivo: 'versão com bug no troco' });
  assert.deepEqual(updateService.lerControleAtualizacao(), { segurada: true, versao: '1.0.3', motivo: 'versão com bug no troco' });
  const s = updateService.getStatus();
  // Sem versão baixada ainda, um pedido de versão específica não segura nada.
  assert.equal(s.retida, false);
  updateService.aplicarControleDaInstalacao({ atualizacaoSegurada: true, atualizacaoSeguradaVersao: '*' });
  assert.equal(updateService.getStatus().retida, true);
  assert.equal(updateService.getStatus().retencaoVersao, '*');
  assert.match(updateService.quitAndInstall().error || '', /baixar|segurada/);
  // Versão em formato inválido é ignorada (não segura por engano).
  updateService.aplicarControleDaInstalacao({ atualizacaoSegurada: true, atualizacaoSeguradaVersao: 'qualquer' });
  assert.equal(updateService.lerControleAtualizacao().segurada, false);
  updateService.aplicarControleDaInstalacao({ atualizacaoSegurada: false });
  assert.equal(updateService.getStatus().retida, false);
});
