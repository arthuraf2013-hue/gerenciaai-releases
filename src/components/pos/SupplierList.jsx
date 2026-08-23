import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

export function SupplierList() {
  const [suppliers, setSuppliers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ nome: '', cnpjCpf: '', telefone: '', email: '' });
  const [sugestoes, setSugestoes] = useState([]);
  const [carregandoSugestoes, setCarregandoSugestoes] = useState(false);
  const [exportandoLista, setExportandoLista] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
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

  async function handleExportarLista() {
    setExportandoLista(true);
    setExportMsg('');
    const result = await window.pdv.report.exportPurchaseSuggestions({ locationId: window.APP_LOCATION_ID });
    setExportandoLista(false);
    if (result.canceled) return;
    setExportMsg(result.ok ? `${result.total} item(ns) exportado(s) com sucesso.` : `Erro: ${result.error}`);
  }

  // Agrupa por fornecedor — assim a lista já sai pronta pra levar/mandar
  // pro fornecedor certo, em vez de uma lista solta misturando todo mundo.
  const sugestoesPorFornecedor = sugestoes.reduce((acc, s) => {
    const chave = s.fornecedor_nome || '(sem fornecedor cadastrado)';
    if (!acc[chave]) acc[chave] = [];
    acc[chave].push(s);
    return acc;
  }, {});

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="truck" size={20} /> Fornecedores</h1>
        <button className="btn-primary" onClick={startNew}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={15} /> Novo fornecedor</span>
        </button>
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
            <button className="btn-primary" type="submit">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="save" size={15} /> Salvar</span>
            </button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span>
            </button>
          </div>
        </form>
      )}

      {suppliers.length === 0 ? (
        <p className="empty-state">Nenhum fornecedor cadastrado ainda.</p>
      ) : (
      <table className="data-table">
        <thead><tr><th>Nome</th><th>CNPJ/CPF</th><th>Telefone</th><th></th></tr></thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id}>
              <td>{s.nome}</td><td>{s.cnpj_cpf}</td><td>{s.telefone}</td>
              <td><button className="btn-link" onClick={() => startEdit(s)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="edit" size={14} /> Editar</span>
              </button></td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      <section className="settings-section" style={{ marginTop: 28 }}>
        <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="truck" size={18} /> Lista de compra sugerida</h2>
        <p className="screen-hint">
          Baseada na velocidade de venda dos últimos 30 dias — sem IA, só estatística. Só considera
          produtos no estoque mínimo ou abaixo. Agrupada por fornecedor, pronta pra levar ou mandar.
          Quando a mercadoria chegar, use o <strong>Abastecimento</strong> pra dar entrada no estoque.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={carregarSugestoes} disabled={carregandoSugestoes}>
            {carregandoSugestoes ? 'Calculando...' : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="refresh" size={15} /> Calcular sugestão</span>
            )}
          </button>
          {sugestoes.length > 0 && (
            <button className="btn-secondary" onClick={handleExportarLista} disabled={exportandoLista}>
              {exportandoLista ? 'Exportando...' : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="chart" size={15} /> Exportar planilha</span>
              )}
            </button>
          )}
        </div>
        {exportMsg && <p className={exportMsg.startsWith('Erro') ? 'modal-error' : 'io-message'}>{exportMsg}</p>}

        {Object.entries(sugestoesPorFornecedor).map(([fornecedor, itens]) => (
          <div key={fornecedor} style={{ marginTop: 20 }}>
            <h3 style={{ marginBottom: 6 }}>{fornecedor}</h3>
            <table className="data-table">
              <thead><tr><th>Produto</th><th>Estoque atual</th><th>Venda/dia</th><th>Sugerido</th></tr></thead>
              <tbody>
                {itens.map((s) => (
                  <tr key={s.id}>
                    <td>{s.nome}</td>
                    <td>{s.estoque_atual}</td>
                    <td>{s.velocidadeDiaria}</td>
                    <td><strong>{s.quantidadeSugerida}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </div>
  );
}
