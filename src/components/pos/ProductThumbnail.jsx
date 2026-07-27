import { memo, useEffect, useState } from 'react';

/**
 * @param {{ product: object, size?: number }} props
 */
function ProductThumbnailBase({ product, size = 56 }) {
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

// Numa lista de 60 produtos, sem isso cada miniatura re-renderiza (e
// reexecuta o efeito de checagem) toda vez que QUALQUER outra coisa na
// tela muda — digitar na busca, atualizar estoque de outro produto, etc.
// React.memo pula a renderização quando as props (produto e tamanho)
// não mudaram de verdade.
export const ProductThumbnail = memo(ProductThumbnailBase);
