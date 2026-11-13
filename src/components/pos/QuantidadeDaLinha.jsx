import { useState } from 'react';

/** − quantidade + na linha do carrinho. O − some no último (aí é o Cancelar). */
export function QuantidadeDaLinha({ item, onAjustar }) {
  const [ocupado, setOcupado] = useState(false);
  async function clicar(e, delta) {
    e.stopPropagation();
    if (ocupado) return;
    setOcupado(true);
    try { await onAjustar(item, delta); } finally { setOcupado(false); }
  }
  return (
    <span className="linha-qtd" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="linha-qtd-btn" disabled={ocupado || item.quantidade <= 1}
        aria-label={`Tirar um ${item.nome}`} title={item.quantidade <= 1 ? 'Para tirar o último, use Cancelar' : 'Tirar um'}
        onClick={(e) => clicar(e, -1)}>−</button>
      <span className="linha-qtd-valor" aria-label={`Quantidade: ${item.quantidade}`}>{item.quantidade}</span>
      <button type="button" className="linha-qtd-btn" disabled={ocupado}
        aria-label={`Pôr mais um ${item.nome}`} title="Pôr mais um" onClick={(e) => clicar(e, 1)}>+</button>
    </span>
  );
}
