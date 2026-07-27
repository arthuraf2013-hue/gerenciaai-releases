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
    });
    return () => { ignore = true; };
  }, [debouncedQuery]);

  function handleSelect(product) {
    onSelect(product);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="product-search">
      <input
        className="search-input"
        placeholder="Buscar produto manualmente (quando o leitor não funciona)..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && results.length > 0 && (
        <ul className="product-search-results">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => handleSelect(p)}>
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
