import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { TableOrderScreen } from './TableOrderScreen';
import { useEscToClose } from '../../hooks/useEscToClose';

const STATUS_LABEL = {
  livre: 'Livre',
  ocupada: 'Ocupada',
  aguardando_limpeza: 'Aguardando limpeza',
  reservada: 'Reservada',
};

export function RestaurantTables() {
  const { currentUser } = useSession();
  const [tables, setTables] = useState([]);
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
  const [reservaDataHora, setReservaDataHora] = useState('');
  const [mesaAberta, setMesaAberta] = useState(null); // { tableId, saleId, numero, nome, pessoas } | null

  async function reload() {
    const list = await window.pdv.table.list({ locationId: window.APP_LOCATION_ID });
    setTables(Array.isArray(list) ? list : []);
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
    setReservaDataHora('');
    setReservandoMesa(table);
  }

  async function confirmarReserva(e) {
    e.preventDefault();
    const result = await window.pdv.table.markReserved({
      tableId: reservandoMesa.id,
      reservadoPara: reservaDataHora || undefined,
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
        <h1>🍽️ Mesas</h1>
        <button className="btn-primary" onClick={() => setShowNew(true)}>➕ Nova mesa</button>
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
                    <button type="button" className="table-card-excluir" onClick={(e) => handleExcluirMesa(t, e)}>🗑️ Excluir</button>
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
            <h2>🍽️ Nova mesa</h2>
            <label>Número
              <input value={novoNumero} onChange={(e) => setNovoNumero(e.target.value)} required autoFocus />
            </label>
            <label>Nome (opcional)
              <input value={novoNome} onChange={(e) => setNovoNome(e.target.value)} placeholder="Ex: Varanda, Mesa do fundo..." />
            </label>
            {createError && <p className="modal-error">{createError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowNew(false)}>✖️ Cancelar</button>
              <button type="submit" className="btn-primary">➕ Criar</button>
            </div>
          </form>
        </div>
      )}

      {abrindoMesa && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={confirmarAbrirMesa}>
            <h2>🍽️ Abrir {abrindoMesa.nome || `Mesa ${abrindoMesa.numero}`}</h2>
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
              <button type="button" className="btn-secondary" onClick={() => setAbrindoMesa(null)}>✖️ Cancelar</button>
              <button type="submit" className="btn-primary">🍽️ Abrir mesa</button>
            </div>
          </form>
        </div>
      )}

      {reservandoMesa && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={confirmarReserva}>
            <h2>🍽️ Reservar {reservandoMesa.nome || `Mesa ${reservandoMesa.numero}`}</h2>
            <label>Pra quando? (opcional)
              <input
                type="datetime-local"
                value={reservaDataHora}
                onChange={(e) => setReservaDataHora(e.target.value)}
                autoFocus
              />
            </label>
            <p className="screen-hint" style={{ margin: '0 0 8px' }}>
              Deixe em branco se for só uma reserva sem hora marcada.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setReservandoMesa(null)}>✖️ Cancelar</button>
              <button type="submit" className="btn-primary">🍽️ Reservar</button>
            </div>
          </form>
        </div>
      )}
    </div>

  );
}
