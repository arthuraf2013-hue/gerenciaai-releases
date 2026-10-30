import { useState } from 'react';
import { SupplyScreen } from './SupplyScreen';
import { SupplierList } from '../pos/SupplierList';
import { NfeEntradaScreen } from './NfeEntradaScreen';
import { PurchaseOrdersScreen } from './PurchaseOrdersScreen';
import { useModuloCompras, ModuloComprasInativo } from './erpUtils';
import Icon from '../common/Icon';

const ABAS = [
  { id: 'receber', icone: 'import', rotulo: 'Receber mercadoria' },
  { id: 'notas', icone: 'document', rotulo: 'Notas de compra (XML)', erp: true },
  { id: 'pedidos', icone: 'clipboard', rotulo: 'Pedidos de compra', erp: true },
  { id: 'fornecedores', icone: 'truck', rotulo: 'Fornecedores' },
];

export function SupplyAndSuppliersScreen() {
  const [aba, setAba] = useState('receber');
  const moduloCompras = useModuloCompras();
  const atual = ABAS.find((a) => a.id === aba);

  let conteudo;
  if (atual.erp && moduloCompras === null) conteudo = <div className="screen"><p className="empty-state">Carregando...</p></div>;
  else if (atual.erp && !moduloCompras) conteudo = <ModuloComprasInativo />;
  else if (aba === 'notas') conteudo = <NfeEntradaScreen />;
  else if (aba === 'pedidos') conteudo = <PurchaseOrdersScreen />;
  else if (aba === 'fornecedores') conteudo = <SupplierList />;
  else conteudo = <SupplyScreen />;

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        {ABAS.map((a) => (
          <button key={a.id} className={aba === a.id ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba(a.id)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name={a.icone} size={15} /> {a.rotulo}
              {a.erp && moduloCompras === false && <Icon name="lock" size={13} title="Módulo ERP — Compras não ativo" />}
            </span>
          </button>
        ))}
      </div>

      {conteudo}
    </div>
  );
}
