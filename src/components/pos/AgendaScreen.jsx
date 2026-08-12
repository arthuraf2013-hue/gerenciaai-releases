import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { toISODate } from '../../utils/date';
import { useEscToClose } from '../../hooks/useEscToClose';

const STATUS_LABEL = { agendado: 'Agendado', confirmado: 'Confirmado', concluido: 'Concluído', cancelado: 'Cancelado', faltou: 'Faltou' };
const STATUS_CLASSE = { agendado: 'row-warning', confirmado: '', concluido: '', cancelado: 'row-critical', faltou: 'row-critical' };

function NovoAgendamento({ profissionais, dataInicial, onCriado, onCancelar }) {
  const { currentUser } = useSession();
  const [clientes, setClientes] = useState([]);
  const [form, setForm] = useState({
    professionalId: profissionais[0]?.id || '', customerId: '', clienteNomeAvulso: '', clienteTelefoneAvulso: '',
    servico: '', data: dataInicial, hora: '09:00', duracaoMinutos: '60', observacoes: '',
  });
  const [erro, setErro] = useState('');
  useEscToClose(onCancelar);

  useEffect(() => {
    window.pdv.customers.list({}).then((list) => setClientes(Array.isArray(list) ? list : []));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    const r = await window.pdv.appointments.create({
      locationId: window.APP_LOCATION_ID, professionalId: form.professionalId,
      customerId: form.customerId || undefined,
      clienteNomeAvulso: form.customerId ? undefined : form.clienteNomeAvulso,
      clienteTelefoneAvulso: form.customerId ? undefined : form.clienteTelefoneAvulso,
      servico: form.servico, dataHoraInicio: `${form.data} ${form.hora}:00`,
      duracaoMinutos: Number(form.duracaoMinutos) || 60, observacoes: form.observacoes,
      operadorId: currentUser.id,
    });
    if (!r.ok) { setErro(r.error); return; }
    onCriado();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <form onSubmit={handleSubmit}>
          <h2>Novo agendamento</h2>
          <div className="form-grid">
            <label>Profissional
              <select value={form.professionalId} onChange={(e) => setForm({ ...form, professionalId: e.target.value })} required>
                {profissionais.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
              </select>
            </label>
            <label>Serviço<input value={form.servico} onChange={(e) => setForm({ ...form, servico: e.target.value })} required /></label>
          </div>

          <label>Cliente cadastrado (opcional)
            <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
              <option value="">— cliente avulso (digite abaixo) —</option>
              {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </label>
          {!form.customerId && (
            <div className="form-grid">
              <label>Nome do cliente<input value={form.clienteNomeAvulso} onChange={(e) => setForm({ ...form, clienteNomeAvulso: e.target.value })} /></label>
              <label>Telefone<input value={form.clienteTelefoneAvulso} onChange={(e) => setForm({ ...form, clienteTelefoneAvulso: e.target.value })} /></label>
            </div>
          )}

          <div className="form-grid">
            <label>Data<input type="date" value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} required /></label>
            <label>Hora<input type="time" value={form.hora} onChange={(e) => setForm({ ...form, hora: e.target.value })} required /></label>
            <label>Duração (min)<input type="number" value={form.duracaoMinutos} onChange={(e) => setForm({ ...form, duracaoMinutos: e.target.value })} /></label>
          </div>
          <label>Observações<input value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} /></label>

          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onCancelar}>Cancelar</button>
            <button type="submit" className="btn-primary">Agendar</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AgendaDoDia() {
  const [profissionais, setProfissionais] = useState([]);
  const [data, setData] = useState(toISODate(new Date()));
  const [filtroProfissional, setFiltroProfissional] = useState('');
  const [agendamentos, setAgendamentos] = useState(null);
  const [showNovo, setShowNovo] = useState(false);

  useEffect(() => {
    window.pdv.appointments.listProfessionals().then((list) => setProfissionais(Array.isArray(list) ? list : []));
  }, []);

  function carregar() {
    window.pdv.appointments.list({ locationId: window.APP_LOCATION_ID, data, professionalId: filtroProfissional || undefined }).then((list) => {
      setAgendamentos(Array.isArray(list) ? list : []);
    });
  }
  useEffect(carregar, [data, filtroProfissional]);

  async function handleStatus(id, status) {
    await window.pdv.appointments.updateStatus({ appointmentId: id, status });
    carregar();
  }

  async function handleConfirmar(id) {
    const r = await window.pdv.appointments.montarLinkConfirmacao({ appointmentId: id });
    if (!r.ok) return alert(r.error);
    window.open(r.url, '_blank');
  }

  return (
    <div>
      <div className="inline-form" style={{ marginBottom: 12 }}>
        <label>Dia<input type="date" value={data} onChange={(e) => setData(e.target.value)} /></label>
        <label>Profissional
          <select value={filtroProfissional} onChange={(e) => setFiltroProfissional(e.target.value)}>
            <option value="">Todos</option>
            {profissionais.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        </label>
        <button className="btn-primary" onClick={() => setShowNovo(true)} disabled={profissionais.length === 0}>+ Novo agendamento</button>
      </div>
      {profissionais.length === 0 && <p className="screen-hint">Cadastre um profissional na aba "Profissionais" antes de agendar.</p>}

      {agendamentos === null && <p className="empty-state">Carregando...</p>}
      {agendamentos !== null && agendamentos.length === 0 && <p className="empty-state">Nenhum agendamento nesse dia.</p>}
      {agendamentos && agendamentos.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Hora</th><th>Cliente</th><th>Serviço</th><th>Profissional</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {agendamentos.map((a) => (
              <tr key={a.id} className={STATUS_CLASSE[a.status]}>
                <td>{a.data_hora_inicio.slice(11, 16)}</td>
                <td>{a.clienteNome || '—'}</td>
                <td>{a.servico}</td>
                <td>{a.profissionalNome}</td>
                <td>
                  <select value={a.status} onChange={(e) => handleStatus(a.id, e.target.value)}>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
                <td>
                  {a.clienteTelefone && (
                    <button className="btn-link" onClick={() => handleConfirmar(a.id)}>Confirmar por WhatsApp</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNovo && (
        <NovoAgendamento
          profissionais={profissionais} dataInicial={data}
          onCancelar={() => setShowNovo(false)}
          onCriado={() => { setShowNovo(false); carregar(); }}
        />
      )}
    </div>
  );
}

function Profissionais() {
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null);
  useEscToClose(() => setEditando(null), !!editando);

  function carregar() {
    window.pdv.appointments.listProfessionals().then((list) => setLista(Array.isArray(list) ? list : []));
  }
  useEffect(carregar, []);

  async function handleSave(e) {
    e.preventDefault();
    await window.pdv.appointments.upsertProfessional(editando);
    setEditando(null);
    carregar();
  }
  async function handleExcluir(id) {
    if (!confirm('Remover esse profissional?')) return;
    await window.pdv.appointments.deactivateProfessional({ id });
    carregar();
  }

  return (
    <div>
      <div className="screen-actions" style={{ marginBottom: 12 }}>
        <button className="btn-primary" onClick={() => setEditando({ nome: '', especialidade: '' })}>+ Novo profissional</button>
      </div>
      {lista === null && <p className="empty-state">Carregando...</p>}
      {lista !== null && lista.length === 0 && <p className="empty-state">Nenhum profissional cadastrado ainda.</p>}
      {lista && lista.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Nome</th><th>Especialidade</th><th></th></tr></thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.id}>
                <td>{p.nome}</td>
                <td>{p.especialidade || '—'}</td>
                <td>
                  <button className="btn-link" onClick={() => setEditando({ id: p.id, nome: p.nome, especialidade: p.especialidade || '' })}>Editar</button>
                  <button className="btn-link-danger" style={{ marginLeft: 10 }} onClick={() => handleExcluir(p.id)}>Remover</button>
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
              <h2>Profissional</h2>
              <label>Nome<input value={editando.nome} onChange={(e) => setEditando({ ...editando, nome: e.target.value })} required autoFocus /></label>
              <label>Especialidade<input value={editando.especialidade} onChange={(e) => setEditando({ ...editando, especialidade: e.target.value })} /></label>
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

export function AgendaScreen() {
  const [aba, setAba] = useState('agenda');

  return (
    <div className="screen">
      <h1>Agenda</h1>
      <div className="settings-tabs" style={{ marginTop: 0 }}>
        <button className={aba === 'agenda' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('agenda')}>Agenda</button>
        <button className={aba === 'profissionais' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('profissionais')}>Profissionais</button>
      </div>
      {aba === 'agenda' && <AgendaDoDia />}
      {aba === 'profissionais' && <Profissionais />}
    </div>
  );
}
