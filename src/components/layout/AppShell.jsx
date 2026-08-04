import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useProfile } from '../../context/ProfileContext';
import { POSScreen } from '../pos/POSScreen';
import { RestaurantScreen } from '../pos/RestaurantScreen';
import { HistoryScreen } from '../pos/HistoryScreen';
import { CommandPalette } from './CommandPalette';
import { ProductsScreen } from '../inventory/ProductsScreen';
import { SupplyAndSuppliersScreen } from '../inventory/SupplyAndSuppliersScreen';
import { FinanceiroScreen } from '../inventory/FinanceiroScreen';
import { StockAlerts } from '../inventory/StockAlerts';
import { SettingsScreen } from '../settings/SettingsScreen';
import { UserManagement } from '../users/UserManagement';
import { Dashboard } from '../pos/Dashboard';
import { CustomerList } from '../pos/CustomerList';
import { ReturnFlow } from '../pos/ReturnFlow';
import { Clock } from './Clock';

// Perfis que trabalham com prato/receita/cardápio — usado pra decidir
// quais telas específicas de restaurante aparecem no menu. Hoje inclui
// Padaria também, já que ela também monta receita com insumos
// (farinha, fermento etc.) e pode ter itens tipo "prato do dia".
const PERFIS_RESTAURANTE = ['restaurante', 'padaria'];

const NAV_ITEMS = [
  { id: 'pos', label: 'PDV', roles: ['operador', 'gerente', 'admin'] },
  { id: 'restaurant', label: 'Restaurante', roles: ['operador', 'gerente', 'admin'], perfil: PERFIS_RESTAURANTE },
  { id: 'dashboard', label: 'Painel', roles: ['gerente', 'admin'] },
  { id: 'history', label: 'Histórico', roles: ['operador', 'gerente', 'admin'] },
  { id: 'products', label: 'Produtos', roles: ['gerente', 'admin'] },
  { id: 'supply', label: 'Abastecimento', roles: ['gerente', 'admin'] },
  { id: 'financeiro', label: 'Financeiro', roles: ['gerente', 'admin'] },
  { id: 'customers', label: 'Clientes', roles: ['operador', 'gerente', 'admin'] },
  { id: 'returns', label: 'Devolução', roles: ['operador', 'gerente', 'admin'] },
  { id: 'alerts', label: 'Alertas', roles: ['operador', 'gerente', 'admin'] },
  { id: 'settings', label: 'Configurações', roles: ['admin'] },
  { id: 'users', label: 'Usuários', roles: ['gerente', 'admin'] },
];

export function AppShell() {
  const { currentUser, logout } = useSession();
  const { profile } = useProfile();
  const [screen, setScreen] = useState('pos');
  const [sincronizacaoAtiva, setSincronizacaoAtiva] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('gerenciaai:tema') === 'escuro');
  const [returnPreselectId, setReturnPreselectId] = useState(null);
  const [conflitosProdutos, setConflitosProdutos] = useState(0);

  useEffect(() => {
    window.pdv.pdvRegistry.getStatus().then((s) => setSincronizacaoAtiva(s.sincronizacaoAtiva));
  }, []);

  useEffect(() => {
    if (!sincronizacaoAtiva) return;
    function checarConflitos() {
      window.pdv.products.countConflitosCodigoBarrasPendentes().then(setConflitosProdutos);
    }
    checarConflitos();
    // A cada 2 minutos é o suficiente — não é algo que muda toda hora,
    // só depois de a sincronização detectar um conflito novo.
    const id = setInterval(checarConflitos, 2 * 60 * 1000);
    return () => clearInterval(id);
  }, [sincronizacaoAtiva]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('gerenciaai:tema', darkMode ? 'escuro' : 'claro');
  }, [darkMode]);

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(currentUser.role)) return false;
    if (!item.perfil) return true;
    const perfisPermitidos = Array.isArray(item.perfil) ? item.perfil : [item.perfil];
    return perfisPermitidos.includes(profile?.id);
  });

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo-mark.svg" alt="" width="26" height="26" />
          <span>GerenciaAI</span>
        </div>
        <div className="sidebar-clock-wrap"><Clock /></div>
        <p className="sidebar-shortcut-hint">Ctrl+K: busca rápida</p>
        <ul>
          {visibleItems.map((item) => (
            <li key={item.id}>
              <button
                className={screen === item.id ? 'nav-item nav-item-active' : 'nav-item'}
                onClick={() => setScreen(item.id)}
              >
                {item.label}
                {item.id === 'products' && conflitosProdutos > 0 && (
                  <span className="badge-warning" style={{ marginLeft: 8 }} title="Produtos com conflito de código de barras da sincronização, esperando resolução">
                    ⚠ {conflitosProdutos}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          {sincronizacaoAtiva && <span className="sidebar-pdv-number" title="Sincronizado com outros PDVs">🔗 Sincronizado</span>}

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
        {/* PDV e Restaurante ficam sempre montados, só escondidos com
            CSS, em vez de desmontados/recriados a cada troca de aba —
            sem isso, voltar pro PDV no meio de um atendimento perdia o
            que estava digitado na busca, reiniciava buscas, etc. As
            outras telas continuam recriando ao revisitar de propósito
            (faz sentido querer dado fresco no Histórico, por exemplo). */}
        <div style={{ display: screen === 'pos' ? 'block' : 'none', height: '100%' }}>
          <POSScreen />
        </div>
        <div style={{ display: screen === 'restaurant' ? 'block' : 'none', height: '100%' }}>
          <RestaurantScreen />
        </div>
        {screen === 'dashboard' && <Dashboard />}
        {screen === 'history' && (
          <HistoryScreen onDevolver={(saleId) => { setReturnPreselectId(saleId); setScreen('returns'); }} />
        )}
        {screen === 'products' && <ProductsScreen />}
        {screen === 'supply' && <SupplyAndSuppliersScreen />}
        {screen === 'financeiro' && <FinanceiroScreen />}
        {screen === 'customers' && <CustomerList />}
        {screen === 'returns' && (
          <ReturnFlow preselectSaleId={returnPreselectId} onPreselectConsumed={() => setReturnPreselectId(null)} />
        )}
        {screen === 'alerts' && <StockAlerts />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'users' && <UserManagement />}
      </main>
      <CommandPalette items={visibleItems} onNavigate={setScreen} />
    </div>
  );
}
