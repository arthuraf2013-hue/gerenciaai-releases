import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { SalesHistory } from './SalesHistory';
import { CashReport } from './CashReport';
import Icon from '../common/Icon';

/**
 * @param {{ onDevolver: (saleId: string) => void }} props
 */
export function HistoryScreen({ onDevolver }) {
  const { currentUser } = useSession();
  const [aba, setAba] = useState('vendas');
  const podeVerFechamentos = ['gerente', 'admin'].includes(currentUser.role);

  return (
    <div className="screen">
      {podeVerFechamentos && (
        <div className="settings-tabs" style={{ marginTop: 0 }}>
          <button className={aba === 'vendas' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('vendas')}><Icon name="receipt" size={15} /> Vendas</button>
          <button className={aba === 'caixa' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('caixa')}><Icon name="money" size={15} /> Fechamentos de caixa</button>
        </div>
      )}

      {aba === 'caixa' && podeVerFechamentos ? <CashReport /> : <SalesHistory onDevolver={onDevolver} />}
    </div>
  );
}
