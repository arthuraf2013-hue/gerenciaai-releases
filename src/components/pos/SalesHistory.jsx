import { useEffect, useState } from 'react';

const STATUS_LABEL = {
  aberta: 'Em aberto',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

const METODO_LABEL = {
  dinheiro: 'Dinheiro', cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito',
  pix: 'Pix', fiado: 'Fiado', outro: 'Outro',
};

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function formatMetodos(str) {
  if (!str) return '—';
  return str.split(',').map((m) => METODO_LABEL[m] || m).join(', ');
}

export function SalesHistory() {
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('hoje'); // 'hoje' | 'semana' | 'mes' | 'personalizado'
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [sales, setSales] = useState([]);
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  useEffect(() => {
    window.pdv.time.getStatus().then((s) => setOffsetMs(s.offsetMs || 0));
  }, []);

  // Recalcula o intervalo de datas sempre que o período muda (usando o
  // relógio sincronizado, não o relógio cru do sistema).
  useEffect(() => {
    const now = new Date(Date.now() + offsetMs);
    if (periodo === 'hoje') {
      setDataInicio(toISODate(now));
      setDataFim(toISODate(now));
    } else if (periodo === 'semana') {
      const diaSemana = now.getDay() === 0 ? 7 : now.getDay(); // segunda = 1 ... domingo = 7
      const inicioSemana = new Date(now);
      inicioSemana.setDate(now.getDate() - (diaSemana - 1));
      setDataInicio(toISODate(inicioSemana));
      setDataFim(toISODate(now));
    } else if (periodo === 'mes') {
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
      setDataInicio(toISODate(inicioMes));
      setDataFim(toISODate(now));
    }
    // 'personalizado' não mexe nas datas — o usuário escolhe manualmente
  }, [periodo, offsetMs]);

  useEffect(() => {
    if (!dataInicio || !dataFim) return;
    window.pdv.sale.listByRange({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then((list) => {
      setSales(Array.isArray(list) ? list : []);
    });
  }, [dataInicio, dataFim]);

  async function handleExport() {
    setExportando(true);
    setExportMsg('');
    const result = await window.pdv.report.exportSales({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim });
    setExportando(false);
    if (result.canceled) return;
    setExportMsg(result.ok
      ? `Relatório exportado: ${result.total} venda(s), R$ ${result.totalFinalizado.toFixed(2)} finalizado no período.`
      : result.error);
  }

  const totalDia = sales
    .filter((s) => s.status === 'finalizada')
    .reduce((acc, s) => acc + s.total, 0);

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Histórico</h1>
        <strong>Total finalizado: R$ {totalDia.toFixed(2)}</strong>
      </div>

      <div className="period-selector">
        {['hoje', 'semana', 'mes', 'personalizado'].map((p) => (
          <button
            key={p}
            className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'}
            onClick={() => setPeriodo(p)}
          >
            {p === 'hoje' ? 'Hoje' : p === 'semana' ? 'Esta semana' : p === 'mes' ? 'Este mês' : 'Personalizado'}
          </button>
        ))}

        {periodo === 'personalizado' && (
          <>
            <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
            <span>até</span>
            <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
          </>
        )}

        <button className="btn-secondary" onClick={handleExport} disabled={exportando} style={{ marginLeft: 'auto' }}>
          {exportando ? 'Exportando...' : 'Exportar relatório'}
        </button>
      </div>

      {exportMsg && <p className="io-message">{exportMsg}</p>}

      {sales.length === 0 ? (
        <p className="empty-state">Nenhuma venda nesse período.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Data/hora</th><th>Operador</th><th>Itens</th><th>Total</th><th>Pagamento</th><th>Status</th></tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className={s.status === 'cancelada' ? 'row-critical' : ''}>
                <td>{new Date(s.data_efetiva + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}</td>
                <td>{s.operador_nome}</td>
                <td>{s.total_itens}</td>
                <td>R$ {s.total.toFixed(2)}</td>
                <td>{formatMetodos(s.metodos_pagamento)}</td>
                <td>{STATUS_LABEL[s.status] || s.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
