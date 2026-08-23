import { useEffect, useState } from 'react';
import { ProductThumbnail } from './ProductThumbnail';
import Icon from '../common/Icon';

/**
 * @param {{ locationId: string, refreshKey: number, onSelectProduct: (product: object) => void }} props
 */
export function RecentlySoldStrip({ locationId, refreshKey, onSelectProduct }) {
  const [products, setProducts] = useState([]);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    window.pdv.posDisplay.getConfig().then(setConfig);
  }, []);

  useEffect(() => {
    if (!config) return;
    window.pdv.sale.listRecentlySold({ locationId, modo: config.modo_vendidos_recentes, limit: config.qtd_vendidos_recentes }).then((list) => {
      setProducts(Array.isArray(list) ? list : []);
    });
  }, [locationId, refreshKey, config]);

  if (products.length === 0) return null;

  return (
    <div className="recent-strip">
      <span className="recent-strip-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="star" size={14} />
        {config?.modo_vendidos_recentes === 'frequente' ? 'Mais vendidos' : 'Vendidos recentemente'}
      </span>
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
