import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

const STATUS_LABEL = {
  pendente: 'Pendente',
  aguardando_confirmacao: 'Aguardando confirmação',
  confirmada: 'Confirmada',
  cancelada: 'Cancelada',
  nao_confirmada: 'Não confirmada',
  concluida: 'Concluída',
};
const STATUS_CLASSE = {
  aguardando_confirmacao: 'row-warning',
  cancelada: 'row-critical',
  nao_confirmada: 'row-critical',
};

function formatarDataHora(str) {
  if (!str) return '—';
  // 'YYYY-MM-DD HH:MM:SS' (hora local, sem fuso pra converter) -- ver
  // comentário em reservationService sobre esse formato.
  const [data, hora] = str.split(' ');
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano} ${hora?.slice(0, 5) || ''}`;
}

function NovaReserva({ onCriada, onCancelar }) {
  const { currentUser } = useSession();
  const [form, setForm] = useState({ nome: '', telefone: '', pessoas: '2', data: '', hora: '20:00', observacoes: '' });
  const [erro, setErro] = useState('');
  useEscToClose(onCancelar);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    const r = await window.pdv.reservation.create({
      locationId: window.APP_LOCATION_ID,
      clienteNome: form.nome,
      clienteTelefone: form.telefone,
      pessoas: Number(form.pessoas) || 0,
      dataHora: `${form.data} ${form.hora}:00`,
      origem: 'manual',
      operadorId: currentUser.id,
      observacoes: form.observacoes,
    });
    if (!r.ok) { setErro(r.error); return; }
    onCriada();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <form onSubmit={handleSubmit}>
          <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={18} /> Nova reserva</h2>
          <div className="form-grid">
            <label>Nome do cliente<input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required autoFocus /></label>
            <label>Telefone<input value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} required /></label>
          </div>
          <div className="form-grid-3">
            <label>Pessoas<input type="number" min="1" value={form.pessoas} onChange={(e) => setForm({ ...form, pessoas: e.target.value })} required /></label>
            <label>Data<input type="date" value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} required /></label>
            <label>Hora<input type="time" value={form.hora} onChange={(e) => setForm({ ...form, hora: e.target.value })} required /></label>
          </div>
          <label>Observações (opcional)<input value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} /></label>

          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onCancelar}><Icon name="close" size={15} /> Cancelar</button>
            <button type="submit" className="btn-primary"><Icon name="book" size={15} /> Reservar</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ReservasScreen() {
  const [reservas, setReservas] = useState(null);
  const [mesasLivres, setMesasLivres] = useState([]);
  const [filtroStatus, setFiltroStatus] = useState('ativas');
  const [showNova, setShowNova] = useState(false);
  const [erro, setErro] = useState('');

  function carregar() {
    Promise.all([
      window.pdv.reservation.list({ locationId: window.APP_LOCATION_ID }),
      window.pdv.table.list({ locationId: window.APP_LOCATION_ID }),
    ]).then(([listaReservas, listaMesas]) => {
      setReservas(Array.isArray(listaReservas) ? listaReservas : []);
      setMesasLivres(Array.isArray(listaMesas) ? listaMesas : []);
    });
  }
  useEffect(carregar, []);

  const reservasFiltradas = (reservas || []).filter((r) => {
    if (filtroStatus === 'todas') return true;
    if (filtroStatus === 'ativas') return ['pendente', 'aguardando_confirmacao', 'confirmada'].includes(r.status);
    return r.status === filtroStatus;
  });

  async function handleVincularMesa(reservationId, mesaId) {
    setErro('');
    const r = mesaId
      ? await window.pdv.reservation.linkMesa({ reservationId, mesaId })
      : await window.pdv.reservation.unlinkMesa({ reservationId });
    if (!r.ok) { setErro(r.error); return; }
    carregar();
  }

  async function handleConfirmar(reservationId) {
    setErro('');
    const r = await window.pdv.reservation.confirmar({ reservationId });
    if (!r.ok) { setErro(r.error); return; }
    carregar();
  }

  async function handleCancelar(reservationId) {
    if (!confirm('Cancelar essa reserva?')) return;
    setErro('');
    const r = await window.pdv.reservation.cancel({ reservationId });
    if (!r.ok) { setErro(r.error); return; }
    carregar();
  }

  // Mesa vinculada à própria reserva sempre aparece na lista (mesmo que
  // já esteja ocupada por outra comanda agora) -- senão o dropdown
  // "perderia" a mesa já escolhida assim que ela deixasse de estar
  // livre por qualquer outro motivo.
  function opcoesMesaPara(reserva) {
    return mesasLivres.filter((m) => m.status === 'livre' || m.id === reserva.mesa_id);
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="book" size={20} /> Reservas</h1>
        <button className="btn-primary" onClick={() => setShowNova(true)}><Icon name="add" size={15} /> Nova reserva</button>
      </div>
      <p className="screen-hint">
        Reservas feitas pelo chatbot do WhatsApp chegam aqui automaticamente, sem mesa vinculada ainda —
        vincule a uma mesa livre quando quiser. O chatbot confirma direto com o cliente 1h antes do horário;
        o status muda sozinho conforme a resposta dele.
      </p>
      <div className="inline-form" style={{ marginBottom: 12 }}>
        <label>Mostrar
          <select value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
            <option value="ativas">Ativas (pendente/aguardando/confirmada)</option>
            <option value="todas">Todas</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {erro && <p className="modal-error">{erro}</p>}

      {reservas === null && <p className="empty-state">Carregando...</p>}
      {reservas !== null && reservasFiltradas.length === 0 && <p className="empty-state">Nenhuma reserva por aqui.</p>}
      {reservas !== null && reservasFiltradas.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Data/hora</th><th>Cliente</th><th>Telefone</th><th>Pessoas</th>
              <th>Status</th><th>Mesa</th><th>Origem</th><th></th>
            </tr>
          </thead>
          <tbody>
            {reservasFiltradas.map((r) => (
              <tr key={r.id} className={STATUS_CLASSE[r.status] || ''}>
                <td>{formatarDataHora(r.data_hora)}</td>
                <td>{r.cliente_nome}</td>
                <td>{r.cliente_telefone}</td>
                <td>{r.pessoas}</td>
                <td>{STATUS_LABEL[r.status] || r.status}</td>
                <td>
                  {['cancelada', 'nao_confirmada', 'concluida'].includes(r.status) ? (
                    r.mesaNome || r.mesaNumero || '—'
                  ) : (
                    <select value={r.mesa_id || ''} onChange={(e) => handleVincularMesa(r.id, e.target.value || null)}>
                      <option value="">— sem mesa —</option>
                      {opcoesMesaPara(r).map((m) => (
                        <option key={m.id} value={m.id}>{m.nome || `Mesa ${m.numero}`}</option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {r.origem === 'whatsapp' ? <><Icon name="chat" size={14} /> WhatsApp</> : <><Icon name="signature" size={14} /> Manual</>}
                  </span>
                </td>
                <td>
                  {['pendente', 'aguardando_confirmacao'].includes(r.status) && (
                    <button className="btn-link" onClick={() => handleConfirmar(r.id)}><Icon name="checkCircle" size={14} /> Confirmar</button>
                  )}
                  {!['cancelada', 'nao_confirmada', 'concluida'].includes(r.status) && (
                    <button className="btn-link-danger" onClick={() => handleCancelar(r.id)}><Icon name="close" size={14} /> Cancelar</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNova && (
        <NovaReserva onCancelar={() => setShowNova(false)} onCriada={() => { setShowNova(false); carregar(); }} />
      )}
    </div>
  );
}
