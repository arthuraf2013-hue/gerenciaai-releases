// Ponte produtos do GerenciaAI -> Price do Vértice (tabelas de preço nas TVs).
//
// Ao conectar e a cada 5 minutos, lê o catálogo ativo (products.list) e manda ao
// Vértice. O módulo do Vértice (verticeSync.syncProducts) lembra o que já foi
// enviado e só grava o que mudou: preço trocado no caixa aparece na TV em minutos.
// Produto desativado ou excluído some da lista do Price.

/** Produto do SQLite -> formato do Vértice. Pura -- exportada pra teste. */
export function produtoParaVertice(p, hoje = null) {
  if (!p || !p.id || !p.nome || p.ativo === 0 || p.ativo === false) return null;
  const preco = Number(p.preco) || 0;
  const promo = Number(p.preco_promocional) || 0;
  const ate = p.promocao_valida_ate ? String(p.promocao_valida_ate).slice(0, 10) : null;
  // Promoção vencida ou maior que o preço normal não vai (a TV mostraria "de/por" errado).
  const promoValida = promo > 0 && promo < preco && (!ate || !hoje || ate >= hoje);
  return {
    id: String(p.id),
    name: String(p.nome).trim(),
    category: p.categoria || null,
    unit: p.unidade || null,
    price: preco,
    promoPrice: promoValida ? promo : null,
    promoUntil: promoValida ? ate : null,
  };
}

export function iniciarPonteProdutos(vx, { intervaloMs = 5 * 60000 } = {}) {
  let parado = false;
  let rodando = false;
  let statusAnterior = null;

  async function sincronizar() {
    if (parado || rodando || !vx.isPaired() || typeof vx.syncProducts !== 'function') return;
    rodando = true;
    try {
      const r = await window.pdv.products.list({});
      if (r && r.ok === false) return;
      const linhas = Array.isArray(r) ? r : r?.data || r?.items || [];
      const hoje = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD no fuso local
      await vx.syncProducts(linhas.map((p) => produtoParaVertice(p, hoje)).filter(Boolean));
    } catch (err) {
      console.warn('[vertice] produtos não enviados', err?.message || err);
    } finally {
      rodando = false;
    }
  }

  // Só quando acabou de conectar (cada envio também muda o estado: não pode disparar de novo).
  const pararEstado = vx.onState((s) => {
    if (s.status === 'paired' && statusAnterior !== 'paired') sincronizar();
    statusAnterior = s.status;
  });
  const ciclo = setInterval(sincronizar, intervaloMs);
  return () => { parado = true; pararEstado(); clearInterval(ciclo); };
}
