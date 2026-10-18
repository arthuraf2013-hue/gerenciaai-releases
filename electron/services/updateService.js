const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');

// electron-updater é carregado sob demanda (dentro de cada função que
// precisa dele), não no topo do arquivo -- fora do Electron de verdade
// (rodando os testes com `node --test`, por exemplo), o getter interno
// do autoUpdater tenta construir um updater específico da plataforma
// (ex: AppImageUpdater no Linux) que já lê `app.getVersion()` direto no
// construtor, e derruba o `require` do módulo inteiro nesse ambiente.
// Isso também é o que permite testar o marcador de atualização pendente
// (ver mais abaixo) sem precisar simular o Electron inteiro.
function obterAutoUpdater() {
  return require('electron-updater').autoUpdater;
}

let status = {
  checking: false,
  disponivel: false,
  versaoDisponivel: null,
  baixando: false,
  progresso: 0,
  baixado: false,
  erro: null,
  versaoAtual: null,
  // Instalação segurada pela Central (ver "Segurar/liberar instalação"
  // mais abaixo): baixa normalmente, mas não instala.
  retida: false,
  retencaoIgnoradaPorObrigatoria: false,
  retencaoVersao: null,
  retencaoMotivo: null,
};
let autoUpdaterPronto = false;

function setupAutoUpdater() {
  // Baixa sozinho assim que acha uma versão nova (checkForUpdates já
  // roda periodicamente em background, ver main.js) — sem precisar de
  // clique nenhum. A instalação em si fica pra `autoInstallOnAppQuit`
  // logo abaixo: só aplica a atualização já baixada quando o app
  // fechar sozinho (troca de turno, fim do expediente, reinício do
  // Windows) — nunca interrompe uma venda em andamento forçando o app
  // a fechar no meio do uso. Configurações → Atualizações ainda mostra
  // o progresso e tem um botão "instalar agora" pra quem não quiser
  // esperar o próximo fechamento natural, mas isso é opcional, não
  // obrigatório.
  const autoUpdater = obterAutoUpdater();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  status.versaoAtual = require('electron').app.getVersion();

  autoUpdater.on('checking-for-update', () => {
    status = { ...status, checking: true, erro: null };
  });
  autoUpdater.on('update-available', (info) => {
    status = { ...status, checking: false, disponivel: true, versaoDisponivel: info.version };
    reavaliarRetencao();
  });
  autoUpdater.on('update-not-available', () => {
    status = { ...status, checking: false, disponivel: false };
  });
  autoUpdater.on('download-progress', (p) => {
    status = { ...status, baixando: true, progresso: Math.round(p.percent) };
    reportarProgressoNoFirestore().catch(() => {}); // best-effort, nunca trava o download por causa disso
  });
  autoUpdater.on('update-downloaded', (info) => {
    status = { ...status, baixando: false, baixado: true, progresso: 100, versaoDisponivel: info?.version || status.versaoDisponivel };
    // O marcador de "atualização pendente" (ver verificarAtualizacaoFoiAplicada)
    // é gravado/apagado em reavaliarRetencao: ele cobre os dois jeitos da
    // atualização ser aplicada (clique manual e autoInstallOnAppQuit), mas
    // NÃO pode existir enquanto a Central segura a instalação -- senão a
    // próxima abertura, ainda na versão antiga de propósito, seria
    // reportada como "atualização que falhou".
    reavaliarRetencao({ semRelato: true }); // o relato vai logo abaixo, já com a data do download
    reportarProgressoNoFirestore({ baixadaAgora: true }).catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    // Erro mais comum aqui: o publish do package.json ainda não foi
    // configurado com um repositório GitHub real (owner/repo de
    // exemplo) — no lugar de travar o app, só marca no status, a tela
    // mostra isso como "verifique a configuração de publicação".
    status = { ...status, checking: false, baixando: false, erro: err.message };
  });
  autoUpdaterPronto = true;
  reavaliarRetencao();
}

function checkForUpdates() {
  status = { ...status, erro: null };
  obterAutoUpdater().checkForUpdates().catch((err) => {
    status = { ...status, checking: false, erro: err.message };
  });
  return { ok: true };
}

function downloadUpdate() {
  if (!status.disponivel) return { ok: false, error: 'Nenhuma atualização disponível pra baixar.' };
  obterAutoUpdater().downloadUpdate().catch((err) => {
    status = { ...status, baixando: false, erro: err.message };
  });
  return { ok: true };
}

function quitAndInstall() {
  if (!status.baixado) return { ok: false, error: 'A atualização ainda não terminou de baixar.' };
  if (status.retida) {
    return {
      ok: false,
      error: `A instalação da versão ${status.versaoDisponivel} foi segurada pela Central${status.retencaoMotivo ? ` (${status.retencaoMotivo})` : ''}. Ela fica baixada e instala sozinha quando o suporte liberar.`,
    };
  }
  obterAutoUpdater().quitAndInstall();
  return { ok: true };
}

function getStatus() {
  return status;
}

// ============================================================
// Verificação pós-atualização — detecta uma atualização que baixou
// certinho mas não terminou de se aplicar direito (instalador
// silencioso interrompido por antivírus, queda de energia, Windows
// Update forçando reinício bem no meio da troca de arquivos). O
// sintoma real, quando acontece, é o app parecer "desinstalado" pro
// cliente. O marcador fica em userData (fora da pasta de instalação),
// então sobrevive mesmo que a atualização mexa/apague arquivos dentro
// da pasta do app.
//
// Importante: isso só ajuda quando o app CONSEGUE abrir de novo (fica
// preso na versão antiga, por exemplo). Se a pasta de instalação
// inteira sumir, não sobra processo nenhum pra rodar essa checagem —
// pra esse caso mais extremo (o que o Arthur descreveu) só um
// mecanismo fora do processo do app (ex: um atalho/launcher próprio,
// ou uma tarefa agendada do Windows) consegue detectar e reparar
// sozinho, e isso precisa de teste numa máquina Windows de verdade
// antes de valer a pena arriscar em produção.
// ============================================================

function caminhoMarcadorAtualizacao() {
  // Mesmo truque do resto do código (ver backupService.js) pra
  // funcionar tanto dentro do Electron de verdade quanto rodando com
  // `node --test` fora dele: fora do Electron, require('electron')
  // devolve só o caminho do binário (uma string) -- desestruturar
  // `app` dela dá `undefined` sem lançar erro, então cai no fallback.
  const { app } = require('electron');
  // GERENCIAAI_MARCADOR_DIR só existe pros testes: isola o marcador numa pasta
  // temporária (sem depender de poder apagar arquivo dentro do repositório).
  const base = app ? app.getPath('userData') : (process.env.GERENCIAAI_MARCADOR_DIR || path.join(__dirname, '../../.data'));
  return path.join(base, 'atualizacao-pendente.json');
}

function marcarAtualizacaoPendente(versaoEsperada) {
  if (!versaoEsperada) return;
  try {
    fs.writeFileSync(caminhoMarcadorAtualizacao(), JSON.stringify({ versaoEsperada, iniciadoEm: Date.now() }));
  } catch (err) {
    console.error('[updateService] não conseguiu gravar o marcador de atualização pendente:', err.message);
  }
}

/**
 * Chamada uma vez, logo depois do app subir. Se existir um marcador de
 * atualização pendente: apaga ele (já não precisa mais checar de novo)
 * e confere se a versão atual bate com a esperada. Se não bater,
 * reporta pra Central (mesmo mecanismo de erro automático já existente,
 * contexto dedicado 'atualizacao_falhou' — aparece na aba Erros) e
 * tenta buscar a atualização de novo sozinho, sem esperar o próximo
 * ciclo periódico de 4h.
 */
function verificarAtualizacaoFoiAplicada() {
  const caminho = caminhoMarcadorAtualizacao();
  if (!fs.existsSync(caminho)) return;

  let conteudo;
  try {
    conteudo = fs.readFileSync(caminho, 'utf-8');
  } catch (err) {
    console.error('[updateService] não conseguiu ler o marcador de atualização pendente:', err.message);
    return;
  }
  try {
    // Apaga assim que consegue ler, mesmo se o conteúdo estiver
    // corrompido -- não precisa conferir de novo nas próximas
    // aberturas, e um marcador corrompido não deveria ficar tentando
    // (e falhando) pra sempre.
    fs.unlinkSync(caminho);
  } catch (err) {
    console.error('[updateService] não conseguiu apagar o marcador de atualização pendente:', err.message);
  }

  let marcador;
  try {
    marcador = JSON.parse(conteudo);
  } catch (err) {
    console.error('[updateService] marcador de atualização pendente corrompido, ignorando:', err.message);
    return;
  }
  if (!marcador?.versaoEsperada) return;

  // Mesmo truque de app-ou-fallback do resto do arquivo -- fora do
  // Electron de verdade (ex: rodando os testes), não dá pra saber a
  // versão atual, então não dá pra concluir nada: melhor não fazer
  // nada do que reportar um falso positivo.
  const { app } = require('electron');
  const versaoAtual = app?.getVersion ? app.getVersion() : null;
  if (!versaoAtual || versaoAtual === marcador.versaoEsperada) return; // aplicou certinho (ou não dá pra checar)

  const minutosDesde = Math.round((Date.now() - (marcador.iniciadoEm || Date.now())) / 60000);
  require('./errorReportService').reportarErro({
    mensagem: `Atualização pra ${marcador.versaoEsperada} não foi aplicada -- app reabriu ainda na ${versaoAtual} (${minutosDesde}min depois de baixar)`,
    stack: null,
    contexto: 'atualizacao_falhou',
  });

  // O app conseguiu abrir (só ficou na versão errada) -- tenta de novo
  // sozinho em vez de esperar o cliente notar ou o próximo ciclo de 4h.
  setTimeout(() => {
    try { checkForUpdates(); } catch (err) { console.error('[update]', err); }
  }, 5000);
}

// ============================================================
// Atualização obrigatória — publicada remotamente pelo painel de
// licenciamento, pra não precisar atualizar cliente por cliente na
// mão. Reaproveita o MESMO projeto Firebase do licenciamento (não
// precisa de um projeto separado) e o MESMO id de instalação.
// ============================================================

/** Compara duas versões tipo "0.4.10" — mais seguro que comparar como
 * texto puro (que erraria "0.4.10" < "0.4.9", já que '1' < '9'). */
function versaoMenorQue(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

function getLocalForcedUpdateState() {
  const db = getDb();
  return db.prepare('SELECT * FROM forced_update_state WHERE id = ?').get('default');
}

function saveLocalForcedUpdateState({ versaoMinimaExigida, obrigatoria }) {
  const db = getDb();
  db.prepare('UPDATE forced_update_state SET versao_minima_exigida = ?, obrigatoria = ? WHERE id = ?')
    .run(versaoMinimaExigida || null, obrigatoria ? 1 : 0, 'default');
  reavaliarRetencao();
}

/** Override POR INSTALAÇÃO (vem junto no documento da própria
 * instalação, escrito pela Central) -- chamada pela escuta em tempo
 * real de licenseService, mesmo padrão de aplicarMensagemDaInstalacao.
 * Quando ativo, vale no lugar da regra global SÓ nessa máquina --
 * serve tanto pra testar uma versão nova aos poucos (rollout gradual:
 * ativa o override numa máquina de teste ANTES de publicar a regra
 * global) quanto pra isentar um cliente específico por um tempo. */
function aplicarOverrideDaInstalacao(dadosInstalacao) {
  const db = getDb();
  db.prepare('UPDATE forced_update_state SET versao_minima_override = ?, override_ativo = ? WHERE id = ?')
    .run(
      dadosInstalacao.versaoMinimaOverride || null,
      dadosInstalacao.overrideAtivo === true ? 1 : 0,
      'default'
    );
  reavaliarRetencao();
}

/** Decide, só com dado local (sem rede), se a atualização obrigatória
 * está bloqueando o uso agora — pode ser chamado a qualquer momento,
 * inclusive offline (usa o último valor conhecido). O override por
 * instalação, quando ativo, sempre vence a regra global (positivo ou
 * negativo: tanto pra exigir uma versão MAIOR quanto pra dispensar
 * dessa máquina uma exigência global vigente). */
function verificarAtualizacaoObrigatoria() {
  const state = getLocalForcedUpdateState();
  const versaoAtual = require('electron').app.getVersion();

  if (state.override_ativo) {
    if (!state.versao_minima_override) return { bloqueado: false };
    const precisaAtualizar = versaoMenorQue(versaoAtual, state.versao_minima_override);
    return { bloqueado: precisaAtualizar, versaoMinimaExigida: state.versao_minima_override, versaoAtual, viaOverride: true };
  }

  if (!state.obrigatoria || !state.versao_minima_exigida) {
    return { bloqueado: false };
  }
  const precisaAtualizar = versaoMenorQue(versaoAtual, state.versao_minima_exigida);
  return { bloqueado: precisaAtualizar, versaoMinimaExigida: state.versao_minima_exigida, versaoAtual };
}

let pararEscutaAtualizacao = null;

/** Escuta em tempo real o documento único de config de atualização
 * (publicado pelo painel) — assim que você publica uma nova versão
 * obrigatória, todo cliente conectado percebe em poucos segundos. */
function iniciarEscutaAtualizacaoObrigatoria() {
  try {
    const licenseService = require('./licenseService');
    const { doc, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const ref = doc(firestore, 'config', 'atualizacao');

    if (pararEscutaAtualizacao) pararEscutaAtualizacao();
    pararEscutaAtualizacao = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          saveLocalForcedUpdateState({ versaoMinimaExigida: d.versaoMinimaExigida, obrigatoria: d.obrigatoria === true });
        } else {
          saveLocalForcedUpdateState({ versaoMinimaExigida: null, obrigatoria: false });
        }
      },
      (err) => console.error('[updateService] escuta de atualização obrigatória falhou:', err)
    );
  } catch (err) {
    console.error('[updateService] não foi possível iniciar a escuta de atualização obrigatória:', err);
  }
}

/** Escreve o progresso do download no próprio documento da instalação
 * no Firestore (mesma coleção `installations` do licenciamento) — é
 * assim que o painel consegue mostrar a barra de progresso de cada
 * cliente. Melhor esforço só — nunca trava o download por causa disso. */
async function reportarProgressoNoFirestore({ baixadaAgora = false } = {}) {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
  const firestore = licenseService.getLicenseFirestore();
  const installId = pdvRegistryService.getOrCreateDeviceUid();
  const ref = doc(firestore, 'installations', installId);
  const campos = {
    atualizacaoBaixando: status.baixando,
    atualizacaoProgresso: status.progresso,
    atualizacaoBaixado: status.baixado,
    atualizacaoVersaoAlvo: status.versaoDisponivel || null,
    // Confirmação de que o pedido da Central está valendo NESTA máquina
    // (a Central mostra "segurada" só depois disso -- antes é "pedido
    // enviado, esperando a máquina").
    atualizacaoRetida: status.retida,
    atualizacaoRetidaVersao: status.retida ? (status.retencaoVersao || null) : null,
    atualizacaoRetencaoIgnorada: status.retencaoIgnoradaPorObrigatoria ? 'obrigatoria' : null,
  };
  if (baixadaAgora) campos.atualizacaoBaixadaEm = serverTimestamp();
  await setDoc(ref, campos, { merge: true });
}

// ============================================================
// Segurar/liberar instalação pela Central. A Central grava no
// documento da instalação:
//   atualizacaoSegurada: true|false
//   atualizacaoSeguradaVersao: '1.0.3' (só essa) | '*' (todas até liberar)
//   atualizacaoSeguradaMotivo: texto opcional
// e esta máquina:
//   - continua BAIXANDO a versão nova (pra Central ver qual está
//     esperando e pra instalar na hora quando liberar);
//   - desliga o autoInstallOnAppQuit enquanto a versão baixada estiver
//     coberta pelo pedido (o electron-updater lê essa flag na hora de
//     fechar, então mudar a qualquer momento vale);
//   - recusa o "Instalar agora" de Configurações.
// O pedido fica gravado no SQLite (atualizacao_controle): vale mesmo se
// o app fechar sem internet. Atualização OBRIGATÓRIA vence o pedido --
// senão a máquina ficaria presa na tela de atualização sem poder
// instalar; nesse caso a máquina avisa a Central ('obrigatoria').
// ============================================================

const TODAS_AS_VERSOES = '*';

function lerControleAtualizacao() {
  const db = getDb();
  const r = db.prepare(`SELECT segurada, versao, motivo FROM atualizacao_controle WHERE id = 'default'`).get();
  return r ? { segurada: r.segurada === 1, versao: r.versao || null, motivo: r.motivo || null } : { segurada: false, versao: null, motivo: null };
}

/** Chamada pela escuta em tempo real do documento da instalação (licenseService). */
function aplicarControleDaInstalacao(dadosInstalacao) {
  const versao = typeof dadosInstalacao.atualizacaoSeguradaVersao === 'string' ? dadosInstalacao.atualizacaoSeguradaVersao.trim() : '';
  const segurada = dadosInstalacao.atualizacaoSegurada === true && (versao === TODAS_AS_VERSOES || /^\d+\.\d+\.\d+/.test(versao));
  const motivo = segurada && dadosInstalacao.atualizacaoSeguradaMotivo ? String(dadosInstalacao.atualizacaoSeguradaMotivo).slice(0, 200) : null;
  const atual = lerControleAtualizacao();
  if (atual.segurada === segurada && (atual.versao || null) === (segurada ? versao : null) && atual.motivo === motivo) return;
  getDb().prepare(
    `INSERT INTO atualizacao_controle (id, segurada, versao, motivo, atualizado_em) VALUES ('default', ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET segurada = excluded.segurada, versao = excluded.versao, motivo = excluded.motivo, atualizado_em = excluded.atualizado_em`,
  ).run(segurada ? 1 : 0, segurada ? versao : null, motivo);
  reavaliarRetencao({ forcarRelato: true });
}

/**
 * Decisão pura (testável): a versão `alvo` (a disponível/baixada) está
 * segurada? `obrigatoriaBloqueando` = a tela de atualização obrigatória
 * está travando o uso agora (aí o pedido é ignorado).
 */
function decidirRetencao({ alvo, controle, obrigatoriaBloqueando }) {
  const cobre = !!(controle?.segurada && controle.versao
    && (controle.versao === TODAS_AS_VERSOES || (alvo && controle.versao === alvo)));
  if (!cobre) return { retida: false, ignoradaPorObrigatoria: false };
  if (obrigatoriaBloqueando) return { retida: false, ignoradaPorObrigatoria: true };
  return { retida: true, ignoradaPorObrigatoria: false };
}

function reavaliarRetencao({ forcarRelato = false, semRelato = false } = {}) {
  let controle;
  try { controle = lerControleAtualizacao(); } catch { return; } // banco ainda não aberto
  let obrigatoriaBloqueando = false;
  try { obrigatoriaBloqueando = !!verificarAtualizacaoObrigatoria().bloqueado; } catch { /* fora do Electron (testes) */ }
  const r = decidirRetencao({ alvo: status.versaoDisponivel, controle, obrigatoriaBloqueando });
  if (autoUpdaterPronto) {
    try { obterAutoUpdater().autoInstallOnAppQuit = !r.retida; } catch (err) { console.error('[updateService] não consegui ajustar a instalação automática:', err.message); }
  }
  const mudou = r.retida !== status.retida || r.ignoradaPorObrigatoria !== status.retencaoIgnoradaPorObrigatoria;
  status = {
    ...status,
    retida: r.retida,
    retencaoIgnoradaPorObrigatoria: r.ignoradaPorObrigatoria,
    retencaoVersao: r.retida ? controle.versao : null,
    retencaoMotivo: r.retida ? controle.motivo : null,
  };
  if (status.baixado) {
    if (r.retida) apagarMarcadorAtualizacao();
    else marcarAtualizacaoPendente(status.versaoDisponivel);
  }
  if (autoUpdaterPronto && !semRelato && (mudou || forcarRelato)) reportarProgressoNoFirestore().catch(() => {});
  return r;
}

function apagarMarcadorAtualizacao() {
  try { fs.unlinkSync(caminhoMarcadorAtualizacao()); } catch { /* não existia */ }
}

module.exports = {
  setupAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall, getStatus,
  verificarAtualizacaoObrigatoria, iniciarEscutaAtualizacaoObrigatoria, versaoMenorQue,
  reportarProgressoNoFirestore, aplicarOverrideDaInstalacao,
  aplicarControleDaInstalacao, decidirRetencao, reavaliarRetencao, lerControleAtualizacao, TODAS_AS_VERSOES,
  marcarAtualizacaoPendente, verificarAtualizacaoFoiAplicada, caminhoMarcadorAtualizacao,
};
