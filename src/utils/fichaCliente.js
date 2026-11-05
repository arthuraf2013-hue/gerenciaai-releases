/**
 * Formatação e período da Ficha do cliente (FichaClienteModal.jsx).
 * Sem React aqui, para os testes (tests/fichaClienteFormato.test.js).
 */
import { toISODate } from './date';

const FUSO = 'America/Sao_Paulo';

export const PERIODOS = [
  { chave: 'tudo', rotulo: 'Tudo' },
  { chave: 'hoje', rotulo: 'Hoje' },
  { chave: 'semana', rotulo: 'Esta semana' },
  { chave: 'mes', rotulo: 'Este mês' },
  { chave: 'personalizado', rotulo: 'Personalizado' },
];

/** Mesmas regras do Histórico (SalesHistory.jsx): semana começa na segunda,
 * dia no fuso de São Paulo. 'tudo' = sem datas; 'personalizado' não mexe. */
export function intervaloDoPeriodo(periodo, agora) {
  if (periodo === 'tudo') return { dataInicio: '', dataFim: '' };
  if (periodo === 'hoje') return { dataInicio: toISODate(agora), dataFim: toISODate(agora) };
  if (periodo === 'semana') {
    // Dia da semana no fuso de São Paulo (não no da máquina).
    const hojeSp = new Date(`${toISODate(agora)}T12:00:00Z`);
    const diaSemana = hojeSp.getUTCDay() === 0 ? 7 : hojeSp.getUTCDay();
    const inicio = new Date(hojeSp.getTime() - (diaSemana - 1) * 86400000);
    return { dataInicio: inicio.toISOString().slice(0, 10), dataFim: toISODate(agora) };
  }
  if (periodo === 'mes') {
    const hoje = toISODate(agora);
    return { dataInicio: `${hoje.slice(0, 8)}01`, dataFim: hoje };
  }
  return null;
}

/** 'AAAA-MM-DD HH:MM:SS' (UTC, como o banco grava) -> "05/11/2026 14:30". */
export function dataHora(utc) {
  if (!utc) return '—';
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: FUSO });
}

/** Só a data (UTC do banco -> dia em São Paulo). */
export function dataDoBanco(utc) {
  if (!utc) return '—';
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: FUSO });
}

/** 'AAAA-MM-DD' (data de calendário, sem fuso) -> "05/11/2026". */
export function dataCalendario(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

export function moeda(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const FRACIONADAS = ['kg', 'g', 'l', 'ml', 'm', 'm²', 'm³'];

export function quantidade(q, unidade = 'un') {
  const n = Number(q) || 0;
  if (FRACIONADAS.includes(unidade)) {
    return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${unidade}`;
  }
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Valor de uma especificação, pelo tipo do campo do perfil. */
export function valorDaEspecificacao(e) {
  if (e.tipo === 'boolean') return e.valor ? 'Sim' : 'Não';
  if (e.tipo === 'data') return dataCalendario(e.valor);
  if (e.tipo === 'numero' && Number.isFinite(Number(e.valor))) return Number(e.valor).toLocaleString('pt-BR');
  return String(e.valor);
}

/** Dioptria da receita: "+1,25", "-2,50", "0,00"; vazio = "—". */
export function dioptria(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const texto = Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n > 0 ? `+${texto}` : n < 0 ? `-${texto}` : texto;
}

export function eixo(v) {
  return v == null || v === '' ? '—' : `${v}°`;
}

/** Receita da ótica que valia no dia da compra: a mais nova com data até o dia. */
export function receitaDaCompra(receitas, finalizadaEmUtc) {
  if (!Array.isArray(receitas) || !finalizadaEmUtc) return null;
  const d = new Date(`${String(finalizadaEmUtc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dia = toISODate(d);
  return receitas
    .filter((r) => r.dataReceita && r.dataReceita <= dia)
    .sort((a, b) => (a.dataReceita < b.dataReceita ? 1 : -1))[0] || null;
}

/** Hora LOCAL gravada como texto (agenda do salão, reservas): 'AAAA-MM-DD HH:MM[:SS]' -> "12/11/2026 14:00". */
export function dataHoraLocal(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(texto || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : dataCalendario(texto);
}

export const STATUS_AGENDA = {
  agendado: 'Agendado', confirmado: 'Confirmado', concluido: 'Concluído', cancelado: 'Cancelado', faltou: 'Faltou',
};
export const STATUS_ORCAMENTO = { aberto: 'Em aberto', convertido: 'Virou venda', cancelado: 'Cancelado' };
export const STATUS_ENTREGA = { pendente: 'Pendente', em_rota: 'Saiu para entrega', entregue: 'Entregue', cancelada: 'Cancelada' };
export const STATUS_RESERVA = {
  pendente: 'Pendente', aguardando_confirmacao: 'Aguardando confirmação', confirmada: 'Confirmada',
  cancelada: 'Cancelada', nao_confirmada: 'Não confirmada', concluida: 'Compareceu',
};
export const SITUACAO_PET = { atrasada: 'atrasada', proxima: 'nos próximos 7 dias', em_dia: 'em dia' };

/** Seções da ficha: as do perfil vêm primeiro e aparecem mesmo vazias; as
 * outras só quando o cliente tem algo nelas. */
const SECOES_DO_PERFIL = {
  otica: ['receitas'],
  petshop: ['pets'],
  salao_beleza: ['agenda'],
  restaurante: ['reservas'],
  padaria: ['reservas'],
  material_construcao: ['orcamentos'],
  vestuario: ['preferencias'],
  armazem: ['fiado'],
};

export function secoesDaFicha(ficha) {
  if (!ficha) return { antes: [], depois: [] };
  const temDado = {
    receitas: (ficha.receitas || []).length > 0,
    pets: (ficha.pets || []).length > 0,
    agenda: (ficha.agenda?.proximos || []).length + (ficha.agenda?.historico || []).length > 0,
    reservas: (ficha.reservas || []).length > 0,
    orcamentos: (ficha.orcamentos || []).length > 0,
    preferencias: (ficha.preferencias || []).length > 0,
    fiado: (ficha.fiado || []).length > 0 || (ficha.cliente?.saldoFiado || 0) > 0,
    entregas: (ficha.entregas?.lista || []).length > 0,
  };
  const doPerfil = SECOES_DO_PERFIL[ficha.perfil?.id] || [];
  const antes = doPerfil.filter((s) => s !== 'reservas' || ficha.cliente?.telefone || temDado.reservas);
  const ordem = ['receitas', 'pets', 'agenda', 'preferencias', 'orcamentos', 'reservas', 'entregas', 'fiado'];
  const depois = ordem.filter((s) => !antes.includes(s) && temDado[s]);
  return { antes, depois };
}
