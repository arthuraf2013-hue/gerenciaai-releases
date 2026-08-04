import { useEffect, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { ProductThumbnail } from './ProductThumbnail';

/**
 * @param {{ onSelect: (product: object) => void }} props
 */
export function ProductSearchBox({ onSelect }) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 180); // mais curto que outras telas — isso é usado durante a venda, precisa continuar ágil
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [indiceSelecionado, setIndiceSelecionado] = useState(-1);
  const [modoBusca, setModoBusca] = useState('lista');

  useEffect(() => {
    window.pdv.posDisplay.getConfig().then((c) => setModoBusca(c.modo_busca));
  }, []);

  useEffect(() => {
    let ignore = false;
    if (debouncedQuery.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    window.pdv.products.list({ query: debouncedQuery }).then((list) => {
      if (ignore) return;
      setResults(Array.isArray(list) ? list.slice(0, 8) : []);
      setOpen(true);
      setIndiceSelecionado(-1); // sempre recomeça sem nada selecionado quando o resultado muda
    });
    return () => { ignore = true; };
  }, [debouncedQuery]);

  function handleSelect(product) {
    onSelect(product);
    setQuery('');
    setResults([]);
    setOpen(false);
    setIndiceSelecionado(-1);
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
    </div>
  );
}
