import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useProfile } from '../../context/ProfileContext';
import { POSScreen } from '../pos/POSScreen';
import { RestaurantScreen } from '../pos/RestaurantScreen';
import { HistoryScreen } from '../pos/HistoryScreen';
import { CommandPalette } from './CommandPalette';
import { KeyboardHelpModal, useKeyboardHelpShortcut } from './KeyboardHelpModal';
import { ProductsScreen } from '../inventory/ProductsScreen';
import { SupplyAndSuppliersScreen } from '../inventory/SupplyAndSuppliersScreen';
import { FinanceiroScreen } from '../inventory/FinanceiroScreen';
import { StockAlerts } from '../inventory/StockAlerts';
import { SettingsScreen } from '../settings/SettingsScreen';
import { UserManagement } from '../users/UserManagement';
import { Dashboard } from '../pos/Dashboard';
import { CustomerList } from '../pos/CustomerList';
import { DeliveryScreen } from '../pos/DeliveryScreen';
import { BotOrdersScreen } from '../pos/BotOrdersScreen';
import { QuotesScreen } from '../pos/QuotesScreen';
import { AgendaScreen } from '../pos/AgendaScreen';
import { ReturnFlow } from '../pos/ReturnFlow';
import { Clock } from './Clock';
import { SwitchUserModal } from '../auth/SwitchUserModal';

// Seções que já vêm fechadas (em "gaveta") na primeira vez que o app
// abre — depois disso, a escolha do usuário (aberta/fechada) fica
// salva em localStorage e prevalece. PDV (e Restaurante) nunca entram
// aqui: ficam soltos no topo, fora de qualquer seção, sempre visíveis.
const CHAVE_SECOES_FECHADAS = 'gerenciaai:secoes-fechadas';

// Perfis que trabalham com prato/receita/cardápio — usado pra decidir
// quais telas específicas de restaurante aparecem no menu. Hoje inclui
// Padaria também, já que ela também monta receita com insumos
// (farinha, fermento etc.) e pode ter itens tipo "prato do dia".
const PERFIS_RESTAURANTE = ['restaurante', 'padaria'];

const NAV_ITEMS = [
  // Sem seção — ficam sempre no topo, são as telas de venda do dia a dia.
  { id: 'pos', label: 'PDV', roles: ['operador', 'gerente', 'admin'] },
  { id: 'restaurant', label: 'Restaurante', roles: ['operador', 'gerente', 'admin'], perfil: PERFIS_RESTAURANTE },

  { id: 'history', label: 'Histórico', roles: ['operador', 'gerente', 'admin'], section: 'Vendas' },
  { id: 'returns', label: 'Devolução', roles: ['operador', 'gerente', 'admin'], section: 'Vendas' },
  { id: 'delivery', label: 'Delivery', roles: ['operador', 'gerente', 'admin'], section: 'Vendas' },
  { id: 'quotes', label: 'Orçamentos', roles: ['operador', 'gerente', 'admin'], section: 'Vendas' },
  { id: 'agenda', label: 'Agenda', roles: ['operador', 'gerente', 'admin'], perfil: 'salao_beleza', section: 'Vendas' },

  // Setor à parte, fora de qualquer perfil de negócio — só aparece
  // quando o admin ativa em Configurações (é onde o pedido separado
  // pelo chatbot de WhatsApp, ou digitado manualmente, cai pra alguém
  // separar). `requerBotDelivery` é filtrado dinamicamente abaixo,
  // igual a `perfil` — não dá pra decidir isso na hora de montar esta
  // lista estática porque depende de uma configuração salva no banco.
  { id: 'botOrders', label: 'Separação', roles: ['operador', 'gerente', 'admin'], section: 'Separação', requerBotDelivery: true },

  { id: 'products', label: 'Produtos', roles: ['gerente', 'admin'], section: 'Cadastros' },
  { id: 'customers', label: 'Clientes', roles: ['operador', 'gerente', 'admin'], section: 'Cadastros' },

  { id: 'dashboard', label: 'Painel', roles: ['gerente', 'admin'], section: 'Gestão' },
  { id: 'supply', label: 'Abastecimento', roles: ['gerente', 'admin'], section: 'Gestão' },
  { id: 'financeiro', label: 'Financeiro', roles: ['gerente', 'admin'], section: 'Gestão' },
  { id: 'alerts', label: 'Alertas', roles: ['operador', 'gerente', 'admin'], section: 'Gestão' },
  { id: 'users', label: 'Usuários', roles: ['gerente', 'admin'], section: 'Gestão' },

  { id: 'settings', label: 'Configurações', roles: ['admin'], section: 'Sistema' },
];

export function AppShell() {
  const { currentUser, logout } = useSession();
  const { profile } = useProfile();
  const [screen, setScreen] = useState('pos');
  const [sincronizacaoAtiva, setSincronizacaoAtiva] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('gerenciaai:tema') === 'escuro');
  const [returnPreselectId, setReturnPreselectId] = useState(null);
  const [conflitosProdutos, setConflitosProdutos] = useState(0);
  const [secoesFechadas, setSecoesFechadas] = useState(() => {
    try {
      const salvo = localStorage.getItem(CHAVE_SECOES_FECHADAS);
      return salvo ? new Set(JSON.parse(salvo)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [trocarUsuarioAberto, setTrocarUsuarioAberto] = useState(false);
  const [botDeliveryAtivo, setBotDeliveryAtivo] = useState(false);
  const keyboardHelp = useKeyboardHelpShortcut();

  function alternarSecao(titulo) {
    setSecoesFechadas((atual) => {
      const novo = new Set(atual);
      if (novo.has(titulo)) novo.delete(titulo); else novo.add(titulo);
      try { localStorage.setItem(CHAVE_SECOES_FECHADAS, JSON.stringify([...novo])); } catch { /* ok ignorar */ }
      return novo;
    });
  }

  useEffect(() => {
    window.pdv.pdvRegistry.getStatus().then((s) => setSincronizacaoAtiva(s.sincronizacaoAtiva));
  }, []);

  useEffect(() => {
    // Refeito a cada troca de tela (não só uma vez no início) — assim,
    // se o admin ligar "Separação" nas Configurações e voltar, o item
    // já aparece no menu sem precisar reabrir o app.
    window.pdv.botOrders.getConfig().then((c) => setBotDeliveryAtivo(!!c.ativo));
  }, [screen]);

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
    if (item.requerBotDelivery && !botDeliveryAtivo) return false;
    if (!item.perfil) return true;
    const perfisPermitidos = Array.isArray(item.perfil) ? item.perfil : [item.perfil];
    return perfisPermitidos.includes(profile?.id);
  });

  // Agrupa mantendo a ordem de NAV_ITEMS — item sem `section` fica
  // solto no topo (grupo ''), o resto vira uma seção com cabeçalho.
  const grupos = [];
  for (const item of visibleItems) {
    const chave = item.section || '';
    let grupo = grupos.find((g) => g.titulo === chave);
    if (!grupo) { grupo = { titulo: chave, itens: [] }; grupos.push(grupo); }
    grupo.itens.push(item);
  }

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo-mark.svg" alt="" width="26" height="26" />
          <span>GerenciaAI</span>
        </div>
        <div className="sidebar-clock-wrap"><Clock /></div>
        <p className="sidebar-shortcut-hint">Ctrl+K: busca rápida · ?: atalhos de teclado</p>
        <ul
          onKeyDown={(e) => {
            // Setas pra navegar entre os itens do menu sem precisar de
            // mouse — comportamento padrão de menu, mesma ideia do
            // Ctrl+K (que já usa seta+Enter internamente).
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const botoes = Array.from(e.currentTarget.querySelectorAll('button.nav-item'));
            const indiceAtual = botoes.indexOf(document.activeElement);
            const proximo = e.key === 'ArrowDown'
              ? botoes[Math.min(indiceAtual + 1, botoes.length - 1)]
              : botoes[Math.max(indiceAtual - 1, 0)];
            (proximo || botoes[0])?.focus();
          }}
        >
          {grupos.map((grupo) => {
            // PDV e Restaurante caem no grupo sem título ('') — ficam
            // sempre soltos no topo, sem seta e sem poder ser
            // escondidos. Só as seções com título (Vendas, Cadastros,
            // Gestão, Sistema) viram gaveta.
            const temSecao = !!grupo.titulo;
            const fechado = temSecao && secoesFechadas.has(grupo.titulo);
            return (
              <li key={grupo.titulo || '_topo'} className="nav-group">
                {temSecao && (
                  <button
                    type="button"
                    className="nav-section-title"
                    onClick={() => alternarSecao(grupo.titulo)}
                    aria-expanded={!fechado}
                  >
                    <span>{grupo.titulo}</span>
                    <svg
                      className={fechado ? 'nav-section-arrow nav-section-arrow-fechado' : 'nav-section-arrow'}
                      width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                )}
                {(!temSecao || !fechado) && (
                  <ul className="nav-group-list">
                    {grupo.itens.map((item) => (
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
                )}
              </li>
            );
          })}
        </ul>
        <div className="sidebar-footer">
          {sincronizacaoAtiva && <span className="sidebar-pdv-number" title="Sincronizado com outros PDVs">🔗 Sincronizado</span>}

          <button
            type="button"
            className="sidebar-user sidebar-user-switch"
            onClick={() => setTrocarUsuarioAberto(true)}
            title="Trocar de operador"
          >
            <div className="sidebar-user-avatar">{currentUser.nome.charAt(0).toUpperCase()}</div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{currentUser.nome}</span>
              <span className="sidebar-user-role">{currentUser.role}</span>
            </div>
            <svg className="sidebar-user-switch-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 2l4 4-4 4" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <path d="M7 22l-4-4 4-4" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          </button>

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
          {/* key={currentUser.id}: força remontar ao trocar de operador
              (menu "Trocar de operador") — sem isso, o carrinho/venda em
              aberto do operador anterior continuava aparecendo pro novo
              operador (o efeito que retoma venda em aberto só roda
              quando `saleId` ainda está vazio). Com o remount, o
              componente nasce de novo do zero e já busca a venda em
              aberto certa, a do operador que acabou de entrar. */}
          <POSScreen key={currentUser.id} />
        </div>
        <div style={{ display: screen === 'restaurant' ? 'block' : 'none', height: '100%' }}>
          <RestaurantScreen key={currentUser.id} />
        </div>
        {screen === 'dashboard' && <Dashboard />}
        {screen === 'history' && (
          <HistoryScreen onDevolver={(saleId) => { setReturnPreselectId(saleId); setScreen('returns'); }} />
        )}
        {screen === 'products' && <ProductsScreen />}
        {screen === 'supply' && <SupplyAndSuppliersScreen />}
        {screen === 'financeiro' && <FinanceiroScreen />}
        {screen === 'customers' && <CustomerList />}
        {screen === 'delivery' && <DeliveryScreen />}
        {screen === 'quotes' && <QuotesScreen />}
        {screen === 'agenda' && <AgendaScreen />}
        {screen === 'returns' && (
          <ReturnFlow preselectSaleId={returnPreselectId} onPreselectConsumed={() => setReturnPreselectId(null)} />
        )}
        {screen === 'alerts' && <StockAlerts />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'users' && <UserManagement />}
        {screen === 'botOrders' && <BotOrdersScreen />}
      </main>
      <CommandPalette items={visibleItems} onNavigate={setScreen} />
      {keyboardHelp.open && <KeyboardHelpModal onClose={keyboardHelp.close} />}
      {trocarUsuarioAberto && (
        <SwitchUserModal
          onClose={() => setTrocarUsuarioAberto(false)}
          onSwitched={() => setScreen('pos')}
        />
      )}
    </div>
  );
}
