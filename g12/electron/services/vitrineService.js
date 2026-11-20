const crypto = require('crypto');
const { getDb } = require('../db/database');

/**
 * Vitrine online: página pública com os produtos e o preço da loja
 * (pwa-mobile/loja.html?s=<endereço>). O cliente monta o carrinho e manda o
 * pedido pelo WhatsApp da loja -- nada é gravado pelo público no Firebase.
 *
 * Quem decide o quê:
 *  - a Central cria o endereço (`vitrines/{endereço}`: cliente, máquina que
 *    publica e o WhatsApp que recebe os pedidos) e grava `vitrineSlug` no
 *    documento da instalação. O WhatsApp fica SÓ ali, num documento que só
 *    a Central grava -- assim ninguém troca o número para onde vão os
 *    pedidos, mesmo que consiga gravar nos documentos da máquina;
 *  - a loja liga/desliga e ajusta a vitrine aqui (Configurações → Vitrine
 *    online) e este computador publica o catálogo em
 *    installations/{id}/vitrine/{catalogo,config}, só quando muda.
 *
 * Publicado: nome, categoria, preço de venda (promoção por validade já
 * aplicada), unidade e uma faixa de disponibilidade ("disponível", "poucas
 * unidades", "esgotado") -- nunca custo nem a quantidade exata em estoque.
 */

const LIMITE_ITENS = 1500;
const LIMITE_BYTES = 800 * 1024; // documento do Firestore aceita até 1 MiB
// 'local' = consumir no estabelecimento: pelo QR da mesa, entra na comanda
// dela; sem mesa, retira no balcão pela senha.
const MODOS_VALIDOS = ['retirada', 'entrega', 'local'];
const SLUG_VALIDO = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function getRow() {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM vitrine_config WHERE id = 'default'`).get();
  if (!row) {
    db.prepare(`INSERT INTO vitrine_config (id) VALUES ('default')`).run();
    row = db.prepare(`SELECT * FROM vitrine_config WHERE id = 'default'`).get();
  }
  return row;
}

function parseModos(json) {
  try {
    const lista = JSON.parse(json || '[]');
    return Array.isArray(lista) ? lista.filter((m) => MODOS_VALIDOS.includes(m)) : [];
  } catch {
    return [];
  }
}

let falhaPublicacao = null; // { motivo, texto, em }
const TEXTO_FALHA = {
  timeout: 'sem conexão com a internet (o envio não terminou). Tentando de novo a cada 5 minutos.',
  sem_cota: 'limite de envios à nuvem atingido por agora. Tente mais tarde.',
  erro: 'erro ao enviar para a nuvem. Veja a conexão e clique em Publicar agora.',
};
const LIMITE_ENVIO_MS = 20000;
function anotarFalhaPublicacao(motivo) { falhaPublicacao = { motivo, texto: TEXTO_FALHA[motivo] || TEXTO_FALHA.erro, em: new Date().toISOString() }; }
function _definirTempoLimiteParaTeste(ms) { limiteEnvioMs = ms; }
let limiteEnvioMs = LIMITE_ENVIO_MS;
let nuvemDeTeste = null; // { doc, writeBatch, serverTimestamp } falsos nos testes
function _definirNuvemParaTeste(n) { nuvemDeTeste = n || null; }

function getConfig() {
  const r = getRow();
  return {
    ativa: r.ativa === 1,
    ocultarSemEstoque: r.ocultar_sem_estoque === 1,
    avisoPoucasUnidades: Number(r.aviso_poucas_unidades) || 0,
    mensagem: r.mensagem || '',
    modos: parseModos(r.modos),
    pedidoMinimo: Number(r.pedido_minimo) || 0,
    pedidosOnline: r.pedidos_online === 1,
    // Pedido do QR de mesa já aberta entra direto (vitrinePedidoService.aceitarSozinhoSeMesaAberta).
    aceitarMesaAberta: r.aceitar_mesa_aberta !== 0,
    // "Pagar agora com Pix" na página (vitrinePixService). Só vale com pedido
    // direto no sistema e Pix automático configurado.
    pixOnline: r.pix_online === 1 && r.pedidos_online === 1,
    pixOnlineDisponivel: (() => { try { return require('./vitrinePixService').disponivel(); } catch { return false; } })(),
    slug: r.slug || null,
    link: r.slug ? linkPublico(r.slug) : null,
    ultimaPublicacao: r.ultima_publicacao || null,
    itensPublicados: r.itens_publicados ?? null,
    // Última tentativa que não deu certo (só em memória): a tela mostra o motivo.
    falhaPublicacao: falhaPublicacao ? { ...falhaPublicacao } : null,
  };
}

/** Config + QR do link (imagem PNG em data URL) pra tela de Configurações
 * e pra imprimir no balcão. */
async function getConfigComQr() {
  const config = getConfig();
  let qrDataUrl = null;
  if (config.link) {
    try { qrDataUrl = await require('qrcode').toDataURL(config.link, { errorCorrectionLevel: 'M', margin: 1, width: 360 }); } catch { qrDataUrl = null; }
  }
  return { ...config, qrDataUrl };
}

function linkPublico(slug, tokenMesa) {
  return `https://gerenciaai-garcom.web.app/loja.html?s=${encodeURIComponent(slug)}${tokenMesa ? `&m=${encodeURIComponent(tokenMesa)}` : ''}`;
}

// ---------- QR de cada mesa ----------
// O link da mesa leva um segredo próprio (`restaurant_tables.qr_token`):
// quem só conhece o endereço da vitrine não consegue mandar pedido "para a
// mesa 5". A página pública recebe só o HASH do segredo -> rótulo da mesa
// (para escrever "Mesa 5" na tela), nunca o segredo.
const TOKEN_MESA = /^[A-Za-z0-9]{24}$/;

function hashTokenMesa(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
}

function garantirTokenMesa(db, tableId) {
  const mesa = db.prepare('SELECT id, qr_token FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!mesa) return null;
  if (mesa.qr_token && TOKEN_MESA.test(mesa.qr_token)) return mesa.qr_token;
  for (let i = 0; i < 5; i++) {
    const token = crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    if (token.length !== 24) continue;
    try {
      db.prepare('UPDATE restaurant_tables SET qr_token = ? WHERE id = ?').run(token, tableId);
      return token;
    } catch { /* colisão do índice único: tenta outro */ }
  }
  return null;
}

/** Mesa pelo segredo do QR (pedido que chegou da página). */
function mesaPeloToken(token) {
  if (!TOKEN_MESA.test(String(token || ''))) return null;
  return getDb().prepare('SELECT * FROM restaurant_tables WHERE qr_token = ?').get(token) || null;
}

function rotuloMesa(m) {
  return m.nome ? String(m.nome).slice(0, 30) : `Mesa ${m.numero}`;
}

/**
 * Para onde o QR da mesa aponta. Pedido pela rede da loja ligado
 * (mesaLocalService, sem Firebase): o servidor da loja. Senão, a vitrine na
 * internet (se a Central já criou o endereço). null = nenhum dos dois.
 */
function destinoDoQr() {
  try {
    const local = require('./mesaLocalService').getConfig();
    if (local.ativo && local.endereco) return { modo: 'local', link: (token) => require('./mesaLocalService').linkDaMesa(token, local), local };
  } catch { /* banco sem a tabela */ }
  const config = getConfig();
  if (config.slug) return { modo: 'internet', link: (token) => linkPublico(config.slug, token) };
  return null;
}

/**
 * A vitrine na internet recebe pedido de mesa? (Central criou o endereço,
 * vitrine ligada e "pedidos direto no sistema".) Com a rede da loja ligada,
 * o cartão da mesa ganha um SEGUNDO QR, para quem está sem o Wi-Fi da loja.
 */
function internetDisponivel() {
  try { const c = getConfig(); return !!(c.slug && c.ativa && c.pedidosOnline); } catch { return false; }
}

/** QR do Wi-Fi para o cartão da mesa (quando a loja escolheu mostrar). */
async function wifiDoCartao() {
  try {
    const local = require('./mesaLocalService').getConfig();
    if (!local.ativo || !local.mostrarWifi) return null;
    const texto = require('./mesaLocalService').textoQrWifi(local);
    if (!texto) return null;
    return { nome: local.wifiNome, qrDataUrl: await require('qrcode').toDataURL(texto, { errorCorrectionLevel: 'M', margin: 1, width: 200 }) };
  } catch { return null; }
}

/** Link + QR de cada mesa (Configurações → Vitrine → QR das mesas). */
async function qrDasMesas() {
  const config = getConfig();
  const destino = destinoDoQr();
  if (!destino) return { ok: false, error: 'Ligue o "Pedido pela mesa na rede da loja" (Configurações → Vitrine) ou peça à Central o endereço da vitrine.' };
  const db = getDb();
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  const mesas = location ? db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE location_id = ? ORDER BY CAST(numero AS INTEGER), numero').all(location.id) : [];
  const QRCode = require('qrcode');
  const duplo = destino.modo === 'local' && internetDisponivel();
  const lista = [];
  for (const m of mesas) {
    const token = garantirTokenMesa(db, m.id);
    if (!token) continue;
    const link = destino.link(token);
    let qrDataUrl = null;
    try { qrDataUrl = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { qrDataUrl = null; }
    const item = { tableId: m.id, numero: m.numero, rotulo: rotuloMesa(m), link, qrDataUrl, linkInternet: null, qrInternetDataUrl: null };
    // Rede da loja ligada + vitrine ativa: segundo QR (pela internet, sem o Wi-Fi da loja).
    if (duplo) {
      item.linkInternet = linkPublico(config.slug, token);
      try { item.qrInternetDataUrl = await QRCode.toDataURL(item.linkInternet, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { item.qrInternetDataUrl = null; }
    }
    lista.push(item);
  }
  if (lista.length && (destino.modo === 'internet' || duplo)) publicarSeMudou().catch(() => {});
  return {
    ok: true, modo: destino.modo, duplo, pedidosOnline: destino.modo === 'local' ? true : config.pedidosOnline,
    ativa: destino.modo === 'local' ? true : config.ativa, mesas: lista, wifi: await wifiDoCartao(),
  };
}

/** Link/QR de UMA mesa (botão de QR na tela de Mesas). null sem vitrine com pedido pelo site. */
async function qrDaMesa(tableId) {
  const config = getConfig();
  const destino = destinoDoQr();
  if (!destino) return null;
  if (destino.modo === 'internet' && (!config.ativa || !config.pedidosOnline)) return null;
  const db = getDb();
  const m = db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!m) return null;
  const token = garantirTokenMesa(db, m.id);
  if (!token) return null;
  const link = destino.link(token);
  let qrDataUrl = null;
  try { qrDataUrl = await require('qrcode').toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { qrDataUrl = null; }
  // Rede da loja ligada + vitrine ativa: também o link/QR pela internet (cliente sem o Wi-Fi da loja).
  let urlInternet = null;
  let qrInternetDataUrl = null;
  if (destino.modo === 'local' && internetDisponivel()) {
    urlInternet = linkPublico(config.slug, token);
    try { qrInternetDataUrl = await require('qrcode').toDataURL(urlInternet, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { qrInternetDataUrl = null; }
  }
  if (destino.modo === 'internet' || urlInternet) publicarSeMudou().catch(() => {});
  return { url: link, qrCodeDataUrl: qrDataUrl, urlInternet, qrInternetDataUrl, rotulo: rotuloMesa(m), vitrine: true, modo: destino.modo };
}

/** Troca o QR de uma mesa (o impresso antigo para de funcionar). */
function trocarQrDaMesa({ tableId, requestingUserId }) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) return { ok: false, error: 'Apenas um gerente ou administrador pode trocar o QR da mesa.' };
  const r = db.prepare('UPDATE restaurant_tables SET qr_token = NULL WHERE id = ?').run(tableId);
  if (!r.changes) return { ok: false, error: 'Mesa não encontrada.' };
  garantirTokenMesa(db, tableId);
  publicarSeMudou().catch(() => {});
  return { ok: true };
}

// ---------- exportar QR (arquivo / impressão) ----------

function nomeArquivo(texto) {
  return String(texto || 'qr').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'qr';
}

/**
 * Salva o QR da vitrine (ou de UMA mesa) em PNG grande, para mandar à
 * gráfica, colar no Instagram ou imprimir. O caminho vem SEMPRE do diálogo
 * do processo principal (nunca do renderer).
 */
async function salvarQrPng({ tableId, via } = {}) {
  const config = getConfig();
  const alvoDoQr = tableId ? destinoDoQr() : null;
  if (tableId ? !alvoDoQr : !config.slug) return { ok: false, error: 'A Central ainda não criou o endereço da vitrine desta loja.' };
  let link = config.link;
  let rotulo = 'vitrine';
  if (tableId) {
    const db = getDb();
    const m = db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE id = ?').get(tableId);
    if (!m) return { ok: false, error: 'Mesa não encontrada.' };
    const token = garantirTokenMesa(db, m.id);
    if (!token) return { ok: false, error: 'Não consegui gerar o QR desta mesa.' };
    link = via === 'internet' && internetDisponivel() ? linkPublico(config.slug, token) : alvoDoQr.link(token);
    rotulo = via === 'internet' ? `${rotuloMesa(m)}-sem-wifi` : rotuloMesa(m);
    publicarSeMudou().catch(() => {});
  }
  const { dialog } = require('electron');
  const escolha = await dialog.showSaveDialog({
    title: 'Salvar QR Code', defaultPath: `qr-${nomeArquivo(rotulo)}.png`, filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
  });
  if (escolha.canceled || !escolha.filePath) return { ok: false, cancelado: true };
  const destino = escolha.filePath.toLowerCase().endsWith('.png') ? escolha.filePath : `${escolha.filePath}.png`;
  await require('qrcode').toFile(destino, link, { errorCorrectionLevel: 'M', margin: 2, width: 1200, type: 'png' });
  return { ok: true, caminho: destino };
}

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Folha(s) com os cartões de QR das mesas, com a aparência do estúdio de
 * impressão (papel, quantos por folha, cor, logo, textos). Exportada pra teste.
 */
function montarFolhaQrMesas({ nomeLoja, mesas, config = null, wifi = null }) {
  const layout = require('./impressaoLayout');
  const c = config || (() => { try { return require('./estudioImpressaoService').getConfig('qrmesa'); } catch { return {}; } })();
  return layout.montarCartoesQr(c, { loja: { nome: nomeLoja, wifi }, mesas });
}

/**
 * Imprime (ou salva em PDF) os cartões de QR. `tableIds`: só essas mesas
 * (vazio = todas). Cada QR abre a vitrine SÓ daquela mesa.
 */
/** Aparência do estúdio com papel/quantidade/orientação escolhidos na hora. */
function configDoQrComEscolhas({ porFolha, papel, orientacao } = {}) {
  let base = {};
  try { base = require('./estudioImpressaoService').getConfig('qrmesa'); } catch { base = {}; }
  return require('./impressaoLayout').normalizarConfig('qrmesa', {
    ...base,
    ...(porFolha !== undefined && porFolha !== null ? { porFolha } : {}), ...(papel ? { papel } : {}), ...(orientacao ? { orientacao } : {}),
  });
}

async function imprimirQrMesas({ tableIds = null, porFolha, papel, orientacao } = {}) {
  const r = await qrDasMesas();
  if (!r.ok) return r;
  const filtro = Array.isArray(tableIds) && tableIds.length ? new Set(tableIds) : null;
  const mesas = filtro ? r.mesas.filter((m) => filtro.has(m.tableId)) : r.mesas;
  if (!mesas.length) return { ok: false, error: filtro ? 'Escolha ao menos uma mesa.' : 'Nenhuma mesa cadastrada.' };
  const html = montarFolhaQrMesas({ nomeLoja: nomeDaLoja(), mesas, config: configDoQrComEscolhas({ porFolha, papel, orientacao }), wifi: r.wifi });
  const { ok, motivo } = await require('./printService').imprimirEmJanelaInvisivel(html, { silent: false, printBackground: true });
  return ok || motivo === 'cancelled' ? { ok: true, cancelado: !ok, quantidade: mesas.length } : { ok: false, error: `Não imprimiu (${motivo || 'erro'}).` };
}

/**
 * PDF com os cartões de QR, para imprimir depois (gráfica, outra impressora).
 * `porFolha`, `papel`, `orientacao`: escolhidos na hora (sem mudar o estúdio);
 * o resto da aparência vem do estúdio. `tableIds`: só essas mesas.
 */
async function gerarPdfQrMesas({ tableIds = null, porFolha, papel, orientacao } = {}) {
  const r = await qrDasMesas();
  if (!r.ok) return r;
  const filtro = Array.isArray(tableIds) && tableIds.length ? new Set(tableIds.map(String)) : null;
  const mesas = filtro ? r.mesas.filter((m) => filtro.has(m.tableId)) : r.mesas;
  if (!mesas.length) return { ok: false, error: filtro ? 'Escolha ao menos uma mesa.' : 'Nenhuma mesa cadastrada.' };
  const layout = require('./impressaoLayout');
  const config = configDoQrComEscolhas({ porFolha, papel, orientacao });
  const html = montarFolhaQrMesas({ nomeLoja: nomeDaLoja(), mesas, config, wifi: r.wifi });
  const pdf = await require('./printService').gerarPdf(html);
  const { dialog, app, shell } = require('electron');
  const escolha = await dialog.showSaveDialog({
    title: 'Salvar o PDF dos QR das mesas',
    defaultPath: require('path').join(app.getPath('documents'), `qr-das-mesas-${config.porFolha}-por-folha.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (escolha.canceled || !escolha.filePath) return { ok: false, cancelado: true };
  const destino = escolha.filePath.toLowerCase().endsWith('.pdf') ? escolha.filePath : `${escolha.filePath}.pdf`;
  require('fs').writeFileSync(destino, pdf);
  shell.openPath(destino).catch(() => {});
  const m = layout.medidasDoCartao(config.papel, config.porFolha, config.orientacao);
  return { ok: true, caminho: destino, quantidade: mesas.length, folhas: Math.ceil(mesas.length / m.porPagina), porFolha: m.porPagina };
}

/** hash -> rótulo, para a página pública escrever "Mesa 5". */
function mapaPublicoDasMesas() {
  const db = getDb();
  const mapa = {};
  for (const m of db.prepare('SELECT numero, nome, qr_token FROM restaurant_tables WHERE qr_token IS NOT NULL').all()) {
    if (TOKEN_MESA.test(m.qr_token)) mapa[hashTokenMesa(m.qr_token)] = rotuloMesa(m);
  }
  return mapa;
}

function saveConfig({ ativa, ocultarSemEstoque, avisoPoucasUnidades, mensagem, modos, pedidoMinimo, pedidosOnline, pixOnline, aceitarMesaAberta, requestingUserId }) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) {
    return { ok: false, error: 'Apenas um gerente ou administrador pode mudar a vitrine online.' };
  }
  const listaModos = Array.isArray(modos) ? [...new Set(modos)].filter((m) => MODOS_VALIDOS.includes(m)) : [];
  if (ativa && listaModos.length === 0) return { ok: false, error: 'Escolha pelo menos retirada na loja, consumo no local ou entrega.' };
  const recebePedidos = pedidosOnline !== undefined ? !!pedidosOnline : getRow().pedidos_online === 1;
  const querPix = pixOnline !== undefined ? !!pixOnline : getRow().pix_online === 1;
  if (querPix && !recebePedidos) return { ok: false, error: 'O Pix pelo site precisa de "Receber os pedidos direto no sistema" ligado.' };
  if (querPix && pixOnline && !require('./vitrinePixService').disponivel()) {
    return { ok: false, error: 'Para o cliente pagar pelo site, ligue o Pix automático (Configurações → Geral → Pix automático) com token e e-mail.' };
  }
  if (listaModos.includes('local') && !recebePedidos) return { ok: false, error: 'Consumo no local precisa de "Receber os pedidos direto no sistema" ligado (o pedido vai para a mesa ou ganha senha).' };
  const aviso = Number(avisoPoucasUnidades);
  if (!Number.isInteger(aviso) || aviso < 0 || aviso > 1000) return { ok: false, error: 'Aviso de "poucas unidades" precisa ser um número inteiro (0 desliga).' };
  const minimo = Number(pedidoMinimo);
  if (!Number.isFinite(minimo) || minimo < 0 || minimo > 100000) return { ok: false, error: 'Pedido mínimo inválido.' };
  getRow();
  db.prepare(
    `UPDATE vitrine_config SET ativa = ?, ocultar_sem_estoque = ?, aviso_poucas_unidades = ?, mensagem = ?, modos = ?,
       pedido_minimo = ?, pedidos_online = ?, pix_online = ?, atualizado_por_id = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`
  ).run(ativa ? 1 : 0, ocultarSemEstoque ? 1 : 0, aviso, String(mensagem || '').trim().slice(0, 280), JSON.stringify(listaModos),
    Math.round(minimo * 100) / 100, recebePedidos ? 1 : 0, querPix && recebePedidos ? 1 : 0, requestingUserId);
  if (aceitarMesaAberta !== undefined) {
    try { db.prepare("UPDATE vitrine_config SET aceitar_mesa_aberta = ? WHERE id = 'default'").run(aceitarMesaAberta ? 1 : 0); } catch { /* banco antigo */ }
  }
  require('./authService').registrarEventoAuditoria({
    tipoEvento: 'vitrine_alterada', solicitanteId: requestingUserId,
    motivo: ativa ? `Vitrine online ligada/ajustada${recebePedidos ? ' (pedidos direto no sistema)' : ''}` : 'Vitrine online desligada',
  });
  // O pedido do site cai na Separação: liga a aba se estiver desligada.
  if (ativa && recebePedidos) {
    const bot = require('./botOrderService');
    if (!bot.getConfig().ativo) bot.updateConfig({ ativo: true });
  }
  publicarSeMudou().catch(() => {});
  try { require('./vitrinePedidoService').atualizarEscuta(); } catch { /* sem rede/escuta: segue */ }
  return { ok: true, config: getConfig() };
}

/** Endereço criado na Central (installations/{id}.vitrineSlug). */
function aplicarDaInstalacao(dados) {
  const slug = typeof dados?.vitrineSlug === 'string' && SLUG_VALIDO.test(dados.vitrineSlug) ? dados.vitrineSlug : null;
  const atual = getRow().slug || null;
  if (slug === atual) return;
  getDb().prepare(`UPDATE vitrine_config SET slug = ?, ultimo_hash = NULL WHERE id = 'default'`).run(slug);
  publicarSeMudou().catch(() => {});
  try { require('./vitrinePedidoService').atualizarEscuta(); } catch { /* segue */ }
}

function faixaDeEstoque(estoque, aviso) {
  if (estoque == null) return 'disponivel';
  if (estoque <= 0) return 'esgotado';
  if (aviso > 0 && estoque <= aviso) return 'poucas';
  return 'disponivel';
}

/** Catálogo como vai pro público. Exportada pra teste (não toca rede). */
function montarCatalogo() {
  const db = getDb();
  const config = getConfig();
  const productService = require('./productService');
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  const produtos = db.prepare(
    `SELECT id, nome, categoria, preco, preco_promocional, promocao_valida_ate, unidade, tipo FROM products
     WHERE ativo = 1 ORDER BY categoria, nome`
  ).all();
  const estoques = new Map();
  if (location) {
    for (const l of db.prepare(`SELECT product_id, COALESCE(SUM(quantidade), 0) AS total FROM stock_movements WHERE location_id = ? GROUP BY product_id`).all(location.id)) {
      estoques.set(l.product_id, l.total);
    }
  }
  const itens = [];
  for (const p of produtos) {
    const preco = productService.precoEfetivo(p);
    if (!(preco > 0)) continue;
    const estoque = p.tipo === 'servico' ? null : (estoques.get(p.id) ?? 0);
    const faixa = faixaDeEstoque(estoque, config.avisoPoucasUnidades);
    if (faixa === 'esgotado' && config.ocultarSemEstoque) continue;
    itens.push({
      id: p.id, nome: p.nome, categoria: p.categoria || null, preco: Math.round(preco * 100) / 100,
      ...(preco !== p.preco ? { precoDe: Math.round(p.preco * 100) / 100 } : {}),
      unidade: p.unidade || 'un', disponibilidade: faixa,
    });
    if (itens.length >= LIMITE_ITENS) break;
  }
  // Cabe num documento só; se passar (nomes enormes), corta o fim.
  while (itens.length && Buffer.byteLength(JSON.stringify(itens)) > LIMITE_BYTES) itens.splice(Math.floor(itens.length * 0.9));
  return { itens, cortado: produtos.length > itens.length && itens.length >= LIMITE_ITENS };
}

function nomeDaLoja() {
  try { return require('./fiscalService').getNomeNegocio() || 'Nossa loja'; } catch { return 'Nossa loja'; }
}

let publicando = null;
/**
 * Publica catálogo + config se algo mudou desde a última vez (hash). Sem
 * endereço criado na Central, não publica nada.
 */
async function publicarSeMudou() {
  if (publicando) return publicando;
  publicando = (async () => {
    // Sem este await, uma saída antecipada (sem endereço, sem mudança) rodava o finally
    // ANTES de `publicando` ser atribuído e a trava ficava presa com o resultado velho
    // para sempre: a vitrine nunca mais publicava até reiniciar o app.
    await null;
    try {
      const config = getConfig();
      if (!config.slug) return { publicado: false, motivo: 'sem_endereco' };
      const { itens } = config.ativa ? montarCatalogo() : { itens: [] };
      const publico = {
        ativa: config.ativa, nomeLoja: nomeDaLoja(), mensagem: config.mensagem, modos: config.modos, pedidoMinimo: config.pedidoMinimo,
        pedidosOnline: config.ativa && config.pedidosOnline,
        mesas: config.ativa && config.pedidosOnline ? mapaPublicoDasMesas() : {},
        pagamentoOnline: !!(config.ativa && config.pixOnline && config.pixOnlineDisponivel),
      };
      const hash = crypto.createHash('sha256').update(JSON.stringify({ publico, itens })).digest('hex');
      if (hash === getRow().ultimo_hash && getRow().ultima_publicacao) { falhaPublicacao = null; return { publicado: false, motivo: 'sem_mudanca' }; }
      if (!require('./nuvemDisjuntorService').podeEscrever('vitrine', 2)) { anotarFalhaPublicacao('sem_cota'); return { publicado: false, motivo: 'sem_cota' }; }

      const { doc, writeBatch, serverTimestamp } = nuvemDeTeste || require('firebase/firestore');
      const firestore = require('./licenseService').getLicenseFirestore();
      const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
      const lote = writeBatch(firestore);
      lote.set(doc(firestore, 'installations', installId, 'vitrine', 'config'), { ...publico, atualizadoEm: serverTimestamp() });
      lote.set(doc(firestore, 'installations', installId, 'vitrine', 'catalogo'), { itens, atualizadoEm: serverTimestamp() });
      let relogio;
      try {
        await Promise.race([
          lote.commit(),
          new Promise((_, rej) => { relogio = setTimeout(() => rej(Object.assign(new Error('envio demorou demais'), { codigo: 'timeout' })), limiteEnvioMs); }),
        ]);
      } finally { clearTimeout(relogio); }
      falhaPublicacao = null;
      getDb().prepare(`UPDATE vitrine_config SET ultimo_hash = ?, ultima_publicacao = NOW_SYNCED(), itens_publicados = ? WHERE id = 'default'`)
        .run(hash, itens.length);
      return { publicado: true, itens: itens.length };
    } catch (err) {
      console.error('[vitrineService] publicar falhou:', err?.message || err);
      const motivo = err?.codigo === 'timeout' ? 'timeout' : 'erro';
      anotarFalhaPublicacao(motivo);
      return { publicado: false, motivo };
    } finally {
      publicando = null;
    }
  })();
  return publicando;
}

let intervalo = null;
function iniciarPublicacaoContinua() {
  if (intervalo) clearInterval(intervalo);
  publicarSeMudou().catch(() => {});
  intervalo = setInterval(() => { publicarSeMudou().catch(() => {}); }, 5 * 60 * 1000);
}

module.exports = {
  getConfig, getConfigComQr, saveConfig, aplicarDaInstalacao, montarCatalogo, publicarSeMudou, iniciarPublicacaoContinua, linkPublico, faixaDeEstoque,
  qrDasMesas, qrDaMesa, internetDisponivel, trocarQrDaMesa, mesaPeloToken, hashTokenMesa, mapaPublicoDasMesas, garantirTokenMesa,
  salvarQrPng, imprimirQrMesas, montarFolhaQrMesas, gerarPdfQrMesas, configDoQrComEscolhas, _definirTempoLimiteParaTeste, _definirNuvemParaTeste,
  SLUG_VALIDO, MODOS_VALIDOS,
};
