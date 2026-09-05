import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import { useSession } from '../../context/SessionContext';
import { useProfile } from '../../context/ProfileContext';
// PDV e Restaurante ficam com import estático de propósito -- ver o
// comentário mais abaixo ("sempre montados"): eles entram na árvore desde
// o primeiro render (só escondidos com CSS), então carregá-los sob
// demanda não adiaria nada, só acrescentaria uma espera de Suspense sem
// necessidade na tela que abre primeiro.
import { POSScreen } from '../pos/POSScreen';
import { RestaurantScreen } from '../pos/RestaurantScreen';
import { CommandPalette } from './CommandPalette';
import { KeyboardHelpModal, useKeyboardHelpShortcut } from './KeyboardHelpModal';
import { Clock } from './Clock';
import { SwitchUserModal } from '../auth/SwitchUserModal';
import Icon from '../common/Icon';

// Todas as telas abaixo só entram na árvore quando `screen` vira o id
// correspondente (ver o <main> mais abaixo) -- carregadas sob demanda com
// React.lazy() em vez de import estático, pra não fazer todo mundo baixar
// e parsear o código de ~16 telas (Painel, Configurações, Financeiro,
// Cozinha, NFC-e...) só pra abrir o PDV, que é a tela que 100% dos
// usuários veem primeiro. Cada uma vira um chunk separado do Vite.
const HistoryScreen = lazy(() => import('../pos/HistoryScreen').then((m) => ({ default: m.HistoryScreen })));
const ProductsScreen = lazy(() => import('../inventory/ProductsScreen').then((m) => ({ default: m.ProductsScreen })));
const SupplyAndSuppliersScreen = lazy(() => import('../inventory/SupplyAndSuppliersScreen').then((m) => ({ default: m.SupplyAndSuppliersScreen })));
const FinanceiroScreen = lazy(() => import('../inventory/FinanceiroScreen').then((m) => ({ default: m.FinanceiroScreen })));
const StockAlerts = lazy(() => import('../inventory/StockAlerts').then((m) => ({ default: m.StockAlerts })));
const SettingsScreen = lazy(() => import('../settings/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));
const UserManagement = lazy(() => import('../users/UserManagement').then((m) => ({ default: m.UserManagement })));
const Dashboard = lazy(() => import('../pos/Dashboard').then((m) => ({ default: m.Dashboard })));
const CustomerList = lazy(() => import('../pos/CustomerList').then((m) => ({ default: m.CustomerList })));
const DeliveryScreen = lazy(() => import('../pos/DeliveryScreen').then((m) => ({ default: m.DeliveryScreen })));
const BotOrdersScreen = lazy(() => import('../pos/BotOrdersScreen').then((m) => ({ default: m.BotOrdersScreen })));
const KitchenDisplayScreen = lazy(() => import('../pos/KitchenDisplayScreen').then((m) => ({ default: m.KitchenDisplayScreen })));
const QuotesScreen = lazy(() => import('../pos/QuotesScreen').then((m) => ({ default: m.QuotesScreen })));
const AgendaScreen = lazy(() => import('../pos/AgendaScreen').then((m) => ({ default: m.AgendaScreen })));
const ServicePriceScreen = lazy(() => import('../pos/ServicePriceScreen').then((m) => ({ default: m.ServicePriceScreen })));
const ReservasScreen = lazy(() => import('../pos/ReservasScreen').then((m) => ({ default: m.ReservasScreen })));
const ReturnFlow = lazy(() => import('../pos/ReturnFlow').then((m) => ({ default: m.ReturnFlow })));

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

// Perfis que vendem serviço com tabela de preços/consulta rápida (ver
// ProductsScreen.jsx PERFIS_SERVICO_COM_MATERIAL, mesmo espírito —
// qualquer perfil novo que passe a usar "tipo_servico" entra aqui).
const PERFIS_TABELA_SERVICOS = ['salao_beleza'];

// Rótulo dos status "ativos" (na fila) pro balão de consulta rápida no
// contador da barra lateral — concluído/cancelado não aparecem aqui
// porque já saíram da fila (ver listActiveOrders no botOrderService).
const STATUS_SEPARACAO_LABEL = { novo: 'Novo', em_separacao: 'Em separação', pronto: 'Pronto' };

const NAV_ITEMS = [
  // Sem seção — ficam sempre no topo, são as telas de venda do dia a dia.
  { id: 'pos', icon: 'cart', label: 'PDV', roles: ['operador', 'gerente', 'admin', 'suporte'] },
  { id: 'restaurant', icon: 'plate', label: 'Restaurante', roles: ['operador', 'gerente', 'admin', 'suporte'], perfil: PERFIS_RESTAURANTE },
  { id: 'kitchen', icon: 'cooking', label: 'Cozinha', roles: ['operador', 'gerente', 'admin', 'suporte'], perfil: PERFIS_RESTAURANTE },

  { id: 'history', icon: 'receipt', label: 'Histórico', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Vendas' },
  { id: 'returns', icon: 'undo', label: 'Devolução', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Vendas' },
  { id: 'delivery', icon: 'truck', label: 'Delivery', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Vendas' },
  { id: 'quotes', icon: 'clipboard', label: 'Orçamentos', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Vendas' },
  { id: 'agenda', icon: 'calendar', label: 'Agenda', roles: ['operador', 'gerente', 'admin', 'suporte'], perfil: 'salao_beleza', section: 'Vendas' },
  { id: 'servicePrices', icon: 'card', label: 'Preços de Serviço', roles: ['operador', 'gerente', 'admin', 'suporte'], perfil: PERFIS_TABELA_SERVICOS, section: 'Vendas' },
  { id: 'reservations', icon: 'book', label: 'Reservas', roles: ['operador', 'gerente', 'admin', 'suporte'], perfil: PERFIS_RESTAURANTE, section: 'Vendas' },

  // Setor à parte, fora de qualquer perfil de negócio — só aparece
  // quando o admin ativa em Configurações (é onde o pedido separado
  // pelo chatbot de WhatsApp, ou digitado manualmente, cai pra alguém
  // separar). `requerBotDelivery` é filtrado dinamicamente abaixo,
  // igual a `perfil` — não dá pra decidir isso na hora de montar esta
  // lista estática porque depende de uma configuração salva no banco.
  { id: 'botOrders', icon: 'box', label: 'Separação', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Separação', requerBotDelivery: true },

  { id: 'products', icon: 'tag', label: 'Produtos', roles: ['gerente', 'admin', 'suporte'], section: 'Cadastros' },
  { id: 'customers', icon: 'users', label: 'Clientes', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Cadastros' },

  { id: 'dashboard', icon: 'chart', label: 'Painel', roles: ['gerente', 'admin', 'suporte'], section: 'Gestão' },
  { id: 'supply', icon: 'import', label: 'Abastecimento', roles: ['gerente', 'admin', 'suporte'], section: 'Gestão' },
  { id: 'financeiro', icon: 'money', label: 'Financeiro', roles: ['gerente', 'admin', 'suporte'], section: 'Gestão' },
  { id: 'alerts', icon: 'warning', label: 'Alertas', roles: ['operador', 'gerente', 'admin', 'suporte'], section: 'Gestão' },
  { id: 'users', icon: 'briefcase', label: 'Usuários', roles: ['gerente', 'admin', 'suporte'], section: 'Gestão' },

  // Gerente também vê Configurações agora (pra poder conectar/gerenciar
  // o canal de WhatsApp sozinho) — seções realmente restritas a admin
  // (segurança, restaurar backup) continuam bloqueadas no backend
  // mesmo que a tela apareça (ver authService.requireRole nos handlers).
  { id: 'settings', icon: 'settings', label: 'Configurações', roles: ['gerente', 'admin', 'suporte'], section: 'Sistema' },
];

// Ícone dos títulos de seção (gaveta) da barra lateral — puramente
// visual, pra bater com o mesmo padrão usado nas abas de Configurações.
const SECTION_ICON = { Vendas: 'cash', Separação: 'box', Cadastros: 'folder', Gestão: 'trendUp', Sistema: 'settings' };

// Cor própria de cada ícone da navegação lateral -- puramente visual,
// pra cada item ser reconhecível de relance em vez de ficar tudo no
// mesmo tom apagado. Escolhidas pra contrastar bem tanto com o verde
// bem escuro da sidebar (#0d2b28) quanto com o destaque do item ativo
// (--sidebar-accent, #1d5850). Vale pros ícones dos itens de menu e
// dos títulos de seção (que reaproveitam os mesmos nomes de ícone).
const NAV_ICON_COLOR = {
  cart: '#f5a623',
  plate: '#ff8a65',
  cooking: '#ef5350',
  receipt: '#4fc3f7',
  undo: '#ba68c8',
  truck: '#4dd0e1',
  clipboard: '#7986cb',
  calendar: '#f06292',
  card: '#26a69a',
  book: '#ab47bc',
  box: '#ffa726',
  tag: '#ff7043',
  users: '#26c6da',
  chart: '#42a5f5',
  import: '#66bb6a',
  money: '#ffca28',
  warning: '#f4511e',
  briefcase: '#7e57c2',
  settings: '#90a4ae',
  cash: '#ffd54f',
  folder: '#66bb6a',
  trendUp: '#42a5f5',
};

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
  const [pedidosSeparacaoAtivos, setPedidosSeparacaoAtivos] = useState([]);
  const [balaoSeparacaoAberto, setBalaoSeparacaoAberto] = useState(false);
  const [posicaoBalaoSeparacao, setPosicaoBalaoSeparacao] = useState({ top: 0, left: 0 });
  const badgeSeparacaoRef = useRef(null);
  const balaoSeparacaoRef = useRef(null);
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
    if (!botDeliveryAtivo) { setPedidosSeparacaoAtivos([]); return; }
    function carregarPedidosAtivos() {
      window.pdv.botOrders.listActive({ locationId: window.APP_LOCATION_ID })
        .then((list) => setPedidosSeparacaoAtivos(Array.isArray(list) ? list : []));
    }
    carregarPedidosAtivos();
    // Um pedido pode cair na fila a qualquer momento (digitado por
    // alguém, ou futuramente pelo chatbot do WhatsApp) enquanto quem
    // está usando o PDV está em qualquer outra tela — por isso esse
    // contador atualiza sozinho aqui, independente da aba aberta.
    const id = setInterval(carregarPedidosAtivos, 20000);
    return () => clearInterval(id);
  }, [botDeliveryAtivo]);

  useEscToClose(() => setBalaoSeparacaoAberto(false), balaoSeparacaoAberto);

  useEffect(() => {
    if (!balaoSeparacaoAberto) return;
    function handleClickFora(e) {
      if (balaoSeparacaoRef.current?.contains(e.target)) return;
      if (badgeSeparacaoRef.current?.contains(e.target)) return;
      setBalaoSeparacaoAberto(false);
    }
    document.addEventListener('mousedown', handleClickFora);
    return () => document.removeEventListener('mousedown', handleClickFora);
  }, [balaoSeparacaoAberto]);

  function handleAbrirBalaoSeparacao(e) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setPosicaoBalaoSeparacao({ top: rect.bottom + 6, left: rect.left });
    setBalaoSeparacaoAberto((v) => !v);
  }

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
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      {SECTION_ICON[grupo.titulo] && (
                        <Icon
                          name={SECTION_ICON[grupo.titulo]}
                          size={15}
                          className="nav-section-icon"
                          style={{ color: NAV_ICON_COLOR[SECTION_ICON[grupo.titulo]] }}
                        />
                      )}
                      {grupo.titulo}
                    </span>
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
                        <div style={{ display: 'flex', alignItems: 'stretch' }}>
                          <button
                            className={screen === item.id ? 'nav-item nav-item-active' : 'nav-item'}
                            style={{ flex: 1 }}
                            onClick={() => setScreen(item.id)}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                              <Icon name={item.icon} size={18} className="nav-icon" style={{ color: NAV_ICON_COLOR[item.icon] }} />
                              {item.label}
                            </span>
                            {item.id === 'products' && conflitosProdutos > 0 && (
                              <span className="badge-warning" style={{ marginLeft: 8 }} title="Produtos com conflito de código de barras da sincronização, esperando resolução">
                                <Icon name="warning" size={11} /> {conflitosProdutos}
                              </span>
                            )}
                          </button>
                          {item.id === 'botOrders' && pedidosSeparacaoAtivos.length > 0 && (
                            <button
                              ref={badgeSeparacaoRef}
                              type="button"
                              onClick={handleAbrirBalaoSeparacao}
                              title="Pedidos aguardando separação — clique para uma consulta rápida"
                              style={{
                                alignSelf: 'center', marginRight: 12, flexShrink: 0,
                                background: 'var(--sidebar-accent)', color: 'white', border: 'none',
                                borderRadius: 999, padding: '1px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                              }}
                            >
                              {pedidosSeparacaoAtivos.length}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <div className="sidebar-footer">
          {sincronizacaoAtiva && (
            <span className="sidebar-pdv-number" title="Sincronizado com outros PDVs" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="link" size={14} /> Sincronizado
            </span>
          )}

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
        {/* Suspense só cobre as telas carregadas sob demanda (ver os
            React.lazy() no topo do arquivo) -- PDV/Restaurante ficam de
            fora de propósito, seu import é estático. Fallback bem
            simples: a troca de aba já é rápida (chunk pequeno, geralmente
            cacheado pelo navegador depois da primeira vez), não precisa
            de um spinner elaborado pra um piscar de tela tão curto. */}
        <Suspense fallback={<div className="screen-hint" style={{ padding: 24 }}>Carregando…</div>}>
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
          {screen === 'servicePrices' && <ServicePriceScreen />}
          {screen === 'reservations' && <ReservasScreen />}
          {screen === 'returns' && (
            <ReturnFlow preselectSaleId={returnPreselectId} onPreselectConsumed={() => setReturnPreselectId(null)} />
          )}
          {screen === 'alerts' && <StockAlerts />}
          {screen === 'settings' && <SettingsScreen />}
          {screen === 'users' && <UserManagement />}
          {screen === 'botOrders' && <BotOrdersScreen />}
          {screen === 'kitchen' && <KitchenDisplayScreen />}
        </Suspense>
      </main>
      <CommandPalette items={visibleItems} onNavigate={setScreen} />
      {keyboardHelp.open && <KeyboardHelpModal onClose={keyboardHelp.close} />}
      {trocarUsuarioAberto && (
        <SwitchUserModal
          onClose={() => setTrocarUsuarioAberto(false)}
          onSwitched={() => setScreen('pos')}
        />
      )}
      {balaoSeparacaoAberto && (
        <div
          ref={balaoSeparacaoRef}
          className="cart-alert-popover"
          style={{ position: 'fixed', top: posicaoBalaoSeparacao.top, left: posicaoBalaoSeparacao.left, zIndex: 301 }}
        >
          <span className="cart-alert-popover-title">Pedidos aguardando separação</span>
          {pedidosSeparacaoAtivos.length === 0 ? (
            <p className="screen-hint" style={{ margin: 0 }}>Nenhum pedido na fila.</p>
          ) : (
            <ul>
              {pedidosSeparacaoAtivos.map((p) => (
                <li key={p.id}>
                  {p.cliente_nome} — {STATUS_SEPARACAO_LABEL[p.status] || p.status}
                  {p.tipo_entrega === 'entrega' ? ' (entrega)' : ' (retirada)'}
                </li>
              ))}
            </ul>
          )}
          <p className="screen-hint" style={{ margin: '8px 0 0' }}>
            Só consulta rápida — abra a aba "Separação" para atualizar um pedido.
          </p>
        </div>
      )}
    </div>
  );
}
