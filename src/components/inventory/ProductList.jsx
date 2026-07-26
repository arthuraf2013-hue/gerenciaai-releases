import { useEffect, useRef, useState } from 'react';
import { ProductForm } from './ProductForm';
import { ProductThumbnail } from '../pos/ProductThumbnail';
import { StockAdjustModal } from './StockAdjustModal';
import { useSession } from '../../context/SessionContext';

const PAGE_SIZE = 60;

export function ProductList() {
  const { currentUser } = useSession();
  const [products, setProducts] = useState([]);
  const [estoquePorProduto, setEstoquePorProduto] = useState({});
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // null = fechado, {} = novo, {...} = editar
  const [adjusting, setAdjusting] = useState(null); // produto sendo ajustado, ou null
  const [ioMessage, setIoMessage] = useState(null);
  const [ioBusy, setIoBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [totalProdutos, setTotalProdutos] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef(null);
  const reloadTokenRef = useRef(0);

  // Carrega o primeiro lote (ou refaz do zero quando a busca muda) — o
  // resto vem por rolagem infinita em loadMore(), pra nunca precisar
  // trazer o catálogo inteiro de uma vez e travar a tela.
  async function reload() {
    // Cada letra digitada dispara uma nova busca; a resposta de uma
    // busca mais antiga pode chegar DEPOIS da mais nova (a rede/IPC não
    // garante ordem de chegada). Sem isso, uma resposta atrasada de uma
    // busca anterior sobrescrevia a lista certa com uma errada — mesmo
    // a busca sendo iniciada nessa ordem, a mais lenta "vencia" por
    // chegar por último e aplicar seu resultado desatualizado.
    const meuToken = ++reloadTokenRef.current;
    const queryDestaBusca = query;

    setHasMore(true);
    const list = await window.pdv.products.list({ query: queryDestaBusca || undefined, limit: PAGE_SIZE, offset: 0 });
    if (meuToken !== reloadTokenRef.current) return; // já tem busca mais nova em andamento — descarta esta resposta atrasada

    if (!Array.isArray(list)) {
      setProducts([]);
      setHasMore(false);
      setLoadError(list?.error || 'Não foi possível carregar os produtos.');
      return;
    }
    setLoadError('');
    setProducts(list);
    setHasMore(list.length === PAGE_SIZE);

    window.pdv.products.count({ query: queryDestaBusca || undefined }).then((total) => {
      if (meuToken === reloadTokenRef.current) setTotalProdutos(total);
    });

    const estoque = await window.pdv.stock.getForLocation({ locationId: window.APP_LOCATION_ID });
    if (meuToken !== reloadTokenRef.current) return;
    if (Array.isArray(estoque)) {
      const mapa = {};
      estoque.forEach((e) => { mapa[e.id] = e.estoque_atual; });
      setEstoquePorProduto(mapa);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    const meuToken = reloadTokenRef.current;
    setLoadingMore(true);
    const list = await window.pdv.products.list({ query: query || undefined, limit: PAGE_SIZE, offset: products.length });
    setLoadingMore(false);
    if (meuToken !== reloadTokenRef.current) return; // a busca mudou enquanto isso carregava — descarta
    if (!Array.isArray(list)) return;
    setProducts((prev) => [...prev, ...list]);
    setHasMore(list.length === PAGE_SIZE);
  }

  useEffect(() => { reload(); }, [query]);

  // Observa um marcador invisível logo depois da tabela — quando ele
  // entra na área visível da rolagem, carrega o próximo lote sozinho.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const scrollContainer = sentinel.closest('.main-content');

    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { root: scrollContainer || null, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [products.length, hasMore, loadingMore, query]);

  async function handleExport() {
    setIoBusy(true);
    const result = await window.pdv.io.exportProducts({ locationId: window.APP_LOCATION_ID });
    setIoBusy(false);
    if (result.canceled) return;
    setIoMessage(result.ok ? `${result.total} produtos exportados com sucesso.` : result.error);
  }

  async function handleImport() {
    setIoBusy(true);
    const result = await window.pdv.io.importProducts({
      locationId: window.APP_LOCATION_ID,
      operadorId: currentUser.id,
      deviceId: window.APP_DEVICE_ID,
    });
    setIoBusy(false);
    if (result.canceled) return;
    if (!result.ok) return setIoMessage(result.error);

    const { importados, atualizados, erros, total } = result.report;
    let msg = `${total} linhas processadas: ${importados} novos produtos, ${atualizados} atualizados.`;
    if (erros.length > 0) msg += ` ${erros.length} linha(s) com erro (linha ${erros[0].linha}: ${erros[0].erro}${erros.length > 1 ? '...' : ''}).`;
    setIoMessage(msg);
    reload();
  }

  async function handleDelete(product) {
    const estoqueAtual = estoquePorProduto[product.id];
    const avisoEstoque = typeof estoqueAtual === 'number' && estoqueAtual > 0
      ? `\n\nAtenção: ainda há ${estoqueAtual} ${product.unidade || 'un'} em estoque registrado para este produto.`
      : '';
    if (!confirm(`Excluir "${product.nome}"? Ele deixa de aparecer no PDV e nas listagens, mas o histórico de vendas não é afetado.${avisoEstoque}`)) {
      return;
    }
    const result = await window.pdv.products.deactivate({ productId: product.id });
    if (!result.ok) return setIoMessage(result.error);
    reload();
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Produtos {totalProdutos !== null && <span className="screen-hint" style={{ fontWeight: 400, fontSize: 15 }}>({totalProdutos} no total)</span>}</h1>
        <div className="screen-actions">
          <button className="btn-secondary" onClick={handleImport} disabled={ioBusy}>Importar planilha</button>
          <button className="btn-secondary" onClick={handleExport} disabled={ioBusy}>Exportar planilha</button>
          <button className="btn-primary" onClick={() => setEditing({})}>+ Novo produto</button>
        </div>
      </div>

      <p className="screen-hint">
        A importação segue o modelo em <code>templates/modelo_importacao_estoque.xlsx</code> —
        baixe, preencha e importe para trazer o estoque de outro sistema.
      </p>

      {ioMessage && <p className="io-message">{ioMessage}</p>}
      {loadError && <p className="modal-error">{loadError}</p>}

      <input
        className="search-input"
        placeholder="Buscar por nome, SKU ou código de barras..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <table className="data-table">
        <thead>
          <tr>
            <th></th><th>Nome</th><th>SKU</th><th>Categoria</th><th>Preço</th><th>Estoque atual</th><th>Mín.</th><th></th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const estoqueAtual = estoquePorProduto[p.id] ?? '—';
            const abaixoDoMinimo = typeof estoqueAtual === 'number' && estoqueAtual <= p.estoque_minimo;
            return (
              <tr key={p.id}>
                <td><ProductThumbnail product={p} size={36} /></td>
                <td>{p.nome}</td>
                <td>{p.sku}</td>
                <td>{p.categoria}</td>
                <td>R$ {p.preco.toFixed(2)}</td>
                <td className={abaixoDoMinimo ? 'text-danger' : ''}>{estoqueAtual}</td>
                <td>{p.estoque_minimo}</td>
                <td style={{ display: 'flex', gap: 10 }}>
                  <button className="btn-link" onClick={() => setEditing(p)}>Editar</button>
                  <button className="btn-link" onClick={() => setAdjusting(p)}>Ajustar estoque</button>
                  <button className="btn-link-danger" onClick={() => handleDelete(p)}>Excluir</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div ref={sentinelRef} style={{ height: 1 }} />
      {loadingMore && <p className="empty-state">Carregando mais produtos...</p>}
      {!hasMore && products.length > 0 && <p className="empty-state">Fim da lista — {products.length} produto(s).</p>}
      {!loadError && products.length === 0 && <p className="empty-state">Nenhum produto encontrado.</p>}

      {editing !== null && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-wide">
            <ProductForm
              product={editing.id ? editing : null}
              onSaved={() => { setEditing(null); reload(); }}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      {adjusting && (
        <StockAdjustModal
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onAdjusted={() => { setAdjusting(null); reload(); }}
        />
      )}
    </div>
  );
}
