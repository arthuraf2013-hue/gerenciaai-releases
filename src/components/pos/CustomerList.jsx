import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useProfile } from '../../context/ProfileContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEscToClose } from '../../hooks/useEscToClose';
import { LapsedCustomersModal } from './LapsedCustomersModal';
import { PetsModal } from './PetsModal';
import { EyewearModal } from './EyewearModal';
import { PetReminderModal } from './PetReminderModal';

export function CustomerList() {
  const { currentUser } = useSession();
  const { profile } = useProfile();
  const [customers, setCustomers] = useState([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [editing, setEditing] = useState(null); // { id, nome, telefone, cpf } | 'new' | null
  const [form, setForm] = useState({ nome: '', telefone: '', cpf: '', cnpj: '' });
  const [selected, setSelected] = useState(null); // cliente com histórico aberto
  useEscToClose(() => setSelected(null), !!selected);
  const [history, setHistory] = useState([]);
  const [pagamentoValor, setPagamentoValor] = useState('');
  const [saveError, setSaveError] = useState('');
  const [soQuemDeve, setSoQuemDeve] = useState(false);
  const [showLapsed, setShowLapsed] = useState(false);
  const [showPetReminders, setShowPetReminders] = useState(false);
  const [petsDoCliente, setPetsDoCliente] = useState(null); // customer com modal de pets aberto
  const [eyewearDoCliente, setEyewearDoCliente] = useState(null); // customer com modal de receita óptica aberto

  useEffect(() => {
    let ignore = false;
    window.pdv.customers.list({ query: debouncedQuery || undefined }).then((list) => {
      if (ignore) return;
      setCustomers(Array.isArray(list) ? list : []);
    });
    return () => { ignore = true; };
  }, [debouncedQuery]);

  // Recarrega manualmente (depois de salvar um cliente ou registrar um
  // pagamento) — sempre busca a lista completa mais atual, sem esperar
  // o debounce da digitação, já que é uma ação pontual do usuário.
  async function reload() {
    const list = await window.pdv.customers.list({ query: query || undefined });
    setCustomers(Array.isArray(list) ? list : []);
  }

  const customersExibidos = soQuemDeve
    ? [...customers].filter((c) => c.saldoFiado > 0).sort((a, b) => b.saldoFiado - a.saldoFiado)
    : customers;

  function startNew() {
    setForm({ nome: '', telefone: '', cpf: '', cnpj: '' });
    setEditing('new');
  }

  function startEdit(c) {
    setForm({ id: c.id, nome: c.nome, telefone: c.telefone || '', cpf: c.cpf || '', cnpj: c.cnpj || '' });
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
        <div className="screen-actions">
          <button className="btn-secondary" onClick={() => setShowLapsed(true)}>⚠️ Clientes que sumiram</button>
          {profile?.id === 'petshop' && (
            <button className="btn-secondary" onClick={() => setShowPetReminders(true)}>🐾 Lembretes de vacina/vermífugo</button>
          )}
          <button className="btn-primary" onClick={startNew}>➕ Novo cliente</button>
        </div>
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
            <label>CNPJ (cliente pessoa jurídica)<input value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} /></label>
          </div>
          {saveError && <p className="modal-error">{saveError}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" type="submit">💾 Salvar</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>✖️ Cancelar</button>
          </div>
        </form>
      )}

      {customersExibidos.length === 0 ? (
        <p className="empty-state">
          {soQuemDeve ? 'Nenhum cliente com saldo pendente.' : 'Nenhum cliente cadastrado ainda.'}
        </p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Nome</th><th>Telefone</th><th>Pontos</th><th>Saldo fiado</th><th></th></tr></thead>
          <tbody>
            {customersExibidos.map((c) => (
              <tr key={c.id}>
              <td>{c.nome}</td>
              <td>{c.telefone}</td>
              <td>{c.pontos}</td>
              <td className={c.saldoFiado > 0 ? 'text-danger' : ''}>R$ {c.saldoFiado.toFixed(2)}</td>
              <td>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button className="btn-link" onClick={() => startEdit(c)}>✏️ Editar</button>
                  <button className="btn-link" onClick={() => openHistory(c)}>🧾 Fiado</button>
                  {profile?.id === 'petshop' && (
                    <button className="btn-link" onClick={() => setPetsDoCliente(c)}>🐾 Pets</button>
                  )}
                  {profile?.id === 'otica' && (
                    <button className="btn-link" onClick={() => setEyewearDoCliente(c)}>👓 Receita</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div className="modal-overlay">
          <div className="modal-card" style={{ width: 'min(480px, 94vw)' }}>
            <h2>🧾 Fiado — {selected.nome}</h2>
            <p>Saldo devedor: <strong>R$ {customers.find((c) => c.id === selected.id)?.saldoFiado.toFixed(2)}</strong></p>

            <div className="inline-form">
              <label>Registrar pagamento
                <input type="number" step="0.01" value={pagamentoValor} onChange={(e) => setPagamentoValor(e.target.value)} />
              </label>
              <button className="btn-primary" onClick={handlePagamento}>💰 Registrar</button>
            </div>

            <ul className="payment-list" style={{ marginTop: 16, maxHeight: 220, overflowY: 'auto' }}>
              {history.map((h) => (
                <li key={h.id}>
                  {new Date(h.criado_em + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — {h.tipo === 'divida' ? 'Compra' : 'Pagamento'}: R$ {h.valor.toFixed(2)}
                </li>
              ))}
              {history.length === 0 && <li>Nenhum movimento ainda.</li>}
            </ul>

            <button className="btn-secondary" style={{ marginTop: 16 }} onClick={() => setSelected(null)}>✖️ Fechar</button>
          </div>
        </div>
      )}

      {showLapsed && <LapsedCustomersModal onFechar={() => setShowLapsed(false)} />}
      {showPetReminders && <PetReminderModal onFechar={() => setShowPetReminders(false)} />}
      {petsDoCliente && <PetsModal customer={petsDoCliente} onFechar={() => setPetsDoCliente(null)} />}
      {eyewearDoCliente && <EyewearModal customer={eyewearDoCliente} onFechar={() => setEyewearDoCliente(null)} />}
    </div>
  );
}
