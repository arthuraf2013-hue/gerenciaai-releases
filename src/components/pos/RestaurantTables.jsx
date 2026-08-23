import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { TableOrderScreen } from './TableOrderScreen';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

const STATUS_LABEL = {
  livre: 'Livre',
  ocupada: 'Ocupada',
  aguardando_limpeza: 'Aguardando limpeza',
  reservada: 'Reservada',
};

// Indicador de reserva feita pelo chatbot (ou cadastrada manualmente na
// tela de Reservas) já vinculada a essa mesa -- ver reservationService.
// Ícone/rótulo por status, igual à jornada que o cliente vive no
// WhatsApp (ver whatsappBotHandler): pendente -> aguardando confirmação
// (lembrete de 1h antes já mandado) -> confirmada.
const RESERVA_BADGE = {
  pendente: { icon: 'clock', texto: 'Reservada' },
  aguardando_confirmacao: { icon: 'hourglass', texto: 'Aguardando confirmação' },
  confirmada: { icon: 'checkCircle', texto: 'Confirmada' },
};

export function RestaurantTables() {
  const { currentUser } = useSession();
  const [tables, setTables] = useState([]);
  const [reservasPorMesa, setReservasPorMesa] = useState({});
  const [loadError, setLoadError] = useState('');
  const [offsetMs, setOffsetMs] = useState(0);
  const [, setTick] = useState(0); // só pra forçar recalcular o tempo de ocupação a cada minuto

  useEffect(() => {
    window.pdv.time.getStatus().then((s) => setOffsetMs(s.offsetMs || 0));
    const id = setInterval(() => setTick((t) => t + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  function tempoOcupada(abertaEm) {
    if (!abertaEm) return null;
    const minutos = Math.max(0, Math.round((Date.now() + offsetMs - new Date(abertaEm + 'Z').getTime()) / 60000));
    if (minutos < 60) return { texto: `há ${minutos}min`, longa: minutos >= 90 };
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return { texto: `há ${horas}h${resto > 0 ? ` ${resto}min` : ''}`, longa: minutos >= 90 };
  }

  const [showNew, setShowNew] = useState(false);
  useEscToClose(() => setShowNew(false), showNew);
  const [novoNumero, setNovoNumero] = useState('');
  const [novoNome, setNovoNome] = useState('');
  const [createError, setCreateError] = useState('');
  const [abrindoMesa, setAbrindoMesa] = useState(null); // mesa aguardando número de pessoas antes de abrir
  useEscToClose(() => setAbrindoMesa(null), !!abrindoMesa);
  const [pessoasInput, setPessoasInput] = useState('2');
  const [reservandoMesa, setReservandoMesa] = useState(null);
  useEscToClose(() => setReservandoMesa(null), !!reservandoMesa);
  // Antes era um único <input type="datetime-local">, mas o ícone de
  // calendário/relógio embutido nele não abria de forma confiável (o
  // controle combinado do Chromium é mais frágil dentro do Electron) --
  // dois campos separados (data + hora), igual ao padrão já usado e
  // funcionando na tela de Reservas, resolve isso.
  const [reservaData, setReservaData] = useState('');
  const [reservaHora, setReservaHora] = useState('');
  const [mesaAberta, setMesaAberta] = useState(null); // { tableId, saleId, numero, nome, pessoas } | null
  const [qrMesa, setQrMesa] = useState(null); // mesa que está com o modal de QR code aberto
  useEscToClose(() => setQrMesa(null), !!qrMesa);
  const [qrDados, setQrDados] = useState(null); // { url, qrCodeDataUrl } | null
  const [qrError, setQrError] = useState('');
  const [qrCarregando, setQrCarregando] = useState(false);

  async function reload() {
    const [list, reservas] = await Promise.all([
      window.pdv.table.list({ locationId: window.APP_LOCATION_ID }),
      window.pdv.reservation.listVinculadasAtivas({ locationId: window.APP_LOCATION_ID }),
    ]);
    setTables(Array.isArray(list) ? list : []);
    const mapa = {};
    (Array.isArray(reservas) ? reservas : []).forEach((r) => { mapa[r.mesa_id] = r; });
    setReservasPorMesa(mapa);
  }

  useEffect(() => { reload(); }, []);

  function pedirNumeroPessoas(table) {
    setLoadError('');
    setPessoasInput('2');
    setAbrindoMesa(table);
  }

  async function confirmarAbrirMesa(e) {
    e.preventDefault();
    const result = await window.pdv.table.open({
      tableId: abrindoMesa.id, locationId: window.APP_LOCATION_ID, operadorId: currentUser.id,
      pessoas: pessoasInput || undefined,
    });
    if (!result.ok) {
      setLoadError(result.error);
      setAbrindoMesa(null);
      return;
    }
    setMesaAberta({
      tableId: abrindoMesa.id, saleId: result.saleId, numero: abrindoMesa.numero,
      nome: abrindoMesa.nome, pessoas: Number(pessoasInput) || null,
    });
    setAbrindoMesa(null);
  }

  async function continuarMesaOcupada(table) {
    setMesaAberta({
      tableId: table.id, saleId: table.sale_id, numero: table.numero, nome: table.nome, pessoas: table.pessoas,
    });
  }

  function handleClickMesa(table) {
    if (table.status === 'ocupada') return continuarMesaOcupada(table);
    if (table.status === 'livre' || table.status === 'reservada') return pedirNumeroPessoas(table);
    // aguardando_limpeza: não abre nada, só os botões de ação no card cuidam disso
  }

  async function handleCriarMesa(e) {
    e.preventDefault();
    setCreateError('');
    const result = await window.pdv.table.create({
      locationId: window.APP_LOCATION_ID, numero: novoNumero, nome: novoNome || undefined,
    });
    if (!result.ok) return setCreateError(result.error);
    setNovoNumero('');
    setNovoNome('');
    setShowNew(false);
    reload();
  }

  async function handleExcluirMesa(table, e) {
    e.stopPropagation();
    if (!confirm(`Excluir a mesa "${table.nome || table.numero}"?`)) return;
    const result = await window.pdv.table.delete({ tableId: table.id });
    if (!result.ok) return setLoadError(result.error);
    reload();
  }

  async function handleMarcarLimpa(table, e) {
    e.stopPropagation();
    const result = await window.pdv.table.markCleaned({ tableId: table.id });
    if (!result.ok) return setLoadError(result.error);
    reload();
  }

  function abrirReserva(table, e) {
    e.stopPropagation();
    setLoadError('');
    setReservaData('');
    setReservaHora('');
    setReservandoMesa(table);
  }

  async function confirmarReserva(e) {
    e.preventDefault();
    // Mesmo formato ISO local ('YYYY-MM-DDTHH:MM') que o antigo
    // datetime-local produzia -- continua batendo com o `new Date(...)`
    // usado mais abaixo pra exibir a data/hora no card da mesa.
    const reservadoPara = reservaData ? `${reservaData}T${reservaHora || '00:00'}` : undefined;
    const result = await window.pdv.table.markReserved({
      tableId: reservandoMesa.id,
      reservadoPara,
    });
    if (!result.ok) {
      setLoadError(result.error);
      setReservandoMesa(null);
      return;
    }
    setReservandoMesa(null);
    reload();
  }

  async function handleCancelarReserva(table, e) {
    e.stopPropagation();
    const result = await window.pdv.table.cancelReservation({ tableId: table.id });
    if (!result.ok) return setLoadError(result.error);
    reload();
  }

  async function abrirQrCode(table, e) {
    e.stopPropagation();
    setQrMesa(table);
    setQrDados(null);
    setQrError('');
    setQrCarregando(true);
    const result = await window.pdv.table.montarLinkPedido({ tableId: table.id });
    setQrCarregando(false);
    if (!result.ok) return setQrError(result.error);
    setQrDados(result);
  }

  if (mesaAberta) {
    return (
      <TableOrderScreen
        tableId={mesaAberta.tableId}
        saleId={mesaAberta.saleId}
        numero={mesaAberta.numero}
        nome={mesaAberta.nome}
        pessoas={mesaAberta.pessoas}
        onFechar={() => { setMesaAberta(null); reload(); }}
      />
    );
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={20} /> Mesas</h1>
        <button className="btn-primary" onClick={() => setShowNew(true)}><Icon name="add" size={15} /> Nova mesa</button>
      </div>
      <p className="screen-hint">
        Clique numa mesa livre ou reservada pra abrir uma comanda (informando quantas pessoas —
        usado só pra calcular quanto fica por pessoa na hora de dividir a conta). Clique numa mesa
        ocupada pra continuar lançando itens ou fechar a conta.
      </p>
      {loadError && <p className="modal-error">{loadError}</p>}

      {tables.length === 0 ? (
        <p className="empty-state">Nenhuma mesa cadastrada ainda — clique em "+ Nova mesa".</p>
      ) : (
        <div className="tables-grid">
          {tables.map((t) => {
            const tempo = t.status === 'ocupada' ? tempoOcupada(t.aberta_em) : null;
            return (
            <div
              key={t.id}
              className={`table-card table-card-${t.status}`}
              onClick={() => handleClickMesa(t)}
            >
              <span className="table-card-numero">{t.nome || `Mesa ${t.numero}`}</span>
              <button
                type="button" className="table-card-action" style={{ marginTop: 4 }}
                onClick={(e) => abrirQrCode(t, e)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="mobile" size={14} /> QR do cardápio</span>
              </button>
              {reservasPorMesa[t.id] && (
                <span
                  className={`table-reserva-badge table-reserva-badge-${reservasPorMesa[t.id].status}`}
                  title={`${reservasPorMesa[t.id].cliente_nome} — ${reservasPorMesa[t.id].pessoas} pessoa(s)`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Icon name={RESERVA_BADGE[reservasPorMesa[t.id].status]?.icon} size={13} /> {RESERVA_BADGE[reservasPorMesa[t.id].status]?.texto}
                </span>
              )}
              {t.status === 'ocupada' && (
                <span className="table-card-status">
                  Ocupada{t.pessoas ? ` — ${t.pessoas} pessoa(s)` : ''} — R$ {(t.total_atual || 0).toFixed(2)}
                  {tempo && (
                    <><br /><span className={tempo.longa ? 'table-card-tempo-longo' : ''}>{tempo.texto}</span></>
                  )}
                </span>
              )}
              {t.status === 'livre' && (
                <>
                  <span className="table-card-status">Livre</span>
                  <div className="table-card-actions">
                    <button type="button" className="table-card-action" onClick={(e) => abrirReserva(t, e)}>Reservar</button>
                    <button type="button" className="table-card-excluir" onClick={(e) => handleExcluirMesa(t, e)}><Icon name="trash" size={14} /> Excluir</button>
                  </div>
                </>
              )}
              {t.status === 'reservada' && (
                <>
                  <span className="table-card-status">
                    Reservada
                    {t.reservado_para && <><br />{new Date(t.reservado_para).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</>}
                  </span>
                  <button type="button" className="table-card-action" onClick={(e) => handleCancelarReserva(t, e)}>Cancelar reserva</button>
                </>
              )}
              {t.status === 'aguardando_limpeza' && (
                <>
                  <span className="table-card-status">Aguardando limpeza</span>
                  <button type="button" className="table-card-action" onClick={(e) => handleMarcarLimpa(t, e)}>Marcar como limpa</button>
                </>
              )}
            </div>
            );
          })}
        </div>
      )}

      {showNew && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={handleCriarMesa}>
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={18} /> Nova mesa</h2>
            <label>Número
              <input value={novoNumero} onChange={(e) => setNovoNumero(e.target.value)} required autoFocus />
            </label>
            <label>Nome (opcional)
              <input value={novoNome} onChange={(e) => setNovoNome(e.target.value)} placeholder="Ex: Varanda, Mesa do fundo..." />
            </label>
            {createError && <p className="modal-error">{createError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowNew(false)}><Icon name="close" size={15} /> Cancelar</button>
              <button type="submit" className="btn-primary"><Icon name="add" size={15} /> Criar</button>
            </div>
          </form>
        </div>
      )}

      {abrindoMesa && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={confirmarAbrirMesa}>
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={18} /> Abrir {abrindoMesa.nome || `Mesa ${abrindoMesa.numero}`}</h2>
            <label>Quantas pessoas?
              <input
                type="number" min="1" value={pessoasInput}
                onChange={(e) => setPessoasInput(e.target.value)}
                autoFocus required
              />
            </label>
            <p className="screen-hint" style={{ margin: '0 0 8px' }}>
              Só pra ajudar a calcular quanto fica por pessoa na hora de fechar a conta — não separa
              os pagamentos automaticamente.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setAbrindoMesa(null)}><Icon name="close" size={15} /> Cancelar</button>
              <button type="submit" className="btn-primary"><Icon name="plate" size={15} /> Abrir mesa</button>
            </div>
          </form>
        </div>
      )}

      {reservandoMesa && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={confirmarReserva}>
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={18} /> Reservar {reservandoMesa.nome || `Mesa ${reservandoMesa.numero}`}</h2>
            <p className="screen-hint" style={{ margin: '0 0 4px' }}>Pra quando? (opcional)</p>
            <div className="form-grid">
              <label>Data
                <input
                  type="date"
                  value={reservaData}
                  onChange={(e) => setReservaData(e.target.value)}
                  autoFocus
                />
              </label>
              <label>Hora
                <input
                  type="time"
                  value={reservaHora}
                  onChange={(e) => setReservaHora(e.target.value)}
                  disabled={!reservaData}
                />
              </label>
            </div>
            <p className="screen-hint" style={{ margin: '0 0 8px' }}>
              Deixe em branco se for só uma reserva sem hora marcada.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setReservandoMesa(null)}><Icon name="close" size={15} /> Cancelar</button>
              <button type="submit" className="btn-primary"><Icon name="plate" size={15} /> Reservar</button>
            </div>
          </form>
        </div>
      )}
      {qrMesa && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="mobile" size={18} /> QR do cardápio — {qrMesa.nome || `Mesa ${qrMesa.numero}`}</h2>
            <p className="screen-hint" style={{ margin: '0 0 8px' }}>
              Imprima e cole na mesa: o cliente escaneia, o WhatsApp já abre com "Mesa {qrMesa.numero}"
              preenchido, e o pedido feito por ali cai direto nessa comanda pra alguém confirmar.
            </p>
            {qrCarregando && <p className="empty-state">Gerando...</p>}
            {qrError && <p className="modal-error">{qrError}</p>}
            {qrDados && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                {qrDados.qrCodeDataUrl && (
                  <img
                    src={qrDados.qrCodeDataUrl} alt={`QR code de pedido da Mesa ${qrMesa.numero}`}
                    style={{ width: 220, height: 220, borderRadius: 8, border: '1px solid var(--color-border)' }}
                  />
                )}
                <button type="button" className="btn-secondary" onClick={() => window.open(qrDados.url, '_blank')}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="link" size={14} /> Abrir o link</span>
                </button>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)', wordBreak: 'break-all', textAlign: 'center' }}>
                  {qrDados.url}
                </span>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setQrMesa(null)}><Icon name="close" size={15} /> Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>

  );
}
