import { useState } from 'react';
import { SupplyScreen } from './SupplyScreen';
import { SupplierList } from '../pos/SupplierList';

export function SupplyAndSuppliersScreen() {
  const [aba, setAba] = useState('receber');

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'receber' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('receber')}>Receber mercadoria</button>
        <button className={aba === 'fornecedores' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('fornecedores')}>Fornecedores</button>
      </div>

      {aba === 'receber' ? <SupplyScreen /> : <SupplierList />}
    </div>
  );
}
