import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { toISODate } from '../../utils/date';
import { ManagerAuthModal } from './ManagerAuthModal';
import Icon from '../common/Icon';

export function ReturnFlow({ preselectSaleId, onPreselectConsumed }) {
  const { currentUser } = useSession();
  const [offsetMs, setOffsetMs] = useState(0);
  const [query, setQuery] = useState('');
  const [sales, setSales] = useState([]);
  const [selectedSale, setSelectedSale] = useState(null);
  const [items, setItems] = useState([]);
  const [quantidades, setQuantidades] = useState({}); // saleItemId -> quantidade a devolver
  const [showAuth, setShowAuth] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [recentes, setRecentes] = useState([]);
  const [erroPreselect, setErroPreselect] = useState('');

  useEffect(() => {
    window.pdv.time.getStatus().then((s) => setOffsetMs(s.offsetMs || 0));
  }, []);

  async function buscar() {
    const list = await window.pdv.returns.findFinalizedSales({ locationId: window.APP_LOCATION_ID, query: query || undefined });
    setSales(Array.isArray(list) ? list : []);
  }

  useEffect(() => { buscar(); }, []);

  // Veio do botão "Devolver" no Histórico — busca essa venda específica
  // e já abre pra devolução, sem precisar buscar de novo manualmente.
  useEffect(() => {
    if (!preselectSaleId) return;
    (async () => {
      setErroPreselect('');
      const list = await window.pdv.returns.findFinalizedSales({ locationId: window.APP_LOCATION_ID, query: preselectSaleId });
      const venda = Array.isArray(list) ? list.find((s) => s.id === preselectSaleId) : null;
      if (venda) {
        await selecionarVenda(venda);
      } else {
        setErroPreselect('Não encontrei essa venda pra devolução — pode ter mais de 60 dias, o limite de busca automática aqui.');
      }
      onPreselectConsumed?.();
    })();
  }, [preselectSaleId]);

  async function reloadRecentes() {
    const hoje = toISODate(new Date(Date.now() + offsetMs));
    const list = await window.pdv.returns.list({ locationId: window.APP_LOCATION_ID, dataInicio: '2000-01-01', dataFim: hoje });
    setRecentes(Array.isArray(list) ? list.slice(0, 10) : []);
  }
  useEffect(() => { reloadRecentes(); }, [resultado, offsetMs]);

  async function selecionarVenda(sale) {
    setSelectedSale(sale);
    setResultado(null);
    const list = await window.pdv.returns.getSaleItems({ saleId: sale.id });
    setItems(Array.isArray(list) ? list : []);
    setQuantidades({});
  }

  function itensParaDevolver() {
    return Object.entries(quantidades)
      .filter(([, qtd]) => Number(qtd) > 0)
      .map(([saleItemId, qtd]) => ({ saleItemId, quantidade: Number(qtd) }));
  }

  async function handleAuthConfirm(candidateId, pin, motivo) {
    const result = await window.pdv.returns.create({
      saleId: selectedSale.id,
      locationId: window.APP_LOCATION_ID,
      itens: itensParaDevolver(),
      motivo,
      currentOperatorId: currentUser.id,
      candidateManagerId: candidateId,
      pin,
      deviceId: window.APP_DEVICE_ID,
    });
    if (result.ok) {
      setResultado(result);
      setSelectedSale(null);
      setItems([]);
    }
    return result;
  }

  return (
    <div className="screen">
      <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="undo" size={20} /> Devolução</h1>
      {erroPreselect && <p className="modal-error">{erroPreselect}</p>}
      <p className="screen-hint">Devolução de itens de uma venda já finalizada — exige autorização de gerente, igual ao cancelamento.</p>

      {!selectedSale && (
        <>
          <div className="inline-form" style={{ marginBottom: 16 }}>
            <input placeholder="Buscar por código da venda ou operador..." value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn-secondary" onClick={buscar}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="search" size={15} /> Buscar</span>
            </button>
          </div>

          <table className="data-table">
            <thead><tr><th>Venda</th><th>Data</th><th>Operador</th><th>Total</th><th></th></tr></thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id}>
                  <td>{s.id.slice(0, 8)}</td>
                  <td>{new Date(s.finalizada_em + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                  <td>{s.operador_nome}</td>
                  <td>R$ {s.total.toFixed(2)}</td>
                  <td><button className="btn-link" onClick={() => selecionarVenda(s)}>Selecionar</button></td>
                </tr>
              ))}
              {sales.length === 0 && <tr><td colSpan={5} className="empty-state">Nenhuma venda finalizada encontrada nos últimos 60 dias.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {selectedSale && (
        <div>
          <h2>Venda {selectedSale.id.slice(0, 8)}</h2>
          <table className="data-table">
            <thead><tr><th>Item</th><th>Vendido</th><th>Já devolvido</th><th>Devolver agora</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.nome}</td>
                  <td>{i.quantidade}</td>
                  <td>{i.ja_devolvido}</td>
                  <td>
                    <input
                      type="number" min="0" max={i.quantidade - i.ja_devolvido} style={{ width: 70 }}
                      value={quantidades[i.id] || ''}
                      onChange={(e) => setQuantidades({ ...quantidades, [i.id]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn-secondary" onClick={() => setSelectedSale(null)}>Voltar</button>
            <button className="btn-danger" disabled={itensParaDevolver().length === 0} onClick={() => setShowAuth(true)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="undo" size={15} /> Devolver itens selecionados</span>
            </button>
          </div>
        </div>
      )}

      {resultado && (
        <p className="io-message">Devolução registrada — R$ {resultado.valorDevolvido.toFixed(2)} devolvido ao estoque.</p>
      )}

      {recentes.length > 0 && (
        <section className="settings-section" style={{ marginTop: 28 }}>
          <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="undo" size={18} /> Devoluções recentes</h2>
          <table className="data-table">
            <thead><tr><th>Data</th><th>Venda</th><th>Valor</th><th>Autorizado por</th></tr></thead>
            <tbody>
              {recentes.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.criado_em + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                  <td>{r.sale_id.slice(0, 8)}</td>
                  <td>R$ {r.valor_devolvido.toFixed(2)}</td>
                  <td>{r.autorizado_por_nome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {showAuth && (
        <ManagerAuthModal
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="undo" size={18} /> Autorizar devolução</span>}
          onConfirm={handleAuthConfirm}
          onClose={() => setShowAuth(false)}
        />
      )}
    </div>
  );
}
