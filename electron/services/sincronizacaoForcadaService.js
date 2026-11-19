/**
 * "Forçar atualização dos dados" -- botão na Central.
 *
 * A Central grava `installations/{id}.sincronizacaoPedidaEm`. A escuta do
 * documento da instalação (licenseService.iniciarEscutaTempoReal) chama
 * aoMudarInstalacao(); quando o pedido é novo, esta máquina refaz a
 * sincronização do grupo (produtos, clientes, usuários e PINs) e reenvia o
 * histórico recente, e grava `sincronizacaoFeitaEm` para a Central mostrar
 * que terminou. Não apaga nada: só puxa e envia de novo.
 *
 * Pedido feito com o app fechado é atendido na próxima abertura: o pedido
 * vale enquanto for mais novo que a última resposta desta máquina
 * (`sincronizacaoFeitaEm`, gravada pela própria máquina).
 */

let ultimoPedidoAtendido = null;

/** Milissegundos de um Timestamp do Firestore (ou de uma data), ou null. */
function marcaParaMs(valor) {
  if (!valor) return null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (valor instanceof Date) return valor.getTime();
  const n = Date.parse(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide se um pedido ainda não atendido deve ser atendido agora.
 * feitaMs: última resposta gravada por esta máquina no documento;
 * ultimoAtendidoMs: pedido já começado nesta execução (não repete).
 * Pura -- testada em tests/sincronizacaoForcada.test.js.
 */
function pedidoNovo(pedidoMs, feitaMs, ultimoAtendidoMs) {
  if (!Number.isFinite(pedidoMs)) return false;
  if (Number.isFinite(ultimoAtendidoMs) && pedidoMs <= ultimoAtendidoMs) return false;
  if (Number.isFinite(feitaMs) && feitaMs >= pedidoMs) return false;
  return true;
}

async function forcar() {
  // Sem cota de escrita hoje (nuvemDisjuntorService): nada iria. O pedido
  // continua valendo e é atendido quando a cota voltar.
  if (!require('./nuvemDisjuntorService').podeEscrever()) {
    ultimoPedidoAtendido = null;
    return { ok: false, semCota: true };
  }
  const resultado = { usuarios: false, grupo: false, historico: false };
  try {
    const r = await require('./userSyncService').sincronizarTudo();
    resultado.usuarios = !!r?.ok;
  } catch (err) { console.error('[sincronizacaoForcada] usuários:', err?.message || err); }
  try {
    await require('./grupoReplicaService').iniciar();
    resultado.grupo = true;
  } catch (err) { console.error('[sincronizacaoForcada] grupo:', err?.message || err); }
  try {
    // Só o que ainda não foi (ou mudou depois de ir): a repassada completa
    // dos 60 dias já acontece uma vez por dia sozinha (pushPeriodico).
    resultado.historico = !!(await require('./salesSyncService').pushTodoOHistorico({ diasRecentes: 60, apenasPendentes: true }));
  } catch (err) { console.error('[sincronizacaoForcada] histórico:', err?.message || err); }

  const ok = Object.values(resultado).every(Boolean);
  try {
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const firestore = require('./licenseService').getLicenseFirestore();
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    await setDoc(doc(firestore, 'installations', installId), {
      sincronizacaoFeitaEm: serverTimestamp(), sincronizacaoFeitaOk: ok,
    }, { merge: true });
  } catch (err) {
    console.error('[sincronizacaoForcada] não foi possível avisar a Central:', err?.message || err);
  }
  return { ok, ...resultado };
}

/** Chamado a cada mudança do documento desta instalação. Nunca lança. */
function aoMudarInstalacao(dados) {
  try {
    const pedidoMs = marcaParaMs(dados?.sincronizacaoPedidaEm);
    if (!pedidoNovo(pedidoMs, marcaParaMs(dados?.sincronizacaoFeitaEm), ultimoPedidoAtendido)) return;
    ultimoPedidoAtendido = pedidoMs;
    forcar().catch((err) => console.error('[sincronizacaoForcada]', err?.message || err));
  } catch (err) {
    console.error('[sincronizacaoForcada] pedido ignorado:', err?.message || err);
  }
}

module.exports = { aoMudarInstalacao, forcar, pedidoNovo, marcaParaMs };
