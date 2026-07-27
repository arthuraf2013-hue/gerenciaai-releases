import { useCallback, useEffect, useState } from 'react';
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner';
import { useSession } from '../../context/SessionContext';
import { ManagerAuthModal } from './ManagerAuthModal';
import { PaymentPanel } from './PaymentPanel';
import { ProductSearchBox } from './ProductSearchBox';
import { SaleAttachmentsPanel } from './SaleAttachmentsPanel';
import { OpenCashScreen } from './OpenCashScreen';
import { CloseCashModal } from './CloseCashModal';
import { CategoryProductBrowser } from './CategoryProductBrowser';
import { playBeep } from '../../utils/sound';
import { RecentlySoldStrip } from './RecentlySoldStrip';
import { Clock } from '../layout/Clock';
import { PosTour } from './PosTour';
import { TrainingPresentationModal } from './TrainingPresentationModal';

function playErrorBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 220;
    osc.type = 'square';
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // ambiente sem suporte a áudio — falha silenciosamente, não é crítico
  }
}

export function POSScreen() {
  // Lido aqui dentro (não no topo do módulo) de propósito: o topo do módulo
  // roda durante a avaliação do grafo de imports, ANTES do bootstrap()
  // do main.jsx terminar de buscar o local real — capturar window.APP_LOCATION_ID
  // ali sempre dava undefined. Aqui dentro já roda depois do app montado.
  const LOCATION_ID = window.APP_LOCATION_ID;
  const DEVICE_ID = window.APP_DEVICE_ID;
  const { currentUser } = useSession();
  const [cashSession, setCashSession] = useState(undefined); // undefined = carregando, null = sem caixa aberto
  const [showCloseCash, setShowCloseCash] = useState(false);
  const [saleId, setSaleId] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [feedback, setFeedback] = useState({ message: 'Aponte o leitor para o código de barras do produto...', type: 'info' });
  const [authAction, setAuthAction] = useState(null); // { type: 'item'|'sale', itemId? }
  const [showPayment, setShowPayment] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [recentRefreshKey, setRecentRefreshKey] = useState(0);
  const [pendingQty, setPendingQty] = useState('1');
  const [openAlertId, setOpenAlertId] = useState(null);

  // Fecha o balão de alerta se clicar em qualquer outro lugar da tela.
  useEffect(() => {
    if (!openAlertId) return;
    function handleClickOutside() { setOpenAlertId(null); }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openAlertId]);
  const [showTour, setShowTour] = useState(false);
  const [showTraining, setShowTraining] = useState(false);

  // O PDV exige um caixa aberto para o local antes de qualquer venda —
  // sem isso não dá pra conferir dinheiro no fechamento do turno.
  useEffect(() => {
    window.pdv.cash.getOpenSession({ locationId: LOCATION_ID }).then((session) => setCashSession(session?.id ? session : null));
  }, []);

  // Ao entrar no PDV, retoma uma venda "aberta" existente deste operador
  // (ex: app fechado no meio de uma venda) em vez de sempre abrir uma nova.
  useEffect(() => {
    if (!saleId && currentUser && cashSession) {
      window.pdv.sale.getOrOpenCurrent({ locationId: LOCATION_ID, operadorId: currentUser.id }).then((r) => {
        setSaleId(r.saleId);
        setItems(r.items);
        setTotal(r.total);
        if (r.resumed && r.items.length > 0) {
          setFeedback({ message: 'Venda em aberto retomada — carrinho restaurado.', type: 'success' });
        }
      });
    }
  }, [saleId, currentUser, cashSession]);

  const addProductToCart = useCallback(async (product) => {
    const quantidade = Math.max(1, Number(pendingQty) || 1);
    const result = await window.pdv.sale.addItem({
      saleId,
      productId: product.id,
      locationId: LOCATION_ID,
      quantidade,
      operadorId: currentUser.id,
      deviceId: DEVICE_ID,
    });
    if (!result.ok) {
      setFeedback({ message: result.error, type: 'error' });
      playErrorBeep();
      return;
    }
    setItems((prev) => {
      const existeIndex = prev.findIndex((it) => it.id === result.itemId);
      if (existeIndex >= 0) {
        // mesmo produto já estava no carrinho — soma na linha, não duplica
        const atualizado = [...prev];
        atualizado[existeIndex] = { ...atualizado[existeIndex], quantidade: result.quantidadeTotal, alerta: result.alerta };
        return atualizado;
      }
      return [...prev, {
        id: result.itemId, nome: product.nome, quantidade, precoUnitario: result.precoUnitario, cancelado: false,
        alerta: result.alerta,
      }];
    });
    playBeep();
    setTotal((prev) => prev + result.precoUnitario * quantidade);
    setPendingQty('1'); // a quantidade digitada vale só pro próximo item — volta a 1 sozinho
    setRecentRefreshKey((prev) => prev + 1);

    // Produto controlado que costuma exigir receita: só um lembrete, nunca
    // bloqueia a venda — o estoque pode ter itens que não são medicamentos.
    if (result.avisoReceita) {
      setFeedback({ message: `${product.nome} adicionado. É um controlado — considere anexar a receita.`, type: 'info' });
    } else {
      setFeedback({ message: `${product.nome} adicionado.`, type: 'success' });
    }
  }, [saleId, currentUser, pendingQty]);

  /**
   * Chamada depois que a IA extrai os medicamentos de uma receita anexada.
   * Para cada nome identificado, busca no catálogo (mesma busca por nome/SKU/
   * código de barras da busca manual) e adiciona ao carrinho quando há
   * estoque disponível. O que não for encontrado ou não tiver estoque
   * entra num aviso único no final — nunca trava a venda.
   */
  const addProductsFromPrescription = useCallback(async (extractedData) => {
    const nomes = extractedData.medicamentos.filter((n) => n && n.trim());
    if (nomes.length === 0) return;

    const adicionados = [];
    const indisponiveis = [];
    const naoEncontrados = [];

    for (const nome of nomes) {
      const matches = await window.pdv.products.list({ query: nome });
      if (!Array.isArray(matches) || matches.length === 0) {
        naoEncontrados.push(nome);
        continue;
      }
      const produto = matches[0]; // melhor correspondência simples: primeiro resultado da busca

      const result = await window.pdv.sale.addItem({
        saleId,
        productId: produto.id,
        locationId: LOCATION_ID,
        quantidade: 1,
        operadorId: currentUser.id,
        deviceId: DEVICE_ID,
      });

      if (!result.ok) {
        indisponiveis.push(`${produto.nome} (${result.error})`);
        continue;
      }

      setItems((prev) => {
        const existeIndex = prev.findIndex((it) => it.id === result.itemId);
        if (existeIndex >= 0) {
          const atualizado = [...prev];
          atualizado[existeIndex] = { ...atualizado[existeIndex], quantidade: result.quantidadeTotal, alerta: result.alerta };
          return atualizado;
        }
        return [...prev, {
          id: result.itemId, nome: produto.nome, quantidade: 1, precoUnitario: result.precoUnitario, cancelado: false,
          alerta: result.alerta,
        }];
      });
      playBeep();
      setTotal((prev) => prev + result.precoUnitario);
      adicionados.push(produto.nome);
    }

    setRecentRefreshKey((prev) => prev + 1);

    const partes = [];
    if (adicionados.length > 0) partes.push(`Adicionado(s) da receita: ${adicionados.join(', ')}.`);
    if (indisponiveis.length > 0) partes.push(`Sem estoque suficiente: ${indisponiveis.join(', ')}.`);
    if (naoEncontrados.length > 0) partes.push(`Não encontrado(s) no catálogo: ${naoEncontrados.join(', ')}.`);

    const houveProblema = indisponiveis.length > 0 || naoEncontrados.length > 0;
    setFeedback({
      message: partes.join(' ') || 'Nenhum medicamento reconhecido na receita.',
      type: houveProblema ? 'error' : 'success',
    });
    if (houveProblema) playErrorBeep();
  }, [saleId, currentUser]);

  const handleScan = useCallback(async (codigoBarras) => {
    if (!saleId) return;
    const product = await window.pdv.products.findByBarcode(codigoBarras);
    if (!product) {
      setFeedback({ message: `Código não encontrado: ${codigoBarras}`, type: 'error' });
      playErrorBeep();
      return;
    }
    addProductToCart(product);
  }, [saleId, addProductToCart]);

  useBarcodeScanner(handleScan, { enabled: !showPayment && !authAction && !showAttachments });

  async function requestCancelItem(itemId) {
    const check = await window.pdv.sale.needsManagerAuthForCancel({ saleId });
    if (!check.needsAuth) {
      // Venda ainda sem nenhum pagamento registrado — é só ajuste do
      // carrinho (cliente pediu mais, desistiu de algo), cancela direto
      // sem precisar de outra pessoa autorizar.
      const item = items.find((i) => i.id === itemId);
      const result = await window.pdv.sale.cancelItem({
        saleId, saleItemId: itemId, locationId: LOCATION_ID,
        currentOperatorId: currentUser.id, deviceId: DEVICE_ID,
      });
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, cancelado: true } : i)));
        setTotal((prev) => prev - item.precoUnitario * item.quantidade);
        setSelectedItemId(null);
      } else {
        setFeedback({ message: result.error, type: 'error' });
      }
      return;
    }
    setAuthAction({ type: 'item', itemId });
  }

  function requestCancelSale() {
    setAuthAction({ type: 'sale' });
  }

  async function handleAuthConfirm(candidateId, pin, motivo) {
    if (authAction.type === 'item') {
      const item = items.find((i) => i.id === authAction.itemId);
      const result = await window.pdv.sale.cancelItem({
        saleId,
        saleItemId: authAction.itemId,
        locationId: LOCATION_ID,
        currentOperatorId: currentUser.id,
        candidateManagerId: candidateId,
        pin,
        motivo,
        deviceId: DEVICE_ID,
      });
      if (result.ok) {
        setItems((prev) => prev.map((i) => (i.id === authAction.itemId ? { ...i, cancelado: true } : i)));
        setTotal((prev) => prev - item.precoUnitario * item.quantidade);
        setSelectedItemId(null);
      }
      return result;
    }

    const result = await window.pdv.sale.cancel({
      saleId,
      locationId: LOCATION_ID,
      currentOperatorId: currentUser.id,
      candidateManagerId: candidateId,
      pin,
      motivo,
      deviceId: DEVICE_ID,
    });
    if (result.ok) {
      setItems([]);
      setTotal(0);
      setSaleId(null); // uma nova venda será aberta automaticamente
    }
    return result;
  }

  const itensAtivos = items.filter((i) => !i.cancelado);

  // Atalhos de teclado: F2 finaliza, F4 cancela o item selecionado, Esc fecha modais.
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (showPayment) setShowPayment(false);
        else if (authAction) setAuthAction(null);
        else if (showAttachments) setShowAttachments(false);
        return;
      }
      if (showPayment || authAction || showAttachments) return;

      if (e.key === 'F2' && itensAtivos.length > 0) {
        e.preventDefault();
        setShowPayment(true);
      }
      if (e.key === 'F4' && selectedItemId) {
        e.preventDefault();
        requestCancelItem(selectedItemId);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPayment, authAction, showAttachments, itensAtivos.length, selectedItemId]);

  if (cashSession === undefined) {
    return <div className="screen"><p className="empty-state">Carregando...</p></div>;
  }

  if (cashSession === null) {
    return <OpenCashScreen locationId={LOCATION_ID} onOpened={() => {
      window.pdv.cash.getOpenSession({ locationId: LOCATION_ID }).then((session) => setCashSession(session?.id ? session : null));
    }} />;
  }

  return (
    <div className="pos-screen">
      <header className="pos-header">
        <h1>PDV</h1>
        <div className="pos-header-right">
          <Clock compact />
          <span className="pos-operator">Operador: {currentUser?.nome}</span>
          <button className="help-btn" onClick={() => setShowTour(true)} title="Ver tutorial do PDV">?</button>
          <button className="help-btn help-btn-training" onClick={() => setShowTraining(true)} title="Apresentação de treinamento">🎓</button>
          <button className="btn-link" style={{ color: 'white' }} onClick={() => setShowCloseCash(true)}>Fechar caixa</button>
        </div>
      </header>

      <div className="pos-search-row">
        <div className="qty-stepper" title="Quantidade do próximo item — digite antes de escanear ou buscar pra adicionar várias unidades de uma vez">
          <input
            type="text" inputMode="numeric"
            className="qty-stepper-input"
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
        <ProductSearchBox onSelect={addProductToCart} />
        <button className="btn-secondary pos-attach-btn" onClick={() => setShowAttachments(true)}>
          Anexar receita / arquivo
        </button>
      </div>

      <p className={`scan-feedback scan-feedback-${feedback.type}`}>{feedback.message}</p>

      <div className="pos-main-scroll">
        <CategoryProductBrowser onSelectProduct={addProductToCart} />

        <ul className="cart-list">
          {itensAtivos.map((item) => (
            <li
              key={item.id}
              className={`cart-item ${selectedItemId === item.id ? 'cart-item-selected' : ''}`}
              onClick={() => setSelectedItemId(item.id)}
            >
              <span className="cart-item-name">
                {item.nome} × {item.quantidade}
                {item.alerta?.nivel && (
                  <span className="cart-alert-wrap">
                    <button
                      type="button"
                      className={`cart-alert-icon cart-alert-${item.alerta.nivel}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenAlertId((prev) => (prev === item.id ? null : item.id));
                      }}
                    >
                      ⚠
                    </button>
                    {openAlertId === item.id && (
                      <div className="cart-alert-popover" onClick={(e) => e.stopPropagation()}>
                        <strong className={`cart-alert-popover-title cart-alert-popover-${item.alerta.nivel}`}>
                          {item.alerta.nivel === 'critico' ? 'Crítico' : 'Aviso'}
                        </strong>
                        <ul>
                          {item.alerta.motivos.map((motivo, i) => <li key={i}>{motivo}</li>)}
                        </ul>
                      </div>
                    )}
                  </span>
                )}
              </span>
              <span>R$ {(item.precoUnitario * item.quantidade).toFixed(2)}</span>
              <button className="btn-link-danger" onClick={(e) => { e.stopPropagation(); requestCancelItem(item.id); }}>
                Cancelar
              </button>
            </li>
          ))}
        </ul>
      </div>

      <RecentlySoldStrip locationId={LOCATION_ID} refreshKey={recentRefreshKey} onSelectProduct={addProductToCart} />

      <footer className="pos-footer">
        <div className="pos-total">Total: <strong>R$ {total.toFixed(2)}</strong></div>
        <div className="pos-actions">
          <span className="pos-shortcuts-hint">F2 finalizar · F4 cancelar item selecionado</span>
          <button className="btn-secondary" onClick={requestCancelSale} disabled={itensAtivos.length === 0}>
            Cancelar venda
          </button>
          <button className="btn-primary pos-pay-btn" onClick={() => setShowPayment(true)} disabled={itensAtivos.length === 0}>
            Ir para pagamento
          </button>
        </div>
      </footer>

      {showPayment && (
        <div className="modal-overlay">
          <div className="modal-card">
            <PaymentPanel saleId={saleId} total={total} onFinalized={() => {
              setShowPayment(false);
              setItems([]);
              setTotal(0);
              setSaleId(null);
            }} />
            <button className="btn-secondary" onClick={() => setShowPayment(false)}>Voltar ao carrinho</button>
          </div>
        </div>
      )}

      {authAction && (
        <ManagerAuthModal
          title={authAction.type === 'item' ? 'Cancelar item' : 'Cancelar venda inteira'}
          onConfirm={handleAuthConfirm}
          onClose={() => setAuthAction(null)}
        />
      )}

      {showAttachments && (
        <SaleAttachmentsPanel
          saleId={saleId}
          operadorId={currentUser.id}
          onClose={() => setShowAttachments(false)}
          onExtracted={addProductsFromPrescription}
        />
      )}

      {showCloseCash && (
        <CloseCashModal
          sessionId={cashSession.id}
          onCancel={() => setShowCloseCash(false)}
          onClosed={() => {
            setShowCloseCash(false);
            setCashSession(null); // volta para a tela de abertura de caixa
          }}
        />
      )}

      <PosTour forceOpen={showTour} onClose={() => setShowTour(false)} />
      {showTraining && <TrainingPresentationModal onClose={() => setShowTraining(false)} />}
    </div>
  );
}
