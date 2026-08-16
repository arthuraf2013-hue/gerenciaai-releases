import { useState } from 'react';
import { useProfile } from '../../context/ProfileContext';
import { ProductList } from './ProductList';
import { IngredientManager } from './IngredientManager';
import { WasteLog } from './WasteLog';
import { CategoryManager } from './CategoryManager';

const PERFIS_RESTAURANTE = ['restaurante', 'padaria'];

export function ProductsScreen() {
  const { profile } = useProfile();
  const [aba, setAba] = useState('produtos');
  const mostraAbasRestaurante = PERFIS_RESTAURANTE.includes(profile?.id);

  return (
    <div className="screen">
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'produtos' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('produtos')}>🏷️ Produtos</button>
        <button className={aba === 'categorias' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('categorias')}>🗂️ Categorias</button>
        {mostraAbasRestaurante && (
          <>
            <button className={aba === 'insumos' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('insumos')}>🥫 Insumos</button>
            <button className={aba === 'desperdicio' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('desperdicio')}>🗑️ Desperdício</button>
          </>
        )}
      </div>

      {aba === 'categorias' && <CategoryManager />}
      {aba === 'insumos' && mostraAbasRestaurante && <IngredientManager />}
      {aba === 'desperdicio' && mostraAbasRestaurante && <WasteLog />}
      {aba === 'produtos' && <ProductList />}
    </div>
  );
}
