import { useEffect, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { ProductThumbnail } from './ProductThumbnail';

/**
 * @param {{ onSelect: (product: object) => void, onSelectPersonalizado?: () => void }} props
 */
export function ProductSearchBox({ onSelect, onSelectPersonalizado }) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 180); // mais curto que outras telas — isso é usado durante a venda, precisa continuar ágil
  const [results, setResults] = useState([]);
  const [resultadosDoGrupo, setResultadosDoGrupo] = useState([]);
  const [open, setOpen] = useState(false);
  const [indiceSelecionado, setIndiceSelecionado] = useState(-1);
  const [modoBusca, setModoBusca] = useState('lista');
  const [importando, setImportando] = useState(null); // id do produto do grupo sendo importado

  useEffect(() => {
    window.pdv.posDisplay.getConfig().then((c) => setModoBusca(c.modo_busca));
  }, []);

  useEffect(() => {
    let ignore = false;
    if (debouncedQuery.trim().length < 2) {
      setResults([]);
      setResultadosDoGrupo([]);
      setOpen(false);
      return;
    }
    window.pdv.products.list({ query: debouncedQuery }).then((list) => {
      if (ignore) return;
      const listaLocal = Array.isArray(list) ? list.slice(0, 8) : [];
      setResults(listaLocal);
      setOpen(true);
      setIndiceSelecionado(-1); // sempre recomeça sem nada selecionado quando o resultado muda

      // Só consulta o grupo quando a busca local não resolve sozinha —
      // é o caso de um produto que existe só em outra máquina
      // sincronizada (nunca foi cadastrado aqui). Isso NUNCA grava
      // nada na base local sozinho — só mostra a opção de trazer o
      // produto, se a pessoa escolher.
      if (listaLocal.length === 0 && window.pdv.productSync) {
        window.pdv.productSync.buscarNoGrupo({ query: debouncedQuery }).then((doGrupo) => {
          if (ignore) return;
          setResultadosDoGrupo(Array.isArray(doGrupo) ? doGrupo.slice(0, 8) : []);
        });
      } else {
        setResultadosDoGrupo([]);
      }
    });
    return () => { ignore = true; };
  }, [debouncedQuery]);

  function handleSelect(product) {
    onSelect(product);
    setQuery('');
    setResults([]);
    setResultadosDoGrupo([]);
    setOpen(false);
    setIndiceSelecionado(-1);
  }

  function handleSelectPersonalizado() {
    if (!onSelectPersonalizado) return;
    onSelectPersonalizado();
    setQuery('');
    setResults([]);
    setResultadosDoGrupo([]);
    setOpen(false);
    setIndiceSelecionado(-1);
  }

  // Card de "produto personalizado" só aparece quando a busca é
  // especificamente por essa palavra (prefixo de "personalizado") — não
  // é um produto de verdade no catálogo, é um atalho pra montar um
  // prato/produto na hora com insumos e/ou produtos do catálogo.
  const queryNormalizada = query.trim().toLowerCase();
  const mostrarCardPersonalizado = !!onSelectPersonalizado
    && queryNormalizada.length >= 4
    && 'personalizado'.startsWith(queryNormalizada);

  /** Produto achado na consulta ao grupo, mas ainda sem existir
   * localmente — traz ele pra base local (só esse produto, só agora,
   * porque a pessoa escolheu) e já adiciona na venda. */
  async function handleSelecionarDoGrupo(produtoDoGrupo) {
    setImportando(produtoDoGrupo.id);
    await window.pdv.productSync.importarDoGrupo(produtoDoGrupo);
    setImportando(null);
    handleSelect({
      id: produtoDoGrupo.id, nome: produtoDoGrupo.nome, preco: produtoDoGrupo.preco,
      codigo_barras: produtoDoGrupo.codigoBarras, sku: produtoDoGrupo.sku, categoria: produtoDoGrupo.categoria,
    });
  }

  async function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      if (!open || results.length === 0) return;
      e.preventDefault();
      setIndiceSelecionado((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      if (!open || results.length === 0) return;
      e.preventDefault();
      setIndiceSelecionado((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (query.trim().length < 2) return;

      // Se a busca (com debounce) já tinha resultado pronto — inclusive
      // se a pessoa navegou com as setas — usa ele direto.
      if (open && results.length > 0) {
        handleSelect(results[indiceSelecionado >= 0 ? indiceSelecionado : 0]);
        return;
      }

      // Senão, o Enter chegou ANTES do debounce de 180ms terminar —
      // isso é exatamente o que acontece com uma pistola de código de
      // barras (digita tudo e já manda Enter bem mais rápido que
      // digitação humana). Busca na hora, sem esperar o debounce, e
      // adiciona direto — sem isso, o código ficava "esperando" no
      // campo até o dropdown aparecer sozinho, exigindo clicar depois.
      const listaFresca = await window.pdv.products.list({ query: query.trim() });
      if (Array.isArray(listaFresca) && listaFresca.length > 0) {
        handleSelect(listaFresca[0]);
        return;
      }
      // Não achou local — última tentativa, consulta se existe no
      // catálogo do grupo (produto cadastrado só em outra máquina
      // sincronizada) antes de desistir.
      if (window.pdv.productSync) {
        const doGrupo = await window.pdv.productSync.buscarNoGrupo({ query: query.trim() });
        if (Array.isArray(doGrupo) && doGrupo.length > 0) {
          await handleSelecionarDoGrupo(doGrupo[0]);
        }
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setIndiceSelecionado(-1);
    }
  }

  return (
    <div className="product-search">
      <input
        className="search-input"
        placeholder="Buscar produto manualmente (quando o leitor não funciona)..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {mostrarCardPersonalizado && modoBusca === 'blocos' && (
        <div className="product-search-results product-search-results-blocks">
          <button type="button" className="product-card product-card-personalizado" onClick={handleSelectPersonalizado}>
            <span className="product-card-personalizado-icon" aria-hidden>🎨</span>
            <span className="product-card-name">Produto personalizado</span>
            <span className="product-card-price">Montar agora</span>
          </button>
        </div>
      )}
      {mostrarCardPersonalizado && modoBusca !== 'blocos' && (
        <ul className="product-search-results">
          <li>
            <button type="button" className="product-search-result-personalizado" onClick={handleSelectPersonalizado}>
              <span>🎨 Produto personalizado — montar agora</span>
            </button>
          </li>
        </ul>
      )}
      {open && results.length > 0 && modoBusca === 'blocos' && (
        <div className="product-search-results product-search-results-blocks">
          {results.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`product-card ${i === indiceSelecionado ? 'product-search-result-active' : ''}`}
              onClick={() => handleSelect(p)}
              onMouseEnter={() => setIndiceSelecionado(i)}
            >
              <ProductThumbnail product={p} size={56} />
              <span className="product-card-name">{p.nome}</span>
              <span className="product-card-price">R$ {p.preco.toFixed(2)}</span>
            </button>
          ))}
        </div>
      )}
      {open && results.length > 0 && modoBusca !== 'blocos' && (
        <ul className="product-search-results">
          {results.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className={i === indiceSelecionado ? 'product-search-result-active' : ''}
                onClick={() => handleSelect(p)}
                onMouseEnter={() => setIndiceSelecionado(i)}
              >
                <span>{p.nome}</span>
                <span className="product-search-price">R$ {p.preco.toFixed(2)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && results.length === 0 && resultadosDoGrupo.length > 0 && (
        <ul className="product-search-results">
          <li className="product-search-group-label">Não cadastrado aqui, mas encontrado no grupo:</li>
          {resultadosDoGrupo.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => handleSelecionarDoGrupo(p)} disabled={importando === p.id}>
                <span>{p.nome} {importando === p.id ? '(trazendo...)' : ''}</span>
                <span className="product-search-price">R$ {p.preco.toFixed(2)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
