import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ProductSearchBox } from './ProductSearchBox';
import { CategoryProductBrowser } from './CategoryProductBrowser';
import { PaymentPanel } from './PaymentPanel';

// Só carrega quando alguém abre o montador de item personalizado (ver POSScreen).
const CustomItemBuilder = lazy(() => import('./CustomItemBuilder').then((m) => ({ default: m.CustomItemBuilder })));
import { ManagerAuthModal } from './ManagerAuthModal';
import { VincularClienteModal } from './VincularClienteModal';
import { useEscToClose } from '../../hooks/useEscToClose';
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner';
import { usePromptModal } from '../../hooks/usePromptModal';
import { PromptModal } from '../common/PromptModal';
import { playBeep } from '../../utils/sound';
import Icon from '../common/Icon';
import { DropdownMenu, DropdownMenuItem } from '../common/DropdownMenu';

function playErrorBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 220;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch (err) { /* sem suporte a áudio, sem problema — só não toca o som */ }
}

/**
 * @param {{ tableId: string, saleId: string, numero: string, nome?: string, onFechar: () => void }} props
 */
export function TableOrderScreen({ tableId, saleId, numero, nome, pessoas: pessoasIniciais, onFechar }) {
  // Lido aqui dentro (não no topo do módulo) de propósito: o topo do
  // módulo roda durante a avaliação do grafo de imports, ANTES do
  // bootstrap() do main.jsx terminar de buscar o local real — capturar
  // window.APP_LOCATION_ID ali sempre dava undefined (mesmo problema já
  // corrigido antes no POSScreen). Aqui dentro já roda depois do app montado.
  const LOCATION_ID = window.APP_LOCATION_ID;
  const DEVICE_ID = window.APP_DEVICE_ID;
  const { currentUser } = useSession();
  const { promptState, promptAsync, confirmarPrompt, cancelarPrompt } = usePromptModal();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [taxaServicoPercentual, setTaxaServicoPercentual] = useState(0);
  const [pendingQty, setPendingQty] = useState('1');
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [pessoas, setPessoasAtual] = useState(pessoasIniciais);
  const [editandoPessoas, setEditandoPessoas] = useState(false);
  useEscToClose(() => setEditandoPessoas(false), editandoPessoas);
  const [pessoasInput, setPessoasInput] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  useEscToClose(() => setShowPayment(false), showPayment);
  const [authAction, setAuthAction] = useState(null); // { itemId } | null
  const [editandoObs, setEditandoObs] = useState(null); // { itemId, valor } | null
  useEscToClose(() => setEditandoObs(null), !!editandoObs);
  const [showTransferir, setShowTransferir] = useState(false);
  useEscToClose(() => setShowTransferir(false), showTransferir);
  const [mesasLivres, setMesasLivres] = useState([]);
  const [transferError, setTransferError] = useState('');
  const [showCustomItemBuilder, setShowCustomItemBuilder] = useState(false);
  // Pessoas da comanda (vagas 1..N, com nome opcional) e grupo de mesas unidas.
  const [pessoasLista, setPessoasLista] = useState([]);
  const [grupo, setGrupo] = useState(null); // { principal, unidas: [] } | null
  const [showJuntar, setShowJuntar] = useState(false);
  useEscToClose(() => setShowJuntar(false), showJuntar);
  const [mesasParaJuntar, setMesasParaJuntar] = useState([]);
  const [juntarSelecionadas, setJuntarSelecionadas] = useState([]);
  const [juntarError, setJuntarError] = useState('');
  const [juntando, setJuntando] = useState(false);
  // Para quem os próximos itens vão (null = sem pessoa). Escolhe uma vez e
  // vai tocando nos produtos -- sem escolher a pessoa item por item.
  const [pessoaAtiva, setPessoaAtiva] = useState(null);
  // Pessoa com a janela "ligar a um cliente do cadastro" aberta.
  const [vinculandoPessoa, setVinculandoPessoa] = useState(null);

  const aplicarPessoas = useCallback((lista) => {
    const pessoasDaComanda = Array.isArray(lista) ? lista : [];
    setPessoasLista(pessoasDaComanda);
    setPessoasAtual(pessoasDaComanda.length || null);
    setPessoaAtiva((atual) => (atual && atual <= pessoasDaComanda.length ? atual : null));
  }, []);

  const recarregarComanda = useCallback(async () => {
    const cart = await window.pdv.table.getCart({ saleId });
    setItems(cart.items || []);
    setTotal(cart.total || 0);
    setTaxaServicoPercentual(cart.taxaServicoPercentual || 0);
    aplicarPessoas(cart.pessoas);
    setGrupo(cart.grupo || null);
  }, [saleId, aplicarPessoas]);

  useEffect(() => { recarregarComanda(); }, [recarregarComanda]);
  // Nome de pessoa, item ou pessoa nova lançados pelo celular aparecem na hora.
  useEffect(() => window.pdv.table.onMudou?.(() => { recarregarComanda(); }), [recarregarComanda]);

  useEffect(() => {
    if (!feedback) return;
    const id = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(id);
  }, [feedback]);

  async function addProductToCart(product) {
    const quantidade = Math.max(1, Number(pendingQty) || 1);
    const result = await window.pdv.sale.addItem({
      saleId, productId: product.id, locationId: LOCATION_ID,
      quantidade, operadorId: currentUser.id, deviceId: DEVICE_ID, pessoaNumero: pessoaAtiva,
    });
    if (!result.ok) {
      setFeedback({ message: result.error, type: 'error' });
      return;
    }
    setItems((prev) => {
      const existeIndex = prev.findIndex((it) => it.id === result.itemId);
      if (existeIndex >= 0) {
        const atualizado = [...prev];
        atualizado[existeIndex] = { ...atualizado[existeIndex], quantidade: result.quantidadeTotal };
        return atualizado;
      }
      return [...prev, {
        id: result.itemId, nome: product.nome, quantidade, precoUnitario: result.precoUnitario, cancelado: false,
        pessoaNumero: pessoaAtiva,
      }];
    });
    playBeep();
    // Total vem direto do backend (recalculado do zero a partir das linhas
    // ativas), não de um incremento local — ver saleService.recalcularTotal.
    setTotal(result.novoTotal);
    setPendingQty('1');
    const destino = pessoasLista.find((p) => p.numero === pessoaAtiva);
    setFeedback({ message: `${product.nome} adicionado${destino ? ` para ${destino.nome || `Pessoa ${destino.numero}`}` : ''}.`, type: 'success' });
  }

  /** Item personalizado já foi gravado no backend pelo CustomItemBuilder —
   * aqui só reflete no carrinho da mesa, igual addProductToCart faz
   * depois de um addItem normal. */
  function handleCustomItemAdded(result) {
    if (pessoaAtiva) window.pdv.sale.setItemPerson({ saleItemId: result.itemId, pessoaNumero: pessoaAtiva });
    setItems((prev) => [...prev, {
      id: result.itemId, nome: result.nome, quantidade: 1, precoUnitario: result.precoUnitario, cancelado: false,
      pessoaNumero: pessoaAtiva,
    }]);
    setTotal(result.novoTotal); // recalculado no backend — ver addProductToCart
    setShowCustomItemBuilder(false);
    setFeedback({ message: `${result.nome} adicionado.`, type: 'success' });
    playBeep();
  }

  const handleScan = useCallback(async (codigoBarras) => {
    const product = await window.pdv.products.findByBarcode(codigoBarras);
    if (product) {
      addProductToCart(product);
      return;
    }

    if (window.pdv.productSync) {
      const doGrupo = await window.pdv.productSync.buscarNoGrupoPorCodigoBarras({ codigoBarras });
      if (doGrupo) {
        await window.pdv.productSync.importarDoGrupo(doGrupo);
        addProductToCart({
          id: doGrupo.id, nome: doGrupo.nome, preco: doGrupo.preco,
          codigo_barras: doGrupo.codigoBarras, sku: doGrupo.sku, categoria: doGrupo.categoria,
        });
        return;
      }
    }

    setFeedback({ message: `Código não encontrado: ${codigoBarras}`, type: 'error' });
    playErrorBeep();
  }, [addProductToCart]);

  useBarcodeScanner(handleScan, { enabled: !showPayment && !authAction && !editandoObs && !showTransferir && !editandoPessoas && !showCustomItemBuilder && !showJuntar && !promptState && !vinculandoPessoa });

  async function requestCancelItem(itemId) {
    const check = await window.pdv.sale.needsManagerAuthForCancel({ saleId });
    if (!check.needsAuth) {
      const result = await window.pdv.sale.cancelItem({
        saleId, saleItemId: itemId, locationId: LOCATION_ID,
        currentOperatorId: currentUser.id, deviceId: DEVICE_ID,
      });
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, cancelado: true } : i)));
        setTotal(result.novoTotal); // recalculado no backend — auto-corrige qualquer deriva anterior
        setSelectedItemId(null);
      } else {
        setFeedback({ message: result.error, type: 'error' });
      }
      return;
    }
    setAuthAction({ type: 'cancelItem', itemId });
  }

  async function requestDesocupar() {
    if (!confirm(`Desocupar ${nome || `Mesa ${numero}`}? Isso cancela a comanda em aberto dessa mesa.`)) return;

    if (itensAtivos.length === 0) {
      // Sem nenhum item lançado ainda -- libera direto, sem pedir
      // autorização de gerente (não tem risco de fraude nenhum em
      // cancelar algo que nunca teve nada dentro).
      const result = await window.pdv.table.desocupar({
        tableId, locationId: LOCATION_ID, currentOperatorId: currentUser.id, deviceId: DEVICE_ID,
      });
      if (result.ok) { onFechar(); } else { setFeedback({ message: result.error, type: 'error' }); }
      return;
    }

    const config = await window.pdv.auth.getSecurityConfig();
    if (config.exigir_autorizacao_cancelamento !== 1) {
      const result = await window.pdv.table.desocupar({
        tableId, locationId: LOCATION_ID, currentOperatorId: currentUser.id, deviceId: DEVICE_ID,
      });
      if (result.ok) { onFechar(); } else { setFeedback({ message: result.error, type: 'error' }); }
      return;
    }

    setAuthAction({ type: 'desocupar' });
  }

  function abrirEdicaoObs(item) {
    setEditandoObs({ itemId: item.id, valor: item.observacao || '' });
  }

  async function salvarObs(e) {
    e.preventDefault();
    await window.pdv.sale.setItemNote({ saleItemId: editandoObs.itemId, observacao: editandoObs.valor });
    setItems((prev) => prev.map((i) => (i.id === editandoObs.itemId ? { ...i, observacao: editandoObs.valor.trim() } : i)));
    setEditandoObs(null);
  }

  async function handleEditarPrecoItem(item) {
    const novoPrecoStr = await promptAsync(`Novo preço unitário para "${item.nome}" (preço atual: R$ ${item.precoUnitario.toFixed(2)}):`, item.precoUnitario.toFixed(2));
    if (novoPrecoStr === null) return;
    const novoPreco = Number(novoPrecoStr.replace(',', '.'));
    if (!(novoPreco >= 0)) return setFeedback({ message: 'Preço inválido.', type: 'error' });

    const motivo = await promptAsync('Motivo da alteração (opcional — ex: "Cortesia cliente antigo"):', '');

    const result = await window.pdv.sale.setItemPrice({
      saleId, saleItemId: item.id, novoPreco, motivo: motivo || null, currentOperatorId: currentUser.id,
    });
    if (!result.ok) return setFeedback({ message: result.error, type: 'error' });

    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, precoUnitario: result.novoPreco } : i)));
    setTotal(result.novoTotal); // recalculado no backend — ver addProductToCart
    setFeedback({ message: `Preço de "${item.nome}" atualizado.`, type: 'success' });
  }

  async function abrirTransferencia() {
    setTransferError('');
    const list = await window.pdv.table.list({ locationId: window.APP_LOCATION_ID });
    setMesasLivres(Array.isArray(list) ? list.filter((t) => t.status === 'livre' && t.id !== tableId) : []);
    setShowTransferir(true);
  }

  async function confirmarTransferencia(toTableId) {
    const result = await window.pdv.table.transfer({ fromTableId: tableId, toTableId });
    if (!result.ok) {
      setTransferError(result.error);
      return;
    }
    setShowTransferir(false);
    onFechar(); // a comanda saiu dessa mesa, volta pra grade
  }

  function abrirEdicaoPessoas() {
    setPessoasInput(String(pessoas || ''));
    setEditandoPessoas(true);
  }

  async function confirmarEdicaoPessoas(e) {
    e.preventDefault();
    const novoValor = Number(pessoasInput);
    if (!novoValor || novoValor < 1) return;
    const result = await window.pdv.table.updatePeople({ tableId, pessoas: novoValor });
    if (!result.ok) {
      setFeedback({ message: result.error, type: 'error' });
      return;
    }
    aplicarPessoas(result.pessoas);
    setEditandoPessoas(false);
  }

  // ---- pessoas nomeadas (sem limite) ----
  const rotuloPessoa = (p) => (p.nome ? `${p.numero} · ${p.nome}` : `Pessoa ${p.numero}`);

  async function adicionarPessoa() {
    const nomeDigitado = await promptAsync('Nome da nova pessoa (opcional):', '', { placeholder: 'Ex: Ana' });
    if (nomeDigitado === null) return;
    const result = await window.pdv.table.adicionarPessoa({ tableId, nome: nomeDigitado });
    if (!result.ok) return setFeedback({ message: result.error, type: 'error' });
    aplicarPessoas(result.pessoas);
  }

  async function renomearPessoa(pessoa) {
    const nomeDigitado = await promptAsync(`Nome da pessoa ${pessoa.numero} (vazio apaga o nome):`, pessoa.nome || '', { placeholder: 'Ex: Ana' });
    if (nomeDigitado === null) return;
    const result = await window.pdv.table.renomearPessoa({ tableId, numero: pessoa.numero, nome: nomeDigitado });
    if (!result.ok) return setFeedback({ message: result.error, type: 'error' });
    aplicarPessoas(result.pessoas);
  }

  async function removerPessoa(pessoa) {
    const result = await window.pdv.table.removerPessoa({ tableId, numero: pessoa.numero });
    if (!result.ok) return setFeedback({ message: result.error, type: 'error' });
    // Itens dessa pessoa voltaram para "não atribuído" e as seguintes subiram um número.
    setPessoaAtiva(null);
    await recarregarComanda();
    setFeedback({ message: `${rotuloPessoa(pessoa)} removida. Os itens dela ficaram sem pessoa.`, type: 'success' });
  }

  async function vincularCliente(pessoa, customerId) {
    const result = await window.pdv.table.vincularCliente({ tableId, numero: pessoa.numero, customerId });
    if (!result.ok) return setFeedback({ message: result.error, type: 'error' });
    aplicarPessoas(result.pessoas);
    setVinculandoPessoa(null);
    const atual = result.pessoas.find((p) => p.numero === pessoa.numero);
    setFeedback({
      message: customerId ? `${nomeCurto(atual || pessoa)} ligada ao cliente ${atual?.clienteNome}.` : `${nomeCurto(atual || pessoa)} não está mais ligada a um cliente.`,
      type: 'success',
    });
  }

  // ---- juntar e separar mesas ----
  async function abrirJuntar() {
    setJuntarError('');
    setJuntarSelecionadas([]);
    const list = await window.pdv.table.list({ locationId: window.APP_LOCATION_ID });
    const idsDoGrupo = new Set([tableId, grupo?.principal?.id, ...(grupo?.unidas || []).map((m) => m.id)].filter(Boolean));
    setMesasParaJuntar(Array.isArray(list)
      ? list.filter((t) => !idsDoGrupo.has(t.id) && !t.unida_a_mesa_id && (t.status === 'livre' || t.status === 'ocupada'))
      : []);
    setShowJuntar(true);
  }

  async function confirmarJuntar() {
    if (juntarSelecionadas.length === 0) return setJuntarError('Escolha pelo menos uma mesa.');
    setJuntando(true);
    const result = await window.pdv.table.juntar({ tableId, mesaIds: juntarSelecionadas, currentOperatorId: currentUser.id });
    setJuntando(false);
    if (!result.ok) return setJuntarError(result.error);
    await recarregarComanda();
    setShowJuntar(false);
    setFeedback({ message: 'Mesas unidas. A conta agora é uma só.', type: 'success' });
  }

  async function separarMesa(mesa) {
    const result = await window.pdv.table.separar({ tableId: mesa.id, currentOperatorId: currentUser.id });
    if (!result.ok) return setJuntarError(result.error);
    if (mesa.id === tableId) {
      // Esta tela era a da mesa separada: ela não tem mais comanda.
      setShowJuntar(false);
      onFechar();
      return;
    }
    await recarregarComanda();
    setFeedback({ message: `${mesa.nome || `Mesa ${mesa.numero}`} separada. O consumo continua nesta comanda.`, type: 'success' });
  }

  async function handleImprimirComanda() {
    const result = await window.pdv.print.kitchenTicket({ saleId, mesaLabel: nome || `Mesa ${numero}` });
    if (!result.ok) {
      setFeedback({ message: result.error, type: 'error' });
      return;
    }
    setFeedback({ message: `Comanda enviada — ${result.totalItens} item(ns).`, type: 'success' });
  }

  async function handleAuthConfirm(candidateId, pin, motivo) {
    if (authAction.type === 'desocupar') {
      const result = await window.pdv.table.desocupar({
        tableId, locationId: LOCATION_ID, currentOperatorId: currentUser.id,
        candidateManagerId: candidateId, pin, motivo, deviceId: DEVICE_ID,
      });
      if (result.ok) {
        setAuthAction(null);
        onFechar();
      }
      return result;
    }

    const result = await window.pdv.sale.cancelItem({
      saleId, saleItemId: authAction.itemId, locationId: LOCATION_ID,
      currentOperatorId: currentUser.id, candidateManagerId: candidateId, pin, motivo, deviceId: DEVICE_ID,
    });
    if (result.ok) {
      setItems((prev) => prev.map((i) => (i.id === authAction.itemId ? { ...i, cancelado: true } : i)));
      setTotal(result.novoTotal); // recalculado no backend — auto-corrige qualquer deriva anterior
      setAuthAction(null);
      setSelectedItemId(null);
    }
    return result;
  }

  const itensAtivos = items.filter((i) => !i.cancelado);

  // Comanda agrupada por pessoa: quem tem item, quem ainda não tem, e "Sem pessoa".
  const numerosValidos = new Set(pessoasLista.map((p) => p.numero));
  const gruposComItens = pessoasLista
    .map((p) => ({ numero: p.numero, pessoa: p, itens: itensAtivos.filter((i) => i.pessoaNumero === p.numero) }))
    .filter((g) => g.itens.length > 0);
  const pessoasSemItens = pessoasLista.filter((p) => !itensAtivos.some((i) => i.pessoaNumero === p.numero));
  const itensSemPessoa = itensAtivos.filter((i) => !i.pessoaNumero || !numerosValidos.has(i.pessoaNumero));
  const subtotal = (lista) => lista.reduce((acc, i) => acc + i.precoUnitario * i.quantidade, 0);
  const nomeCurto = (p) => p.nome || `Pessoa ${p.numero}`;
  const podeEditarPreco = ['gerente', 'admin', 'suporte'].includes(currentUser.role);

  async function atribuirPessoa(itemId, valor) {
    const pessoaNumero = valor ? Number(valor) : null;
    await window.pdv.sale.setItemPerson({ saleItemId: itemId, pessoaNumero });
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, pessoaNumero } : i)));
  }


  function renderItem(item) {
    return (
      <li
        key={item.id}
        className={selectedItemId === item.id ? 'mesa-item mesa-item-selecionado' : 'mesa-item'}
        onClick={() => setSelectedItemId(item.id)}
      >
        <span className="mesa-item-nome">
          {item.nome} × {item.quantidade}
          {item.observacao && <span className="mesa-item-obs"><Icon name="warning" size={12} /> {item.observacao}</span>}
        </span>
        <span className="mesa-item-preco">{(item.precoUnitario * item.quantidade).toFixed(2)}</span>
        <DropdownMenu label="⋯">
          {pessoasLista.filter((p) => p.numero !== item.pessoaNumero).map((p) => (
            <DropdownMenuItem key={p.numero} onClick={() => atribuirPessoa(item.id, p.numero)}>Mover para {nomeCurto(p)}</DropdownMenuItem>
          ))}
          {item.pessoaNumero && <DropdownMenuItem onClick={() => atribuirPessoa(item.id, '')}>Tirar da pessoa</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => abrirEdicaoObs(item)}>{item.observacao ? 'Editar observação' : 'Observação'}</DropdownMenuItem>
          {podeEditarPreco && <DropdownMenuItem onClick={() => handleEditarPrecoItem(item)}>Editar preço</DropdownMenuItem>}
          <DropdownMenuItem danger onClick={() => requestCancelItem(item.id)}>Cancelar item</DropdownMenuItem>
        </DropdownMenu>
      </li>
    );
  }

  return (
    <div className="pos-screen mesa-tela">
      <header className="pos-header">
        <h1>
          {grupo?.principal ? (grupo.principal.nome || `Mesa ${grupo.principal.numero}`) : (nome || `Mesa ${numero}`)}
          {grupo?.unidas?.length > 0 && (
            <span className="mesa-unidas-titulo"> + {grupo.unidas.map((m) => m.nome || `Mesa ${m.numero}`).join(' + ')}</span>
          )}
        </h1>
        <div className="pos-header-right">
          <button className="close-cash-btn" onClick={abrirJuntar}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="link" size={15} /> {grupo?.unidas?.length > 0 ? `Mesas unidas (${grupo.unidas.length})` : 'Juntar mesas'}
            </span>
          </button>
          <button className="close-cash-btn" onClick={handleImprimirComanda} title="Imprimir a comanda para a cozinha">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="printer" size={15} /> Cozinha</span>
          </button>
          <DropdownMenu label="Mais">
            <DropdownMenuItem onClick={abrirEdicaoPessoas}>Número de pessoas ({pessoas || 0})</DropdownMenuItem>
            {!(grupo?.unidas?.length > 0) && <DropdownMenuItem onClick={abrirTransferencia}>Transferir mesa</DropdownMenuItem>}
            <DropdownMenuItem danger onClick={requestDesocupar}>Desocupar mesa</DropdownMenuItem>
          </DropdownMenu>
          <button className="close-cash-btn" onClick={onFechar}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="arrowLeft" size={15} /> Mesas</span>
          </button>
        </div>
      </header>

      {feedback && <p className={feedback.type === 'error' ? 'modal-error' : 'io-message'} style={{ margin: '8px 24px' }}>{feedback.message}</p>}

      <div className="mesa-corpo">
        <section className="mesa-catalogo" aria-label="Produtos">
          <div className="pos-search-row">
            <div className="qty-stepper" title="Quantidade do próximo item">
              <input
                type="text" inputMode="numeric" className="qty-stepper-input"
                value={pendingQty}
                onChange={(e) => { if (/^\d*$/.test(e.target.value)) setPendingQty(e.target.value); }}
              />
              <div className="qty-stepper-buttons">
                <button type="button" className="qty-stepper-btn" onClick={() => setPendingQty((q) => String((Number(q) || 1) + 1))} tabIndex={-1}>
                  <svg width="9" height="6" viewBox="0 0 9 6" fill="none"><path d="M1 5L4.5 1L8 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button type="button" className="qty-stepper-btn" onClick={() => setPendingQty((q) => String(Math.max(1, (Number(q) || 1) - 1)))} tabIndex={-1}>
                  <svg width="9" height="6" viewBox="0 0 9 6" fill="none"><path d="M1 1L4.5 5L8 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </div>
            <ProductSearchBox onSelect={addProductToCart} onSelectPersonalizado={() => setShowCustomItemBuilder(true)} />
          </div>
          <CategoryProductBrowser onSelectProduct={addProductToCart} />
        </section>

        <aside className="mesa-comanda" aria-label="Comanda">
          <div className="mesa-lancar-para">
            <span className="mesa-lancar-titulo">Lançar para</span>
            <div className="mesa-lancar-opcoes">
              <button type="button" className={`mesa-chip mesa-chip-sem${pessoaAtiva === null ? ' mesa-chip-ativo' : ''}`} onClick={() => setPessoaAtiva(null)}>
                Sem pessoa
              </button>
              {pessoasLista.map((p) => (
                <button
                  key={p.numero} type="button"
                  className={`mesa-chip${pessoaAtiva === p.numero ? ' mesa-chip-ativo' : ''}`}
                  onClick={() => setPessoaAtiva(p.numero)}
                >
                  {nomeCurto(p)}
                </button>
              ))}
              <button type="button" className="mesa-chip mesa-chip-adicionar" onClick={adicionarPessoa} title="Adicionar pessoa">
                <Icon name="add" size={13} /> Pessoa
              </button>
            </div>
          </div>

          <div className="mesa-comanda-lista">
            {itensAtivos.length === 0 && pessoasLista.length === 0 && (
              <p className="empty-state">Nenhum item lançado ainda. Escolha a pessoa em "Lançar para" e toque nos produtos.</p>
            )}

            {gruposComItens.map((g) => (
              <div key={g.numero} className={`mesa-grupo${pessoaAtiva === g.numero ? ' mesa-grupo-ativo' : ''}`}>
                <div className="mesa-grupo-cabecalho">
                  <button type="button" className="mesa-grupo-nome" onClick={() => setPessoaAtiva(g.numero)} title="Lançar os próximos itens para esta pessoa">
                    {nomeCurto(g.pessoa)}
                  </button>
                  <BotaoCliente pessoa={g.pessoa} rotulo={nomeCurto(g.pessoa)} aoClicar={() => setVinculandoPessoa(g.pessoa)} />
                  <button type="button" className="mesa-icone" onClick={() => renomearPessoa(g.pessoa)} aria-label={`Renomear ${nomeCurto(g.pessoa)}`} title="Dar ou trocar o nome">
                    <Icon name="edit" size={13} />
                  </button>
                  <button type="button" className="mesa-icone" onClick={() => removerPessoa(g.pessoa)} aria-label={`Remover ${nomeCurto(g.pessoa)}`} title="Remover pessoa (os itens ficam sem pessoa)">
                    <Icon name="close" size={13} />
                  </button>
                  <span className="mesa-grupo-subtotal">R$ {subtotal(g.itens).toFixed(2)}</span>
                </div>
                <ul className="mesa-grupo-itens">{g.itens.map(renderItem)}</ul>
              </div>
            ))}

            {pessoasSemItens.length > 0 && (
              <div className="mesa-sem-itens">
                {pessoasSemItens.map((p) => (
                  <span key={p.numero} className={`mesa-sem-itens-pessoa${pessoaAtiva === p.numero ? ' mesa-sem-itens-ativa' : ''}`}>
                    <button type="button" className="mesa-grupo-nome" onClick={() => setPessoaAtiva(p.numero)}>{nomeCurto(p)}</button>
                    <BotaoCliente pessoa={p} rotulo={nomeCurto(p)} aoClicar={() => setVinculandoPessoa(p)} pequeno />
                    <button type="button" className="mesa-icone" onClick={() => renomearPessoa(p)} aria-label={`Renomear ${nomeCurto(p)}`}><Icon name="edit" size={12} /></button>
                    <button type="button" className="mesa-icone" onClick={() => removerPessoa(p)} aria-label={`Remover ${nomeCurto(p)}`}><Icon name="close" size={12} /></button>
                  </span>
                ))}
                <span className="mesa-sem-itens-rotulo">sem itens</span>
              </div>
            )}

            {itensSemPessoa.length > 0 && (
              <div className={`mesa-grupo mesa-grupo-sem-pessoa${pessoaAtiva === null ? ' mesa-grupo-ativo' : ''}`}>
                <div className="mesa-grupo-cabecalho">
                  <span className="mesa-grupo-nome">Sem pessoa</span>
                  <span className="mesa-grupo-subtotal">R$ {subtotal(itensSemPessoa).toFixed(2)}</span>
                </div>
                <ul className="mesa-grupo-itens">{itensSemPessoa.map(renderItem)}</ul>
              </div>
            )}
          </div>

          <footer className="mesa-comanda-rodape">
            <div className="pos-total">
              Total: <strong>R$ {total.toFixed(2)}</strong>
              {pessoas > 0 && <span className="mesa-por-pessoa">R$ {(total / pessoas).toFixed(2)} por pessoa ({pessoas})</span>}
            </div>
            <button className="btn-primary pos-pay-btn" disabled={itensAtivos.length === 0} onClick={() => setShowPayment(true)}>
              Ir para pagamento
            </button>
          </footer>
        </aside>
      </div>

      {showPayment && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-wide">
            <PaymentPanel
              saleId={saleId}
              total={total}
              mostrarTaxaServico
              taxaServicoPercentual={taxaServicoPercentual}
              onFinalized={async () => {
                await window.pdv.table.release({ tableId });
                onFechar();
              }}
            />
            <button className="btn-secondary" onClick={() => setShowPayment(false)}>Voltar ao pedido</button>
          </div>
        </div>
      )}

      {authAction && (
        <ManagerAuthModal
          title={authAction.type === 'desocupar' ? 'Desocupar mesa' : 'Cancelar item'}
          onConfirm={handleAuthConfirm}
          onClose={() => setAuthAction(null)}
        />
      )}

      {showCustomItemBuilder && (
        <Suspense fallback={null}>
          <CustomItemBuilder
            saleId={saleId}
            locationId={LOCATION_ID}
            operadorId={currentUser.id}
            deviceId={DEVICE_ID}
            onAdded={handleCustomItemAdded}
            onClose={() => setShowCustomItemBuilder(false)}
          />
        </Suspense>
      )}

      {vinculandoPessoa && (
        <VincularClienteModal
          pessoa={pessoasLista.find((p) => p.numero === vinculandoPessoa.numero) || vinculandoPessoa}
          rotulo={nomeCurto(pessoasLista.find((p) => p.numero === vinculandoPessoa.numero) || vinculandoPessoa)}
          onEscolher={(c) => vincularCliente(vinculandoPessoa, c.id)}
          onDesvincular={() => vincularCliente(vinculandoPessoa, null)}
          onFechar={() => setVinculandoPessoa(null)}
        />
      )}
      {editandoPessoas && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={confirmarEdicaoPessoas}>
            <h2>Número de pessoas — {nome || `Mesa ${numero}`}</h2>
            <label>Quantas pessoas agora?
              <input
                type="number" min="1"
                value={pessoasInput}
                onChange={(e) => setPessoasInput(e.target.value)}
                autoFocus required
              />
            </label>
            <p className="screen-hint" style={{ margin: 0 }}>
              Chegou mais gente na mesa? Atualize aqui — só muda o cálculo de "por pessoa", não afeta os
              itens já lançados.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditandoPessoas(false)}>Cancelar</button>
              <button type="submit" className="btn-primary">Salvar</button>
            </div>
          </form>
        </div>
      )}

      {editandoObs && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={salvarObs}>
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="edit" size={18} /> Observação do item</h2>
            <label>Ex: sem cebola, ponto da carne mal passado...
              <textarea
                rows={3}
                value={editandoObs.valor}
                onChange={(e) => setEditandoObs((prev) => ({ ...prev, valor: e.target.value }))}
                autoFocus
              />
            </label>
            <p className="screen-hint" style={{ margin: 0 }}>Vai junto na próxima comanda impressa pra cozinha.</p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditandoObs(null)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span>
              </button>
              <button type="submit" className="btn-primary">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="save" size={15} /> Salvar</span>
              </button>
            </div>
          </form>
        </div>
      )}
      {showTransferir && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="plate" size={18} /> Transferir pra qual mesa?</h2>
            <p className="screen-hint" style={{ margin: '0 0 10px' }}>
              A comanda inteira (itens, pessoas) vai pra mesa escolhida — essa mesa aqui fica
              aguardando limpeza.
            </p>
            {transferError && <p className="modal-error">{transferError}</p>}
            {mesasLivres.length === 0 ? (
              <p className="empty-state">Nenhuma mesa livre no momento.</p>
            ) : (
              <div className="tables-grid">
                {mesasLivres.map((t) => (
                  <button
                    key={t.id} type="button" className="table-card table-card-livre"
                    onClick={() => confirmarTransferencia(t.id)}
                  >
                    <span className="table-card-numero">{t.nome || `Mesa ${t.numero}`}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowTransferir(false)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {showJuntar && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icon name="link" size={18} /> Juntar mesas a {grupo?.principal ? (grupo.principal.nome || `Mesa ${grupo.principal.numero}`) : (nome || `Mesa ${numero}`)}
            </h2>
            <p className="screen-hint" style={{ margin: '0 0 10px' }}>
              Mesa ocupada: os itens e as pessoas dela entram nesta comanda. Mesa livre: só fica unida.
              A conta passa a ser uma só, e fechar a conta libera todas.
            </p>
            {grupo?.unidas?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <strong style={{ fontSize: 13 }}>Já unidas</strong>
                {grupo.unidas.map((m) => (
                  <div key={m.id} className="mesa-juntar-linha">
                    <span>{m.nome || `Mesa ${m.numero}`}</span>
                    <button type="button" className="btn-link" onClick={() => separarMesa(m)} title="O consumo continua nesta comanda; a mesa fica aguardando limpeza">
                      Separar
                    </button>
                  </div>
                ))}
              </div>
            )}
            {mesasParaJuntar.length === 0 ? (
              <p className="empty-state">Nenhuma mesa livre ou ocupada disponível para juntar.</p>
            ) : (
              <div>
                {mesasParaJuntar.map((t) => (
                  <label key={t.id} className="mesa-juntar-linha">
                    <input
                      type="checkbox"
                      checked={juntarSelecionadas.includes(t.id)}
                      onChange={(e) => {
                        setJuntarError('');
                        setJuntarSelecionadas((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((id) => id !== t.id)));
                      }}
                    />
                    <span>
                      {t.nome || `Mesa ${t.numero}`} · {t.status === 'livre' ? 'livre' : `ocupada · R$ ${(t.total_atual || 0).toFixed(2)}${t.pessoas ? ` · ${t.pessoas} pessoa(s)` : ''}${t.mesas_unidas ? ` · com Mesa ${t.mesas_unidas}` : ''}`}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {juntarError && <p className="modal-error">{juntarError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowJuntar(false)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Fechar</span>
              </button>
              {mesasParaJuntar.length > 0 && (
                <button type="button" className="btn-primary" disabled={juntando} onClick={confirmarJuntar}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="link" size={15} /> {juntando ? 'Juntando...' : 'Juntar mesas'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {promptState && (
        <PromptModal {...promptState} onConfirmar={confirmarPrompt} onCancelar={cancelarPrompt} />
      )}
    </div>
  );
}

/** Ícone de cliente na pessoa da mesa: cheio quando ela já está ligada a um cliente do cadastro. */
function BotaoCliente({ pessoa, rotulo, aoClicar, pequeno = false }) {
  const ligado = !!pessoa.clienteId;
  return (
    <button
      type="button" className={`mesa-icone${ligado ? ' mesa-icone-cliente' : ''}`} onClick={aoClicar}
      aria-label={ligado ? `${rotulo}: cliente ${pessoa.clienteNome}` : `Ligar ${rotulo} a um cliente do cadastro`}
      title={ligado ? `Cliente do cadastro: ${pessoa.clienteNome} (clique para trocar ou desligar)` : 'Ligar a um cliente do cadastro'}
    >
      <Icon name="user" size={pequeno ? 12 : 13} />
    </button>
  );
}
