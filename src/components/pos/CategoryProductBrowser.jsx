import { useEffect, useState } from 'react';
import { ProductThumbnail } from './ProductThumbnail';

/**
 * @param {{ onSelectProduct: (product: object) => void }} props
 */
export function CategoryProductBrowser({ onSelectProduct }) {
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  // As categorias vêm direto do que já está cadastrado nos produtos —
  // cadastrar um produto com categoria nova já faz o botão aparecer aqui,
  // sem precisar de nenhuma tela de configuração separada.
  async function reloadCategories() {
    const list = await window.pdv.products.listCategories();
    setCategories(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reloadCategories(); }, []);

  async function handleCategoryClick(categoria) {
    if (activeCategory === categoria) {
      setActiveCategory(null);
      setProducts([]);
      return;
    }
    setActiveCategory(categoria);
    setLoadingProducts(true);
    const list = await window.pdv.products.list({ categoria });
    setProducts(Array.isArray(list) ? list : []);
    setLoadingProducts(false);
  }

  return (
    <div className="category-browser">
      <div className="category-buttons">
        {categories.map((c) => (
          <button
            key={c.categoria}
            className={`category-btn ${activeCategory === c.categoria ? 'category-btn-active' : ''}`}
            onClick={() => handleCategoryClick(c.categoria)}
          >
            {c.categoria} <span className="category-count">{c.total}</span>
          </button>
        ))}
        {categories.length === 0 && (
          <p className="empty-state" style={{ margin: 0 }}>Cadastre produtos com categoria para os botões aparecerem aqui.</p>
        )}
      </div>

      {activeCategory && (
        <div className="product-grid">
          {loadingProducts && <p className="empty-state">Carregando...</p>}
          {!loadingProducts && products.map((p) => (
            <button key={p.id} className="product-card" onClick={() => onSelectProduct(p)}>
              <ProductThumbnail product={p} size={64} />
              <span className="product-card-name">{p.nome}</span>
              <span className="product-card-price">R$ {p.preco.toFixed(2)}</span>
            </button>
          ))}
          {!loadingProducts && products.length === 0 && (
            <p className="empty-state">Nenhum produto ativo nessa categoria.</p>
          )}
        </div>
      )}
    </div>
  );
}
