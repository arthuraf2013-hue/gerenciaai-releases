import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ProductSearchBox } from './ProductSearchBox';
import { CategoryProductBrowser } from './CategoryProductBrowser';
import { PaymentPanel } from './PaymentPanel';
import { ManagerAuthModal } from './ManagerAuthModal';
import { playBeep } from '../../utils/sound';

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
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [taxaServicoPercentual, setTaxaServicoPercentual] = useState(0);
  const [pendingQty, setPendingQty] = useState('1');
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [pessoas, setPessoasAtual] = useState(pessoasIniciais);
  const [editandoPessoas, setEditandoPessoas] = useState(false);
  const [pessoasInput, setPessoasInput] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [authAction, setAuthAction] = useState(null); // { itemId } | null
  const [editandoObs, setEditandoObs] = useState(null); // { itemId, valor } | null
  const [showTransferir, setShowTransferir] = useState(false);
  const [mostrarDivisao, setMostrarDivisao] = useState(false);
  const [mesasLivres, setMesasLivres] = useState([]);
  const [transferError, setTransferError] = useState('');

  useEffect(() => {
    window.pdv.table.getCart({ saleId }).then((cart) => {
      setItems(cart.items || []);
      setTotal(cart.total || 0);
      setTaxaServicoPercentual(cart.taxaServicoPercentual || 0);
    });
  }, [saleId]);

  useEffect(() => {
    if (!feedback) return;
    const id = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(id);
  }, [feedback]);

  async function addProductToCart(product) {
    const quantidade = Math.max(1, Number(pendingQty) || 1);
    const result = await window.pdv.sale.addItem({
      saleId, productId: product.id, locationId: LOCATION_ID,
      quantidade, operadorId: currentUser.id, deviceId: DEVICE_ID,
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
      }];
    });
    playBeep();
    setTotal((prev) => prev + result.precoUnitario * quantidade);
    setPendingQty('1');
    setFeedback({ message: `${product.nome} adicionado.`, type: 'success' });
  }

  async function requestCancelItem(itemId) {
    const check = await window.pdv.sale.needsManagerAuthForCancel({ saleId });
    if (!check.needsAuth) {
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
    setAuthAction({ itemId });
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
    if (result.ok) {
      setPessoasAtual(novoValor);
      setEditandoPessoas(false);
    }
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
    const item = items.find((i) => i.id === authAction.itemId);
    const result = await window.pdv.sale.cancelItem({
      saleId, saleItemId: authAction.itemId, locationId: LOCATION_ID,
      currentOperatorId: currentUser.id, candidateManagerId: candidateId, pin, motivo, deviceId: DEVICE_ID,
    });
    if (result.ok) {
      setItems((prev) => prev.map((i) => (i.id === authAction.itemId ? { ...i, cancelado: true } : i)));
      setTotal((prev) => prev - item.precoUnitario * item.quantidade);
      setAuthAction(null);
      setSelectedItemId(null);
    }
    return result;
  }

  const itensAtivos = items.filter((i) => !i.cancelado);

  const divisaoPorPessoa = Object.values(
    itensAtivos.reduce((acc, item) => {
      const pessoa = item.pessoaNumero || 0; // 0 = não atribuído
      const subtotalItem = item.precoUnitario * item.quantidade;
      if (!acc[pessoa]) acc[pessoa] = { pessoa, subtotal: 0 };
      acc[pessoa].subtotal += subtotalItem;
      return acc;
    }, {})
  ).sort((a, b) => a.pessoa - b.pessoa);

  async function atribuirPessoa(itemId, valor) {
    const pessoaNumero = valor ? Number(valor) : null;
    await window.pdv.sale.setItemPerson({ saleItemId: itemId, pessoaNumero });
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, pessoaNumero } : i)));
  }


  return (
    <div className="pos-screen">
      <header className="pos-header">
        <h1>{nome || `Mesa ${numero}`}</h1>
        <div className="pos-header-right">
          {pessoas ? (
            <button type="button" className="pos-operator pos-operator-editable" onClick={abrirEdicaoPessoas} title="Editar número de pessoas">
              {pessoas} pessoa(s) ✎
            </button>
          ) : (
            <button type="button" className="pos-operator pos-operator-editable" onClick={abrirEdicaoPessoas}>
              + Informar nº de pessoas
            </button>
          )}
          <button className="close-cash-btn" onClick={abrirTransferencia}>Transferir mesa</button>
          <button className="close-cash-btn" onClick={handleImprimirComanda}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" />
            </svg>
            Comanda p/ cozinha
          </button>
          <button className="close-cash-btn" onClick={onFechar}>← Voltar às mesas</button>
        </div>
      </header>

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
        <ProductSearchBox onSelect={addProductToCart} />
      </div>

      {feedback && <p className={feedback.type === 'error' ? 'modal-error' : 'io-message'} style={{ margin: '8px 24px' }}>{feedback.message}</p>}

      <CategoryProductBrowser onSelectProduct={addProductToCart} />

      <div className="cart-list-mesa-wrapper">
      <ul className="cart-list">
        {itensAtivos.map((item) => (
          <li
            key={item.id}
            className={`cart-item-mesa ${selectedItemId === item.id ? 'cart-item-selected' : ''}`}
            onClick={() => setSelectedItemId(item.id)}
          >
            <div className="cart-item-mesa-topo">
              <span className="cart-item-mesa-nome">{item.nome} × {item.quantidade}</span>
              <span className="cart-item-mesa-preco">R$ {(item.precoUnitario * item.quantidade).toFixed(2)}</span>
            </div>
            {item.observacao && <div className="cart-item-obs">⚠ {item.observacao}</div>}
            <div className="cart-item-mesa-controles">
              {pessoas > 1 && (
                <select
                  value={item.pessoaNumero || ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => atribuirPessoa(item.id, e.target.value)}
                  className="cart-item-pessoa"
                >
                  <option value="">Não atribuído</option>
                  {Array.from({ length: pessoas }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>Pessoa {n}</option>
                  ))}
                </select>
              )}
              <button className="btn-link" onClick={(e) => { e.stopPropagation(); abrirEdicaoObs(item); }}>
                {item.observacao ? 'Editar obs.' : '+ Observação'}
              </button>
              <button className="btn-link-danger" onClick={(e) => { e.stopPropagation(); requestCancelItem(item.id); }}>
                Cancelar
              </button>
            </div>
          </li>
        ))}
        {itensAtivos.length === 0 && <p className="empty-state">Nenhum item lançado nessa mesa ainda.</p>}
      </ul>
      </div>

      {pessoas > 1 && itensAtivos.length > 0 && (
        <div className="screen-section-box">
          <button type="button" className="btn-link" onClick={() => setMostrarDivisao((v) => !v)}>
            {mostrarDivisao ? 'Esconder' : 'Ver'} divisão por pessoa
          </button>
          {mostrarDivisao && (
            <ul className="payment-list" style={{ marginTop: 8 }}>
              {divisaoPorPessoa.map(({ pessoa, subtotal }) => (
                <li key={pessoa}>{pessoa === 0 ? 'Não atribuído' : `Pessoa ${pessoa}`}: R$ {subtotal.toFixed(2)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <footer className="pos-footer">
        <div className="pos-total">
          Total: <strong>R$ {total.toFixed(2)}</strong>
          {pessoas > 0 && <span style={{ marginLeft: 12, fontSize: 13, color: 'var(--color-text-muted)' }}>
            (R$ {(total / pessoas).toFixed(2)} por pessoa, {pessoas} pessoa{pessoas > 1 ? 's' : ''})
          </span>}
        </div>
        <button className="btn-primary pos-pay-btn" disabled={itensAtivos.length === 0} onClick={() => setShowPayment(true)}>
          Ir para pagamento
        </button>
      </footer>

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
          title="Cancelar item"
          onConfirm={handleAuthConfirm}
          onClose={() => setAuthAction(null)}
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
            <h2>Observação do item</h2>
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
              <button type="button" className="btn-secondary" onClick={() => setEditandoObs(null)}>Cancelar</button>
              <button type="submit" className="btn-primary">Salvar</button>
            </div>
          </form>
        </div>
      )}
      {showTransferir && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2>Transferir pra qual mesa?</h2>
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
              <button type="button" className="btn-secondary" onClick={() => setShowTransferir(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
