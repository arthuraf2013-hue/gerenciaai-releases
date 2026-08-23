import { useState } from 'react';
import { useProfile } from '../../context/ProfileContext';
import { ProductList } from './ProductList';
import { IngredientManager } from './IngredientManager';
import { WasteLog } from './WasteLog';
import { PersonalizedItemsAdjustment } from './PersonalizedItemsAdjustment';
import { CategoryManager } from './CategoryManager';
import Icon from '../common/Icon';

const PERFIS_RESTAURANTE = ['restaurante', 'padaria'];

export function ProductsScreen() {
  const { profile } = useProfile();
  const [aba, setAba] = useState('produtos');
  const mostraAbasRestaurante = PERFIS_RESTAURANTE.includes(profile?.id);

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'produtos' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('produtos')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="tag" size={15} /> Produtos</span>
        </button>
        <button className={aba === 'categorias' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('categorias')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="folder" size={15} /> Categorias</span>
        </button>
        {mostraAbasRestaurante && (
          <>
            <button className={aba === 'insumos' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('insumos')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="ingredient" size={15} /> Insumos</span>
            </button>
            <button className={aba === 'desperdicio' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('desperdicio')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="trash" size={15} /> Desperdício</span>
            </button>
            <button className={aba === 'personalizados' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('personalizados')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="palette" size={15} /> Personalizados</span>
            </button>
          </>
        )}
      </div>

      {aba === 'categorias' && <CategoryManager />}
      {aba === 'insumos' && mostraAbasRestaurante && <IngredientManager />}
      {aba === 'desperdicio' && mostraAbasRestaurante && <WasteLog />}
      {aba === 'personalizados' && mostraAbasRestaurante && <PersonalizedItemsAdjustment />}
      {aba === 'produtos' && <ProductList />}
    </div>
  );
}
