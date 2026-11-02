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

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export {
  formatarMoeda, unidadeFracionada, passoDa, quantidadeInicial, arred, formatarQuantidade, slugValido,
  itensDoCarrinho, totalDoCarrinho, montarMensagemPedido, linkWhatsapp, normalizar, PAGAMENTOS, montarPedidoDemo,
};
