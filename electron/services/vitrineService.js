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
const MODOS_VALIDOS = ['retirada', 'entrega'];
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

function linkPublico(slug) {
  return `https://gerenciaai-garcom.web.app/loja.html?s=${encodeURIComponent(slug)}`;
}

function saveConfig({ ativa, ocultarSemEstoque, avisoPoucasUnidades, mensagem, modos, pedidoMinimo, requestingUserId }) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) {
    return { ok: false, error: 'Apenas um gerente ou administrador pode mudar a vitrine online.' };
  }
  const listaModos = Array.isArray(modos) ? [...new Set(modos)].filter((m) => MODOS_VALIDOS.includes(m)) : [];
  if (ativa && listaModos.length === 0) return { ok: false, error: 'Escolha pelo menos retirada na loja ou entrega.' };
  const aviso = Number(avisoPoucasUnidades);
  if (!Number.isInteger(aviso) || aviso < 0 || aviso > 1000) return { ok: false, error: 'Aviso de "poucas unidades" precisa ser um número inteiro (0 desliga).' };
  const minimo = Number(pedidoMinimo);
  if (!Number.isFinite(minimo) || minimo < 0 || minimo > 100000) return { ok: false, error: 'Pedido mínimo inválido.' };
  getRow();
  db.prepare(
    `UPDATE vitrine_config SET ativa = ?, ocultar_sem_estoque = ?, aviso_poucas_unidades = ?, mensagem = ?, modos = ?,
       pedido_minimo = ?, atualizado_por_id = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`
  ).run(ativa ? 1 : 0, ocultarSemEstoque ? 1 : 0, aviso, String(mensagem || '').trim().slice(0, 280), JSON.stringify(listaModos),
    Math.round(minimo * 100) / 100, requestingUserId);
  require('./authService').registrarEventoAuditoria({
    tipoEvento: 'vitrine_alterada', solicitanteId: requestingUserId, motivo: ativa ? 'Vitrine online ligada/ajustada' : 'Vitrine online desligada',
  });
  publicarSeMudou().catch(() => {});
  return { ok: true, config: getConfig() };
}

/** Endereço criado na Central (installations/{id}.vitrineSlug). */
function aplicarDaInstalacao(dados) {
  const slug = typeof dados?.vitrineSlug === 'string' && SLUG_VALIDO.test(dados.vitrineSlug) ? dados.vitrineSlug : null;
  const atual = getRow().slug || null;
  if (slug === atual) return;
  getDb().prepare(`UPDATE vitrine_config SET slug = ?, ultimo_hash = NULL WHERE id = 'default'`).run(slug);
  publicarSeMudou().catch(() => {});
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
  SLUG_VALIDO,
};
