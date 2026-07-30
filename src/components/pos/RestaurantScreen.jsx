import { useState } from 'react';
import { RestaurantTables } from './RestaurantTables';
import { DailyMenu } from '../inventory/DailyMenu';
import { DigitalMenuScreen } from '../inventory/DigitalMenuScreen';

export function RestaurantScreen() {
  const [aba, setAba] = useState('mesas');

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'mesas' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('mesas')}>Mesas</button>
        <button className={aba === 'cardapioDia' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('cardapioDia')}>Cardápio do dia</button>
        <button className={aba === 'cardapioDigital' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('cardapioDigital')}>Cardápio Digital</button>
      </div>

      {aba === 'mesas' && <RestaurantTables />}
      {aba === 'cardapioDia' && <DailyMenu />}
      {aba === 'cardapioDigital' && <DigitalMenuScreen />}
    </div>
  );
}
