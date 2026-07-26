import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';

export function CustomerList() {
  const { currentUser } = useSession();
  const [customers, setCustomers] = useState([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // { id, nome, telefone, cpf } | 'new' | null
  const [form, setForm] = useState({ nome: '', telefone: '', cpf: '' });
  const [selected, setSelected] = useState(null); // cliente com histórico aberto
  const [history, setHistory] = useState([]);
  const [pagamentoValor, setPagamentoValor] = useState('');
  const [saveError, setSaveError] = useState('');
  const [soQuemDeve, setSoQuemDeve] = useState(false);

  async function reload() {
    const list = await window.pdv.customers.list({ query: query || undefined });
    setCustomers(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reload(); }, [query]);

  const customersExibidos = soQuemDeve
    ? [...customers].filter((c) => c.saldoFiado > 0).sort((a, b) => b.saldoFiado - a.saldoFiado)
    : customers;

  function startNew() {
    setForm({ nome: '', telefone: '', cpf: '' });
    setEditing('new');
  }

  function startEdit(c) {
    setForm({ id: c.id, nome: c.nome, telefone: c.telefone || '', cpf: c.cpf || '' });
    setEditing(c.id);
  }

  async function handleSave(e) {
    e.preventDefault();
    const result = await window.pdv.customers.upsert(form);
    if (!result.ok) return setSaveError(result.error);
    setSaveError('');
    setEditing(null);
    reload();
  }

  async function openHistory(c) {
    setSelected(c);
    const list = await window.pdv.customers.getCreditHistory({ customerId: c.id });
    setHistory(Array.isArray(list) ? list : []);
  }

  async function handlePagamento() {
    const valor = Number(pagamentoValor);
    if (!valor || valor <= 0) return;
    await window.pdv.customers.registrarPagamento({ customerId: selected.id, valor, operadorId: currentUser.id });
    setPagamentoValor('');
    await openHistory(selected);
    reload();
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Clientes</h1>
        <button className="btn-primary" onClick={startNew}>Novo cliente</button>
      </div>

      <input
        className="search-input" placeholder="Buscar por nome, telefone ou CPF..."
        value={query} onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 16 }}
      />

      <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={soQuemDeve} onChange={(e) => setSoQuemDeve(e.target.checked)} />
        Ver só quem deve (cobrança pendente) — maior dívida primeiro
      </label>
      {soQuemDeve && (
        <p className="screen-hint">
          {customersExibidos.length} cliente(s) devendo, total de R$
          {' '}{customersExibidos.reduce((acc, c) => acc + c.saldoFiado, 0).toFixed(2)}
        </p>
      )}

      {editing && (
        <form className="product-form" onSubmit={handleSave} style={{ marginBottom: 20 }}>
          <div className="form-grid">
            <label>Nome<input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required /></label>
            <label>Telefone<input value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} /></label>
            <label>CPF<input value={form.cpf} onChange={(e) => setForm({ ...form, cpf: e.target.value })} /></label>
          </div>
          {saveError && <p className="modal-error">{saveError}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" type="submit">Salvar</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </form>
      )}

      <table className="data-table">
        <thead><tr><th>Nome</th><th>Telefone</th><th>Pontos</th><th>Saldo fiado</th><th></th></tr></thead>
        <tbody>
          {customersExibidos.map((c) => (
            <tr key={c.id}>
              <td>{c.nome}</td>
              <td>{c.telefone}</td>
              <td>{c.pontos}</td>
              <td className={c.saldoFiado > 0 ? 'text-danger' : ''}>R$ {c.saldoFiado.toFixed(2)}</td>
              <td style={{ display: 'flex', gap: 10 }}>
                <button className="btn-link" onClick={() => startEdit(c)}>Editar</button>
                <button className="btn-link" onClick={() => openHistory(c)}>Fiado</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div className="modal-overlay">
          <div className="modal-card" style={{ width: 480 }}>
            <h2>Fiado — {selected.nome}</h2>
            <p>Saldo devedor: <strong>R$ {customers.find((c) => c.id === selected.id)?.saldoFiado.toFixed(2)}</strong></p>

            <div className="inline-form">
              <label>Registrar pagamento
                <input type="number" step="0.01" value={pagamentoValor} onChange={(e) => setPagamentoValor(e.target.value)} />
              </label>
              <button className="btn-primary" onClick={handlePagamento}>Registrar</button>
            </div>

            <ul className="payment-list" style={{ marginTop: 16, maxHeight: 220, overflowY: 'auto' }}>
              {history.map((h) => (
                <li key={h.id}>
                  {new Date(h.criado_em + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — {h.tipo === 'divida' ? 'Compra' : 'Pagamento'}: R$ {h.valor.toFixed(2)}
                </li>
              ))}
              {history.length === 0 && <li>Nenhum movimento ainda.</li>}
            </ul>

            <button className="btn-secondary" style={{ marginTop: 16 }} onClick={() => setSelected(null)}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}
