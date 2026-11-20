import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { TableOrderScreen } from './TableOrderScreen';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';
import { QrMesasPdfModal } from './QrMesasPdfModal';
import { apiDasMesas } from '../../utils/mesasApi';

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

/** "AAAA-MM-DDTHH:MM" → "08/11/26, 20:00"; texto que não é data aparece como veio (nunca "Invalid Date"). */
function dataDaReserva(valor) {
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? String(valor) : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function RestaurantTables() {
  const { currentUser } = useSession();
  // Mesa compartilhada: neste caixa as mesas são as do servidor do grupo
  // (rede local). { carregou, podeUsar, ativa, online, servidor, erro }
  const [compart, setCompart] = useState({ carregou: false, ativa: false });
  const remota = !!compart.ativa;
  const api = useMemo(() => apiDasMesas(remota), [remota]);
  // Mesas que ficaram abertas NESTE caixa de antes da mesa compartilhada.
  const [mesasDaqui, setMesasDaqui] = useState([]);
  const [pendencias, setPendencias] = useState([]);
  const [semServidor, setSemServidor] = useState('');
  // Contingência: servidor das mesas fora do ar, este caixa segue pela cópia (fila).
  const [conting, setConting] = useState(null);
  const ehGestao = ['gerente', 'admin', 'suporte'].includes(currentUser.role);
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

  // Modo "Organizar": arrastar (ou setas) para mudar a posição das mesas.
  const [organizando, setOrganizando] = useState(false);
  const [ordemEdit, setOrdemEdit] = useState([]);
  const [arrastando, setArrastando] = useState(null);
  const [salvandoOrdem, setSalvandoOrdem] = useState(false);

  const [showNew, setShowNew] = useState(false);
  useEscToClose(() => setShowNew(false), showNew);
  const [novoNumero, setNovoNumero] = useState('');
  const [novoNome, setNovoNome] = useState('');
  const [createError, setCreateError] = useState('');
  // Cadastro rápido: quantas mesas + de que número começa (padrão: a
  // seguinte à maior que já existe). "Uma mesa só" continua para nome livre.
  const [modoNova, setModoNova] = useState('varias');
  const [qtdMesas, setQtdMesas] = useState('10');
  const [inicioMesas, setInicioMesas] = useState('1');
  const [criando, setCriando] = useState(false);
  const [avisoMesas, setAvisoMesas] = useState('');
  useEffect(() => {
    if (!avisoMesas) return undefined;
    const t = setTimeout(() => setAvisoMesas(''), 8000);
    return () => clearTimeout(t);
  }, [avisoMesas]);
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
  // PDF/impressão dos QR (todas as mesas ou uma): null | { mesaInicial }
  const [qrPdf, setQrPdf] = useState(null);
  const [qrError, setQrError] = useState('');
  const [qrCarregando, setQrCarregando] = useState(false);

  async function carregarCompartilhada() {
    const st = await window.pdv.mesaCompartilhada?.status?.().catch(() => null);
    setCompart({ carregou: true, ...(st || { ativa: false }) });
  }

  async function reload() {
    if (!compart.carregou) return;
    const [list, reservas] = await Promise.all([
      api.table.list({ locationId: window.APP_LOCATION_ID }),
      api.reservation.listVinculadasAtivas({ locationId: window.APP_LOCATION_ID }),
    ]);
    if (remota) {
      // Sem resposta do servidor: continua mostrando a última lista, com o aviso.
      if (!Array.isArray(list)) { setSemServidor(list?.error || 'O servidor das mesas não respondeu.'); return; }
      setSemServidor('');
      setConting(await window.pdv.mesaCompartilhada.contingencia?.().catch(() => null) || null);
      const daqui = await window.pdv.table.list({ locationId: window.APP_LOCATION_ID });
      setMesasDaqui(Array.isArray(daqui) ? daqui.filter((t) => t.status === 'ocupada' && !t.unida_a_mesa_id) : []);
    } else {
      setMesasDaqui([]);
      setSemServidor('');
    }
    if (compart.podeUsar) setPendencias(await window.pdv.mesaCompartilhada.pendencias().catch(() => []) || []);
    setTables(Array.isArray(list) ? list : []);
    const mapa = {};
    (Array.isArray(reservas) ? reservas : []).forEach((r) => { mapa[r.mesa_id] = r; });
    setReservasPorMesa(mapa);
  }

  useEffect(() => { carregarCompartilhada(); }, []);
  useEffect(() => { reload(); }, [compart.carregou, remota]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mesa aberta, pedido, nome ou conta fechada pelo celular (ou no servidor) aparecem na hora.
  useEffect(() => window.pdv.table.onMudou?.((evento) => {
    if (evento?.origem === 'aviso' && evento.mensagem) setAvisoMesas(evento.mensagem);
    if (evento?.origem === 'modo') { carregarCompartilhada(); return; }
    reload();
  }), [compart.carregou, remota]); // eslint-disable-line react-hooks/exhaustive-deps

  async function usarSoAsMesasDaqui() {
    if (!confirm('Usar só as mesas deste caixa?\n\nAs mesas do servidor somem daqui até você voltar. Use só se o servidor estiver desligado: a mesma mesa aberta nos dois computadores vira duas comandas.')) return;
    await window.pdv.mesaCompartilhada.definirModo({ modo: 'local' });
    await carregarCompartilhada();
  }

  async function voltarAsMesasDoServidor() {
    await window.pdv.mesaCompartilhada.definirModo({ modo: 'servidor' });
    await carregarCompartilhada();
  }

  // Cliente pediu pelo celular para mudar de mesa: aprovar ou recusar.
  async function resolverMudanca(m, aprovar, e) {
    e.stopPropagation();
    if (aprovar && !confirm(`${m.tipo === 'todos' ? 'Mudar a mesa toda' : `Levar a conta de ${m.nome || 'cliente'}`} para ${m.para}?`)) return;
    const r = aprovar ? await api.table.aprovarMudanca({ id: m.id }) : await api.table.recusarMudanca({ id: m.id });
    if (r && r.ok === false) alert(r.error);
    reload();
  }

  // Chamado pelo QR (garçom / conta) atendido: some do quadrado.
  async function atenderChamados(table, e) {
    e.stopPropagation();
    const r = await api.table.atenderChamados({ tableId: table.id });
    if (r && r.ok === false) { alert(r.error); return; }
    reload();
  }

  async function destravarMesa(table, e) {
    e.stopPropagation();
    if (!confirm(`Destravar ${table.nome || `Mesa ${table.numero}`}?\n\nEla está sendo paga no ${table.fechando_caixa_nome || 'outro caixa'}. Só destrave se lá desistiram ou o computador desligou: se o ${table.fechando_caixa_nome || 'outro caixa'} já recebeu, a conta seria cobrada duas vezes.`)) return;
    const r = await window.pdv.mesaCompartilhada.destravar({ tableId: table.id });
    if (!r?.ok) return setLoadError(r?.error || 'Não deu para destravar.');
    reload();
  }

  /** Mesa do servidor: traz a conta para receber neste caixa. */
  async function puxarConta(destino) {
    const atual = mesaAberta;
    const r = await window.pdv.mesaCompartilhada.puxar({ tableId: atual.tableId });
    if (!r?.ok) return r || { ok: false, error: 'O servidor não respondeu.' };
    setMesaAberta({ ...atual, saleIdServidor: atual.saleId, saleId: r.saleId, modo: 'fechando', pagarAoAbrir: destino });
    return r;
  }

  /** Desistiu de receber aqui: a mesa volta para o servidor, como estava. */
  async function devolverConta() {
    const atual = mesaAberta;
    const r = await window.pdv.mesaCompartilhada.devolver({ saleId: atual.saleId });
    if (!r?.ok) return r || { ok: false, error: 'Não deu para devolver a mesa.' };
    setMesaAberta({ ...atual, saleId: atual.saleIdServidor, modo: 'remota', pagarAoAbrir: null });
    return r;
  }

  function pedirNumeroPessoas(table) {
    setLoadError('');
    setPessoasInput('2');
    setAbrindoMesa(table);
  }

  async function confirmarAbrirMesa(e) {
    e.preventDefault();
    const result = await api.table.open({
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
      nome: abrindoMesa.nome, pessoas: Number(pessoasInput) || null, modo: remota ? 'remota' : 'local',
    });
    setAbrindoMesa(null);
  }

  async function continuarMesaOcupada(table, { daqui = false } = {}) {
    const base = { tableId: table.id, saleId: table.sale_id, numero: table.numero, nome: table.nome, pessoas: table.pessoas };
    if (remota && !daqui && table.fechando_aqui) {
      // Este caixa já estava recebendo esta conta: continua de onde parou.
      if (table.venda_local_id) {
        setMesaAberta({ ...base, saleIdServidor: table.sale_id, saleId: table.venda_local_id, modo: 'fechando' });
        return;
      }
      const r = await window.pdv.mesaCompartilhada.puxar({ tableId: table.id });
      if (!r?.ok) { setLoadError(r?.error || 'O servidor não respondeu.'); return; }
      setMesaAberta({ ...base, saleIdServidor: table.sale_id, saleId: r.saleId, modo: 'fechando' });
      return;
    }
    setMesaAberta({ ...base, modo: remota && !daqui ? 'remota' : 'local' });
  }

  function handleClickMesa(table) {
    const principal = table.unida_a_mesa_id ? tables.find((t) => t.id === table.unida_a_mesa_id) : table;
    if (principal?.fechando_caixa_id && !principal.fechando_aqui) {
      setLoadError(`${principal.nome || `Mesa ${principal.numero}`} está sendo paga no ${principal.fechando_caixa_nome || 'outro caixa'}. Espere terminar lá.`);
      return;
    }
    setLoadError('');
    if (table.status === 'ocupada') return continuarMesaOcupada(table);
    if (table.status === 'livre' || table.status === 'reservada') return pedirNumeroPessoas(table);
    // aguardando_limpeza: não abre nada, só os botões de ação no card cuidam disso
  }

  // Mesas na ordem da edição; as que chegaram depois (outro caixa cadastrou) vão para o fim.
  const mesasExibidas = organizando
    ? [...tables].sort((a, b) => {
      const ia = ordemEdit.indexOf(a.id);
      const ib = ordemEdit.indexOf(b.id);
      return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    })
    : tables;

  function iniciarOrganizar() {
    setLoadError('');
    setOrdemEdit(tables.map((t) => t.id));
    setOrganizando(true);
  }

  function moverMesa(id, destinoId) {
    if (!destinoId || id === destinoId) return;
    setOrdemEdit((atual) => {
      const base = mesasExibidas.map((t) => t.id);
      const de = base.indexOf(id);
      const para = base.indexOf(destinoId);
      if (de < 0 || para < 0) return atual;
      base.splice(para, 0, base.splice(de, 1)[0]);
      return base;
    });
  }

  function empurrarMesa(id, delta) {
    const base = mesasExibidas.map((t) => t.id);
    const alvo = base[base.indexOf(id) + delta];
    moverMesa(id, alvo);
  }

  async function salvarOrdem() {
    setSalvandoOrdem(true);
    const r = await api.table.reordenar({ locationId: window.APP_LOCATION_ID, ids: mesasExibidas.map((t) => t.id) });
    setSalvandoOrdem(false);
    if (!r?.ok) return setLoadError(r?.error || 'Não foi possível salvar a ordem.');
    setOrganizando(false);
    setAvisoMesas('Ordem das mesas salva.');
    reload();
  }

  async function ordemPorNumero() {
    if (!confirm('Voltar todas as mesas para a ordem por número?')) return;
    setSalvandoOrdem(true);
    const r = await api.table.reordenar({ locationId: window.APP_LOCATION_ID, ids: [] });
    setSalvandoOrdem(false);
    if (!r?.ok) return setLoadError(r?.error || 'Não foi possível restaurar a ordem.');
    setOrganizando(false);
    setAvisoMesas('Mesas na ordem por número.');
    reload();
  }

  async function abrirNovaMesa() {
    setCreateError('');
    setModoNova('varias');
    setShowNew(true);
    const r = await api.table.proximoNumero({ locationId: window.APP_LOCATION_ID });
    if (r?.ok) {
      setInicioMesas(String(r.numero));
      // Mesas excluídas no meio da lista: sugere refazer só esses buracos.
      if (r.buracos > 0) setQtdMesas(String(r.buracos));
    }
  }

  const qtdNum = Number(qtdMesas);
  const inicioNum = Number(inicioMesas);
  const loteValido = Number.isInteger(qtdNum) && qtdNum >= 1 && qtdNum <= 200 && Number.isInteger(inicioNum) && inicioNum >= 1;
  const faixaLote = loteValido ? (qtdNum === 1 ? `a mesa ${inicioNum}` : `as mesas ${inicioNum} a ${inicioNum + qtdNum - 1}`) : '';

  async function handleCriarMesa(e) {
    e.preventDefault();
    setCreateError('');
    if (modoNova === 'varias') {
      if (!loteValido) return setCreateError('Informe de 1 a 200 mesas e o número inicial.');
      setCriando(true);
      const r = await api.table.createLote({ locationId: window.APP_LOCATION_ID, quantidade: qtdNum, inicio: inicioNum });
      setCriando(false);
      if (!r.ok) return setCreateError(r.error);
      const partes = [];
      if (r.criadas.length) {
        partes.push(r.criadas.length === 1
          ? `Mesa ${r.criadas[0]} cadastrada.`
          : `${r.criadas.length} mesas cadastradas (${r.criadas[0]} a ${r.criadas[r.criadas.length - 1]}).`);
      }
      if (r.jaExistiam.length) partes.push(`Já existia${r.jaExistiam.length > 1 ? 'm' : ''}: ${r.jaExistiam.join(', ')}.`);
      setAvisoMesas(partes.join(' ') || 'Nenhuma mesa nova.');
    } else {
      const result = await api.table.create({
        locationId: window.APP_LOCATION_ID, numero: novoNumero, nome: novoNome || undefined,
      });
      if (!result.ok) return setCreateError(result.error);
      setAvisoMesas(`Mesa ${novoNome || novoNumero} cadastrada.`);
      setNovoNumero('');
      setNovoNome('');
    }
    setShowNew(false);
    reload();
  }

  async function handleExcluirMesa(table, e) {
    e.stopPropagation();
    if (!confirm(`Excluir a mesa "${table.nome || table.numero}"?`)) return;
    const result = await api.table.delete({ tableId: table.id });
    if (!result.ok) return setLoadError(result.error);
    reload();
  }

  async function handleMarcarLimpa(table, e) {
    e.stopPropagation();
    const result = await api.table.markCleaned({ tableId: table.id });
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
    const result = await api.table.markReserved({
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
    const result = await api.table.cancelReservation({ tableId: table.id });
    if (!result.ok) return setLoadError(result.error);
    reload();
  }

  async function abrirQrCode(table, e) {
    e.stopPropagation();
    setQrMesa(table);
    setQrDados(null);
    setQrError('');
    setQrCarregando(true);
    const result = await api.table.montarLinkPedido({ tableId: table.id });
    setQrCarregando(false);
    if (!result.ok) return setQrError(result.error);
    setQrDados(result);
  }

  if (mesaAberta) {
    const modo = mesaAberta.modo || 'local';
    return (
      <TableOrderScreen
        key={`${mesaAberta.saleId}-${modo}`}
        tableId={mesaAberta.tableId}
        saleId={mesaAberta.saleId}
        numero={mesaAberta.numero}
        nome={mesaAberta.nome}
        pessoas={mesaAberta.pessoas}
        modo={modo}
        api={modo === 'remota' ? apiDasMesas(true) : window.pdv}
        servidorNome={compart.servidor || null}
        pagarAoAbrir={mesaAberta.pagarAoAbrir || null}
        onPuxar={puxarConta}
        onDevolver={devolverConta}
        onFechar={() => { setMesaAberta(null); reload(); }}
      />
    );
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={20} /> Mesas</h1>
        <div className="mesas-header-acoes">
          {ehGestao && tables.length > 0 && !organizando && !remota && (
            <button type="button" className="btn-secondary" onClick={() => setQrPdf({ mesaInicial: null })}><Icon name="mobile" size={15} /> QR das mesas</button>
          )}
          {ehGestao && tables.length > 1 && !organizando && (
            <button type="button" className="btn-secondary" onClick={iniciarOrganizar}>Organizar</button>
          )}
          <button className="btn-primary" onClick={abrirNovaMesa} disabled={organizando}><Icon name="add" size={15} /> Cadastrar mesas</button>
        </div>
      </div>
      {organizando && (
        <div className="mesas-organizar-barra" role="status">
          <span>Arraste as mesas (ou use as setas) para mudar a ordem. Fica igual nos dois PDVs.</span>
          <span className="mesas-organizar-botoes">
            <button type="button" className="btn-link" onClick={ordemPorNumero} disabled={salvandoOrdem}>Voltar à ordem por número</button>
            <button type="button" className="btn-secondary" onClick={() => setOrganizando(false)} disabled={salvandoOrdem}>Cancelar</button>
            <button type="button" className="btn-primary" onClick={salvarOrdem} disabled={salvandoOrdem}>{salvandoOrdem ? 'Salvando...' : 'Salvar ordem'}</button>
          </span>
        </div>
      )}
      <p className="screen-hint">
        Clique numa mesa livre ou reservada pra abrir uma comanda (informando quantas pessoas —
        usado só pra calcular quanto fica por pessoa na hora de dividir a conta). Clique numa mesa
        ocupada pra continuar lançando itens ou fechar a conta.
      </p>
      {remota && !semServidor && !tables.some((t) => t.offline) && (
        <p className="mesa-compartilhada-aviso" role="status">
          <Icon name="link" size={14} /> Mesas do servidor{compart.servidor ? ` (${compart.servidor})` : ''}: as mesmas nos dois computadores.
          Quem fecha a conta recebe no próprio caixa.
        </p>
      )}
      {remota && !semServidor && (tables.some((t) => t.offline) || conting?.pendentes > 0) && (
        <div className="io-message-aviso mesa-contingencia" role="status">
          <p style={{ margin: 0 }}>
            <strong>{tables.some((t) => t.offline) ? 'Servidor das mesas fora do ar: vendendo pela cópia deste caixa.' : 'Enviando ao servidor o que foi feito sem ele...'}</strong>
            {' '}Dá para abrir mesa, lançar, receber, limpar e abrir de novo.
            {conting?.pendentes > 0 && ` ${conting.pendentes} operação(ões) esperando o servidor (vão sozinhas, na ordem).`}
            {conting?.copiaDe && ` Cópia de ${new Date(`${String(conting.copiaDe).replace(' ', 'T')}Z`).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`}
          </p>
          <button type="button" className="btn-secondary" onClick={async () => { await window.pdv.mesaCompartilhada.enviarFila(); reload(); }}>Enviar agora</button>
        </div>
      )}
      {remota && conting?.erros?.length > 0 && (
        <div className="modal-error mesa-contingencia-erros" role="alert">
          <p style={{ margin: '0 0 4px' }}><strong>O servidor recusou {conting.erros.length} operação(ões) feitas sem ele.</strong> Confira na mesa e lance de novo se precisar:</p>
          <ul style={{ margin: '0 0 6px 18px', padding: 0 }}>
            {conting.erros.slice(0, 6).map((e) => <li key={e.id}>{e.mesa_rotulo || 'Mesa'} — {e.erro}</li>)}
          </ul>
          {ehGestao && <button type="button" className="btn-secondary" onClick={async () => { await window.pdv.mesaCompartilhada.descartarErrosContingencia(); reload(); }}>Conferi</button>}
        </div>
      )}
      {remota && semServidor && (
        <div className="modal-error mesa-compartilhada-sem-servidor" role="alert">
          <p><strong>Sem conexão com o servidor das mesas.</strong> {semServidor}</p>
          <div className="mesa-compartilhada-acoes">
            <button type="button" className="btn-secondary" onClick={reload}>Tentar de novo</button>
            <button type="button" className="btn-link" onClick={usarSoAsMesasDaqui}>Usar só as mesas deste caixa</button>
          </div>
        </div>
      )}
      {compart.carregou && !remota && compart.motivo === 'servidor' && (
        <p className={`mesa-compartilhada-aviso${compart.redeLocalLigada && compart.caixas?.length ? '' : ' mesas-aviso-alerta'}`} role="status">
          <Icon name="link" size={14} />{' '}
          {!compart.redeLocalLigada
            ? 'Este computador é o servidor das mesas, mas a rede local está desligada aqui: os caixas não conseguem usar estas mesas. Veja Configurações → Sincronização → Rede local da loja.'
            : compart.caixas?.length
              ? `Este computador é o servidor das mesas: ${compart.caixas.length} ${compart.caixas.length === 1 ? 'caixa ligado' : 'caixas ligados'} pela rede local (${compart.caixas.map((c) => c.nome).join(', ')}).`
              : 'Este computador é o servidor das mesas, mas nenhum caixa está ligado a ele pela rede local. Gere o código em Configurações → Sincronização → Rede local da loja.'}
        </p>
      )}
      {compart.carregou && !remota && compart.motivo === 'sem_rede_local' && (
        <p className="mesa-compartilhada-aviso mesas-aviso-alerta" role="status">
          Estas são só as mesas deste caixa: ele não está ligado ao servidor pela rede local. Digite o código do servidor em Configurações → Sincronização → Rede local da loja.
        </p>
      )}
      {compart.carregou && !remota && compart.motivo === 'sem_grupo' && (
        <p className="mesa-compartilhada-aviso mesas-aviso-alerta" role="status">
          Estas são só as mesas deste computador: ele não está em um grupo de PDVs (sincronização desligada). Peça ao suporte para vincular na Central.
        </p>
      )}
      {compart.podeUsar && !remota && (
        <p className="io-message mesas-aviso">
          Este caixa está usando só as mesas dele.{' '}
          <button type="button" className="btn-link" onClick={voltarAsMesasDoServidor}>Voltar a usar as mesas do servidor</button>
        </p>
      )}
      {pendencias.length > 0 && (
        <p className="io-message mesas-aviso" role="status">
          Avisando o servidor que {pendencias.map((p) => p.mesa_rotulo).join(', ')} {pendencias.length > 1 ? 'foram pagas' : 'foi paga'} aqui
          {pendencias.some((p) => p.tentativas > 0) ? ' (o servidor ainda não respondeu; a mesa fica travada lá até ele confirmar)' : ''}...
        </p>
      )}
      {loadError && <p className="modal-error">{loadError}</p>}
      {avisoMesas && <p className="io-message mesas-aviso" role="status">{avisoMesas}</p>}

      {remota && mesasDaqui.length > 0 && (
        <div className="mesas-daqui">
          <h2>Abertas só neste caixa</h2>
          <p className="screen-hint">Comandas abertas aqui antes de usar as mesas do servidor. Feche-as normalmente.</p>
          <div className="tables-grid">
            {mesasDaqui.map((t) => (
              <div key={t.id} className="table-card table-card-ocupada" onClick={() => continuarMesaOcupada(t, { daqui: true })}>
                <span className="table-card-numero">{t.nome || `Mesa ${t.numero}`}</span>
                <span className="table-card-status">Ocupada — R$ {(t.total_atual || 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tables.length === 0 ? (
        <div className="empty-state mesas-vazio">
          <p>Nenhuma mesa cadastrada ainda.</p>
          <button type="button" className="btn-primary" onClick={abrirNovaMesa}><Icon name="add" size={15} /> Cadastrar mesas</button>
        </div>
      ) : (
        <div className="tables-grid">
          {mesasExibidas.map((t, pos) => {
            if (organizando) {
              return (
                <div
                  key={t.id}
                  className={`table-card table-card-${t.status} table-card-organizar${arrastando === t.id ? ' table-card-arrastando' : ''}`}
                  draggable
                  onDragStart={(e) => { setArrastando(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={(e) => { e.preventDefault(); moverMesa(arrastando, t.id); setArrastando(null); }}
                  onDragEnd={() => setArrastando(null)}
                >
                  <Icon name="grip" size={14} />
                  <span className="table-card-numero">{t.nome || `Mesa ${t.numero}`}</span>
                  <span className="table-card-organizar-setas">
                    <button type="button" className="table-card-action" aria-label="Mover para antes" disabled={pos === 0} onClick={() => empurrarMesa(t.id, -1)}>&larr;</button>
                    <button type="button" className="table-card-action" aria-label="Mover para depois" disabled={pos === mesasExibidas.length - 1} onClick={() => empurrarMesa(t.id, 1)}>&rarr;</button>
                  </span>
                </div>
              );
            }
            const tempo = t.status === 'ocupada' ? tempoOcupada(t.aberta_em) : null;
            return (
            <div
              key={t.id}
              className={`table-card table-card-${t.status}${t.unida_a_mesa_id ? ' table-card-unida' : ''}`}
              onClick={() => handleClickMesa(t)}
            >
              <span className="table-card-numero">{t.nome || `Mesa ${t.numero}`}</span>
              <IndicadoresDaMesa ind={t.indicadores} onAtender={(e) => atenderChamados(t, e)} onMudanca={resolverMudanca} />
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
              {t.status === 'ocupada' && t.unida_a_mesa_id && (
                <span className="table-card-status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="link" size={13} /> Unida à {t.unida_a_nome || `Mesa ${t.unida_a_numero}`}
                </span>
              )}
              {t.status === 'ocupada' && !t.unida_a_mesa_id && t.fechando_caixa_id && (
                <span className={`table-card-pagando${t.fechando_aqui ? ' table-card-pagando-aqui' : ''}`}>
                  <Icon name="cash" size={13} /> {t.fechando_aqui ? 'Recebendo neste caixa' : `Pagando no ${t.fechando_caixa_nome || 'outro caixa'}`}
                  {!remota && ehGestao && (
                    <button type="button" className="table-card-action" onClick={(e) => destravarMesa(t, e)}>Destravar</button>
                  )}
                </span>
              )}
              {t.status === 'ocupada' && !t.unida_a_mesa_id && (
                <span className="table-card-status">
                  {t.mesas_unidas && <><strong>Com Mesa {t.mesas_unidas}</strong><br /></>}
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
                    {t.reservado_para && <><br />{dataDaReserva(t.reservado_para)}</>}
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
          <form className="modal-card mesas-cadastro" onSubmit={handleCriarMesa}>
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={18} /> Cadastrar mesas</h2>
            <div className="chips-categorias mesas-modo" role="tablist" aria-label="Como cadastrar">
              <button type="button" role="tab" aria-selected={modoNova === 'varias'} className={modoNova === 'varias' ? 'ativo' : ''}
                onClick={() => { setModoNova('varias'); setCreateError(''); }}>Várias de uma vez</button>
              <button type="button" role="tab" aria-selected={modoNova === 'uma'} className={modoNova === 'uma' ? 'ativo' : ''}
                onClick={() => { setModoNova('uma'); setCreateError(''); }}>Uma mesa, com nome</button>
            </div>

            {modoNova === 'varias' ? (
              <>
                <label>Quantas mesas?
                  <input type="number" inputMode="numeric" min="1" max="200" step="1" value={qtdMesas}
                    onChange={(e) => setQtdMesas(e.target.value)} required autoFocus data-teclado-enviar={loteValido ? `Cadastrar ${qtdNum}` : undefined} />
                </label>
                <div className="chips-categorias mesas-atalhos" aria-label="Quantidades comuns">
                  {[5, 10, 15, 20, 30].map((n) => (
                    <button type="button" key={n} className={qtdNum === n ? 'ativo' : ''} onClick={() => setQtdMesas(String(n))}>{n}</button>
                  ))}
                </div>
                <label>Começando do número
                  <input type="number" inputMode="numeric" min="1" step="1" value={inicioMesas} onChange={(e) => setInicioMesas(e.target.value)} required />
                </label>
                <p className="screen-hint mesas-previa">
                  {loteValido ? <>Vai cadastrar <strong>{faixaLote}</strong>. Número que já existe é pulado.</> : 'Informe de 1 a 200 mesas.'}
                </p>
              </>
            ) : (
              <>
                <label>Número
                  <input value={novoNumero} onChange={(e) => setNovoNumero(e.target.value)} required autoFocus />
                </label>
                <label>Nome (opcional)
                  <input value={novoNome} onChange={(e) => setNovoNome(e.target.value)} placeholder="Ex: Varanda, Mesa do fundo..." />
                </label>
              </>
            )}
            {createError && <p className="modal-error">{createError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowNew(false)}><Icon name="close" size={15} /> Cancelar</button>
              <button type="submit" className="btn-primary" disabled={criando || (modoNova === 'varias' && !loteValido)}>
                <Icon name="add" size={15} /> {modoNova === 'varias' ? (loteValido ? `Cadastrar ${qtdNum} mesa${qtdNum > 1 ? 's' : ''}` : 'Cadastrar') : 'Cadastrar'}
              </button>
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
      {qrPdf && <QrMesasPdfModal mesaInicial={qrPdf.mesaInicial} onFechar={() => setQrPdf(null)} />}
      {qrMesa && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="mobile" size={18} /> QR do cardápio — {qrMesa.nome || `Mesa ${qrMesa.numero}`}</h2>
            <p className="screen-hint" style={{ margin: '0 0 8px' }}>
              {qrDados?.vitrine
                ? <>Imprima e cole na mesa: o QR abre a vitrine só desta mesa. O cliente escolhe, informa o nome e o pedido chega no caixa já com a {qrMesa.nome || `Mesa ${qrMesa.numero}`}.</>
                : <>Imprima e cole na mesa: o cliente escaneia, o WhatsApp já abre com "Mesa {qrMesa.numero}" preenchido, e o pedido feito por ali cai direto nessa comanda pra alguém confirmar.</>}
            </p>
            {qrCarregando && <p className="empty-state">Gerando...</p>}
            {qrError && <p className="modal-error">{qrError}</p>}
            {qrDados && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
                  {qrDados.qrCodeDataUrl && (
                    <figure className="qr-mesa-fig">
                      <img
                        src={qrDados.qrCodeDataUrl} alt={`QR code de pedido da Mesa ${qrMesa.numero}`}
                        style={{ width: qrDados.qrInternetDataUrl ? 180 : 220, height: qrDados.qrInternetDataUrl ? 180 : 220, borderRadius: 8, border: '1px solid var(--color-border)' }}
                      />
                      {qrDados.qrInternetDataUrl && <figcaption>Na loja (Wi-Fi)</figcaption>}
                    </figure>
                  )}
                  {qrDados.qrInternetDataUrl && (
                    <figure className="qr-mesa-fig">
                      <img
                        src={qrDados.qrInternetDataUrl} alt={`QR code da Mesa ${qrMesa.numero} pela internet`}
                        style={{ width: 180, height: 180, borderRadius: 8, border: '1px solid var(--color-border)' }}
                      />
                      <figcaption>Sem Wi-Fi (internet do cliente)</figcaption>
                    </figure>
                  )}
                </div>
                <button type="button" className="btn-secondary" onClick={() => window.open(qrDados.url, '_blank')}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="link" size={14} /> Abrir o link</span>
                </button>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)', wordBreak: 'break-all', textAlign: 'center' }}>
                  {qrDados.url}
                </span>
              </div>
            )}
            <div className="modal-actions">
              {qrDados?.vitrine && ehGestao && (
                <button type="button" className="btn-secondary" onClick={async () => {
                  if (!confirm(`Trocar o QR da ${qrMesa.nome || `Mesa ${qrMesa.numero}`}? O QR impresso hoje para de funcionar.`)) return;
                  const r = await window.pdv.vitrine.trocarQrDaMesa({ tableId: qrMesa.id });
                  if (!r?.ok) return setQrError(r?.error || 'Não consegui trocar o QR.');
                  abrirQrCode(qrMesa, { stopPropagation: () => {} });
                }}><Icon name="refresh" size={15} /> Trocar QR</button>
              )}
              {qrDados?.vitrine && ehGestao && (
                <button type="button" className="btn-primary" onClick={() => { setQrPdf({ mesaInicial: qrMesa.id }); setQrMesa(null); }}>
                  <Icon name="printer" size={15} /> Imprimir / PDF
                </button>
              )}
              <button type="button" className="btn-secondary" onClick={() => setQrMesa(null)}><Icon name="close" size={15} /> Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>

  );
}

/** Indicadores do QR no quadrado da mesa: chamados (garçom/conta), pedidos esperando e celulares na mesa. */
function IndicadoresDaMesa({ ind, onAtender, onMudanca }) {
  if (!ind || (!ind.chamados?.length && !ind.pedidosEsperando && !ind.noQr && !ind.mudancas?.length && !ind.chegando?.length)) return null;
  const garcom = ind.chamados?.filter((c) => c.tipo === 'garcom') || [];
  const conta = ind.chamados?.filter((c) => c.tipo === 'conta') || [];
  const quem = (lista) => [...new Set(lista.map((c) => c.nome).filter(Boolean))].join(', ');
  return (
    <div className="mesa-indicadores">
      {conta.length > 0 && (
        <span className="mesa-ind mesa-ind-conta" title={`Pediu a conta: ${quem(conta)}`}>
          <Icon name="cash" size={13} /> Pediu a conta{quem(conta) ? ` · ${quem(conta)}` : ''}
        </span>
      )}
      {garcom.length > 0 && (
        <span className="mesa-ind mesa-ind-garcom" title={`Chamando o garçom: ${quem(garcom)}`}>
          <Icon name="chat" size={13} /> Chamando o garçom{quem(garcom) ? ` · ${quem(garcom)}` : ''}
        </span>
      )}
      {(conta.length > 0 || garcom.length > 0) && (
        <button type="button" className="mesa-ind-atender" onClick={onAtender}><Icon name="checkCircle" size={13} /> Atendido</button>
      )}
      {(ind.mudancas || []).map((m) => (
        <span key={m.id} className="mesa-ind mesa-ind-mudanca" title="Pedido pelo celular: o caixa aprova">
          <Icon name="refresh" size={13} /> {m.tipo === 'todos' ? `Mesa toda quer ir p/ ${m.para}` : `${m.nome || 'Cliente'} quer ir p/ ${m.para}`}
          <button type="button" className="mesa-ind-sim" onClick={(e) => onMudanca(m, true, e)}>Aprovar</button>
          <button type="button" className="mesa-ind-nao" onClick={(e) => onMudanca(m, false, e)} aria-label="Recusar a mudança">Recusar</button>
        </span>
      ))}
      {(ind.chegando || []).map((m) => (
        <span key={m.id} className="mesa-ind mesa-ind-qr" title="Pedido de mudança esperando o caixa aprovar">
          <Icon name="refresh" size={13} /> Chegando: {m.tipo === 'todos' ? `mesa toda do ${m.de}` : `${m.nome || 'cliente'} (do ${m.de})`}
        </span>
      ))}
      {ind.pedidosEsperando > 0 && (
        <span className="mesa-ind mesa-ind-pedido" title="Pedido do QR esperando o atendente confirmar (Separação)">
          <Icon name="plate" size={13} /> {ind.pedidosEsperando === 1 ? '1 pedido esperando' : `${ind.pedidosEsperando} pedidos esperando`}
        </span>
      )}
      {ind.noQr > 0 && (
        <span className="mesa-ind mesa-ind-qr" title="Celulares que entraram nesta mesa pelo QR">
          <Icon name="mobile" size={13} /> {ind.noQr} no QR
        </span>
      )}
    </div>
  );
}
