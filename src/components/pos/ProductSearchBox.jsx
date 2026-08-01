import { useEffect, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

/**
 * @param {{ onSelect: (product: object) => void }} props
 */
export function ProductSearchBox({ onSelect }) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 180); // mais curto que outras telas — isso é usado durante a venda, precisa continuar ágil
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [indiceSelecionado, setIndiceSelecionado] = useState(-1);

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

  function handleKeyDown(e) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndiceSelecionado((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndiceSelecionado((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter sem nada navegado ainda escolhe o primeiro resultado —
      // pra quem digita rápido e já aperta Enter sem usar as setas.
      handleSelect(results[indiceSelecionado >= 0 ? indiceSelecionado : 0]);
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
      {open && results.length > 0 && (
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
