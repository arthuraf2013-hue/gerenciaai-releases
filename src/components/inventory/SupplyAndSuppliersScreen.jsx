import { useState } from 'react';
import { SupplyScreen } from './SupplyScreen';
import { SupplierList } from '../pos/SupplierList';
import Icon from '../common/Icon';

export function SupplyAndSuppliersScreen() {
  const [aba, setAba] = useState('receber');

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'receber' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('receber')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="import" size={15} /> Receber mercadoria</span>
        </button>
        <button className={aba === 'fornecedores' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('fornecedores')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="truck" size={15} /> Fornecedores</span>
        </button>
      </div>

      {aba === 'receber' ? <SupplyScreen /> : <SupplierList />}
    </div>
  );
}
