import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';

const STATUS_LABEL = { pendente: 'Pendente', em_rota: 'Em rota', entregue: 'Entregue', cancelada: 'Cancelada' };
const STATUS_CLASSE = { pendente: 'row-warning', em_rota: '', entregue: '', cancelada: 'row-critical' };

// ---------- Sub-tela: fila de entregas ----------
function DeliveryQueue() {
  const { currentUser } = useSession();
  const [entregas, setEntregas] = useState(null);
  const [rotas, setRotas] = useState([]);
  const [veiculos, setVeiculos] = useState([]);
  const [entregadores, setEntregadores] = useState([]);
  const [filtroStatus, setFiltroStatus] = useState('');
  const [showNova, setShowNova] = useState(false);
  const [novaForm, setNovaForm] = useState({ enderecoManual: '', taxaEntrega: '', observacoes: '' });

  function carregar() {
    window.pdv.delivery.list({ locationId: window.APP_LOCATION_ID, status: filtroStatus || undefined }).then((list) => setEntregas(Array.isArray(list) ? list : []));
  }
  useEffect(carregar, [filtroStatus]);
  useEffect(() => {
    window.pdv.delivery.listRoutes().then((list) => setRotas(Array.isArray(list) ? list : []));
    window.pdv.delivery.listVehicles().then((list) => setVeiculos(Array.isArray(list) ? list : []));
    window.pdv.delivery.listPersons().then((list) => setEntregadores(Array.isArray(list) ? list : []));
  }, []);

  async function handleCriarEntrega(e) {
    e.preventDefault();
    await window.pdv.delivery.create({
      locationId: window.APP_LOCATION_ID, endereco: novaForm.enderecoManual,
      taxaEntrega: Number(novaForm.taxaEntrega) || 0, observacoes: novaForm.observacoes,
      operadorId: currentUser.id,
    });
    setShowNova(false);
    setNovaForm({ enderecoManual: '', taxaEntrega: '', observacoes: '' });
    carregar();
  }

  async function handleAtribuir(entregaId, campo, valor) {
    const atual = entregas.find((e) => e.id === entregaId);
    await window.pdv.delivery.assign({
      deliveryId: entregaId,
      routeId: campo === 'route_id' ? valor : atual.route_id,
      deliveryPersonId: campo === 'delivery_person_id' ? valor : atual.delivery_person_id,
      vehicleId: campo === 'vehicle_id' ? valor : atual.vehicle_id,
    });
    carregar();
  }

  async function handleStatus(entregaId, status) {
    await window.pdv.delivery.updateStatus({ deliveryId: entregaId, status });
    carregar();
  }

  async function handleAvisar(entregaId) {
    const result = await window.pdv.delivery.montarLinkStatus({ deliveryId: entregaId });
    if (!result.ok) return alert(result.error);
    window.open(result.url, '_blank');
  }

  return (
    <div>
      <div className="screen-actions" style={{ marginBottom: 12 }}>
        {['', 'pendente', 'em_rota', 'entregue', 'cancelada'].map((s) => (
          <button key={s} className={filtroStatus === s ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setFiltroStatus(s)}>
            {s === '' ? 'Todas' : STATUS_LABEL[s]}
          </button>
        ))}
        <button className="btn-primary" onClick={() => setShowNova(true)}>+ Nova entrega</button>
      </div>

      {entregas === null && <p className="empty-state">Carregando...</p>}
      {entregas !== null && entregas.length === 0 && <p className="empty-state">Nenhuma entrega por aqui.</p>}
      {entregas && entregas.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Cliente/Endereço</th><th>Rota</th><th>Entregador</th><th>Veículo</th><th>Taxa</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {entregas.map((d) => (
              <tr key={d.id} className={STATUS_CLASSE[d.status]}>
                <td>{d.clienteNome || '—'}<br /><span className="screen-hint">{d.endereco || 'sem endereço'}</span></td>
                <td>
                  <select value={d.route_id || ''} onChange={(e) => handleAtribuir(d.id, 'route_id', e.target.value || null)}>
                    <option value="">—</option>
                    {rotas.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
                  </select>
                </td>
                <td>
                  <select value={d.delivery_person_id || ''} onChange={(e) => handleAtribuir(d.id, 'delivery_person_id', e.target.value || null)}>
                    <option value="">—</option>
                    {entregadores.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                  </select>
                </td>
                <td>
                  <select value={d.vehicle_id || ''} onChange={(e) => handleAtribuir(d.id, 'vehicle_id', e.target.value || null)}>
                    <option value="">—</option>
                    {veiculos.map((v) => <option key={v.id} value={v.id}>{v.modelo || v.placa}</option>)}
                  </select>
                </td>
                <td>R$ {d.taxa_entrega.toFixed(2)}</td>
                <td>
                  <select value={d.status} onChange={(e) => handleStatus(d.id, e.target.value)}>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
                <td>
                  {d.clienteTelefone && (d.status === 'em_rota' || d.status === 'entregue') && (
                    <button className="btn-link" onClick={() => handleAvisar(d.id)}>Avisar cliente</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNova && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleCriarEntrega}>
              <h2>Nova entrega</h2>
              <p className="screen-hint" style={{ margin: '0 0 8px' }}>
                Pra criar uma entrega vinculada a uma venda já finalizada, use o botão de entrega
                direto na tela de Histórico. Aqui é pra pedido avulso (por telefone, por exemplo).
              </p>
              <label>Endereço<input value={novaForm.enderecoManual} onChange={(e) => setNovaForm({ ...novaForm, enderecoManual: e.target.value })} required /></label>
              <label>Taxa de entrega<input type="number" step="0.01" value={novaForm.taxaEntrega} onChange={(e) => setNovaForm({ ...novaForm, taxaEntrega: e.target.value })} /></label>
              <label>Observações<input value={novaForm.observacoes} onChange={(e) => setNovaForm({ ...novaForm, observacoes: e.target.value })} /></label>
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowNova(false)}>Cancelar</button>
                <button type="submit" className="btn-primary">Criar</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Sub-tela genérica de cadastro simples (rota/veículo/entregador) ----------
function CadastroSimples({ titulo, campos, listFn, upsertFn, deactivateFn }) {
  const [itens, setItens] = useState(null);
  const [editando, setEditando] = useState(null);

  function carregar() {
    listFn().then((list) => setItens(Array.isArray(list) ? list : []));
  }
  useEffect(carregar, []);

  async function handleSave(e) {
    e.preventDefault();
    await upsertFn(editando);
    setEditando(null);
    carregar();
  }

  async function handleExcluir(id) {
    if (!confirm('Remover?')) return;
    await deactivateFn({ id });
    carregar();
  }

  return (
    <div>
      <div className="screen-actions" style={{ marginBottom: 12 }}>
        <button className="btn-primary" onClick={() => setEditando(Object.fromEntries(campos.map((c) => [c.chave, ''])))}>+ Novo</button>
      </div>

      {itens === null && <p className="empty-state">Carregando...</p>}
      {itens !== null && itens.length === 0 && <p className="empty-state">Nenhum cadastro ainda.</p>}
      {itens && itens.length > 0 && (
        <table className="data-table">
          <thead><tr>{campos.map((c) => <th key={c.chave}>{c.label}</th>)}<th></th></tr></thead>
          <tbody>
            {itens.map((item) => (
              <tr key={item.id}>
                {campos.map((c) => <td key={c.chave}>{item[c.chave] || '—'}</td>)}
                <td>
                  <button className="btn-link" onClick={() => setEditando({ id: item.id, ...Object.fromEntries(campos.map((c) => [c.chave, item[c.chave] || ''])) })}>Editar</button>
                  <button className="btn-link-danger" style={{ marginLeft: 10 }} onClick={() => handleExcluir(item.id)}>Remover</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editando && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleSave}>
              <h2>{titulo}</h2>
              {campos.map((c) => (
                <label key={c.chave}>{c.label}<input value={editando[c.chave]} onChange={(e) => setEditando({ ...editando, [c.chave]: e.target.value })} autoFocus={c === campos[0]} /></label>
              ))}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setEditando(null)}>Cancelar</button>
                <button type="submit" className="btn-primary">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export function DeliveryScreen() {
  const [aba, setAba] = useState('entregas');

  return (
    <div className="screen">
      <h1>Delivery</h1>

      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'entregas' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('entregas')}>Entregas</button>
        <button className={aba === 'rotas' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('rotas')}>Rotas</button>
        <button className={aba === 'veiculos' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('veiculos')}>Veículos</button>
        <button className={aba === 'entregadores' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('entregadores')}>Entregadores</button>
      </div>

      {aba === 'entregas' && <DeliveryQueue />}
      {aba === 'rotas' && (
        <CadastroSimples
          titulo="Rota"
          campos={[{ chave: 'nome', label: 'Nome' }, { chave: 'descricao', label: 'Área/bairros' }]}
          listFn={window.pdv.delivery.listRoutes} upsertFn={window.pdv.delivery.upsertRoute} deactivateFn={window.pdv.delivery.deactivateRoute}
        />
      )}
      {aba === 'veiculos' && (
        <CadastroSimples
          titulo="Veículo"
          campos={[{ chave: 'modelo', label: 'Modelo' }, { chave: 'placa', label: 'Placa' }, { chave: 'tipo', label: 'Tipo (moto, carro, bike...)' }]}
          listFn={window.pdv.delivery.listVehicles} upsertFn={window.pdv.delivery.upsertVehicle} deactivateFn={window.pdv.delivery.deactivateVehicle}
        />
      )}
      {aba === 'entregadores' && (
        <CadastroSimples
          titulo="Entregador"
          campos={[{ chave: 'nome', label: 'Nome' }, { chave: 'telefone', label: 'Telefone' }]}
          listFn={window.pdv.delivery.listPersons} upsertFn={window.pdv.delivery.upsertPerson} deactivateFn={window.pdv.delivery.deactivatePerson}
        />
      )}
    </div>
  );
}
