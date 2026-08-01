import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';

const TIPOS = [
  { value: 'entrada', label: 'Entrada (recebi mercadoria)', sinal: 1 },
  { value: 'perda', label: 'Perda / quebra / vencido', sinal: -1 },
  { value: 'ajuste', label: 'Correção de inventário (contei e está diferente)', sinal: null },
];

/**
 * @param {{ product: object, onClose: () => void, onAdjusted: () => void }} props
 */
export function StockAdjustModal({ product, onClose, onAdjusted }) {
  useEscToClose(onClose);
  const { currentUser } = useSession();
  const [tipo, setTipo] = useState('entrada');
  const [quantidade, setQuantidade] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const tipoInfo = TIPOS.find((t) => t.value === tipo);

  async function handleSubmit(e) {
    e.preventDefault();
    const qtd = Number(quantidade);
    if (!qtd || qtd === 0) return setError('Informe uma quantidade diferente de zero.');
    setError('');
    setSaving(true);

    // Para "ajuste" (correção de inventário), o sinal já vem de como a
    // pessoa digitou (pode ser pra mais ou pra menos); para entrada/perda,
    // o sinal é sempre o mesmo, então convertemos pra sempre pedir um
    // número positivo na tela e aplicar o sinal certo aqui.
    const quantidadeComSinal = tipoInfo.sinal === null ? qtd : Math.abs(qtd) * tipoInfo.sinal;

    const result = await window.pdv.stock.adjust({
      productId: product.id,
      locationId: window.APP_LOCATION_ID,
      quantidade: quantidadeComSinal,
      tipo,
      motivo: motivo || null,
      operadorId: currentUser.id,
      deviceId: window.APP_DEVICE_ID,
    });
    setSaving(false);
    if (!result.ok) return setError(result.error);
    onAdjusted(result.estoqueAtual);
  }

  return (
    <div className="modal-overlay">
      <form className="modal-card" onSubmit={handleSubmit}>
        <h2>Ajustar estoque — {product.nome}</h2>

        <label>Tipo
          <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
            {TIPOS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <label>
          {tipo === 'ajuste' ? 'Quantidade (negativo para diminuir, positivo para aumentar)' : 'Quantidade'}
          <input type="number" step="any" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} autoFocus />
        </label>

        <label>Motivo (opcional)
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex: nota fiscal 1234, caixa danificada..." />
        </label>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Confirmar'}</button>
        </div>
      </form>
    </div>
  );
}
