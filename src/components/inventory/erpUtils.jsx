import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

export const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Custo unitário: até 4 casas quando a conta não fecha em centavos. */
export const brlCusto = (v) => Number(v || 0).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4,
});

export const qtd = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** 'AAAA-MM-DD' (data de calendário) -> 'DD/MM/AAAA', sem passar por Date (fuso). */
export const dataBR = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

const CHIPS = {
  rascunho: ['chip-atualizar', 'Em conferência'],
  confirmada: ['chip-novo', 'Lançada'],
  estornada: ['chip-erro', 'Estornada'],
  enviado: ['chip-novo', 'Enviado'],
  parcial: ['chip-atualizar', 'Recebido em parte'],
  recebido: ['chip-novo', 'Recebido'],
  cancelado: ['chip-erro', 'Cancelado'],
};

export function ChipStatus({ status, rascunhoPedido = false }) {
  const [classe, texto] = rascunhoPedido && status === 'rascunho' ? ['chip-neutro', 'Rascunho'] : (CHIPS[status] || ['chip-neutro', status]);
  return <span className={`chip-situacao ${classe}`}>{texto}</span>;
}

/** Status do módulo pago "ERP — Compras" (null enquanto carrega). */
export function useModuloCompras() {
  const [ativo, setAtivo] = useState(null);
  useEffect(() => {
    window.pdv.erp.status().then((r) => setAtivo(r?.compras !== false));
  }, []);
  return ativo;
}

export function ModuloComprasInativo() {
  return (
    <div className="screen">
      <section className="settings-section erp-bloqueado">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="lock" size={18} /> ERP — Compras</h2>
        <p>
          Pedido de compra e entrada de mercadoria pelo XML da nota fiscal fazem parte do módulo
          <strong> ERP — Compras</strong>, que não está ativo nesta loja.
        </p>
        <p className="screen-hint" style={{ marginBottom: 0 }}>
          Fale com o suporte da Vetta Sistemas para liberar. O custo médio dos produtos continua sendo
          calculado normalmente no Abastecimento.
        </p>
      </section>
    </div>
  );
}
