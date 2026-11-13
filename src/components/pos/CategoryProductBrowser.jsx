import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';
import { ProductThumbnail } from './ProductThumbnail';

/**
 * @param {{ onSelectProduct: (product: object) => void, modo?: 'faixa'|'suspenso', onModo?: (m: string) => void }} props
 * modo 'faixa' = botões (padrão); 'suspenso' = uma linha só com a lista de
 * categorias -- escolha de cada usuário (PreferenciasContext).
 */
export function CategoryProductBrowser({ onSelectProduct, modo = 'faixa', onModo }) {
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [tamanhoBlocos, setTamanhoBlocos] = useState('confortavel');
  const activeCategoryRef = useRef(activeCategory);

  useEffect(() => {
    window.pdv.posDisplay.getConfig().then((c) => setTamanhoBlocos(c.tamanho_blocos));
  }, []);

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
      activeCategoryRef.current = null;
      setActiveCategory(null);
      setProducts([]);
      return;
    }
    activeCategoryRef.current = categoria;
    setActiveCategory(categoria);
    setLoadingProducts(true);
    const list = await window.pdv.products.list({ categoria });
    // Clicar rápido entre categorias pode fazer a resposta de uma
    // categoria anterior chegar depois da mais recente — sem conferir,
    // os produtos errados apareciam sob a categoria certa selecionada.
    if (categoria !== activeCategoryRef.current) return;
    setProducts(Array.isArray(list) ? list : []);
    setLoadingProducts(false);
  }

  return (
    <div className="category-browser">
      {modo === 'suspenso' ? (
        <div className="category-suspenso">
          <label>
            <Icon name="tag" size={15} /> Categoria
            <select value={activeCategory || ''} onChange={(e) => handleCategoryClick(e.target.value || activeCategory)}>
              <option value="">{categories.length ? 'Escolha para ver os produtos…' : 'Nenhuma categoria cadastrada'}</option>
              {categories.map((c) => <option key={c.categoria} value={c.categoria}>{c.categoria} ({c.total})</option>)}
            </select>
          </label>
          {activeCategory && <button type="button" className="btn-link" onClick={() => handleCategoryClick(activeCategory)}>Fechar a grade</button>}
          {onModo && <button type="button" className="btn-link" onClick={() => onModo('faixa')}>Ver em botões</button>}
        </div>
      ) : (
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
        {onModo && categories.length > 6 && (
          <button type="button" className="category-btn category-btn-compactar" onClick={() => onModo('suspenso')} title="Mostrar as categorias numa linha só">
            Compactar
          </button>
        )}
      </div>
      )}

      {activeCategory && (
        <div className={`product-grid ${tamanhoBlocos === 'compacto' ? 'product-grid-compacto' : ''}`}>
          {loadingProducts && <p className="empty-state">Carregando...</p>}
          {!loadingProducts && products.map((p) => (
            <button key={p.id} className="product-card" onClick={() => onSelectProduct(p)}>
              <ProductThumbnail product={p} size={tamanhoBlocos === 'compacto' ? 44 : 64} />
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
