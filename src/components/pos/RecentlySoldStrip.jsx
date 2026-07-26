import { useEffect, useState } from 'react';
import { ProductThumbnail } from './ProductThumbnail';

/**
 * @param {{ locationId: string, refreshKey: number, onSelectProduct: (product: object) => void }} props
 */
export function RecentlySoldStrip({ locationId, refreshKey, onSelectProduct }) {
  const [products, setProducts] = useState([]);

  useEffect(() => {
    window.pdv.sale.listRecentlySold({ locationId }).then((list) => {
      setProducts(Array.isArray(list) ? list : []);
    });
  }, [locationId, refreshKey]);

  if (products.length === 0) return null;

  return (
    <div className="recent-strip">
      <span className="recent-strip-label">Vendidos recentemente</span>
      <div className="recent-strip-items">
        {products.map((p) => (
          <button key={p.id} className="recent-item" onClick={() => onSelectProduct(p)} title={p.nome}>
            <ProductThumbnail product={p} size={40} />
            <span className="recent-item-name">{p.nome}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
