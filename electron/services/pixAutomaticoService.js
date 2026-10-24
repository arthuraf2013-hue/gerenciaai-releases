const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Pix que se confirma sozinho. No caixa, em vez do QR "fixo" (chave da
 * loja, conferido no olho), gera uma cobrança no provedor (Mercado Pago,
 * provedoresPix/) e consulta até ela ser paga; aí lança o pagamento na
 * venda sozinho. O QR fixo continua existindo (Pix sem tarifa) -- este é
 * opcional e o provedor cobra por Pix recebido.
 *
 * Garantias:
 *  - o token do provedor fica cifrado (secretsService) e nunca vai pro
 *    renderer -- a tela só sabe "tem token, final 1a2b";
 *  - cada cobrança vira UM pagamento no máximo (pix_cobrancas.payment_id,
 *    gravado na mesma transação do pagamento). Confirmação manual, consulta
 *    da tela e consulta em segundo plano podem chegar juntas sem duplicar;
 *  - Pix pago depois que a venda fechou (cancelada, ou quitada por outro
 *    meio) não some: vira 'pago_sem_venda', vai pra Auditoria e aparece em
 *    Configurações → Pagamento para devolver ou lançar à mão;
 *  - gerar de novo na mesma venda cancela a cobrança anterior no provedor.
 */

const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];
const STATUS_FINAIS = ['pago', 'cancelado', 'expirado', 'falhou', 'estornado', 'pago_sem_venda', 'erro'];
const INTERVALO_MIN_CONSULTA_MS = 2500;
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let fabricaDeProvedor = (id) => {
  if (id === 'mercadopago') return require('./provedoresPix/mercadoPago').criarMercadoPago();
  throw new Error(`Provedor Pix desconhecido: ${id}`);
};
/** Só pra teste: troca o provedor por um falso (sem rede). */
function _definirProvedorParaTeste(fn) { fabricaDeProvedor = fn; }

function secrets() { return require('./secretsService'); }
function arred2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }

function getRow() {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM pix_automatico_config WHERE id = 'default'`).get();
  if (!row) {
    db.prepare(`INSERT INTO pix_automatico_config (id) VALUES ('default')`).run();
    row = db.prepare(`SELECT * FROM pix_automatico_config WHERE id = 'default'`).get();
  }
  return row;
}

function tokenGuardado() {
  const row = getRow();
  return row.token_enc ? secrets().decrypt(row.token_enc) : null;
}

/** O que a tela pode saber (nunca o token). */
function getConfig() {
  const row = getRow();
  const token = row.token_enc ? tokenGuardado() : null;
  return {
    ativo: row.ativo === 1,
    provedor: row.provedor,
    temToken: !!token,
    tokenFinal: token ? token.slice(-4) : null,
    emailPagador: row.email_pagador || '',
    validadeMin: Number(row.validade_min) || 30,
    tokenDeTeste: !!token && token.startsWith('TEST-'),
  };
}

function exigirGestao(userId) {
  const u = getDb().prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(userId);
  return !!u && PAPEIS_GESTAO.includes(u.role);
}

function saveConfig({ ativo, token, emailPagador, validadeMin, requestingUserId }) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode configurar o Pix automático.' };
  const atual = getRow();
  const novoToken = typeof token === 'string' && token.trim() ? token.trim() : null;
  if (novoToken && !/^(APP_USR|TEST)-[\w-]{20,}$/.test(novoToken)) {
    return { ok: false, error: 'Esse não parece um Access Token do Mercado Pago (começa com APP_USR- ou TEST-).' };
  }
  const email = String(emailPagador || '').trim().slice(0, 120);
  if (ativo && !EMAIL_VALIDO.test(email)) return { ok: false, error: 'Informe o e-mail usado como pagador (o Mercado Pago exige um).' };
  if (ativo && !novoToken && !atual.token_enc) return { ok: false, error: 'Cole o Access Token do Mercado Pago.' };
  const validade = Number(validadeMin);
  if (!Number.isInteger(validade) || validade < 30 || validade > 240) return { ok: false, error: 'Validade do Pix: de 30 a 240 minutos (o Mercado Pago exige pelo menos 30).' };

  getDb().prepare(
    `UPDATE pix_automatico_config SET ativo = ?, token_enc = COALESCE(?, token_enc), email_pagador = ?, validade_min = ?,
       atualizado_por_id = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`
  ).run(ativo ? 1 : 0, novoToken ? secrets().encrypt(novoToken) : null, email, validade, requestingUserId);
  require('./authService').registrarEventoAuditoria({
    tipoEvento: 'pix_automatico_alterado', solicitanteId: requestingUserId,
    motivo: `Pix automático ${ativo ? 'ligado' : 'desligado'}${novoToken ? ` · token novo final ${novoToken.slice(-4)}` : ''}`,
  });
  return { ok: true, config: getConfig() };
}

async function testarConexao({ token, requestingUserId } = {}) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode testar o Pix automático.' };
  const t = (typeof token === 'string' && token.trim()) || tokenGuardado();
  if (!t) return { ok: false, error: 'Cole o Access Token primeiro.' };
  try {
    const r = await fabricaDeProvedor(getRow().provedor).testar({ token: t });
    return { ok: true, conta: r.conta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Mesmo cálculo de saleService.addPayment: total com descontos e taxa de
 * serviço, menos o que já foi pago. */
function restanteDaVenda(db, saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { sale: null, restante: 0 };
  const jaPago = db.prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM payments WHERE sale_id = ?').get(saleId).t;
  const subtotal = sale.total - sale.desconto - sale.desconto_gerente;
  const taxa = sale.taxa_servico_percentual > 0 ? subtotal * (sale.taxa_servico_percentual / 100) : 0;
  return { sale, restante: arred2(subtotal + taxa - jaPago) };
}

function nomeDaLoja() {
  try { return require('./fiscalService').getNomeNegocio() || 'Loja'; } catch { return 'Loja'; }
}

function publico(row) {
  return {
    id: row.id, saleId: row.sale_id, valor: row.valor, status: row.status, expiraEm: row.expira_em,
    paymentId: row.payment_id || null, erro: row.erro || null,
  };
}

async function cancelarNoProvedor(row) {
  const token = tokenGuardado();
  if (!token || !row.provedor_id) return false;
  try {
    await fabricaDeProvedor(row.provedor).cancelar({ token, provedorId: row.provedor_id });
    return true;
  } catch {
    return false;
  }
}

async function criarCobranca({ saleId, valor, operadorId, agoraMs = Date.now() }) {
  const config = getConfig();
  if (!config.ativo) return { ok: false, error: 'Pix automático desligado.', usarQrFixo: true };
  const token = tokenGuardado();
  if (!token) return { ok: false, error: 'Pix automático sem token configurado.', usarQrFixo: true };
  const db = getDb();
  const { sale, restante } = restanteDaVenda(db, saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta.' };
  const v = arred2(Math.min(Number(valor), restante));
  if (!(v > 0)) return { ok: false, error: 'Nada a cobrar: a venda já está paga.' };

  // Cobrança anterior desta venda ainda aberta: cancela (senão o cliente
  // pode pagar o QR velho e o novo).
  const anteriores = db.prepare(`SELECT * FROM pix_cobrancas WHERE sale_id = ? AND status IN ('criando', 'pendente')`).all(saleId);
  for (const a of anteriores) {
    db.prepare(`UPDATE pix_cobrancas SET cancelamento_pedido = 1, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(a.id);
    if (await cancelarNoProvedor(a)) db.prepare(`UPDATE pix_cobrancas SET status = 'cancelado' WHERE id = ? AND payment_id IS NULL AND status = 'pendente'`).run(a.id);
  }

  const id = randomUUID();
  const expiraEmMs = agoraMs + config.validadeMin * 60000;
  db.prepare(
    `INSERT INTO pix_cobrancas (id, sale_id, provedor, valor, status, expira_em, criado_por_id) VALUES (?, ?, ?, ?, 'criando', ?, ?)`
  ).run(id, saleId, config.provedor, v, new Date(expiraEmMs).toISOString(), operadorId || null);
  try {
    const r = await fabricaDeProvedor(config.provedor).criar({
      token, valor: v, descricao: `${nomeDaLoja()} - venda`, referencia: id, idempotencia: id, expiraEmMs, emailPagador: config.emailPagador,
    });
    db.prepare(`UPDATE pix_cobrancas SET provedor_id = ?, copia_e_cola = ?, status = 'pendente', atualizado_em = NOW_SYNCED() WHERE id = ?`)
      .run(r.provedorId, r.copiaECola, id);
    const QRCode = require('qrcode');
    const qrDataUrl = await QRCode.toDataURL(r.copiaECola, { width: 260, margin: 1 });
    return { ok: true, cobranca: { ...publico(db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id)), copiaECola: r.copiaECola, qrDataUrl } };
  } catch (err) {
    db.prepare(`UPDATE pix_cobrancas SET status = 'erro', erro = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(String(err.message).slice(0, 300), id);
    return { ok: false, error: err.message, usarQrFixo: true };
  }
}

/**
 * Lança o Pix pago na venda -- uma vez só por cobrança. Venda que não
 * está mais aberta (ou já quitada) não recebe: a cobrança vira
 * 'pago_sem_venda' para alguém resolver.
 */
function registrarPago(id, { valorPago = null, manualPor = null, manual = !!manualPor } = {}) {
  const db = getDb();
  const saleService = require('./saleService');
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id);
    if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
    if (row.payment_id) return { ok: true, row, jaRegistrado: true };
    if (row.status === 'pago_sem_venda') return { ok: true, row, jaRegistrado: true };
    const { sale, restante } = restanteDaVenda(db, row.sale_id);
    const valor = arred2(Math.min(valorPago || row.valor, row.valor));
    if (!sale || sale.status !== 'aberta' || restante <= 0.005) {
      db.prepare(`UPDATE pix_cobrancas SET status = 'pago_sem_venda', atualizado_em = NOW_SYNCED() WHERE id = ?`).run(id);
      require('./authService').registrarEventoAuditoria({
        tipoEvento: 'pix_recebido_sem_venda', solicitanteId: row.criado_por_id,
        motivo: `Pix automático de R$ ${valor.toFixed(2).replace('.', ',')} pago depois que a venda ${sale ? (sale.status === 'aberta' ? 'já estava quitada' : `ficou ${sale.status}`) : 'sumiu'} (cobrança ${row.provedor_id || id})`,
      });
      return { ok: true, row: db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id), semVenda: true };
    }
    // Valor cheio: se a venda diminuiu depois do QR, o addPayment lança só o
    // que falta e guarda o recebido em detalhes.valorRecebido.
    const r = saleService.addPayment({
      saleId: row.sale_id, metodo: 'pix', valor,
      detalhes: { pixAutomatico: { provedor: row.provedor, cobranca: row.provedor_id }, ...(manual ? { confirmadoManualmentePor: manualPor || 'operador' } : {}) },
    });
    if (!r.ok) throw new Error(r.error);
    if (valor > restante + 0.005) {
      require('./authService').registrarEventoAuditoria({
        tipoEvento: 'pix_recebido_sem_venda', solicitanteId: row.criado_por_id,
        motivo: `Pix automático pagou R$ ${(valor - restante).toFixed(2).replace('.', ',')} a mais do que faltava na venda (a venda diminuiu depois do QR; cobrança ${row.provedor_id || id})`,
      });
    }
    if (manual) {
      require('./authService').registrarEventoAuditoria({
        tipoEvento: 'pix_confirmado_manual', solicitanteId: manualPor,
        motivo: `Pix automático de R$ ${valor.toFixed(2).replace('.', ',')} confirmado na mão antes do Mercado Pago (cobrança ${row.provedor_id || id})`,
      });
    }
    db.prepare(`UPDATE pix_cobrancas SET status = 'pago', payment_id = ?, confirmado_manual = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`)
      .run(r.id, manual ? 1 : 0, id);
    return { ok: true, row: db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id), pagamento: { id: r.id, valor: r.valor } };
  })();
}

/** Consulta o provedor (no máximo a cada 2,5 s por cobrança) e aplica. */
async function consultarCobranca({ id, agoraMs = Date.now() }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
  if (STATUS_FINAIS.includes(row.status) || row.status !== 'pendente') return { ok: true, cobranca: publico(row) };
  if (row.ultima_consulta_ms && agoraMs - row.ultima_consulta_ms < INTERVALO_MIN_CONSULTA_MS) return { ok: true, cobranca: publico(row) };
  db.prepare('UPDATE pix_cobrancas SET ultima_consulta_ms = ? WHERE id = ?').run(agoraMs, id);
  const token = tokenGuardado();
  if (!token) return { ok: true, cobranca: publico(row) };
  let r;
  try {
    r = await fabricaDeProvedor(row.provedor).consultar({ token, provedorId: row.provedor_id });
  } catch (err) {
    return { ok: true, cobranca: publico(row), avisoConsulta: err.message };
  }
  if (r.status === 'pago') {
    const reg = registrarPago(id, { valorPago: r.valorPago });
    if (!reg.ok) return reg;
    return { ok: true, cobranca: publico(reg.row), pagamento: reg.pagamento || null };
  }
  if (r.status !== 'pendente') {
    db.prepare(`UPDATE pix_cobrancas SET status = ?, atualizado_em = NOW_SYNCED() WHERE id = ? AND payment_id IS NULL`).run(r.status, id);
  }
  return { ok: true, cobranca: publico(db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id)) };
}

/** Operador conferiu no aplicativo do banco e confirma na mão (provedor
 * lento ou fora do ar). Se o provedor confirmar depois, não duplica. */
function confirmarManual({ id, operadorId }) {
  const row = getDb().prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
  if (row.status !== 'pendente' && !row.payment_id) return { ok: false, error: 'Esta cobrança não está mais aguardando pagamento.' };
  const reg = registrarPago(id, { manualPor: operadorId || null, manual: true });
  if (!reg.ok) return reg;
  return { ok: true, cobranca: publico(reg.row), pagamento: reg.pagamento || null };
}

/** Cancela no provedor. Se não conseguir, continua conferindo até vencer:
 * pago mesmo assim, entra na venda (se ainda aberta) ou vira 'pago_sem_venda'. */
async function cancelarCobranca({ id }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
  if (row.status !== 'pendente') return { ok: true, cobranca: publico(row) };
  db.prepare(`UPDATE pix_cobrancas SET cancelamento_pedido = 1, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(id);
  const cancelou = await cancelarNoProvedor(row);
  if (cancelou) db.prepare(`UPDATE pix_cobrancas SET status = 'cancelado' WHERE id = ? AND payment_id IS NULL AND status = 'pendente'`).run(id);
  return { ok: true, cancelado: cancelou, cobranca: publico(db.prepare('SELECT * FROM pix_cobrancas WHERE id = ?').get(id)) };
}

/** Segundo plano: confere as pendentes até 10 min depois de vencerem. */
async function reconciliar({ agoraMs = Date.now() } = {}) {
  const limite = new Date(agoraMs - 10 * 60000).toISOString();
  const pendentes = getDb().prepare(`SELECT id FROM pix_cobrancas WHERE status = 'pendente' AND expira_em > ? ORDER BY criado_em LIMIT 50`).all(limite);
  for (const { id } of pendentes) await consultarCobranca({ id, agoraMs }).catch(() => {});
  getDb().prepare(`UPDATE pix_cobrancas SET status = 'expirado', atualizado_em = NOW_SYNCED() WHERE status IN ('pendente', 'criando') AND expira_em <= ?`).run(limite);
}

function listarRecebidosSemVenda() {
  return getDb().prepare(
    `SELECT c.id, c.sale_id, c.valor, c.provedor_id, c.atualizado_em, s.status AS venda_status
     FROM pix_cobrancas c LEFT JOIN sales s ON s.id = c.sale_id WHERE c.status = 'pago_sem_venda' ORDER BY c.atualizado_em DESC LIMIT 50`
  ).all();
}

let intervalo = null;
function iniciarConferencia() {
  if (intervalo) clearInterval(intervalo);
  intervalo = setInterval(() => { if (getConfig().ativo) reconciliar().catch(() => {}); }, 20000);
}

module.exports = {
  getConfig, saveConfig, testarConexao, criarCobranca, consultarCobranca, confirmarManual, cancelarCobranca, reconciliar,
  listarRecebidosSemVenda, iniciarConferencia, registrarPago, _definirProvedorParaTeste,
};
