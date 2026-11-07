const crypto = require('crypto');
const { getDb } = require('../db/database');

/**
 * SENHAS e PAINEL DE CHAMADA (TV / digital signage).
 *
 * De onde vem uma senha:
 *  - venda do balcão, quando "senha no balcão" está ligado (lanchonete:
 *    paga, leva a senha, espera chamar) -- ver criarParaVenda;
 *  - pedido de retirada / "comer aqui" ACEITO na Separação (vitrine pelo QR,
 *    WhatsApp, digitado) -- ver criarParaPedido;
 *  - "Nova senha" à mão na tela Chamada.
 * Numeração por dia LOCAL (timeService.hojeLocalISO): 1, 2, 3... recomeça
 * amanhã. Índices únicos impedem senha repetida no dia e duas senhas para a
 * mesma venda/pedido.
 *
 * Estados: preparando → pronto (CHAMA no painel) → entregue (sai do painel).
 * "Chamar de novo" repete o aviso na TV. Pedido da Separação acompanha o
 * pedido: marcar pronto/entregue aqui muda o pedido e vice-versa.
 *
 * Painel: o computador publica `paineis_chamada/{token}` (Firestore) só
 * quando muda; a página pwa-mobile/painel.html?p=<token> fica aberta na
 * TV/signage, desenha e toca o aviso. O token é segredo (32 caracteres): a
 * URL é o acesso. "Gerar novo link" invalida o anterior. O documento leva só
 * número, primeiro nome e o modelo visual -- nunca valor, telefone ou item.
 *
 * Modelo visual (modelo_json): cores, títulos, mensagem, logo em texto,
 * voz -- editável em Configurações → Painel de chamada. O layout em si mora
 * em pwa-mobile/painel.css (variáveis CSS), pensado para ser ajustado.
 */

const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];
const LIMITE_PRONTOS_NO_PAINEL = 8;
const LIMITE_PREPARANDO_NO_PAINEL = 24;

const MODELO_PADRAO = Object.freeze({
  layout: 'duas_colunas', // 'duas_colunas' (preparando + prontos) | 'so_prontos'
  titulo: '',             // vazio = nome da loja
  tituloPreparando: 'Preparando',
  tituloProntos: 'Prontos',
  tituloChamada: 'Pedido pronto',
  mensagemChamada: 'Retire no balcão',
  mensagem: 'Acompanhe sua senha aqui.',
  mostrarNome: true,
  // Mesma identidade do Vértice (digital signage da Vetta): azul-marinho e dourado.
  corFundo: '#141a26',
  corTexto: '#f5f1e8',
  corDestaque: '#d9a441',
  corPreparando: '#94a3b8',
  falarSenha: true,
  som: true,
  tema: 'escuro',
});

function hojeLocal() {
  return require('./timeService').hojeLocalISO();
}

function getRow() {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM chamada_config WHERE id = 'default'`).get();
  if (!row) {
    db.prepare(`INSERT INTO chamada_config (id) VALUES ('default')`).run();
    row = db.prepare(`SELECT * FROM chamada_config WHERE id = 'default'`).get();
  }
  return row;
}

const COR = /^#[0-9a-fA-F]{6}$/;
function limparTexto(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Modelo salvo, completado com o padrão e com tipos conferidos. */
function normalizarModelo(bruto) {
  const m = { ...MODELO_PADRAO };
  const e = bruto && typeof bruto === 'object' ? bruto : {};
  if (['duas_colunas', 'so_prontos'].includes(e.layout)) m.layout = e.layout;
  if (['escuro', 'claro'].includes(e.tema)) m.tema = e.tema;
  for (const k of ['titulo', 'tituloPreparando', 'tituloProntos', 'tituloChamada', 'mensagemChamada']) if (typeof e[k] === 'string') m[k] = limparTexto(e[k], 40);
  if (typeof e.mensagem === 'string') m.mensagem = limparTexto(e.mensagem, 140);
  for (const k of ['corFundo', 'corTexto', 'corDestaque', 'corPreparando']) if (COR.test(String(e[k] || ''))) m[k] = String(e[k]).toLowerCase();
  for (const k of ['mostrarNome', 'falarSenha', 'som']) if (typeof e[k] === 'boolean') m[k] = e[k];
  return m;
}

function lerModelo(row) {
  try { return normalizarModelo(JSON.parse(row.modelo_json || '{}')); } catch { return normalizarModelo({}); }
}

function linkDoPainel(token) {
  return token ? `https://gerenciaai-garcom.web.app/painel.html?p=${encodeURIComponent(token)}` : null;
}

function getConfig() {
  const r = getRow();
  return {
    ativa: r.ativa === 1,
    senhaNoBalcao: r.senha_no_balcao === 1,
    minutosNoPainel: Number(r.minutos_no_painel) || 15,
    modelo: lerModelo(r),
    link: r.ativa === 1 ? linkDoPainel(r.painel_token) : null,
  };
}

async function getConfigComQr() {
  const config = getConfig();
  let qrDataUrl = null;
  if (config.link) {
    try { qrDataUrl = await require('qrcode').toDataURL(config.link, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { qrDataUrl = null; }
  }
  return { ...config, qrDataUrl, modeloPadrao: { ...MODELO_PADRAO } };
}

function exigirGestao(userId) {
  const u = getDb().prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(userId);
  return !!u && PAPEIS_GESTAO.includes(u.role);
}

function novoToken() {
  return crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, '0');
}

function saveConfig({ ativa, senhaNoBalcao, minutosNoPainel, modelo, requestingUserId }) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode configurar o painel de chamada.' };
  const atual = getRow();
  const minutos = minutosNoPainel !== undefined ? Number(minutosNoPainel) : Number(atual.minutos_no_painel) || 15;
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > 240) return { ok: false, error: 'Tempo da senha pronta no painel: de 1 a 240 minutos.' };
  const ligar = ativa !== undefined ? !!ativa : atual.ativa === 1;
  const token = atual.painel_token || (ligar ? novoToken() : null);
  getDb().prepare(
    `UPDATE chamada_config SET ativa = ?, senha_no_balcao = ?, minutos_no_painel = ?, modelo_json = ?, painel_token = ?,
       ultimo_hash = NULL, atualizado_por_id = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`
  ).run(
    ligar ? 1 : 0,
    (senhaNoBalcao !== undefined ? !!senhaNoBalcao : atual.senha_no_balcao === 1) ? 1 : 0,
    minutos,
    JSON.stringify(modelo !== undefined ? normalizarModelo(modelo) : lerModelo(atual)),
    token,
    requestingUserId,
  );
  require('./authService').registrarEventoAuditoria({
    tipoEvento: 'painel_chamada_alterado', solicitanteId: requestingUserId,
    motivo: ligar ? 'Painel de chamada ligado/ajustado' : 'Painel de chamada desligado',
  });
  if (!ligar && atual.ativa === 1 && token) apagarPainelPublicado(token).catch(() => {});
  else publicarSeMudou().catch(() => {});
  return { ok: true, config: getConfig() };
}

/** Troca o link do painel (o antigo para de funcionar). */
async function gerarNovoLink({ requestingUserId }) {
  if (!exigirGestao(requestingUserId)) return { ok: false, error: 'Apenas um gerente ou administrador pode trocar o link do painel.' };
  const antigo = getRow().painel_token;
  getDb().prepare(`UPDATE chamada_config SET painel_token = ?, ultimo_hash = NULL WHERE id = 'default'`).run(novoToken());
  if (antigo) apagarPainelPublicado(antigo).catch(() => {});
  require('./authService').registrarEventoAuditoria({ tipoEvento: 'painel_chamada_alterado', solicitanteId: requestingUserId, motivo: 'Link do painel de chamada trocado' });
  publicarSeMudou().catch(() => {});
  return { ok: true, config: await getConfigComQr() };
}

// ---------- senhas ----------

function proximoNumero(db, dataLocal) {
  return db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM chamadas WHERE data_local = ?').get(dataLocal).n;
}

function primeiroNome(nome) {
  return limparTexto(nome, 60).split(' ')[0]?.slice(0, 20) || null;
}

/** Cria a senha (transação curta; repete se dois caixas pegarem o mesmo número). */
function criar({ origem, saleId = null, botOrderId = null, nome = null, operadorId = null }) {
  const db = getDb();
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      return db.transaction(() => {
        const ja = saleId
          ? db.prepare(`SELECT * FROM chamadas WHERE sale_id = ?`).get(saleId)
          : (botOrderId ? db.prepare(`SELECT * FROM chamadas WHERE bot_order_id = ?`).get(botOrderId) : null);
        if (ja) return { ok: true, chamada: publica(ja), jaExistia: true };
        const dataLocal = hojeLocal();
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO chamadas (id, data_local, numero, nome, origem, sale_id, bot_order_id, criado_por_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, dataLocal, proximoNumero(db, dataLocal), limparTexto(nome, 60) || null, origem, saleId, botOrderId, operadorId);
        return { ok: true, chamada: publica(db.prepare('SELECT * FROM chamadas WHERE id = ?').get(id)) };
      })();
    } catch (err) {
      if (!/UNIQUE/.test(String(err?.message))) throw err;
    }
  }
  return { ok: false, error: 'Não consegui gerar a senha, tente de novo.' };
}

function publica(r) {
  if (!r) return null;
  return {
    id: r.id, numero: r.numero, nome: r.nome, origem: r.origem, status: r.status, saleId: r.sale_id, botOrderId: r.bot_order_id,
    vezesChamada: r.vezes_chamada, criadoEm: r.criado_em, prontoEm: r.pronto_em, chamadoEm: r.chamado_em, dataLocal: r.data_local,
  };
}

/** Senha da venda do balcão (só com "senha no balcão" ligado). */
function criarParaVenda({ saleId, nome, operadorId }) {
  const config = getConfig();
  if (!config.ativa || !config.senhaNoBalcao) return { ok: false, error: 'Senha no balcão desligada.', desligada: true };
  const sale = getDb().prepare('SELECT s.id, s.status, c.nome AS cliente FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  // Venda de mesa não leva senha (a comanda já é da mesa).
  if (getDb().prepare('SELECT 1 FROM sale_mesas WHERE sale_id = ? LIMIT 1').get(saleId)) return { ok: false, error: 'Venda de mesa não usa senha.', ignorada: true };
  const r = criar({ origem: 'balcao', saleId, nome: primeiroNome(nome || sale.cliente), operadorId });
  if (r.ok && !r.jaExistia) publicarSeMudou().catch(() => {});
  return r;
}

/** Senha do pedido aceito na Separação (retirada / comer aqui). */
function criarParaPedido({ botOrderId, operadorId }) {
  const config = getConfig();
  if (!config.ativa) return { ok: false, error: 'Painel de chamada desligado.', desligada: true };
  const pedido = getDb().prepare('SELECT id, cliente_nome, mesa_numero, tipo_entrega, status FROM bot_orders WHERE id = ?').get(botOrderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  if (pedido.mesa_numero || pedido.tipo_entrega === 'entrega') return { ok: false, error: 'Pedido de mesa ou entrega não usa senha.', ignorada: true };
  if (['cancelado', 'concluido'].includes(pedido.status)) return { ok: false, error: 'Pedido já encerrado.' };
  const r = criar({ origem: 'pedido', botOrderId, nome: primeiroNome(pedido.cliente_nome), operadorId });
  if (r.ok && !r.jaExistia) publicarSeMudou().catch(() => {});
  return r;
}

/**
 * Depois de finalizar uma venda do balcão (handler sale:finalize): com
 * "senha no balcão" ligado, gera a senha (sai no topo do recibo) e manda os
 * itens da cozinha para a impressora dela. Nunca derruba a finalização.
 */
function aposFinalizarVenda({ saleId, nome, operadorId }) {
  try {
    const config = getConfig();
    if (!config.ativa || !config.senhaNoBalcao) return null;
    const r = criarParaVenda({ saleId, nome, operadorId });
    if (!r.ok) return null;
    try {
      const cozinha = require('./cozinhaService');
      if (cozinha.getConfig().ativa) {
        Promise.resolve(cozinha.imprimirItensDaVenda({ saleId })).then((x) => {
          if (x && !x.ok && x.falhou) console.error('[chamada] cozinha:', x.error);
        }).catch((err) => console.error('[chamada] cozinha:', err?.message || err));
      }
    } catch (err) { console.error('[chamada] cozinha:', err?.message || err); }
    return r.chamada;
  } catch (err) {
    console.error('[chamada] senha da venda', saleId, err?.message || err);
    return null;
  }
}

function criarManual({ nome, operadorId }) {
  if (!getConfig().ativa) return { ok: false, error: 'Ligue o painel de chamada em Configurações.' };
  const r = criar({ origem: 'manual', nome: primeiroNome(nome), operadorId });
  if (r.ok) publicarSeMudou().catch(() => {});
  return r;
}

function getPorId(id) {
  return getDb().prepare('SELECT * FROM chamadas WHERE id = ?').get(id);
}

/** Pronto = CHAMA no painel. Chamar de novo repete o aviso. */
function chamar({ id, operadorId, sincronizarPedido = true }) {
  const db = getDb();
  const c = getPorId(id);
  if (!c) return { ok: false, error: 'Senha não encontrada.' };
  if (['entregue', 'cancelada'].includes(c.status)) return { ok: false, error: `A senha ${c.numero} já foi ${c.status === 'entregue' ? 'entregue' : 'cancelada'}.` };
  db.prepare(
    `UPDATE chamadas SET status = 'pronto', pronto_em = COALESCE(pronto_em, NOW_SYNCED()), chamado_em = NOW_SYNCED(),
       vezes_chamada = vezes_chamada + 1 WHERE id = ?`
  ).run(id);
  if (sincronizarPedido && c.bot_order_id) {
    const pedido = db.prepare('SELECT status FROM bot_orders WHERE id = ?').get(c.bot_order_id);
    if (pedido && ['novo', 'em_separacao'].includes(pedido.status)) {
      require('./botOrderService').updateOrderStatus({ orderId: c.bot_order_id, status: 'pronto', operadorId, origemChamada: true });
    }
  }
  publicarSeMudou().catch(() => {});
  return { ok: true, chamada: publica(getPorId(id)) };
}

function entregar({ id, operadorId, sincronizarPedido = true }) {
  const db = getDb();
  const c = getPorId(id);
  if (!c) return { ok: false, error: 'Senha não encontrada.' };
  if (c.status === 'cancelada') return { ok: false, error: 'Senha cancelada.' };
  db.prepare(`UPDATE chamadas SET status = 'entregue', entregue_em = COALESCE(entregue_em, NOW_SYNCED()) WHERE id = ?`).run(id);
  if (sincronizarPedido && c.bot_order_id) {
    const pedido = db.prepare('SELECT status FROM bot_orders WHERE id = ?').get(c.bot_order_id);
    if (pedido && ['novo', 'em_separacao', 'pronto'].includes(pedido.status)) {
      const r = require('./botOrderService').updateOrderStatus({ orderId: c.bot_order_id, status: 'concluido', operadorId, origemChamada: true });
      if (!r.ok) return r;
    }
  }
  publicarSeMudou().catch(() => {});
  return { ok: true, chamada: publica(getPorId(id)) };
}

/** Volta uma senha chamada por engano para "preparando". */
function voltarParaPreparo({ id }) {
  const c = getPorId(id);
  if (!c) return { ok: false, error: 'Senha não encontrada.' };
  if (c.status !== 'pronto') return { ok: false, error: 'Só senha chamada volta para o preparo.' };
  getDb().prepare(`UPDATE chamadas SET status = 'preparando', pronto_em = NULL WHERE id = ?`).run(id);
  publicarSeMudou().catch(() => {});
  return { ok: true, chamada: publica(getPorId(id)) };
}

function cancelar({ id }) {
  const c = getPorId(id);
  if (!c) return { ok: false, error: 'Senha não encontrada.' };
  getDb().prepare(`UPDATE chamadas SET status = 'cancelada' WHERE id = ? AND status <> 'entregue'`).run(id);
  publicarSeMudou().catch(() => {});
  return { ok: true };
}

/** Chamado pelo botOrderService quando o pedido muda por lá. */
function aoMudarStatusDoPedido({ botOrderId, status }) {
  const c = getDb().prepare('SELECT * FROM chamadas WHERE bot_order_id = ?').get(botOrderId);
  if (!c) return;
  if (status === 'pronto' && c.status === 'preparando') chamar({ id: c.id, sincronizarPedido: false });
  else if (status === 'concluido' && c.status !== 'entregue' && c.status !== 'cancelada') entregar({ id: c.id, sincronizarPedido: false });
  else if (status === 'cancelado' && c.status !== 'entregue') cancelar({ id: c.id });
}

/** Senhas de hoje para a tela Chamada (e a de ontem que ainda não saiu). */
function listar() {
  const db = getDb();
  const hoje = hojeLocal();
  const linhas = db.prepare(
    `SELECT c.*, o.tipo_entrega, o.consumo_local, o.status AS pedido_status
     FROM chamadas c LEFT JOIN bot_orders o ON o.id = c.bot_order_id
     WHERE (c.data_local = ? OR c.status IN ('preparando','pronto')) AND c.status <> 'cancelada'
     ORDER BY c.data_local DESC, c.numero DESC LIMIT 300`
  ).all(hoje);
  return {
    hoje,
    preparando: linhas.filter((l) => l.status === 'preparando').map(publica).reverse(),
    prontas: linhas.filter((l) => l.status === 'pronto').map(publica).sort((a, b) => String(b.chamadoEm).localeCompare(String(a.chamadoEm))),
    entregues: linhas.filter((l) => l.status === 'entregue').slice(0, 30).map(publica),
    // Só os ids: o Vértice apaga da TV a senha cancelada (ver ponteSenhas.js).
    canceladas: db.prepare(`SELECT id FROM chamadas WHERE data_local = ? AND status = 'cancelada' ORDER BY numero DESC LIMIT 100`).all(hoje).map((r) => r.id),
  };
}

// ---------- painel (Firestore) ----------

/** O que vai pro documento público do painel. Exportada pra teste. */
function montarPainel({ agoraMs = require('./timeService').nowMs() } = {}) {
  const row = getRow();
  const modelo = lerModelo(row);
  const minutos = Number(row.minutos_no_painel) || 15;
  const limitePronto = new Date(agoraMs - minutos * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const db = getDb();
  const hoje = hojeLocal();
  const nome = (r) => (modelo.mostrarNome && r.nome ? String(r.nome).slice(0, 20) : null);
  const preparando = db.prepare(
    `SELECT numero, nome FROM chamadas WHERE status = 'preparando' AND data_local = ? ORDER BY numero LIMIT ?`
  ).all(hoje, LIMITE_PREPARANDO_NO_PAINEL).map((r) => ({ n: r.numero, nome: nome(r) }));
  const prontos = db.prepare(
    `SELECT id, numero, nome, chamado_em, vezes_chamada FROM chamadas
     WHERE status = 'pronto' AND chamado_em >= ? ORDER BY chamado_em DESC LIMIT ?`
  ).all(limitePronto, LIMITE_PRONTOS_NO_PAINEL);
  const ultima = prontos[0] || null;
  return {
    nomeLoja: nomeDaLoja(),
    modelo,
    preparando: modelo.layout === 'so_prontos' ? [] : preparando,
    prontos: prontos.map((r) => ({ n: r.numero, nome: nome(r) })),
    // seq muda a cada chamada (inclusive "chamar de novo"): a TV toca o aviso.
    ultimaChamada: ultima ? { n: ultima.numero, nome: nome(ultima), seq: `${ultima.id.slice(0, 8)}-${ultima.vezes_chamada}` } : null,
  };
}

function nomeDaLoja() {
  try { return require('./fiscalService').getNomeNegocio() || 'Nossa loja'; } catch { return 'Nossa loja'; }
}

/** Avisa a interface (tela Senhas e a ponte com o Vértice, src/integrations/vertice). */
function avisarJanelas() {
  try {
    const { BrowserWindow } = require('electron');
    for (const janela of BrowserWindow.getAllWindows?.() || []) {
      if (!janela.isDestroyed()) janela.webContents.send('chamada:mudou', { em: Date.now() });
    }
  } catch { /* sem Electron (teste) */ }
}

let publicando = null;
let pendente = false;
async function publicarSeMudou() {
  avisarJanelas();
  if (publicando) { pendente = true; return publicando; }
  publicando = (async () => {
    try {
      const row = getRow();
      if (row.ativa !== 1 || !row.painel_token) return { publicado: false, motivo: 'desligado' };
      const painel = montarPainel();
      const hash = crypto.createHash('sha256').update(JSON.stringify(painel)).digest('hex');
      if (hash === row.ultimo_hash) return { publicado: false, motivo: 'sem_mudanca' };
      const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
      const firestore = require('./licenseService').getLicenseFirestore();
      await setDoc(doc(firestore, 'paineis_chamada', row.painel_token), { ...painel, ativo: true, atualizadoEm: serverTimestamp() });
      getDb().prepare(`UPDATE chamada_config SET ultimo_hash = ? WHERE id = 'default'`).run(hash);
      return { publicado: true };
    } catch (err) {
      console.error('[chamadaService] publicar painel falhou:', err?.message || err);
      return { publicado: false, motivo: 'erro' };
    } finally {
      publicando = null;
      if (pendente) { pendente = false; setTimeout(() => publicarSeMudou().catch(() => {}), 200); }
    }
  })();
  return publicando;
}

/** Link trocado ou painel desligado: o documento antigo passa a dizer "desligado". */
async function apagarPainelPublicado(token) {
  const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
  const firestore = require('./licenseService').getLicenseFirestore();
  await setDoc(doc(firestore, 'paineis_chamada', token), {
    ativo: false, nomeLoja: '', modelo: normalizarModelo({}), preparando: [], prontos: [], ultimaChamada: null, atualizadoEm: serverTimestamp(),
  });
}

let intervalo = null;
function iniciar() {
  if (intervalo) clearInterval(intervalo);
  publicarSeMudou().catch(() => {});
  // Senha pronta "vence" no painel depois de X minutos: o ciclo republica.
  intervalo = setInterval(() => { publicarSeMudou().catch(() => {}); }, 20000);
}

module.exports = {
  getConfig, getConfigComQr, saveConfig, gerarNovoLink, criarParaVenda, criarParaPedido, criarManual, aposFinalizarVenda,
  chamar, entregar, voltarParaPreparo, cancelar, aoMudarStatusDoPedido, listar, montarPainel, publicarSeMudou, iniciar,
  normalizarModelo, MODELO_PADRAO, linkDoPainel,
};
