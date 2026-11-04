const crypto = require('crypto');
const { getDb } = require('../db/database');
const { CATALOGOS_DEMO, PREFIXO_SKU_DEMO } = require('./vitrineDemoCatalogos');

/**
 * VITRINE DE DEMONSTRAÇÃO -- para mostrar o sistema a um prospect.
 *
 * Na Central (Crescimento → Vitrine de demonstração) cria-se um endereço
 * `vitrines/{endereço}` com `demo: { segmento, nomeLoja, expiraEm }`
 * apontando para a MÁQUINA DE DEMONSTRAÇÃO (installations/{id}.maquinaDemo,
 * campo que só a Central grava). O prospect abre o link no celular, monta o
 * pedido e ele cai na Separação desta máquina, como um pedido de verdade.
 *
 * Nesta máquina (só se `maquinaDemo` for true):
 *  - cria uma vez os produtos de demonstração (SKU `DEMO-...`, ver
 *    vitrineDemoCatalogos.js), com estoque inicial -- nunca regrava um que
 *    já existe;
 *  - publica um catálogo por segmento em installations/{id}/vitrine/demo_<segmento>
 *    (mesmo formato da vitrine normal: nunca custo nem estoque exato);
 *  - escuta installations/{id}/pedidos_vitrine (escritos pelo público,
 *    validados pelas regras do Firestore) e cria bot_orders com
 *    `canal = 'vitrine_demo'`. Preço SEMPRE do produto local, nunca do
 *    celular; só produtos DEMO- entram; no máximo 30 pedidos por demonstração.
 *
 * A vitrine normal (vitrineService.js, pedido pelo WhatsApp) não muda.
 */

const CANAL = 'vitrine_demo';
const TELEFONE_PEDIDO = 'vitrine-demo'; // bot_orders.cliente_telefone é obrigatório (mesma ideia do 'app-garcom')
const LIMITE_PEDIDOS_POR_DEMO = 30;
const LIMITE_ITENS_PEDIDO = 40;
const QTD_MAXIMA_ITEM = 99;
const AVISO_POUCAS_UNIDADES = 5;
const ESTOQUE_INICIAL = { kg: 20, un: 40 };
const FRACIONADAS = ['kg', 'l', 'm'];
const PAGAMENTOS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão' };
const SLUG_VALIDO = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const estado = { maquinaDemo: false, intervalo: null, pararEscuta: null, hashes: new Map(), processando: new Set(), publicando: null };

const segmentos = () => Object.keys(CATALOGOS_DEMO);
const skuDe = (item) => `${PREFIXO_SKU_DEMO}${item.codigo}`;
const arred = (v, casas = 2) => { const f = 10 ** casas; return Math.round((Number(v) + Number.EPSILON) * f) / f; };
const moeda = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

function limparTexto(valor, max) {
  // Sem caracteres de controle (quebra de linha vira espaço).
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- produtos e catálogo ----------

/** Cria os produtos de demonstração que ainda não existem (pelo SKU, que é
 * UNIQUE mesmo em produto excluído). Idempotente; não mexe em produto já
 * criado (preço/estoque ajustados à mão continuam como estão). */
function garantirProdutosDemo() {
  const db = getDb();
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  if (!location) return { criados: 0 };
  const productService = require('./productService');
  const stockService = require('./stockService');
  const existe = db.prepare('SELECT id FROM products WHERE sku = ?');
  let criados = 0;
  db.transaction(() => {
    for (const segmento of segmentos()) {
      for (const item of CATALOGOS_DEMO[segmento].itens) {
        const sku = skuDe(item);
        if (existe.get(sku)) continue;
        const r = productService.upsert({ sku, nome: item.nome, categoria: item.categoria, preco: item.preco, unidade: item.unidade });
        if (!r.ok) throw new Error(`Produto de demonstração ${sku}: ${r.error}`);
        const e = stockService.adjustStock({
          productId: r.id, locationId: location.id, quantidade: ESTOQUE_INICIAL[item.unidade] ?? ESTOQUE_INICIAL.un,
          tipo: 'entrada', motivo: 'Estoque inicial da vitrine de demonstração', operadorId: null, deviceId: 'vitrine_demo',
        });
        if (!e.ok) throw new Error(`Estoque do produto de demonstração ${sku}: ${e.error}`);
        criados++;
      }
    }
  })();
  return { criados };
}

/** Catálogo público de um segmento, com os produtos DEMO- desta máquina.
 * Mesmo formato de vitrineService.montarCatalogo (sem custo nem estoque exato). */
function montarCatalogoDemo(segmento) {
  const catalogo = CATALOGOS_DEMO[segmento];
  if (!catalogo) return { itens: [] };
  const db = getDb();
  const { precoEfetivo } = require('./productService');
  const { faixaDeEstoque } = require('./vitrineService');
  const ordem = new Map(catalogo.itens.map((item, i) => [skuDe(item), i]));
  const skus = [...ordem.keys()];
  const marcas = skus.map(() => '?').join(',');
  const produtos = db.prepare(
    `SELECT id, sku, nome, categoria, preco, preco_promocional, promocao_valida_ate, unidade, tipo FROM products
     WHERE ativo = 1 AND sku IN (${marcas})`
  ).all(...skus);
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  const estoques = new Map();
  if (location && produtos.length) {
    const ids = produtos.map((p) => p.id);
    const linhas = db.prepare(
      `SELECT product_id, COALESCE(SUM(quantidade), 0) AS total FROM stock_movements
       WHERE location_id = ? AND product_id IN (${ids.map(() => '?').join(',')}) GROUP BY product_id`
    ).all(location.id, ...ids);
    for (const l of linhas) estoques.set(l.product_id, l.total);
  }
  const itens = produtos
    .sort((a, b) => ordem.get(a.sku) - ordem.get(b.sku))
    .map((p) => {
      const preco = precoEfetivo(p);
      if (!(preco > 0)) return null;
      const estoque = p.tipo === 'servico' ? null : (estoques.get(p.id) ?? 0);
      return {
        id: p.id, nome: p.nome, categoria: p.categoria || null, preco: arred(preco),
        ...(preco !== p.preco ? { precoDe: arred(p.preco) } : {}),
        unidade: p.unidade || 'un', disponibilidade: faixaDeEstoque(estoque, AVISO_POUCAS_UNIDADES),
      };
    })
    .filter(Boolean);
  return { itens };
}

async function publicarCatalogos() {
  if (!estado.maquinaDemo) return { publicados: 0 };
  if (estado.publicando) return estado.publicando;
  estado.publicando = (async () => {
    try {
      const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
      const firestore = require('./licenseService').getLicenseFirestore();
      const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
      let publicados = 0;
      for (const segmento of segmentos()) {
        const { itens } = montarCatalogoDemo(segmento);
        const hash = crypto.createHash('sha256').update(JSON.stringify(itens)).digest('hex');
        if (estado.hashes.get(segmento) === hash) continue;
        await setDoc(doc(firestore, 'installations', installId, 'vitrine', `demo_${segmento}`), { segmento, itens, atualizadoEm: serverTimestamp() });
        estado.hashes.set(segmento, hash);
        publicados++;
      }
      return { publicados };
    } catch (err) {
      console.error('[vitrineDemoService] publicar catálogos falhou:', err?.message || err);
      return { publicados: 0, erro: true };
    } finally {
      estado.publicando = null;
    }
  })();
  return estado.publicando;
}

// ---------- pedidos ----------

/** 'aberta' | 'inexistente' (não é demo desta máquina) | 'encerrada' | 'expirada'. */
function situacaoDaDemo(vitrine, installId, agoraMs) {
  if (!vitrine || vitrine.installId !== installId || !vitrine.demo || typeof vitrine.demo !== 'object') return 'inexistente';
  if (vitrine.ativa === false) return 'encerrada';
  const expira = vitrine.demo.expiraEm;
  const expiraMs = typeof expira?.toMillis === 'function' ? expira.toMillis() : Number(expira);
  if (!(expiraMs > agoraMs)) return 'expirada';
  return 'aberta';
}

/** Só produto DEMO- ativo desta máquina; quantidade inteira (ou em 3 casas
 * para kg/l/m), de 0 a 99; itens repetidos somados; até 40 linhas. */
function itensValidosDoPedido(itensBrutos) {
  if (!Array.isArray(itensBrutos)) return [];
  const buscar = getDb().prepare('SELECT id, unidade FROM products WHERE id = ? AND ativo = 1 AND sku LIKE ?');
  const porProduto = new Map();
  for (const bruto of itensBrutos.slice(0, LIMITE_ITENS_PEDIDO)) {
    const id = typeof bruto?.produtoId === 'string' ? bruto.produtoId.slice(0, 64) : null;
    const q = Number(bruto?.quantidade);
    if (!id || !Number.isFinite(q) || q <= 0) continue;
    const produto = buscar.get(id, `${PREFIXO_SKU_DEMO}%`);
    if (!produto) continue;
    const fracionada = FRACIONADAS.includes(String(produto.unidade || '').toLowerCase());
    const quantidade = fracionada ? arred(q, 3) : Math.round(q);
    if (quantidade <= 0 || quantidade > QTD_MAXIMA_ITEM) continue;
    const somado = arred((porProduto.get(id) || 0) + quantidade, 3);
    if (somado > QTD_MAXIMA_ITEM) continue;
    porProduto.set(id, somado);
  }
  return [...porProduto.entries()].map(([productId, quantidade]) => ({ productId, quantidade }));
}

function observacoesDoPedido({ pagamento, trocoPara, observacao }) {
  const partes = ['Pedido da vitrine de demonstração.'];
  const forma = PAGAMENTOS[pagamento];
  if (forma) {
    const troco = pagamento === 'dinheiro' && Number(trocoPara) > 0 && Number(trocoPara) <= 10000 ? ` (troco para ${moeda(trocoPara)})` : '';
    partes.push(`Pagamento: ${forma}${troco}.`);
  }
  const obs = limparTexto(observacao, 200);
  if (obs) partes.push(`Obs.: ${obs}`);
  return partes.join(' ');
}

/** Cria o pedido local (bot_orders) -- sem rede, exportada pra teste.
 * Idempotente pelo id do documento do Firestore (`pedidoId`). */
function criarPedidoDemo({ pedidoId, slug, nome, modo, endereco, pagamento, trocoPara, observacao, itens }) {
  const db = getDb();
  if (typeof pedidoId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(pedidoId)) return { ok: false, error: 'Pedido inválido.' };
  if (typeof slug !== 'string' || !SLUG_VALIDO.test(slug)) return { ok: false, error: 'Endereço da vitrine inválido.' };
  const ja = db.prepare('SELECT id FROM bot_orders WHERE canal = ? AND canal_ref = ?').get(CANAL, pedidoId);
  if (ja) return { ok: true, id: ja.id, jaExistia: true };

  const recebidos = db.prepare('SELECT COUNT(*) AS n FROM bot_orders WHERE canal = ? AND vitrine_slug = ?').get(CANAL, slug).n;
  if (recebidos >= LIMITE_PEDIDOS_POR_DEMO) return { ok: false, error: `Esta demonstração já recebeu o máximo de ${LIMITE_PEDIDOS_POR_DEMO} pedidos.` };

  const nomeLimpo = limparTexto(nome, 60);
  if (nomeLimpo.length < 2) return { ok: false, error: 'Informe o nome.' };
  const tipo = modo === 'entrega' ? 'entrega' : 'retirada';
  const enderecoLimpo = limparTexto(endereco, 200);
  if (tipo === 'entrega' && enderecoLimpo.length < 6) return { ok: false, error: 'Informe o endereço de entrega.' };
  const validos = itensValidosDoPedido(itens);
  if (!validos.length) return { ok: false, error: 'Nenhum produto do pedido existe na loja de demonstração.' };

  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  if (!location) return { ok: false, error: 'Nenhum local cadastrado nesta instalação.' };

  const botOrderService = require('./botOrderService');
  let orderId = null;
  try {
    db.transaction(() => {
      const r = botOrderService.createOrder({
        locationId: location.id, clienteNome: nomeLimpo, clienteTelefone: TELEFONE_PEDIDO, tipoEntrega: tipo,
        endereco: tipo === 'entrega' ? enderecoLimpo : null,
        observacoes: observacoesDoPedido({ pagamento, trocoPara, observacao }), origem: 'manual', itens: validos,
      });
      if (!r.ok) throw new Error(r.error);
      // Índice único (canal, canal_ref): reentrega do mesmo documento não duplica.
      db.prepare('UPDATE bot_orders SET canal = ?, canal_ref = ?, vitrine_slug = ? WHERE id = ?').run(CANAL, pedidoId, slug, r.id);
      orderId = r.id;
    })();
  } catch (err) {
    const ja2 = db.prepare('SELECT id FROM bot_orders WHERE canal = ? AND canal_ref = ?').get(CANAL, pedidoId);
    if (ja2) return { ok: true, id: ja2.id, jaExistia: true };
    return { ok: false, error: err?.message || 'Não foi possível registrar o pedido.' };
  }
  const { total } = db.prepare('SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS total FROM bot_order_items WHERE bot_order_id = ?').get(orderId);
  return { ok: true, id: orderId, itens: validos.length, total: arred(total), nome: nomeLimpo, tipo };
}

/** Um documento de installations/{id}/pedidos_vitrine com status 'novo'. */
async function processarPedidoRecebido(docSnap, { firestore, installId }) {
  const pedidoId = docSnap.id;
  const dados = docSnap.data() || {};
  if (dados.status !== 'novo' || estado.processando.has(pedidoId)) return;
  estado.processando.add(pedidoId);
  const { doc, getDoc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const ref = doc(firestore, 'installations', installId, 'pedidos_vitrine', pedidoId);
  const recusar = (erro) => updateDoc(ref, { status: 'erro', erro, processadoEm: serverTimestamp() }).catch(() => {});
  try {
    const slug = typeof dados.slug === 'string' && SLUG_VALIDO.test(dados.slug) ? dados.slug : null;
    if (!slug) { await recusar('Endereço da vitrine inválido.'); return; }
    const vitrine = await getDoc(doc(firestore, 'vitrines', slug));
    const situacao = situacaoDaDemo(vitrine.exists() ? vitrine.data() : null, installId, Date.now());
    if (situacao !== 'aberta') {
      await recusar(situacao === 'inexistente' ? 'Demonstração não encontrada nesta loja.' : 'Esta demonstração já terminou.');
      return;
    }
    const r = criarPedidoDemo({ ...dados, pedidoId, slug });
    if (!r.ok) { await recusar(r.error); return; }
    await updateDoc(ref, { status: 'recebido', bot_order_id: r.id, processadoEm: serverTimestamp() });
    if (!r.jaExistia) {
      try { require('./notificationService').notifyNewVitrineOrder(r); } catch { /* aviso é extra */ }
      publicarCatalogos().catch(() => {}); // estoque mudou a faixa? (só publica se mudou)
    }
  } catch (err) {
    console.error('[vitrineDemoService] falha ao processar pedido da vitrine de demonstração:', err);
    await recusar('Não foi possível registrar o pedido na loja.');
  } finally {
    estado.processando.delete(pedidoId);
  }
}

function pararEscutaPedidos() {
  if (estado.pararEscuta) { try { estado.pararEscuta(); } catch { /* já parada */ } }
  estado.pararEscuta = null;
}

function iniciarEscutaPedidos() {
  pararEscutaPedidos();
  try {
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const firestore = require('./licenseService').getLicenseFirestore();
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    estado.pararEscuta = onSnapshot(
      query(collection(firestore, 'installations', installId, 'pedidos_vitrine'), where('status', '==', 'novo')),
      (snap) => {
        snap.docChanges().forEach((mudanca) => {
          if (mudanca.type === 'removed') return;
          processarPedidoRecebido(mudanca.doc, { firestore, installId });
        });
      },
      (err) => console.error('[vitrineDemoService] escuta de pedidos da vitrine de demonstração falhou:', err)
    );
  } catch (err) {
    console.error('[vitrineDemoService] não foi possível iniciar a escuta:', err);
  }
}

// ---------- liga/desliga (Central) ----------

function iniciar() {
  try { garantirProdutosDemo(); } catch (err) { console.error('[vitrineDemoService] produtos de demonstração:', err); }
  publicarCatalogos().catch(() => {});
  if (estado.intervalo) clearInterval(estado.intervalo);
  estado.intervalo = setInterval(() => { publicarCatalogos().catch(() => {}); }, 5 * 60 * 1000);
  iniciarEscutaPedidos();
}

function parar() {
  if (estado.intervalo) clearInterval(estado.intervalo);
  estado.intervalo = null;
  pararEscutaPedidos();
  estado.hashes.clear();
}

/** `installations/{id}.maquinaDemo` (só a Central grava) -- chamado pelo
 * licenseService a cada leitura do documento da instalação. */
function aplicarDaInstalacao(dados) {
  const ligar = dados?.maquinaDemo === true;
  if (ligar === estado.maquinaDemo) return;
  estado.maquinaDemo = ligar;
  if (ligar) iniciar(); else parar();
}

/** Para a tela Configurações → Vitrine online da máquina de demonstração:
 * demonstrações abertas com link e QR, e se a aba Separação está ligada. */
async function listarDemos() {
  const base = { maquinaDemo: estado.maquinaDemo, separacaoAtiva: require('./botOrderService').getConfig().ativo, demos: [] };
  if (!estado.maquinaDemo) return base;
  try {
    const { collection, query, where, getDocs } = require('firebase/firestore');
    const firestore = require('./licenseService').getLicenseFirestore();
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    const snap = await getDocs(query(collection(firestore, 'vitrines'), where('installId', '==', installId)));
    const contar = getDb().prepare('SELECT COUNT(*) AS n FROM bot_orders WHERE canal = ? AND vitrine_slug = ?');
    const { linkPublico } = require('./vitrineService');
    const agora = Date.now();
    for (const d of snap.docs) {
      const v = d.data();
      if (situacaoDaDemo(v, installId, agora) !== 'aberta') continue;
      const link = linkPublico(d.id);
      let qrDataUrl = null;
      try { qrDataUrl = await require('qrcode').toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 360 }); } catch { qrDataUrl = null; }
      base.demos.push({
        slug: d.id, link, qrDataUrl,
        nomeLoja: limparTexto(v.demo.nomeLoja, 80) || 'Loja de demonstração',
        segmento: CATALOGOS_DEMO[v.demo.segmento]?.rotulo || String(v.demo.segmento || ''),
        expiraEmMs: typeof v.demo.expiraEm?.toMillis === 'function' ? v.demo.expiraEm.toMillis() : Number(v.demo.expiraEm),
        pedidosRecebidos: contar.get(CANAL, d.id).n,
      });
    }
    base.demos.sort((a, b) => b.expiraEmMs - a.expiraEmMs);
  } catch (err) {
    console.error('[vitrineDemoService] listar demonstrações falhou:', err?.message || err);
    base.erro = 'Não consegui consultar as demonstrações agora (sem internet?).';
  }
  return base;
}

/** A Central marcou esta instalação como máquina de demonstração
 * (`installations/{id}.maquinaDemo`). Usado também pela demonstração
 * completa (demoDataService), que aceita carregar com vendas só aqui. */
function ehMaquinaDemo() {
  return estado.maquinaDemo === true;
}

module.exports = {
  aplicarDaInstalacao, listarDemos, publicarCatalogos, ehMaquinaDemo,
  // Exportados pra teste (parte local, sem rede).
  garantirProdutosDemo, montarCatalogoDemo, itensValidosDoPedido, criarPedidoDemo, situacaoDaDemo, observacoesDoPedido,
  CANAL, LIMITE_PEDIDOS_POR_DEMO, TELEFONE_PEDIDO,
};
