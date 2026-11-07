const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * MAQUININHA INTEGRADA ao caixa (hoje: Mercado Pago Point,
 * provedoresMaquininha/). No pagamento, em vez de digitar o valor na
 * maquininha e lançar "cartão" à mão, o caixa manda a cobrança para ela; o
 * cliente passa o cartão (ou paga o Pix na tela dela) e o pagamento entra
 * sozinho na venda, com bandeira e autorização -- que vão para a NFC-e
 * (grupo card com tpIntegra=1 e o CNPJ da credenciadora).
 *
 * Mesmo desenho do Pix automático (pixAutomaticoService.js):
 *  - token só no processo principal, cifrado; pode reaproveitar o do Pix
 *    automático (mesma conta Mercado Pago);
 *  - uma cobrança = no máximo um pagamento (payment_id gravado na MESMA
 *    transação do pagamento); consulta da tela, segundo plano e repetição
 *    podem chegar juntas sem duplicar;
 *  - pago depois que a venda fechou (quitada por outro meio, cancelada) vira
 *    'pago_sem_venda' + Auditoria -- dinheiro nunca some;
 *  - nova cobrança na mesma venda cancela a anterior na maquininha;
 *  - operador vem da sessão.
 * A maquininha não integrada continua funcionando como sempre ("Cartão" no
 * caixa, valor digitado nela).
 */

const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];
const STATUS_FINAIS = ['pago', 'cancelado', 'expirado', 'falhou', 'estornado', 'pago_sem_venda', 'erro'];
const INTERVALO_MIN_CONSULTA_MS = 2500;
const VALIDADE_MS = 10 * 60000; // igual ao expiration_time da order (PT10M)
const METODO_POR_TIPO = { credito: 'cartao_credito', debito: 'cartao_debito', pix: 'pix' };

let fabricaDeProvedor = (id) => {
  if (id === 'mercadopago_point') return require('./provedoresMaquininha/mercadoPagoPoint').criarMercadoPagoPoint();
  throw new Error(`Maquininha desconhecida: ${id}`);
};
function _definirProvedorParaTeste(fn) { fabricaDeProvedor = fn; }

function secrets() { return require('./secretsService'); }
function arred2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }

function getRow() {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM maquininha_config WHERE id = 'default'`).get();
  if (!row) {
    db.prepare(`INSERT INTO maquininha_config (id) VALUES ('default')`).run();
    row = db.prepare(`SELECT * FROM maquininha_config WHERE id = 'default'`).get();
  }
  return row;
}

/** Token em uso: o próprio, ou o do Pix automático (mesma conta). */
function tokenEmUso(row = getRow()) {
  if (row.usar_token_pix === 1) {
    const pix = getDb().prepare(`SELECT token_enc FROM pix_automatico_config WHERE id = 'default'`).get();
    return pix?.token_enc ? secrets().decrypt(pix.token_enc) : null;
  }
  return row.token_enc ? secrets().decrypt(row.token_enc) : null;
}

/** O que a tela pode saber (nunca o token). */
function getConfig() {
  const row = getRow();
  const token = tokenEmUso(row);
  return {
    ativa: row.ativa === 1,
    provedor: row.provedor,
    usarTokenPix: row.usar_token_pix === 1,
    temToken: !!token,
    tokenFinal: token ? token.slice(-4) : null,
    tokenDeTeste: !!token && token.startsWith('TEST-'),
    terminalId: row.terminal_id || '',
    imprimirNoTerminal: row.imprimir_no_terminal === 1,
    pronta: row.ativa === 1 && !!token && !!row.terminal_id,
  };
}

function exigirGestao(userId) {
  const u = getDb().prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(userId);
  return !!u && PAPEIS_GESTAO.includes(u.role);
}

function saveConfig({ ativa, usarTokenPix, token, terminalId, imprimirNoTerminal, requestingUserId }) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode configurar a maquininha.' };
  const atual = getRow();
  const novoToken = typeof token === 'string' && token.trim() ? token.trim() : null;
  if (novoToken && !/^(APP_USR|TEST)-[\w-]{20,}$/.test(novoToken)) {
    return { ok: false, error: 'Esse não parece um Access Token do Mercado Pago (começa com APP_USR- ou TEST-).' };
  }
  const usarPix = usarTokenPix !== undefined ? !!usarTokenPix : atual.usar_token_pix === 1;
  const terminal = terminalId !== undefined ? String(terminalId || '').trim().slice(0, 80) : (atual.terminal_id || '');
  const ligar = ativa !== undefined ? !!ativa : atual.ativa === 1;
  if (terminal && !/^[A-Za-z0-9_-]{6,80}$/.test(terminal)) return { ok: false, error: 'Código da maquininha inválido (escolha na lista).' };
  getDb().prepare(
    `UPDATE maquininha_config SET ativa = ?, usar_token_pix = ?, token_enc = COALESCE(?, token_enc), terminal_id = ?, imprimir_no_terminal = ?,
       atualizado_por_id = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`
  ).run(ligar ? 1 : 0, usarPix ? 1 : 0, novoToken ? secrets().encrypt(novoToken) : null, terminal || null,
    (imprimirNoTerminal !== undefined ? !!imprimirNoTerminal : atual.imprimir_no_terminal === 1) ? 1 : 0, requestingUserId);
  const cfg = getConfig();
  if (ligar && (!cfg.temToken || !cfg.terminalId)) {
    getDb().prepare(`UPDATE maquininha_config SET ativa = 0 WHERE id = 'default'`).run();
    return { ok: false, error: !cfg.temToken ? 'Cole o Access Token do Mercado Pago (ou use o do Pix automático).' : 'Escolha a maquininha na lista.' };
  }
  require('./authService').registrarEventoAuditoria({
    tipoEvento: 'maquininha_alterada', solicitanteId: requestingUserId,
    motivo: `Maquininha integrada ${ligar ? 'ligada' : 'desligada'}${terminal ? ` · ${terminal}` : ''}${novoToken ? ` · token novo final ${novoToken.slice(-4)}` : ''}`,
  });
  return { ok: true, config: getConfig() };
}

/** Maquininhas da conta (para escolher na configuração). */
async function listarTerminais({ token, requestingUserId } = {}) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode configurar a maquininha.' };
  const t = (typeof token === 'string' && token.trim()) || tokenEmUso();
  if (!t) return { ok: false, error: 'Cole o Access Token do Mercado Pago primeiro.' };
  try {
    const provedor = fabricaDeProvedor(getRow().provedor);
    const [conta, terminais] = await Promise.all([provedor.testar({ token: t }), provedor.listarTerminais({ token: t })]);
    return { ok: true, conta: conta.conta, terminais };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Coloca a maquininha no modo integrado (PDV). */
async function ativarModoPdv({ terminalId, requestingUserId }) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode configurar a maquininha.' };
  const token = tokenEmUso();
  if (!token) return { ok: false, error: 'Configure o token primeiro.' };
  try {
    const r = await fabricaDeProvedor(getRow().provedor).ativarModoPdv({ token, terminalId });
    return { ok: true, modo: r.modo, aviso: 'Reinicie a maquininha para ela entrar no modo integrado.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Mesmo cálculo do saleService.addPayment (descontos e taxa de serviço). */
function restanteDaVenda(db, saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { sale: null, restante: 0 };
  const jaPago = db.prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM payments WHERE sale_id = ?').get(saleId).t;
  const subtotal = sale.total - sale.desconto - sale.desconto_gerente;
  const taxa = sale.taxa_servico_percentual > 0 ? subtotal * (sale.taxa_servico_percentual / 100) : 0;
  return { sale, restante: arred2(subtotal + taxa - jaPago) };
}

function publico(row) {
  let detalhes = {};
  try { detalhes = JSON.parse(row.detalhes_json || '{}'); } catch { detalhes = {}; }
  return {
    id: row.id, saleId: row.sale_id, valor: row.valor, tipo: row.tipo, parcelas: row.parcelas, status: row.status,
    expiraEm: row.expira_em, paymentId: row.payment_id || null, erro: row.erro || null,
    bandeira: detalhes.bandeira || null, ultimos4: detalhes.ultimos4 || null, naMaquininha: !!detalhes.naMaquininha,
    cancelamentoPedido: row.cancelamento_pedido === 1,
  };
}

function nomeDaLoja() {
  try { return require('./fiscalService').getNomeNegocio() || 'Loja'; } catch { return 'Loja'; }
}

async function cancelarNoProvedor(row, { naMaquininha = false } = {}) {
  const token = tokenEmUso();
  if (!token || !row.provedor_id) return { confirmado: false };
  try {
    return await fabricaDeProvedor(row.provedor).cancelar({ token, provedorId: row.provedor_id, naMaquininha });
  } catch (err) {
    return { confirmado: false, erro: err.message };
  }
}

async function criarCobranca({ saleId, valor, tipo, parcelas = 1, operadorId, agoraMs = Date.now() }) {
  const config = getConfig();
  if (!config.pronta) return { ok: false, error: 'Maquininha integrada não configurada (Configurações → Pagamento).' };
  if (!METODO_POR_TIPO[tipo]) return { ok: false, error: 'Escolha crédito, débito ou Pix.' };
  const n = Math.floor(Number(parcelas) || 1);
  if (tipo === 'credito' && (n < 1 || n > 12)) return { ok: false, error: 'Parcelas: de 1 a 12.' };
  const db = getDb();
  const { sale, restante } = restanteDaVenda(db, saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta.' };
  const v = arred2(Math.min(Number(valor), restante));
  if (!(v > 0)) return { ok: false, error: 'Nada a cobrar: a venda já está paga.' };
  if (v < 1) return { ok: false, error: 'A maquininha cobra a partir de R$ 1,00.' };

  // Cobrança anterior desta venda ainda aberta: cancela (senão o cliente
  // pagaria duas vezes). A que já está na tela da maquininha precisa ser
  // cancelada lá.
  const anteriores = db.prepare(`SELECT * FROM maquininha_cobrancas WHERE sale_id = ? AND status IN ('criando', 'pendente')`).all(saleId);
  for (const a of anteriores) {
    db.prepare(`UPDATE maquininha_cobrancas SET cancelamento_pedido = 1, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(a.id);
    const r = await cancelarNoProvedor(a, { naMaquininha: true });
    if (r.confirmado) db.prepare(`UPDATE maquininha_cobrancas SET status = 'cancelado' WHERE id = ? AND payment_id IS NULL AND status = 'pendente'`).run(a.id);
  }

  const id = randomUUID();
  const row = getRow();
  db.prepare(
    `INSERT INTO maquininha_cobrancas (id, sale_id, provedor, terminal_id, valor, tipo, parcelas, status, expira_em, criado_por_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'criando', ?, ?)`
  ).run(id, saleId, row.provedor, row.terminal_id, v, tipo, tipo === 'credito' ? n : 1, new Date(agoraMs + VALIDADE_MS).toISOString(), operadorId || null);
  try {
    const r = await fabricaDeProvedor(row.provedor).criar({
      token: tokenEmUso(row), terminalId: row.terminal_id, valor: v, tipo, parcelas: n, referencia: id.replace(/-/g, ''), idempotencia: id,
      imprimirNoTerminal: row.imprimir_no_terminal === 1, descricao: `${nomeDaLoja()} - venda`,
    });
    db.prepare(`UPDATE maquininha_cobrancas SET provedor_id = ?, provedor_pagamento_id = ?, status = 'pendente', atualizado_em = NOW_SYNCED() WHERE id = ?`)
      .run(r.provedorId, r.pagamentoId, id);
    return { ok: true, cobranca: publico(db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id)) };
  } catch (err) {
    db.prepare(`UPDATE maquininha_cobrancas SET status = 'erro', erro = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(String(err.message).slice(0, 300), id);
    return { ok: false, error: err.message };
  }
}

/** Lança o pagamento aprovado na venda -- uma vez só por cobrança. */
function registrarPago(id, info = {}) {
  const db = getDb();
  const saleService = require('./saleService');
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id);
    if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
    if (row.payment_id || row.status === 'pago_sem_venda') return { ok: true, row, jaRegistrado: true };
    const detalhesCobranca = {
      bandeira: info.bandeira || null, ultimos4: info.ultimos4 || null, autorizacao: info.autorizacao || null,
      pagamentoId: info.pagamentoId || row.provedor_pagamento_id || null, parcelas: info.parcelas || row.parcelas,
    };
    const { sale, restante } = restanteDaVenda(db, row.sale_id);
    const valor = arred2(Math.min(Number(info.valorPago) || row.valor, row.valor));
    if (!sale || sale.status !== 'aberta' || restante <= 0.005) {
      db.prepare(`UPDATE maquininha_cobrancas SET status = 'pago_sem_venda', detalhes_json = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`)
        .run(JSON.stringify(detalhesCobranca), id);
      require('./authService').registrarEventoAuditoria({
        tipoEvento: 'maquininha_paga_sem_venda', solicitanteId: row.criado_por_id,
        motivo: `Maquininha aprovou R$ ${valor.toFixed(2).replace('.', ',')} depois que a venda ${sale ? (sale.status === 'aberta' ? 'já estava quitada' : `ficou ${sale.status}`) : 'sumiu'} (pedido ${row.provedor_id || id}). Estorne pelo Mercado Pago ou lance à mão.`,
      });
      return { ok: true, row: db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id), semVenda: true };
    }
    const r = saleService.addPayment({
      saleId: row.sale_id, metodo: METODO_POR_TIPO[row.tipo], valor,
      detalhes: { maquininha: { provedor: row.provedor, pedido: row.provedor_id, terminal: row.terminal_id, ...detalhesCobranca } },
    });
    if (!r.ok) throw new Error(r.error);
    db.prepare(`UPDATE maquininha_cobrancas SET status = 'pago', payment_id = ?, detalhes_json = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`)
      .run(r.id, JSON.stringify(detalhesCobranca), id);
    return { ok: true, row: db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id), pagamento: { id: r.id, valor: r.valor } };
  })();
}

/** Consulta o provedor (no máximo a cada 2,5 s por cobrança) e aplica. */
async function consultarCobranca({ id, agoraMs = Date.now() }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
  if (row.status !== 'pendente') return { ok: true, cobranca: publico(row) };
  if (row.ultima_consulta_ms && agoraMs - row.ultima_consulta_ms < INTERVALO_MIN_CONSULTA_MS) return { ok: true, cobranca: publico(row) };
  db.prepare('UPDATE maquininha_cobrancas SET ultima_consulta_ms = ? WHERE id = ?').run(agoraMs, id);
  const token = tokenEmUso();
  if (!token) return { ok: true, cobranca: publico(row) };
  let r;
  try {
    r = await fabricaDeProvedor(row.provedor).consultar({ token, provedorId: row.provedor_id });
  } catch (err) {
    return { ok: true, cobranca: publico(row), avisoConsulta: err.message };
  }
  if (r.status === 'pago') {
    const reg = registrarPago(id, r);
    if (!reg.ok) return reg;
    return { ok: true, cobranca: publico(reg.row), pagamento: reg.pagamento || null, semVenda: !!reg.semVenda };
  }
  if (r.status !== 'pendente') {
    db.prepare(`UPDATE maquininha_cobrancas SET status = ?, erro = ?, atualizado_em = NOW_SYNCED() WHERE id = ? AND payment_id IS NULL`)
      .run(r.status, r.status === 'falhou' ? (r.statusDetalhe || 'recusado') : null, id);
  } else if (r.naMaquininha) {
    let d = {};
    try { d = JSON.parse(row.detalhes_json || '{}'); } catch { d = {}; }
    if (!d.naMaquininha) db.prepare('UPDATE maquininha_cobrancas SET detalhes_json = ? WHERE id = ?').run(JSON.stringify({ ...d, naMaquininha: true }), id);
  }
  return { ok: true, cobranca: publico(db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id)) };
}

/** Cancela antes do cliente pagar. Se o Mercado Pago só aceitar o pedido
 * (já na tela da maquininha), continua conferindo: pago mesmo assim, entra
 * na venda (se ainda aberta) ou vira 'pago_sem_venda'. */
async function cancelarCobranca({ id }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Cobrança não encontrada.' };
  if (row.status !== 'pendente') return { ok: true, cobranca: publico(row) };
  db.prepare(`UPDATE maquininha_cobrancas SET cancelamento_pedido = 1, atualizado_em = NOW_SYNCED() WHERE id = ?`).run(id);
  const r = await cancelarNoProvedor(row, { naMaquininha: true });
  if (r.confirmado) db.prepare(`UPDATE maquininha_cobrancas SET status = 'cancelado' WHERE id = ? AND payment_id IS NULL AND status = 'pendente'`).run(id);
  return {
    ok: true, cancelado: !!r.confirmado,
    aviso: r.confirmado ? null : (r.erro || 'Cancelamento pedido à maquininha. Se o cliente já estiver pagando, cancele na própria maquininha.'),
    cobranca: publico(db.prepare('SELECT * FROM maquininha_cobrancas WHERE id = ?').get(id)),
  };
}

/** Segundo plano: confere as pendentes até 10 min depois de vencerem. */
async function reconciliar({ agoraMs = Date.now() } = {}) {
  const limite = new Date(agoraMs - 10 * 60000).toISOString();
  const pendentes = getDb().prepare(`SELECT id FROM maquininha_cobrancas WHERE status = 'pendente' AND expira_em > ? ORDER BY criado_em LIMIT 50`).all(limite);
  for (const { id } of pendentes) await consultarCobranca({ id, agoraMs }).catch(() => {});
  getDb().prepare(`UPDATE maquininha_cobrancas SET status = 'expirado', atualizado_em = NOW_SYNCED() WHERE status IN ('pendente', 'criando') AND expira_em <= ?`).run(limite);
}

function listarPagasSemVenda() {
  return getDb().prepare(
    `SELECT c.id, c.sale_id, c.valor, c.tipo, c.provedor_id, c.atualizado_em, s.status AS venda_status
     FROM maquininha_cobrancas c LEFT JOIN sales s ON s.id = c.sale_id WHERE c.status = 'pago_sem_venda' ORDER BY c.atualizado_em DESC LIMIT 50`
  ).all();
}

let intervalo = null;
function iniciarConferencia() {
  if (intervalo) clearInterval(intervalo);
  intervalo = setInterval(() => { if (getConfig().ativa) reconciliar().catch(() => {}); }, 15000);
}

module.exports = {
  getConfig, saveConfig, listarTerminais, ativarModoPdv, criarCobranca, consultarCobranca, cancelarCobranca, reconciliar,
  registrarPago, listarPagasSemVenda, iniciarConferencia, _definirProvedorParaTeste, METODO_POR_TIPO,
};
