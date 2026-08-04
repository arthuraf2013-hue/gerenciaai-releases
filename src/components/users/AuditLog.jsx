import { useEffect, useState } from 'react';
import { toISODate } from '../../utils/date';

const TIPO_LABEL = {
  cancelamento_item: 'Cancelamento de item',
  cancelamento_venda: 'Cancelamento de venda',
  devolucao: 'Devolução',
  desconto_manual: 'Desconto manual',
  ajuste_estoque: 'Ajuste de estoque',
  preco_item_alterado: 'Preço de item alterado',
  historico_venda_editado: 'Histórico de venda editado',
  produtos_mesclados: 'Produtos duplicados mesclados',
};

export function AuditLog() {
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('semana');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [eventos, setEventos] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  async function handleExport() {
    setExportando(true);
    setExportMsg('');
    const result = await window.pdv.report.exportAudit({ dataInicio, dataFim });
    setExportando(false);
    if (result.canceled) return;
    setExportMsg(result.ok ? `${result.total} evento(s) exportado(s) com sucesso.` : `Erro: ${result.error}`);
  }

  useEffect(() => {
    window.pdv.time.getStatus().then((s) => setOffsetMs(s.offsetMs || 0));
  }, []);

  useEffect(() => {
    const now = new Date(Date.now() + offsetMs);
    if (periodo === 'hoje') {
      setDataInicio(toISODate(now)); setDataFim(toISODate(now));
    } else if (periodo === 'semana') {
      const inicio = new Date(now); inicio.setDate(now.getDate() - 6);
      setDataInicio(toISODate(inicio)); setDataFim(toISODate(now));
    } else if (periodo === 'mes') {
      const inicio = new Date(now.getFullYear(), now.getMonth(), 1);
      setDataInicio(toISODate(inicio)); setDataFim(toISODate(now));
    }
  }, [periodo, offsetMs]);

  useEffect(() => {
    if (!dataInicio || !dataFim) return;
    window.pdv.auth.listAuditLog({ dataInicio, dataFim }).then((list) => {
      if (!Array.isArray(list)) {
        setEventos([]);
        setLoadError(list?.error || 'Não foi possível carregar a auditoria.');
        return;
      }
      setLoadError('');
      setEventos(list);
    });
  }, [dataInicio, dataFim]);

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Auditoria</h1>
        <button className="btn-secondary" onClick={handleExport} disabled={exportando || eventos.length === 0}>
          {exportando ? 'Exportando...' : 'Exportar planilha'}
        </button>
      </div>
      <p className="screen-hint">
        Toda tentativa de cancelamento, devolução ou desconto manual — aprovada ou negada.
      </p>

      <div className="period-selector">
        {['hoje', 'semana', 'mes'].map((p) => (
          <button key={p} className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(p)}>
            {p === 'hoje' ? 'Hoje' : p === 'semana' ? 'Últimos 7 dias' : 'Este mês'}
          </button>
        ))}
      </div>

      {exportMsg && <p className={exportMsg.startsWith('Erro') ? 'modal-error' : 'io-message'}>{exportMsg}</p>}
      {loadError && <p className="modal-error">{loadError}</p>}

      {eventos.length === 0 ? (
        <p className="empty-state">Nenhum evento de auditoria nesse período.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Data/hora</th><th>Tipo</th><th>Solicitante</th><th>Autorizado por</th><th>Motivo</th><th>Resultado</th></tr>
          </thead>
          <tbody>
            {eventos.map((e) => (
              <tr key={e.id} className={e.sucesso ? '' : 'row-critical'}>
                <td>{new Date(e.criado_em + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}</td>
                <td>{TIPO_LABEL[e.tipo_evento] || e.tipo_evento}</td>
                <td>{e.solicitante_nome || '—'}</td>
                <td>{e.autorizado_por_nome || '—'}</td>
                <td>{e.motivo || '—'}</td>
                <td>{e.sucesso ? 'Aprovado' : 'Negado'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
