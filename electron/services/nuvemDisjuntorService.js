/**
 * Disjuntor da nuvem (Firestore do projeto gerenciaai-licencas).
 *
 * Por que existe (nov/2026): no plano gratuito do Firebase a cota de
 * ESCRITAS do dia acaba e o Firestore responde RESOURCE_EXHAUSTED ("Quota
 * exceeded") até a meia-noite do horário do Pacífico (05:00 de Brasília de
 * novembro a março, 04:00 no resto do ano). O SDK trata esse
 * erro como passageiro: tenta de novo para sempre e a promessa do setDoc
 * NUNCA termina. Resultado visto em produção: o ping parou em todas as
 * máquinas ao mesmo tempo, a Central mostrou todo mundo "offline", o
 * `npm test` não terminava, e cada escrita nova ficava presa na fila do SDK
 * para sair toda de uma vez quando a cota voltasse (queimando a cota nova).
 *
 * O que faz:
 *   - percebe a falta de cota pelo log do próprio SDK (onLog) ou por uma
 *     resposta 429 do ping REST (ver firestoreRestService);
 *   - enquanto a cota não volta, `podeEscrever()` responde false: quem
 *     publica de tempos em tempos (sinal de vida, status ao vivo, fila do
 *     grupo, vendas do grupo) pula a vez e deixa tudo na fila local, que já
 *     existe em cada serviço -- nada se perde, só espera;
 *   - uma sonda (o ping REST) testa a cada SONDA_MS se a cota voltou antes
 *     da hora (ex.: plano pago ligado no meio do dia);
 *   - conta as escritas por origem no dia, para a Central mostrar quem está
 *     gastando a cota (vai no ping).
 *
 * Estado só em memória, de propósito: ao reabrir o app, a primeira escrita
 * (o ping REST, que nunca fica presa) descobre de novo em segundos.
 */

const FUSO_DA_COTA = 'America/Los_Angeles';
const SONDA_MS = 10 * 60 * 1000;
const PRAZO_PADRAO_MS = 20 * 1000;

let escritaBloqueadaAte = 0;
let leituraBloqueadaAte = 0;
let ultimaFaltaEm = 0;
let ultimaSondaEm = 0;
let instalado = false;
let contagem = { dia: null, porOrigem: {} };

function ehErroDeCota(texto) {
  return /RESOURCE_EXHAUSTED|resource-exhausted|Quota exceeded/i.test(String(texto || ''));
}

/** Minutos de diferença do fuso para o UTC naquele instante (ex.: -480). */
function deslocamentoMin(fuso, ms) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: fuso, timeZoneName: 'longOffset' }).formatToParts(new Date(ms));
  const nome = (partes.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(nome);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

function diaNoFuso(fuso, ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { ano: Number(p.year), mes: Number(p.month), dia: Number(p.day) };
}

/** Próxima meia-noite do Pacífico (quando a cota do Firestore renova), em ms UTC. */
function proximoResetDaCota(agoraMs = Date.now()) {
  const { ano, mes, dia } = diaNoFuso(FUSO_DA_COTA, agoraMs);
  const meiaNoiteComoUtc = Date.UTC(ano, mes - 1, dia + 1, 0, 0, 0);
  // Duas passadas: a troca de horário de verão pode cair entre agora e a meia-noite.
  let alvo = meiaNoiteComoUtc - deslocamentoMin(FUSO_DA_COTA, meiaNoiteComoUtc) * 60000;
  alvo = meiaNoiteComoUtc - deslocamentoMin(FUSO_DA_COTA, alvo) * 60000;
  return alvo;
}

function chaveDoDia(agoraMs) {
  const { ano, mes, dia } = diaNoFuso(FUSO_DA_COTA, agoraMs);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** tipo: 'escrita' | 'leitura' */
function registrarFaltaDeCota({ tipo = 'escrita', agoraMs = Date.now() } = {}) {
  const ate = proximoResetDaCota(agoraMs);
  const jaSabia = tipo === 'leitura' ? leituraBloqueadaAte > agoraMs : escritaBloqueadaAte > agoraMs;
  if (tipo === 'leitura') leituraBloqueadaAte = Math.max(leituraBloqueadaAte, ate);
  else escritaBloqueadaAte = Math.max(escritaBloqueadaAte, ate);
  ultimaFaltaEm = agoraMs;
  ultimaSondaEm = agoraMs;
  if (!jaSabia) {
    console.warn(`[nuvem] cota de ${tipo} do Firebase esgotada -- publicações em pausa até ${new Date(ate).toISOString()} (tudo continua salvo neste computador e sobe depois)`);
  }
}

/** Uma escrita passou de verdade: a cota existe (plano pago, ou já renovou). */
function registrarEscritaOk() {
  if (escritaBloqueadaAte) console.warn('[nuvem] escrita voltou a passar -- publicações retomadas');
  escritaBloqueadaAte = 0;
}

function registrarLeituraOk() {
  leituraBloqueadaAte = 0;
}

/**
 * Pode gastar escrita agora? `origem` é só para a contagem do dia
 * (ex.: 'ping', 'statusAoVivo'); `quantidade` = escritas que vai fazer.
 */
function podeEscrever(origem = null, quantidade = 1, agoraMs = Date.now()) {
  if (escritaBloqueadaAte > agoraMs) return false;
  if (escritaBloqueadaAte) escritaBloqueadaAte = 0; // passou do horário de renovação
  if (origem) contar(origem, quantidade, agoraMs);
  return true;
}

function podeLer(agoraMs = Date.now()) {
  if (leituraBloqueadaAte > agoraMs) return false;
  if (leituraBloqueadaAte) leituraBloqueadaAte = 0;
  return true;
}

/** Com a escrita bloqueada: é hora de testar se a cota já voltou? (no máximo a cada SONDA_MS) */
function deveSondar(agoraMs = Date.now()) {
  if (escritaBloqueadaAte <= agoraMs) return false;
  if (agoraMs - ultimaSondaEm < SONDA_MS) return false;
  ultimaSondaEm = agoraMs;
  return true;
}

function contar(origem, quantidade, agoraMs = Date.now()) {
  const dia = chaveDoDia(agoraMs);
  if (contagem.dia !== dia) contagem = { dia, porOrigem: {} };
  const n = Number(quantidade);
  contagem.porOrigem[origem] = (contagem.porOrigem[origem] || 0) + (Number.isFinite(n) && n > 0 ? n : 1);
}

/** Escritas contadas hoje (dia da cota), por origem -- vai no ping para a Central. */
function escritasDeHoje(agoraMs = Date.now()) {
  if (contagem.dia !== chaveDoDia(agoraMs)) return {};
  return { ...contagem.porOrigem };
}

/**
 * Espera a promessa no máximo `ms`. Não cancela a operação do SDK (não há
 * como), só deixa quem chamou seguir a vida -- o erro tem code 'prazo-esgotado'.
 */
function comPrazo(promessa, ms = PRAZO_PADRAO_MS, rotulo = 'operação na nuvem') {
  let relogio = null;
  const prazo = new Promise((_, rejeitar) => {
    relogio = setTimeout(() => {
      const erro = new Error(`${rotulo}: sem resposta em ${Math.round(ms / 1000)} s`);
      erro.code = 'prazo-esgotado';
      rejeitar(erro);
    }, ms);
    relogio.unref?.();
  });
  return Promise.race([Promise.resolve(promessa), prazo]).finally(() => clearTimeout(relogio));
}

/**
 * Escuta o log do SDK do Firebase. Precisa rodar DEPOIS de carregar
 * firebase/firestore: o onLog só alcança os registradores que já existem.
 */
function instalarDeteccaoNoSdk() {
  if (instalado) return;
  try {
    require('firebase/firestore');
    const { onLog } = require('firebase/app');
    if (typeof onLog !== 'function') return;
    onLog((entrada) => {
      try {
        const texto = `${entrada?.message || ''}`;
        if (!ehErroDeCota(texto)) return;
        // "RPC 'Write' stream" e Commit são escrita; Listen/RunQuery/BatchGet são leitura.
        const tipo = /'(Write|Commit)'/.test(texto) || !/'(Listen|RunQuery|RunAggregationQuery|BatchGetDocuments)'/.test(texto)
          ? 'escrita' : 'leitura';
        registrarFaltaDeCota({ tipo });
      } catch { /* nunca atrapalha o log */ }
    });
    instalado = true;
  } catch (err) {
    console.error('[nuvem] não deu para escutar o log do Firebase:', err?.message || err);
  }
}

function status(agoraMs = Date.now()) {
  return {
    escritaPausada: escritaBloqueadaAte > agoraMs,
    escritaVoltaEm: escritaBloqueadaAte > agoraMs ? new Date(escritaBloqueadaAte).toISOString() : null,
    leituraPausada: leituraBloqueadaAte > agoraMs,
    ultimaFaltaDeCotaEm: ultimaFaltaEm ? new Date(ultimaFaltaEm).toISOString() : null,
    escritasHoje: escritasDeHoje(agoraMs),
  };
}

function _zerarParaTeste() {
  escritaBloqueadaAte = 0; leituraBloqueadaAte = 0; ultimaFaltaEm = 0; ultimaSondaEm = 0;
  contagem = { dia: null, porOrigem: {} };
}

module.exports = {
  ehErroDeCota, proximoResetDaCota, registrarFaltaDeCota, registrarEscritaOk, registrarLeituraOk,
  podeEscrever, podeLer, deveSondar, contar, escritasDeHoje, comPrazo, instalarDeteccaoNoSdk, status,
  SONDA_MS, _zerarParaTeste,
};
