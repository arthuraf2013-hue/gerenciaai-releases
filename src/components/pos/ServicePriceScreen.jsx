import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ServiceQuickLookupScreen } from '../inventory/ServiceQuickLookupScreen';
import { ServicePriceTableScreen } from '../inventory/ServicePriceTableScreen';

export function ServicePriceScreen() {
  const { currentUser } = useSession();
  const [aba, setAba] = useState('consulta');
  const podeConfigurarTabela = ['gerente', 'admin', 'suporte'].includes(currentUser.role);

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'consulta' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('consulta')}>Consulta Rápida</button>
        {podeConfigurarTabela && (
          <button className={aba === 'tabela' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('tabela')}>Tabela de Preços</button>
        )}
      </div>

      {aba === 'consulta' && <ServiceQuickLookupScreen />}
      {aba === 'tabela' && podeConfigurarTabela && <ServicePriceTableScreen />}
    </div>
  );
}
