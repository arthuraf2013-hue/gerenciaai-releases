import { useState } from 'react';
import { SupplyScreen } from './SupplyScreen';
import { SupplierList } from '../pos/SupplierList';
import { NfeEntradaScreen } from './NfeEntradaScreen';
import { PurchaseOrdersScreen } from './PurchaseOrdersScreen';
import { InventarioTab, MovimentacaoTab } from './EstoqueErp';
import { useModulosErp, ModuloInativo, Abas } from './erpUtils';

// `modulo`: aba que depende de um módulo pago do ERP (erpService.js).
const ABAS = [
  { id: 'receber', icone: 'import', rotulo: 'Receber mercadoria' },
  { id: 'notas', icone: 'document', rotulo: 'Notas de compra (XML)', modulo: 'compras' },
  { id: 'pedidos', icone: 'clipboard', rotulo: 'Pedidos de compra', modulo: 'compras' },
  { id: 'inventario', icone: 'check', rotulo: 'Inventário', modulo: 'estoque' },
  { id: 'movimentacao', icone: 'history', rotulo: 'Movimentação', modulo: 'estoque' },
  { id: 'fornecedores', icone: 'truck', rotulo: 'Fornecedores' },
];

export function SupplyAndSuppliersScreen() {
  const [aba, setAba] = useState('receber');
  const modulos = useModulosErp();
  const atual = ABAS.find((a) => a.id === aba);
  const bloqueadas = modulos ? Object.fromEntries(ABAS.filter((a) => a.modulo && !modulos[a.modulo]).map((a) => [a.id, true])) : {};

  let conteudo;
  if (atual.modulo && modulos === null) conteudo = <div className="screen"><p className="empty-state">Carregando...</p></div>;
  else if (atual.modulo && !modulos[atual.modulo]) conteudo = <ModuloInativo modulo={atual.modulo} semPermissao={modulos.semPermissao[atual.modulo]} />;
  else if (aba === 'notas') conteudo = <NfeEntradaScreen />;
  else if (aba === 'pedidos') conteudo = <PurchaseOrdersScreen />;
  else if (aba === 'inventario') conteudo = <div className="screen"><InventarioTab /></div>;
  else if (aba === 'movimentacao') conteudo = <div className="screen"><MovimentacaoTab /></div>;
  else if (aba === 'fornecedores') conteudo = <SupplierList />;
  else conteudo = <SupplyScreen />;

  return (
    <div className="screen">
      <Abas abas={ABAS} atual={aba} onChange={setAba} bloqueadas={bloqueadas} />
      {conteudo}
    </div>
  );
}
