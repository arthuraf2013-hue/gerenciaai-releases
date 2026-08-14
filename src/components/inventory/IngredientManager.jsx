import { useEffect, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEscToClose } from '../../hooks/useEscToClose';

const UNIDADES = ['kg', 'g', 'l', 'ml', 'un'];

const emptyForm = { id: null, nome: '', unidade: 'kg', custoUnitario: '', estoqueAtual: '', estoqueMinimo: '' };

export function IngredientManager() {
  const [ingredients, setIngredients] = useState([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [editing, setEditing] = useState(null); // null = fechado, {} = novo, {...} = editar
  useEscToClose(() => setEditing(null), !!editing);
  const [form, setForm] = useState(emptyForm);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    window.pdv.ingredient.list({ query: debouncedQuery || undefined }).then((list) => {
      if (!ignore) setIngredients(Array.isArray(list) ? list : []);
    });
    return () => { ignore = true; };
  }, [debouncedQuery]);

  async function reload() {
    const list = await window.pdv.ingredient.list({ query: query || undefined });
    setIngredients(Array.isArray(list) ? list : []);
  }

  function startNew() {
    setForm(emptyForm);
    setSaveError('');
    setEditing({});
  }

  function startEdit(ing) {
    setForm({
      id: ing.id, nome: ing.nome, unidade: ing.unidade,
      custoUnitario: ing.custo_unitario, estoqueAtual: ing.estoque_atual, estoqueMinimo: ing.estoque_minimo,
    });
    setSaveError('');
    setEditing(ing);
  }

  function setField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    const result = await window.pdv.ingredient.upsert(form);
    setSaving(false);
    if (!result.ok) return setSaveError(result.error);
    setEditing(null);
    reload();
  }

  async function handleDeactivate(ing) {
    if (!confirm(`Remover o insumo "${ing.nome}"? Ele não vai mais aparecer pra montar fichas técnicas novas — as já existentes continuam contando o custo dele.`)) return;
    await window.pdv.ingredient.deactivate({ id: ing.id });
    reload();
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Insumos</h1>
        <button className="btn-primary" onClick={startNew}>+ Novo insumo</button>
      </div>
      <p className="screen-hint">
        Matéria-prima usada nos pratos (farinha, carne, óleo...). Cadastre o custo por unidade aqui
        pra depois montar a ficha técnica de cada prato em Produtos e calcular o custo automaticamente.
      </p>

      <input
        className="search-input" placeholder="Buscar insumo..."
        value={query} onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 16 }}
      />

      {ingredients.length === 0 ? (
        <p className="empty-state">Nenhum insumo cadastrado ainda.</p>
      ) : (
      <table className="data-table">
        <thead><tr><th>Nome</th><th>Unidade</th><th>Custo unitário</th><th>Estoque</th><th></th></tr></thead>
        <tbody>
          {ingredients.map((ing) => (
            <tr key={ing.id}>
              <td>{ing.nome}</td>
              <td>{ing.unidade}</td>
              <td>R$ {ing.custo_unitario.toFixed(2)} / {ing.unidade}</td>
              <td className={ing.estoque_atual <= ing.estoque_minimo && ing.estoque_minimo > 0 ? 'text-danger' : ''}>
                {ing.estoque_atual} {ing.unidade}
              </td>
              <td>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button className="btn-link" onClick={() => startEdit(ing)}>Editar</button>
                  <button className="btn-link-danger" onClick={() => handleDeactivate(ing)}>Remover</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      {editing && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={handleSubmit}>
            <h2>{form.id ? 'Editar insumo' : 'Novo insumo'}</h2>
            <label>Nome
              <input value={form.nome} onChange={(e) => setField('nome', e.target.value)} required autoFocus />
            </label>
            <label>Unidade
              <select value={form.unidade} onChange={(e) => setField('unidade', e.target.value)}>
                {UNIDADES.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label>Custo por unidade (R$)
              <input type="number" step="0.01" min="0" value={form.custoUnitario} onChange={(e) => setField('custoUnitario', e.target.value)} required />
            </label>
            <label>Estoque atual (opcional)
              <input type="number" step="0.01" min="0" value={form.estoqueAtual} onChange={(e) => setField('estoqueAtual', e.target.value)} />
            </label>
            <label>Estoque mínimo (opcional)
              <input type="number" step="0.01" min="0" value={form.estoqueMinimo} onChange={(e) => setField('estoqueMinimo', e.target.value)} />
            </label>
            {saveError && <p className="modal-error">{saveError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
              <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
