import { useEffect, useRef, useState } from 'react';
import { ProductForm } from './ProductForm';
import { ProductThumbnail } from '../pos/ProductThumbnail';
import { StockAdjustModal } from './StockAdjustModal';
import { DuplicateProductsModal } from './DuplicateProductsModal';
import { BarcodeRelinkModal } from './BarcodeRelinkModal';
import { useSession } from '../../context/SessionContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEscToClose } from '../../hooks/useEscToClose';
import { DropdownMenu, DropdownMenuItem } from '../common/DropdownMenu';

const PAGE_SIZE = 60;

export function ProductList() {
  const { currentUser } = useSession();
  const [products, setProducts] = useState([]);
  const [soConflitos, setSoConflitos] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showRelinkCodigos, setShowRelinkCodigos] = useState(false);
  const [duplicatasCount, setDuplicatasCount] = useState(0);
  const [estoquePorProduto, setEstoquePorProduto] = useState({});
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [editing, setEditing] = useState(null); // null = fechado, {} = novo, {...} = editar
  useEscToClose(() => setEditing(null), !!editing);
  const [adjusting, setAdjusting] = useState(null); // produto sendo ajustado, ou null
  const [ioMessage, setIoMessage] = useState(null);
  const [ioBusy, setIoBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [totalProdutos, setTotalProdutos] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef(null);
  const loadMoreRef = useRef(() => {}); // sempre aponta pra função de "carregar mais" da busca atual
  const reloadRef = useRef(() => {}); // idem, pra poder chamar de fora (importar planilha, excluir, etc.)

  // Tudo relacionado a UMA busca específica vive dentro deste único
  // efeito, compartilhando uma única bandeira "ignore" e variáveis
  // locais (não React state) pra controlar o que já foi carregado.
  // Isso evita depender de várias referências sincronizadas por efeitos
  function carregarContagemDuplicados() {
    window.pdv.products.findDuplicates().then((lista) => setDuplicatasCount(lista.length));
  }
  useEffect(carregarContagemDuplicados, []);

  // separados — que tinham uma pequena janela de tempo entre o texto de
  // busca mudar e cada referência terminar de atualizar, janela essa
  // onde a rolagem infinita podia disparar com dados de uma busca
  // anterior ainda por engano.
  useEffect(() => {
    let ignore = false;
    let produtosCarregados = [];
    let temMais = true;
    let carregandoMais = false;

    // Limpa a lista JÁ, antes de buscar o resultado novo — isso separa
    // "esvaziar" e "preencher com o resultado novo" em duas
    // atualizações de estado distintas, em vez de pedir pro React
    // reconciliar de uma vez uma lista que cresceu bastante (pela
    // rolagem infinita) direto pra um resultado bem menor. Sem isso,
    // linhas antigas ficavam presas na tela mesmo depois da busca
    // resolver certo — o problema piorava quanto mais a pessoa tinha
    // rolado a lista antes de buscar, o que bate com o relato do
    // cliente ("funciona só recém aberto, para de funcionar depois de
    // um tempo de uso" — uso, aqui, inclui rolar a lista de produtos).
    setProducts([]);

    async function carregarPrimeiroLote() {
      // Trava a mesma flag que carregarMais respeita — sem isso, o
      // observador de rolagem podia disparar carregarMais ANTES da
      // primeira página sequer terminar de carregar (o marcador de
      // "fim da lista" já está visível assim que a tela abre, ainda
      // sem conteúdo nenhum pra empurrar ele pra fora da vista), e as
      // duas chamadas buscavam a página 1 ao mesmo tempo — resultado:
      // os primeiros produtos apareciam duplicados na tela.
      carregandoMais = true;
      setHasMore(true);
      const list = await window.pdv.products.list({ query: debouncedQuery || undefined, limit: PAGE_SIZE, offset: 0 });
      carregandoMais = false;
      if (ignore) return; // uma busca mais nova já começou — descarta esta resposta atrasada

      if (!Array.isArray(list)) {
        setProducts([]);
        setHasMore(false);
        temMais = false;
        setLoadError(list?.error || 'Não foi possível carregar os produtos.');
        return;
      }
      setLoadError('');
      produtosCarregados = list;
      setProducts(list);
      temMais = list.length === PAGE_SIZE;
      setHasMore(temMais);

      const total = await window.pdv.products.count({ query: debouncedQuery || undefined });
      if (!ignore) setTotalProdutos(total);

      const estoque = await window.pdv.stock.getForLocation({ locationId: window.APP_LOCATION_ID });
      if (ignore) return;
      if (Array.isArray(estoque)) {
        const mapa = {};
        estoque.forEach((e) => { mapa[e.id] = e.estoque_atual; });
        setEstoquePorProduto(mapa);
      }
    }

    async function carregarMais() {
      if (ignore || carregandoMais || !temMais) return;
      carregandoMais = true;
      setLoadingMore(true);
      // Cursor (nome+id do último item já carregado) em vez de offset
      // numérico — imune a produtos novos entrando no meio da rolagem
      // (ver o comentário de ORDER BY no backend pra mais detalhes).
      const ultimoCarregado = produtosCarregados[produtosCarregados.length - 1];
      const list = await window.pdv.products.list({
        query: debouncedQuery || undefined, limit: PAGE_SIZE,
        cursorNome: ultimoCarregado?.nome, cursorId: ultimoCarregado?.id,
      });
      carregandoMais = false;
      setLoadingMore(false);
      if (ignore) return;
      if (!Array.isArray(list)) return;
      produtosCarregados = [...produtosCarregados, ...list];
      setProducts(produtosCarregados);
      temMais = list.length === PAGE_SIZE;
      setHasMore(temMais);
    }

    loadMoreRef.current = carregarMais;
    reloadRef.current = carregarPrimeiroLote;
    carregarPrimeiroLote();

    return () => { ignore = true; };
  }, [debouncedQuery]);

  // Observa um marcador invisível logo depois da tabela — quando ele
  // entra na área visível da rolagem, carrega o próximo lote sozinho.
  // Criado só uma vez; sempre chama a versão mais atual de "carregar
  // mais" através da referência acima, que o efeito de cima mantém
  // sempre apontando pra busca em vigor.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const scrollContainer = sentinel.closest('.main-content');

    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMoreRef.current(); },
      { root: scrollContainer || null, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  async function handleExport() {
    setIoBusy(true);
    const result = await window.pdv.io.exportProducts({ locationId: window.APP_LOCATION_ID });
    setIoBusy(false);
    if (result.canceled) return;
    setIoMessage(result.ok ? `${result.total} produtos exportados com sucesso.` : result.error);
  }

  async function handleClearAll() {
    const confirmacao = confirm(
      `Isso vai limpar TODOS os produtos cadastrados (${totalProdutos ?? 'todos'} no total).\n\n` +
      `Produtos que NUNCA foram vendidos são apagados de vez, liberando o código de barras/SKU pra ` +
      `reimportar dados novos. Produtos que JÁ têm venda ou devolução registrada continuam no histórico ` +
      `intacto — só ficam desativados.\n\n` +
      `Essa ação não afeta vendas já finalizadas. Confirma?`
    );
    if (!confirmacao) return;
    const result = await window.pdv.products.clearAll();
    setIoMessage(`Concluído: ${result.apagados} produto(s) apagado(s), ${result.desativados} desativado(s) (já tinham venda/devolução no histórico).`);
    reloadRef.current();
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
    reloadRef.current();
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
    reloadRef.current();
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Produtos {totalProdutos !== null && <span className="screen-hint" style={{ fontWeight: 400, fontSize: 15 }}>({totalProdutos} no total)</span>}</h1>
        <div className="screen-actions">
          <DropdownMenu label="Ferramentas">
            <DropdownMenuItem onClick={handleImport} disabled={ioBusy}>Importar planilha</DropdownMenuItem>
            <DropdownMenuItem onClick={handleExport} disabled={ioBusy}>Exportar planilha</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowDuplicates(true)}>
              Ver duplicados{duplicatasCount > 0 ? ` (${duplicatasCount})` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowRelinkCodigos(true)}>Re-vincular códigos de barras</DropdownMenuItem>
            <div className="dropdown-menu-separator" />
            <DropdownMenuItem danger onClick={handleClearAll}>Limpar todos os produtos</DropdownMenuItem>
          </DropdownMenu>
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
      <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={soConflitos} onChange={(e) => setSoConflitos(e.target.checked)} />
        Mostrar só produtos com conflito de código de barras pendente
      </label>

      {(() => {
        const produtosExibidos = soConflitos ? products.filter((p) => p.conflito_codigo_barras_pendente) : products;
        if (produtosExibidos.length === 0) {
          if (soConflitos && products.length > 0) return <p className="empty-state">Nenhum produto com conflito de código de barras pendente.</p>;
          return null;
        }
        return (
      <table className="data-table">
        <thead>
          <tr>
            <th></th><th>Nome</th><th>SKU</th><th>Categoria</th><th>Preço</th><th>Estoque atual</th><th>Mín.</th><th></th>
          </tr>
        </thead>
        <tbody>
          {produtosExibidos.map((p) => {
            const estoqueAtual = estoquePorProduto[p.id] ?? '—';
            const abaixoDoMinimo = typeof estoqueAtual === 'number' && estoqueAtual <= p.estoque_minimo;
            return (
              <tr key={p.id}>
                <td><ProductThumbnail product={p} size={36} /></td>
                <td>
                  {p.nome}
                  {p.conflito_codigo_barras_pendente && (
                    <span
                      className="badge-warning"
                      style={{ marginLeft: 6, fontSize: 11 }}
                      title={`Chegou da sincronização com o código de barras "${p.conflito_codigo_barras_pendente}", mas esse código já pertence a outro produto local. Resolva manualmente: defina o código de barras certo pra esse produto (ou apague o outro, se for duplicado).`}
                    >
                      ⚠ conflito de código de barras
                    </span>
                  )}
                </td>
                <td>{p.sku}</td>
                <td>{p.categoria}</td>
                <td>R$ {p.preco.toFixed(2)}</td>
                <td className={abaixoDoMinimo ? 'text-danger' : ''}>{estoqueAtual}</td>
                <td>{p.estoque_minimo}</td>
                <td>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button className="btn-link" onClick={() => setEditing(p)}>Editar</button>
                    <button className="btn-link" onClick={() => setAdjusting(p)}>Ajustar estoque</button>
                    <button className="btn-link-danger" onClick={() => handleDelete(p)}>Excluir</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
        );
      })()}

      <div ref={sentinelRef} style={{ height: 1 }} />
      {loadingMore && <p className="empty-state">Carregando mais produtos...</p>}
      {!hasMore && products.length > 0 && <p className="empty-state">Fim da lista — {products.length} produto(s).</p>}
      {!loadError && products.length === 0 && <p className="empty-state">Nenhum produto encontrado.</p>}

      {editing !== null && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-wide">
            <ProductForm
              product={editing.id ? editing : null}
              onSaved={() => { setEditing(null); reloadRef.current(); }}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      {adjusting && (
        <StockAdjustModal
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onAdjusted={() => { setAdjusting(null); reloadRef.current(); }}
        />
      )}

      {showDuplicates && (
        <DuplicateProductsModal
          onFechar={() => setShowDuplicates(false)}
          onExcluido={() => { carregarContagemDuplicados(); reloadRef.current(); }}
        />
      )}

      {showRelinkCodigos && (
        <BarcodeRelinkModal
          onFechar={() => setShowRelinkCodigos(false)}
          onAplicado={() => reloadRef.current()}
        />
      )}
    </div>
  );
}
