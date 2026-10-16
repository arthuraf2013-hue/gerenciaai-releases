import { lazy, Suspense, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { RestaurantTables } from './RestaurantTables';

// Abas secundárias carregam só quando abertas -- a de Mesas é a que abre
// sempre e continua no pacote principal.
const DailyMenu = lazy(() => import('../inventory/DailyMenu').then((m) => ({ default: m.DailyMenu })));
const DigitalMenuScreen = lazy(() => import('../inventory/DigitalMenuScreen').then((m) => ({ default: m.DigitalMenuScreen })));

export function RestaurantScreen() {
  const { currentUser } = useSession();
  const [aba, setAba] = useState('mesas');
  const podeVerCardapioDigital = ['gerente', 'admin', 'suporte'].includes(currentUser.role);

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'mesas' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('mesas')}>Mesas</button>
        <button className={aba === 'cardapioDia' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('cardapioDia')}>Cardápio do dia</button>
        {podeVerCardapioDigital && (
          <button className={aba === 'cardapioDigital' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('cardapioDigital')}>Cardápio Digital</button>
        )}
      </div>

      {aba === 'mesas' && <RestaurantTables />}
      <Suspense fallback={<p className="empty-state">Carregando...</p>}>
        {aba === 'cardapioDia' && <DailyMenu />}
        {aba === 'cardapioDigital' && podeVerCardapioDigital && <DigitalMenuScreen />}
      </Suspense>
    </div>
  );
}
