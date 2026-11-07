// Contas e texto do pedido da vitrine online (loja.js) -- sem Firebase nem
// DOM, pra tests/vitrineLoja.test.js testar direto.

const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function formatarMoeda(v) {
  return fmtMoeda.format(Number(v) || 0);
}

const FRACIONADAS = ['kg', 'l', 'm'];
function unidadeFracionada(unidade) {
  return FRACIONADAS.includes(String(unidade || '').toLowerCase());
}

/** Quanto o +/- muda: 0,1 em kg/l/m, 1 no resto. */
function passoDa(unidade) {
  return unidadeFracionada(unidade) ? 0.1 : 1;
}

/** Primeira quantidade ao tocar em "+": meio quilo/litro, ou 1. */
function quantidadeInicial(unidade) {
  return unidadeFracionada(unidade) ? 0.5 : 1;
}

function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

function formatarQuantidade(q, unidade) {
  const n = arred(q, 3);
  const texto = n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  return unidadeFracionada(unidade) ? `${texto} ${unidade}` : `${texto}x`;
}

const SLUG_VALIDO = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
function slugValido(s) {
  return typeof s === 'string' && SLUG_VALIDO.test(s);
}

/** Itens do carrinho com o preço ATUAL do catálogo; some o que saiu. */
function itensDoCarrinho(carrinho, catalogo) {
  const porId = new Map((catalogo || []).map((p) => [p.id, p]));
  const itens = [];
  for (const [id, quantidade] of Object.entries(carrinho || {})) {
    const p = porId.get(id);
    const q = Number(quantidade);
    if (!p || !(q > 0) || p.disponibilidade === 'esgotado') continue;
    itens.push({ ...p, quantidade: arred(q, 3), total: arred(p.preco * q) });
  }
  return itens;
}

function totalDoCarrinho(itens) {
  return arred(itens.reduce((s, i) => s + i.total, 0));
}

const PAGAMENTOS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão (na entrega/retirada)' };

/** Texto que vai pro WhatsApp da loja. */
function montarMensagemPedido({ nomeLoja, itens, nome, modo, endereco, pagamento, trocoPara, observacao }) {
  const linhas = [`Olá${nomeLoja ? `, ${nomeLoja}` : ''}! Quero fazer um pedido pela vitrine online:`, ''];
  for (const i of itens) linhas.push(`• ${formatarQuantidade(i.quantidade, i.unidade)} ${i.nome} — ${formatarMoeda(i.total)}`);
  linhas.push('', `*Total estimado: ${formatarMoeda(totalDoCarrinho(itens))}*`);
  if (nome) linhas.push(`Nome: ${nome}`);
  linhas.push(modo === 'entrega' ? `Entrega: ${endereco || '(endereço não informado)'}` : 'Retirada na loja');
  if (pagamento) {
    const troco = pagamento === 'dinheiro' && Number(trocoPara) > 0 ? ` (troco para ${formatarMoeda(trocoPara)})` : '';
    linhas.push(`Pagamento: ${PAGAMENTOS[pagamento] || pagamento}${troco}`);
  }
  if (observacao) linhas.push(`Observação: ${observacao}`);
  linhas.push('', '(Preços da vitrine. A loja confirma valores e disponibilidade.)');
  return linhas.join('\n');
}

function linkWhatsapp(numero, texto) {
  const d = String(numero || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 13) return null;
  return `https://wa.me/${d.length <= 11 ? `55${d}` : d}?text=${encodeURIComponent(texto)}`;
}

/** Documento do pedido da vitrine de DEMONSTRAÇÃO (installations/{id}/pedidos_vitrine),
 * no formato que firestore.rules aceita (o `criadoEm` entra no loja.js, com a
 * hora do servidor). Só id do produto e quantidade: preço é sempre o da loja. */
function montarPedidoDemo({ slug, itens, nome, modo, endereco, pagamento, trocoPara, observacao }) {
  const pedido = {
    slug: String(slug || ''),
    status: 'novo',
    nome: String(nome || '').trim().slice(0, 60),
    modo: modo === 'entrega' ? 'entrega' : 'retirada',
    pagamento: Object.prototype.hasOwnProperty.call(PAGAMENTOS, pagamento) ? pagamento : 'pix',
    itens: (itens || []).slice(0, 40).map((i) => ({ produtoId: String(i.id), quantidade: arred(i.quantidade, 3) })),
  };
  if (pedido.modo === 'entrega') pedido.endereco = String(endereco || '').trim().slice(0, 200);
  const troco = Number(String(trocoPara ?? '').replace(',', '.'));
  if (pedido.pagamento === 'dinheiro' && troco > 0) pedido.trocoPara = arred(Math.min(troco, 10000));
  const obs = String(observacao || '').trim().slice(0, 200);
  if (obs) pedido.observacao = obs;
  return pedido;
}

// Pedido direto no sistema da loja (vitrine com "receber os pedidos direto
// no sistema", ver electron/services/vitrinePedidoService.js). Pagamentos:
const PAGAMENTOS_LOJA = {
  pix_online: 'Pagar agora com Pix',
  pix: 'Pix na retirada',
  dinheiro: 'Dinheiro na retirada',
  cartao: 'Cartão na retirada',
};
const TOKEN_MESA = /^[A-Za-z0-9]{24}$/;

/** Rótulo da forma de receber, com a mesa do QR quando houver. */
function rotuloModo(modo, mesaRotulo) {
  if (modo === 'local') return mesaRotulo ? `Comer aqui · ${mesaRotulo}` : 'Comer aqui';
  if (modo === 'entrega') return 'Entrega';
  return mesaRotulo ? 'Retirar no balcão' : 'Retirar na loja';
}

/** Formas de receber que a página oferece (pelo QR da mesa, "comer aqui" vem primeiro). */
function modosOferecidos(modosDaLoja, { mesaRotulo, pedidosOnline } = {}) {
  const modos = (Array.isArray(modosDaLoja) ? modosDaLoja : []).filter((m) => ['retirada', 'entrega', 'local'].includes(m) && (m !== 'local' || pedidosOnline));
  if (mesaRotulo && pedidosOnline) {
    // Pela mesa não tem entrega; "comer aqui" sempre (é o motivo do QR).
    return ['local', ...modos.filter((m) => m === 'retirada')];
  }
  return modos;
}

/** Documento installations/{id}/pedidos_vitrine/{id} no formato que firestore.rules aceita. */
function montarPedidoLoja({ slug, itens, nome, modo, endereco, pagamento, trocoPara, observacao, mesaToken }) {
  const modoFinal = ['retirada', 'entrega', 'local'].includes(modo) ? modo : 'retirada';
  const comMesa = modoFinal === 'local' && TOKEN_MESA.test(String(mesaToken || ''));
  const pedido = {
    slug: String(slug || ''),
    status: 'novo',
    nome: String(nome || '').trim().slice(0, 60),
    modo: modoFinal,
    pagamento: comMesa ? 'mesa' : (Object.prototype.hasOwnProperty.call(PAGAMENTOS_LOJA, pagamento) ? pagamento : 'pix'),
    itens: (itens || []).slice(0, 40).map((i) => ({ produtoId: String(i.id), quantidade: arred(i.quantidade, 3) })),
  };
  if (comMesa) pedido.mesa = String(mesaToken);
  if (modoFinal === 'entrega') pedido.endereco = String(endereco || '').trim().slice(0, 200);
  const troco = Number(String(trocoPara ?? '').replace(',', '.'));
  if (pedido.pagamento === 'dinheiro' && troco > 0) pedido.trocoPara = arred(Math.min(troco, 10000));
  const obs = String(observacao || '').trim().slice(0, 200);
  if (obs) pedido.observacao = obs;
  return pedido;
}

/** Mesmo hash do computador (vitrineService.hashTokenMesa): sha256, 24 primeiros hex. */
async function hashTokenMesa(token) {
  if (!TOKEN_MESA.test(String(token || ''))) return null;
  const dados = new TextEncoder().encode(String(token));
  const buf = await globalThis.crypto.subtle.digest('SHA-256', dados);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

/**
 * Passo a passo do acompanhamento, a partir do pedido gravado (status do
 * documento: novo/recebido/erro) e da etapa publicada pela loja.
 * Devolve { fase, passos: [{ texto, feito }] }.
 */
function passosDoPedido({ statusDoc, etapa, comMesa, pixOnline }) {
  const e = etapa?.etapa || null;
  const recebido = statusDoc === 'recebido' || !!e;
  const pago = !!etapa?.pago;
  const ordem = ['recebido', 'pagamento', 'preparando', 'pronto', 'entregue'];
  const nivel = (x) => (x === 'na_mesa' || x === 'saiu' ? 4 : ordem.indexOf(x));
  const n = nivel(e);
  if (comMesa) {
    return {
      fase: statusDoc === 'erro' ? 'erro' : (e === 'cancelado' ? 'cancelado' : (e === 'na_mesa' ? 'na_mesa' : (recebido ? 'recebido' : 'enviado'))),
      passos: [
        { texto: 'Pedido enviado', feito: true },
        { texto: 'Recebido pela loja', feito: recebido },
        { texto: 'Confirmado e lançado na sua mesa', feito: e === 'na_mesa' },
      ],
    };
  }
  const passos = [
    { texto: 'Pedido enviado', feito: true },
    { texto: 'Recebido pela loja', feito: recebido },
  ];
  if (pixOnline || e === 'pagamento' || pago) passos.push({ texto: 'Pagamento no Pix', feito: pago });
  passos.push({ texto: 'Preparando (você recebe a senha)', feito: n >= 2 });
  passos.push({ texto: 'Pronto para retirar', feito: n >= 3 });
  let fase = 'enviado';
  if (statusDoc === 'erro') fase = 'erro';
  else if (e === 'cancelado') fase = 'cancelado';
  else if (e) fase = e;
  else if (recebido) fase = 'recebido';
  return { fase, passos };
}

/** "28:41" até o Pix vencer (ou null). */
function tempoRestante(expiraEmIso, agoraMs = Date.now()) {
  const fim = Date.parse(expiraEmIso || '');
  if (!Number.isFinite(fim)) return null;
  const s = Math.max(0, Math.floor((fim - agoraMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export {
  formatarMoeda, unidadeFracionada, passoDa, quantidadeInicial, arred, formatarQuantidade, slugValido,
  itensDoCarrinho, totalDoCarrinho, montarMensagemPedido, linkWhatsapp, normalizar, PAGAMENTOS, montarPedidoDemo,
  PAGAMENTOS_LOJA, rotuloModo, modosOferecidos, montarPedidoLoja, hashTokenMesa, passosDoPedido, tempoRestante,
};
