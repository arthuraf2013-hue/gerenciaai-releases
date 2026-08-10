import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ProductSearchBox } from './ProductSearchBox';

const STATUS_LABEL = { aberto: 'Aberto', convertido: 'Convertido', cancelado: 'Cancelado' };

function NovoOrcamento({ onCriado, onCancelar }) {
  const { currentUser } = useSession();
  const [clientes, setClientes] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [validadeDias, setValidadeDias] = useState('7');
  const [quoteId, setQuoteId] = useState(null); // criado assim que a pessoa começa a adicionar itens
  const [itens, setItens] = useState([]);
  const [erro, setErro] = useState('');

  useEffect(() => {
    window.pdv.customers.list({}).then((list) => setClientes(Array.isArray(list) ? list : []));
  }, []);

  async function garantirOrcamentoCriado() {
    if (quoteId) return quoteId;
    const r = await window.pdv.quotes.create({
      locationId: window.APP_LOCATION_ID, customerId: customerId || undefined,
      operadorId: currentUser.id, validadeDias: Number(validadeDias) || undefined,
    });
    if (!r.ok) { setErro(r.error); return null; }
    setQuoteId(r.id);
    return r.id;
  }

  async function handleAddProduct(product) {
    const id = await garantirOrcamentoCriado();
    if (!id) return;
    await window.pdv.quotes.addItem({ quoteId: id, productId: product.id, quantidade: 1 });
    const cheio = await window.pdv.quotes.get({ quoteId: id });
    setItens(cheio.items);
  }

  async function handleRemoveItem(itemId) {
    await window.pdv.quotes.removeItem({ itemId });
    const cheio = await window.pdv.quotes.get({ quoteId });
    setItens(cheio.items);
  }

  const total = itens.reduce((acc, i) => acc + i.quantidade * i.preco_unitario, 0);

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-fullscreen">
        <h2>Novo orçamento</h2>

        <div className="inline-form" style={{ marginBottom: 12 }}>
          <label>Cliente (opcional)
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={!!quoteId}>
              <option value="">—</option>
              {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </label>
          <label>Válido por (dias)
            <input type="number" value={validadeDias} onChange={(e) => setValidadeDias(e.target.value)} disabled={!!quoteId} style={{ width: 70 }} />
          </label>
        </div>

        <ProductSearchBox onSelect={handleAddProduct} />
        {erro && <p className="modal-error">{erro}</p>}

        <div className="modal-card-fullscreen-scroll" style={{ marginTop: 12 }}>
          {itens.length === 0 && <p className="empty-state">Busque um produto acima pra adicionar ao orçamento.</p>}
          {itens.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Produto</th><th>Qtd</th><th>Preço unit.</th><th>Subtotal</th><th></th></tr></thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.id}>
                    <td>{i.nome}</td>
                    <td>{i.quantidade}</td>
                    <td>R$ {i.preco_unitario.toFixed(2)}</td>
                    <td>R$ {(i.quantidade * i.preco_unitario).toFixed(2)}</td>
                    <td><button className="btn-link-danger" onClick={() => handleRemoveItem(i.id)}>Remover</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {itens.length > 0 && <p style={{ textAlign: 'right', fontWeight: 'bold', margin: '12px 0' }}>Total: R$ {total.toFixed(2)}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancelar}>Fechar</button>
          {quoteId && itens.length > 0 && <button className="btn-primary" onClick={() => onCriado()}>Concluir</button>}
        </div>
      </div>
    </div>
  );
}

export function QuotesScreen() {
  const { currentUser } = useSession();
  const [orcamentos, setOrcamentos] = useState(null);
  const [filtroStatus, setFiltroStatus] = useState('');
  const [showNovo, setShowNovo] = useState(false);
  const [detalhe, setDetalhe] = useState(null);

  function carregar() {
    window.pdv.quotes.list({ locationId: window.APP_LOCATION_ID, status: filtroStatus || undefined }).then((list) => {
      setOrcamentos(Array.isArray(list) ? list : []);
    });
  }
  useEffect(carregar, [filtroStatus]);

  async function handleVerDetalhe(id) {
    const cheio = await window.pdv.quotes.get({ quoteId: id });
    setDetalhe(cheio);
  }

  async function handleConverter(id) {
    const r = await window.pdv.quotes.convertToSale({ quoteId: id, operadorId: currentUser.id, deviceId: window.APP_DEVICE_ID });
    if (!r.ok) return alert(r.error);
    setDetalhe(null);
    carregar();
  }

  async function handleCancelar(id) {
    if (!confirm('Cancelar esse orçamento?')) return;
    await window.pdv.quotes.cancel({ quoteId: id });
    setDetalhe(null);
    carregar();
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Orçamentos</h1>
        <button className="btn-primary" onClick={() => setShowNovo(true)}>+ Novo orçamento</button>
      </div>
      <p className="screen-hint">
        Cotação prévia — não mexe em estoque nem em caixa até você converter em venda de verdade.
      </p>

      <div className="screen-actions" style={{ margin: '12px 0' }}>
        {['', 'aberto', 'convertido', 'cancelado'].map((s) => (
          <button key={s} className={filtroStatus === s ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setFiltroStatus(s)}>
            {s === '' ? 'Todos' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {orcamentos === null && <p className="empty-state">Carregando...</p>}
      {orcamentos !== null && orcamentos.length === 0 && <p className="empty-state">Nenhum orçamento por aqui.</p>}
      {orcamentos && orcamentos.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Cliente</th><th>Total</th><th>Status</th><th>Válido até</th><th></th></tr></thead>
          <tbody>
            {orcamentos.map((q) => (
              <tr key={q.id}>
                <td>{q.clienteNome || '—'}</td>
                <td>R$ {q.total.toFixed(2)}</td>
                <td>{STATUS_LABEL[q.status]}</td>
                <td>{q.validade_ate ? new Date(q.validade_ate + 'T00:00:00').toLocaleDateString('pt-BR') : '—'}</td>
                <td><button className="btn-link" onClick={() => handleVerDetalhe(q.id)}>Ver</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNovo && (
        <NovoOrcamento onCancelar={() => { setShowNovo(false); carregar(); }} onCriado={() => { setShowNovo(false); carregar(); }} />
      )}

      {detalhe && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2>Orçamento — {detalhe.clienteNome || 'sem cliente'}</h2>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {detalhe.items.map((i) => (
                <li key={i.id}>{i.quantidade}x {i.nome} — R$ {(i.quantidade * i.preco_unitario).toFixed(2)}</li>
              ))}
            </ul>
            <p style={{ fontWeight: 'bold' }}>Total: R$ {detalhe.total.toFixed(2)}</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setDetalhe(null)}>Fechar</button>
              {detalhe.status === 'aberto' && (
                <>
                  <button className="btn-link-danger" onClick={() => handleCancelar(detalhe.id)}>Cancelar orçamento</button>
                  <button className="btn-primary" onClick={() => handleConverter(detalhe.id)}>Converter em venda</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
