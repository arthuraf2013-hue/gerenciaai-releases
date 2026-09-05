import { useState } from 'react';
import { useProfile } from '../../context/ProfileContext';
import { ProductList } from './ProductList';
import { IngredientManager } from './IngredientManager';
import { WasteLog } from './WasteLog';
import { PersonalizedItemsAdjustment } from './PersonalizedItemsAdjustment';
import { CategoryManager } from './CategoryManager';
import Icon from '../common/Icon';

const PERFIS_RESTAURANTE = ['restaurante', 'padaria'];
// Perfis que vendem SERVIÇO com material associado (ver
// serviceMaterialService.js) — além dos perfis de restaurante, que já
// tinham a aba de ajuste por causa de item personalizado. Qualquer
// serviço, de qualquer perfil, pode ter material cadastrado (não é
// travado por perfil no ProductForm) — isto só decide quem vê a aba de
// AJUSTE pós-venda por padrão; um perfil novo que passe a usar isso
// entra nesta lista do mesmo jeito que salão de beleza entrou.
const PERFIS_SERVICO_COM_MATERIAL = ['salao_beleza'];

export function ProductsScreen() {
  const { profile } = useProfile();
  const [aba, setAba] = useState('produtos');
  const mostraAbasRestaurante = PERFIS_RESTAURANTE.includes(profile?.id);
  const mostraAbaAjustes = mostraAbasRestaurante || PERFIS_SERVICO_COM_MATERIAL.includes(profile?.id);

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
          </>
        )}
        {mostraAbaAjustes && (
          <button className={aba === 'personalizados' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('personalizados')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="palette" size={15} /> Ajustes</span>
          </button>
        )}
      </div>

      {aba === 'categorias' && <CategoryManager />}
      {aba === 'insumos' && mostraAbasRestaurante && <IngredientManager />}
      {aba === 'desperdicio' && mostraAbasRestaurante && <WasteLog />}
      {aba === 'personalizados' && mostraAbaAjustes && <PersonalizedItemsAdjustment />}
      {aba === 'produtos' && <ProductList />}
    </div>
  );
}
