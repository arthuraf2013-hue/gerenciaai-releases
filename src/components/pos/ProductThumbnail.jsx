import { useEffect, useState } from 'react';

/**
 * @param {{ product: object, size?: number }} props
 */
export function ProductThumbnail({ product, size = 56 }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (product.foto_path) {
      window.pdv.products.getFotoDataUrl({ productId: product.id }).then((url) => {
        if (!cancelled) setDataUrl(url);
      });
    } else {
      setDataUrl(null);
    }
    return () => { cancelled = true; };
  }, [product.id, product.foto_path]);

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt={product.nome}
        className="product-thumb"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div className="product-thumb product-thumb-placeholder" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {product.nome?.[0]?.toUpperCase() || '?'}
    </div>
  );
}
