import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { toISODate } from '../../utils/date';

const CATEGORIAS = [
  { value: 'aluguel', label: 'Aluguel' },
  { value: 'contas_consumo', label: 'Água/Luz/Internet' },
  { value: 'fornecedor', label: 'Fornecedor' },
  { value: 'salario', label: 'Salário' },
  { value: 'impostos', label: 'Impostos' },
  { value: 'outro', label: 'Outro' },
];
const CATEGORIA_LABEL = Object.fromEntries(CATEGORIAS.map((c) => [c.value, c.label]));

export function FinanceiroScreen() {
  const { currentUser } = useSession();
  const [periodo, setPeriodo] = useState('mes');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [resultado, setResultado] = useState(null);
  const [despesas, setDespesas] = useState([]);
  const [pendentes, setPendentes] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ categoria: 'outro', descricao: '', valor: '', fornecedorId: '', dataVencimento: '' });
  const [erro, setErro] = useState('');

  useEffect(() => {
    const hoje = new Date();
    let inicio = new Date(hoje);
    if (periodo === 'hoje') { /* mesmo dia */ }
    else if (periodo === 'semana') inicio.setDate(hoje.getDate() - 7);
    else if (periodo === 'mes') inicio.setDate(1);
    setDataInicio(toISODate(inicio));
    setDataFim(toISODate(hoje));
  }, [periodo]);

  useEffect(() => {
    window.pdv.suppliers.list().then(setFornecedores);
  }, []);

  function carregar() {
    if (!dataInicio || !dataFim) return;
    window.pdv.dashboard.getResultadoSimples({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then(setResultado);
    window.pdv.expenses.list({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then(setDespesas);
    window.pdv.expenses.listPending({ locationId: window.APP_LOCATION_ID }).then(setPendentes);
  }

  useEffect(carregar, [dataInicio, dataFim]);

  async function handleAdicionar(e) {
    e.preventDefault();
    setErro('');
    const result = await window.pdv.expenses.create({
      categoria: form.categoria, descricao: form.descricao, valor: Number(form.valor.replace(',', '.')),
      fornecedorId: form.fornecedorId || null, dataVencimento: form.dataVencimento || null,
      locationId: window.APP_LOCATION_ID, operadorId: currentUser.id,
    });
    if (!result.ok) return setErro(result.error);
    setForm({ categoria: 'outro', descricao: '', valor: '', fornecedorId: '', dataVencimento: '' });
    setShowForm(false);
    carregar();
  }

  async function handleMarcarPaga(expenseId) {
    await window.pdv.expenses.markAsPaid({ expenseId, operadorId: currentUser.id });
    carregar();
  }

  async function handleExcluir(expenseId) {
    if (!confirm('Excluir essa despesa? Não pode ser desfeito.')) return;
    await window.pdv.expenses.remove({ expenseId });
    carregar();
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Financeiro</h1>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ Lançar despesa</button>
      </div>
      <p className="screen-hint">
        Visão rápida de como o negócio está indo — não substitui contador nem é uma DRE contábil
        de verdade (não considera impostos sobre a receita, depreciação, etc).
      </p>

      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={periodo === 'hoje' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo('hoje')}>Hoje</button>
        <button className={periodo === 'semana' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo('semana')}>Últimos 7 dias</button>
        <button className={periodo === 'mes' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo('mes')}>Este mês</button>
      </div>

      {resultado && (
        <div className="screen-section-box" style={{ margin: '16px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16 }}>
            <div><span className="screen-hint">Receita</span><br /><strong>R$ {resultado.receita.toFixed(2)}</strong></div>
            <div><span className="screen-hint">Custo dos produtos</span><br /><strong>R$ {resultado.custoProdutos.toFixed(2)}</strong></div>
            <div><span className="screen-hint">Lucro bruto</span><br /><strong>R$ {resultado.lucroBruto.toFixed(2)}</strong></div>
            <div><span className="screen-hint">Despesas</span><br /><strong>R$ {resultado.despesas.toFixed(2)}</strong></div>
            <div>
              <span className="screen-hint">Resultado do período</span><br />
              <strong style={{ color: resultado.resultado >= 0 ? 'var(--color-primary)' : 'var(--color-danger)' }}>
                R$ {resultado.resultado.toFixed(2)}
              </strong>
            </div>
          </div>
        </div>
      )}

      {pendentes.length > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>Contas a pagar em aberto</h2>
          <table className="data-table">
            <thead><tr><th>Vencimento</th><th>Descrição</th><th>Fornecedor</th><th>Valor</th><th></th></tr></thead>
            <tbody>
              {pendentes.map((p) => (
                <tr key={p.id} className={p.data_vencimento && p.data_vencimento < toISODate(new Date()) ? 'row-warning' : ''}>
                  <td>{p.data_vencimento || '—'}</td>
                  <td>{p.descricao}</td>
                  <td>{p.fornecedor_nome || '—'}</td>
                  <td>R$ {p.valor.toFixed(2)}</td>
                  <td><button className="btn-link" onClick={() => handleMarcarPaga(p.id)}>Marcar como paga</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 style={{ marginTop: 24 }}>Despesas do período</h2>
      {despesas.length === 0 ? (
        <p className="empty-state">Nenhuma despesa lançada nesse período.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th>Valor</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {despesas.map((d) => (
              <tr key={d.id}>
                <td>{d.criado_em?.slice(0, 10)}</td>
                <td>{CATEGORIA_LABEL[d.categoria] || d.categoria}</td>
                <td>{d.descricao}{d.fornecedor_nome ? ` (${d.fornecedor_nome})` : ''}</td>
                <td>R$ {d.valor.toFixed(2)}</td>
                <td>{d.data_pagamento ? 'Paga' : 'Pendente'}</td>
                <td><button className="btn-link-danger" onClick={() => handleExcluir(d.id)}>Excluir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleAdicionar}>
              <h2>Lançar despesa</h2>
              <label>
                Categoria
                <select value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
                  {CATEGORIAS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label style={{ marginTop: 12 }}>
                Descrição
                <input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} required />
              </label>
              <label style={{ marginTop: 12 }}>
                Valor (R$)
                <input type="number" step="0.01" min="0.01" value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} required />
              </label>
              {form.categoria === 'fornecedor' && (
                <label style={{ marginTop: 12 }}>
                  Fornecedor
                  <select value={form.fornecedorId} onChange={(e) => setForm({ ...form, fornecedorId: e.target.value })}>
                    <option value="">(nenhum)</option>
                    {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                  </select>
                </label>
              )}
              <label style={{ marginTop: 12 }}>
                Vencimento (deixe vazio se já está paga)
                <input type="date" value={form.dataVencimento} onChange={(e) => setForm({ ...form, dataVencimento: e.target.value })} />
              </label>
              {erro && <p className="modal-error">{erro}</p>}
              <div className="modal-actions" style={{ marginTop: 16 }}>
                <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancelar</button>
                <button type="submit" className="btn-primary">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
