import { useEffect, useState } from 'react';
import { toISODate } from '../../utils/date';

export function CashReport() {
  const [periodo, setPeriodo] = useState('semana');
  const [sessoes, setSessoes] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [loadError, setLoadError] = useState('');

  function datasDoPeriodo() {
    const hoje = new Date();
    const dataFim = toISODate(hoje);
    const inicio = new Date(hoje);
    if (periodo === 'semana') inicio.setDate(inicio.getDate() - 7);
    if (periodo === 'mes') inicio.setDate(inicio.getDate() - 30);
    const dataInicio = periodo === 'hoje' ? dataFim : toISODate(inicio);
    return { dataInicio, dataFim };
  }

  async function reload() {
    const { dataInicio, dataFim } = datasDoPeriodo();
    const locationId = window.APP_LOCATION_ID;
    const [list, sum] = await Promise.all([
      window.pdv.cash.listClosedSessions({ locationId, dataInicio, dataFim }),
      window.pdv.cash.getClosedSessionsSummary({ locationId, dataInicio, dataFim }),
    ]);
    if (!Array.isArray(list)) {
      setLoadError('Não foi possível carregar os fechamentos.');
      return;
    }
    setLoadError('');
    setSessoes(list);
    setResumo(sum);
  }

  useEffect(() => { reload(); }, [periodo]);

  return (
    <div className="screen">
      <h1>Fechamentos de caixa</h1>
      <p className="screen-hint">
        Relatório consolidado — todos os fechamentos do período, pra conferir diferenças ao longo
        do tempo em vez de só sessão por sessão.
      </p>

      <div className="period-selector">
        {['hoje', 'semana', 'mes'].map((p) => (
          <button key={p} className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(p)}>
            {p === 'hoje' ? 'Hoje' : p === 'semana' ? 'Últimos 7 dias' : 'Últimos 30 dias'}
          </button>
        ))}
      </div>

      {resumo && (
        <p className="screen-hint" style={{ fontSize: 15 }}>
          <strong>{resumo.total_sessoes}</strong> fechamento(s) —{' '}
          <strong>{resumo.sessoes_certas}</strong> bateram certo,{' '}
          <strong className={resumo.sessoes_com_diferenca > 0 ? 'text-danger' : ''}>{resumo.sessoes_com_diferenca}</strong> com diferença —{' '}
          soma das diferenças:{' '}
          <strong className={resumo.soma_diferencas !== 0 ? 'text-danger' : ''}>
            {resumo.soma_diferencas >= 0 ? '+' : ''}R$ {resumo.soma_diferencas.toFixed(2)}
          </strong>
        </p>
      )}

      {loadError && <p className="modal-error">{loadError}</p>}

      {sessoes.length === 0 ? (
        <p className="empty-state">Nenhum fechamento nesse período.</p>
      ) : (
      <table className="data-table">
        <thead>
          <tr><th>Fechado em</th><th>Abriu</th><th>Fechou</th><th>Esperado</th><th>Informado</th><th>Diferença</th></tr>
        </thead>
        <tbody>
          {sessoes.map((s) => (
            <tr key={s.id} className={s.diferenca !== 0 ? 'row-warning' : ''}>
              <td>{new Date(s.fechada_em + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}</td>
              <td>{s.operador_abertura_nome}</td>
              <td>{s.operador_fechamento_nome || '—'}</td>
              <td>R$ {s.valor_fechamento_esperado.toFixed(2)}</td>
              <td>R$ {s.valor_fechamento_informado.toFixed(2)}</td>
              <td className={s.diferenca !== 0 ? 'text-danger' : ''}>
                {s.diferenca >= 0 ? '+' : ''}R$ {s.diferenca.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}
