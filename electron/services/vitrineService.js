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
    // "Pagar agora com Pix" na página (vitrinePixService). Só vale com pedido
    // direto no sistema e Pix automático configurado.
    pixOnline: r.pix_online === 1 && r.pedidos_online === 1,
    pixOnlineDisponivel: (() => { try { return require('./vitrinePixService').disponivel(); } catch { return false; } })(),
    slug: r.slug || null,
    link: r.slug ? linkPublico(r.slug) : null,
    ultimaPublicacao: r.ultima_publicacao || null,
    itensPublicados: r.itens_publicados ?? null,
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

/** Link + QR de cada mesa (Configurações → Vitrine → QR das mesas). */
async function qrDasMesas() {
  const config = getConfig();
  if (!config.slug) return { ok: false, error: 'A Central ainda não criou o endereço da vitrine desta loja.' };
  const db = getDb();
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  const mesas = location ? db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE location_id = ? ORDER BY CAST(numero AS INTEGER), numero').all(location.id) : [];
  const QRCode = require('qrcode');
  const lista = [];
  for (const m of mesas) {
    const token = garantirTokenMesa(db, m.id);
    if (!token) continue;
    const link = linkPublico(config.slug, token);
    let qrDataUrl = null;
    try { qrDataUrl = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { qrDataUrl = null; }
    lista.push({ tableId: m.id, numero: m.numero, rotulo: rotuloMesa(m), link, qrDataUrl });
  }
  if (lista.length) publicarSeMudou().catch(() => {});
  return { ok: true, pedidosOnline: config.pedidosOnline, ativa: config.ativa, mesas: lista };
}

/** Link/QR de UMA mesa (botão de QR na tela de Mesas). null sem vitrine com pedido pelo site. */
async function qrDaMesa(tableId) {
  const config = getConfig();
  if (!config.slug || !config.ativa || !config.pedidosOnline) return null;
  const db = getDb();
  const m = db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!m) return null;
  const token = garantirTokenMesa(db, m.id);
  if (!token) return null;
  const link = linkPublico(config.slug, token);
  let qrDataUrl = null;
  try { qrDataUrl = await require('qrcode').toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 300 }); } catch { qrDataUrl = null; }
  publicarSeMudou().catch(() => {});
  return { url: link, qrCodeDataUrl: qrDataUrl, rotulo: rotuloMesa(m), vitrine: true };
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
async function salvarQrPng({ tableId } = {}) {
  const config = getConfig();
  if (!config.slug) return { ok: false, error: 'A Central ainda não criou o endereço da vitrine desta loja.' };
  let link = config.link;
  let rotulo = 'vitrine';
  if (tableId) {
    const db = getDb();
    const m = db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE id = ?').get(tableId);
    if (!m) return { ok: false, error: 'Mesa não encontrada.' };
    const token = garantirTokenMesa(db, m.id);
    if (!token) return { ok: false, error: 'Não consegui gerar o QR desta mesa.' };
    link = linkPublico(config.slug, token);
    rotulo = rotuloMesa(m);
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

/** Folha com um cartão por mesa (QR + "Mesa 5"), em A4. Exportada pra teste. */
function montarFolhaQrMesas({ nomeLoja, mesas, comVitrine = null }) {
  const cartao = (titulo, sub, qr) => `
    <div class="cartao">
      <div class="loja">${escHtml(nomeLoja)}</div>
      <div class="titulo">${escHtml(titulo)}</div>
      ${qr && /^data:image\/png;base64,/.test(qr) ? `<img src="${qr}" alt="">` : ''}
      <div class="sub">${escHtml(sub)}</div>
    </div>`;
  const cartoes = [
    ...(comVitrine ? [cartao('Cardápio e pedidos', 'Aponte a câmera, escolha e retire no balcão', comVitrine)] : []),
    ...mesas.map((m) => cartao(m.rotulo, 'Aponte a câmera, escolha e informe seu nome', m.qrDataUrl)),
  ].join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>QR das mesas</title><style>
    @page { size: A4; margin: 10mm; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; color: #141a26; }
    .grade { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; }
    .cartao { border: 1.5px dashed #9aa4b2; border-radius: 4mm; padding: 6mm 4mm; text-align: center; break-inside: avoid; }
    .loja { font-size: 12pt; color: #5c6b70; }
    .titulo { font-size: 26pt; font-weight: 800; margin: 1mm 0 3mm; }
    img { width: 58mm; height: 58mm; }
    .sub { font-size: 11pt; margin-top: 2mm; }
  </style></head><body><div class="grade">${cartoes}</div></body></html>`;
}

/** Abre a impressão (com "Salvar como PDF") dos cartões de QR das mesas. */
async function imprimirQrMesas() {
  const r = await qrDasMesas();
  if (!r.ok) return r;
  if (!r.mesas.length && !getConfig().link) return { ok: false, error: 'Nenhuma mesa cadastrada.' };
  const config = await getConfigComQr();
  const html = montarFolhaQrMesas({ nomeLoja: nomeDaLoja(), mesas: r.mesas, comVitrine: config.qrDataUrl || null });
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return new Promise((resolve) => {
    win.webContents.print({ silent: false, printBackground: true }, (ok, motivo) => {
      win.close();
      resolve(ok || motivo === 'cancelled' ? { ok: true, cancelado: !ok } : { ok: false, error: `Não imprimiu (${motivo || 'erro'}).` });
    });
  });
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

function saveConfig({ ativa, ocultarSemEstoque, avisoPoucasUnidades, mensagem, modos, pedidoMinimo, pedidosOnline, pixOnline, requestingUserId }) {
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
      if (hash === getRow().ultimo_hash) return { publicado: false, motivo: 'sem_mudanca' };

      const { doc, writeBatch, serverTimestamp } = require('firebase/firestore');
      const firestore = require('./licenseService').getLicenseFirestore();
      const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
      const lote = writeBatch(firestore);
      lote.set(doc(firestore, 'installations', installId, 'vitrine', 'config'), { ...publico, atualizadoEm: serverTimestamp() });
      lote.set(doc(firestore, 'installations', installId, 'vitrine', 'catalogo'), { itens, atualizadoEm: serverTimestamp() });
      await lote.commit();
      getDb().prepare(`UPDATE vitrine_config SET ultimo_hash = ?, ultima_publicacao = NOW_SYNCED(), itens_publicados = ? WHERE id = 'default'`)
        .run(hash, itens.length);
      return { publicado: true, itens: itens.length };
    } catch (err) {
      console.error('[vitrineService] publicar falhou:', err?.message || err);
      return { publicado: false, motivo: 'erro' };
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
  qrDasMesas, qrDaMesa, trocarQrDaMesa, mesaPeloToken, hashTokenMesa, mapaPublicoDasMesas, garantirTokenMesa,
  salvarQrPng, imprimirQrMesas, montarFolhaQrMesas,
  SLUG_VALIDO, MODOS_VALIDOS,
};
