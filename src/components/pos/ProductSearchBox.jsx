import { useRef, useState } from 'react';

/**
 * @param {{ onSelect: (product: object) => void }} props
 */
export function ProductSearchBox({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const queryRef = useRef(query);

  async function handleChange(value) {
    setQuery(value);
    queryRef.current = value;
    if (value.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const list = await window.pdv.products.list({ query: value });
    // Cada letra digitada dispara uma busca nova; sem conferir se essa
    // resposta ainda corresponde ao texto atual, uma busca mais antiga
    // que demorasse mais podia sobrescrever o resultado certo com um
    // errado — grave aqui porque é daqui que se escolhe o que entra na
    // venda.
    if (value !== queryRef.current) return;
    setResults(Array.isArray(list) ? list.slice(0, 8) : []);
    setOpen(true);
  }

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
        onChange={(e) => handleChange(e.target.value)}
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
