import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { POSScreen } from '../pos/POSScreen';
import { SalesHistory } from '../pos/SalesHistory';
import { ProductList } from '../inventory/ProductList';
import { SupplyScreen } from '../inventory/SupplyScreen';
import { StockAlerts } from '../inventory/StockAlerts';
import { SettingsScreen } from '../settings/SettingsScreen';
import { UserManagement } from '../users/UserManagement';
import { AuditLog } from '../users/AuditLog';
import { Dashboard } from '../pos/Dashboard';
import { CustomerList } from '../pos/CustomerList';
import { SupplierList } from '../pos/SupplierList';
import { ReturnFlow } from '../pos/ReturnFlow';
import { Clock } from './Clock';

const NAV_ITEMS = [
  { id: 'pos', label: 'PDV', roles: ['operador', 'gerente', 'admin'] },
  { id: 'dashboard', label: 'Painel', roles: ['gerente', 'admin'] },
  { id: 'history', label: 'Histórico', roles: ['operador', 'gerente', 'admin'] },
  { id: 'products', label: 'Produtos', roles: ['gerente', 'admin'] },
  { id: 'supply', label: 'Abastecimento', roles: ['gerente', 'admin'] },
  { id: 'customers', label: 'Clientes', roles: ['operador', 'gerente', 'admin'] },
  { id: 'suppliers', label: 'Fornecedores', roles: ['gerente', 'admin'] },
  { id: 'returns', label: 'Devolução', roles: ['operador', 'gerente', 'admin'] },
  { id: 'alerts', label: 'Alertas', roles: ['operador', 'gerente', 'admin'] },
  { id: 'settings', label: 'Configurações', roles: ['admin'] },
  { id: 'users', label: 'Usuários', roles: ['gerente', 'admin'] },
  { id: 'audit', label: 'Auditoria', roles: ['admin'] },
];

export function AppShell() {
  const { currentUser, logout } = useSession();
  const [screen, setScreen] = useState('pos');
  const [pdvNumero, setPdvNumero] = useState(null);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('gerenciaai:tema') === 'escuro');
  const [returnPreselectId, setReturnPreselectId] = useState(null);

  useEffect(() => {
    window.pdv.pdvRegistry.getStatus().then((s) => setPdvNumero(s.numeroPdv));
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('gerenciaai:tema', darkMode ? 'escuro' : 'claro');
  }, [darkMode]);

  const visibleItems = NAV_ITEMS.filter((item) => item.roles.includes(currentUser.role));

  // Operador de caixa vai direto para o PDV em tela cheia, sem menu — é o
  // fluxo do dia a dia e não deve ter distração nem acesso a outras telas.
  if (currentUser.role === 'operador') {
    return <POSScreen />;
  }

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo-mark.svg" alt="" width="26" height="26" />
          <span>GerenciaAI</span>
        </div>
        <div className="sidebar-clock-wrap"><Clock /></div>
        <ul>
          {visibleItems.map((item) => (
            <li key={item.id}>
              <button
                className={screen === item.id ? 'nav-item nav-item-active' : 'nav-item'}
                onClick={() => setScreen(item.id)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          {pdvNumero && <span className="sidebar-pdv-number">{pdvNumero}</span>}

          <div className="sidebar-user">
            <div className="sidebar-user-avatar">{currentUser.nome.charAt(0).toUpperCase()}</div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{currentUser.nome}</span>
              <span className="sidebar-user-role">{currentUser.role}</span>
            </div>
          </div>

          <div className="sidebar-footer-actions">
            <button className="theme-toggle-btn" onClick={() => setDarkMode((v) => !v)}>
              {darkMode ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.8 14.3A9 9 0 1 1 9.7 3.2a7 7 0 0 0 11.1 11.1z" />
                </svg>
              )}
              {darkMode ? 'Modo claro' : 'Modo escuro'}
            </button>

            <button className="theme-toggle-btn theme-toggle-btn-danger" onClick={logout}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
              Sair
            </button>
          </div>
        </div>
      </nav>
      <main className="main-content">
        {screen === 'pos' && <POSScreen />}
        {screen === 'dashboard' && <Dashboard />}
        {screen === 'history' && (
          <SalesHistory onDevolver={(saleId) => { setReturnPreselectId(saleId); setScreen('returns'); }} />
        )}
        {screen === 'products' && <ProductList />}
        {screen === 'supply' && <SupplyScreen />}
        {screen === 'customers' && <CustomerList />}
        {screen === 'suppliers' && <SupplierList />}
        {screen === 'returns' && (
          <ReturnFlow preselectSaleId={returnPreselectId} onPreselectConsumed={() => setReturnPreselectId(null)} />
        )}
        {screen === 'alerts' && <StockAlerts />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'users' && <UserManagement />}
        {screen === 'audit' && <AuditLog />}
      </main>
    </div>
  );
}
