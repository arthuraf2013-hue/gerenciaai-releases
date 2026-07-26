import { useEffect, useState } from 'react';

export function SupplierList() {
  const [suppliers, setSuppliers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ nome: '', cnpjCpf: '', telefone: '', email: '' });
  const [sugestoes, setSugestoes] = useState([]);
  const [carregandoSugestoes, setCarregandoSugestoes] = useState(false);
  const [saveError, setSaveError] = useState('');

  async function reload() {
    const list = await window.pdv.suppliers.list({});
    setSuppliers(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reload(); }, []);

  function startNew() {
    setForm({ nome: '', cnpjCpf: '', telefone: '', email: '' });
    setEditing('new');
  }

  function startEdit(s) {
    setForm({ id: s.id, nome: s.nome, cnpjCpf: s.cnpj_cpf || '', telefone: s.telefone || '', email: s.email || '' });
    setEditing(s.id);
  }

  async function handleSave(e) {
    e.preventDefault();
    const result = await window.pdv.suppliers.upsert(form);
    if (!result.ok) return setSaveError(result.error);
    setSaveError('');
    setEditing(null);
    reload();
  }

  async function carregarSugestoes() {
    setCarregandoSugestoes(true);
    const list = await window.pdv.suppliers.suggestPurchases({ locationId: window.APP_LOCATION_ID });
    setSugestoes(Array.isArray(list) ? list : []);
    setCarregandoSugestoes(false);
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Fornecedores</h1>
        <button className="btn-primary" onClick={startNew}>Novo fornecedor</button>
      </div>

      {editing && (
        <form className="product-form" onSubmit={handleSave} style={{ marginBottom: 20 }}>
          <div className="form-grid">
            <label>Nome<input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required /></label>
            <label>CNPJ/CPF<input value={form.cnpjCpf} onChange={(e) => setForm({ ...form, cnpjCpf: e.target.value })} /></label>
            <label>Telefone<input value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} /></label>
            <label>E-mail<input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          </div>
          {saveError && <p className="modal-error">{saveError}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" type="submit">Salvar</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </form>
      )}

      <table className="data-table">
        <thead><tr><th>Nome</th><th>CNPJ/CPF</th><th>Telefone</th><th></th></tr></thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id}>
              <td>{s.nome}</td><td>{s.cnpj_cpf}</td><td>{s.telefone}</td>
              <td><button className="btn-link" onClick={() => startEdit(s)}>Editar</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="settings-section" style={{ marginTop: 28 }}>
        <h2>Sugestão de compra</h2>
        <p className="screen-hint">
          Baseada na velocidade de venda dos últimos 30 dias — sem IA, só estatística. Só considera
          produtos no estoque mínimo ou abaixo.
        </p>
        <button className="btn-secondary" onClick={carregarSugestoes} disabled={carregandoSugestoes}>
          {carregandoSugestoes ? 'Calculando...' : 'Calcular sugestão'}
        </button>

        {sugestoes.length > 0 && (
          <table className="data-table" style={{ marginTop: 16 }}>
            <thead><tr><th>Produto</th><th>Fornecedor</th><th>Estoque atual</th><th>Venda/dia</th><th>Sugerido</th></tr></thead>
            <tbody>
              {sugestoes.map((s) => (
                <tr key={s.id}>
                  <td>{s.nome}</td>
                  <td>{s.fornecedor_nome || '—'}</td>
                  <td>{s.estoque_atual}</td>
                  <td>{s.velocidadeDiaria}</td>
                  <td><strong>{s.quantidadeSugerida}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
