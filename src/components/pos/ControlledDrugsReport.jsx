import { useEffect, useState } from 'react';
import { toISODate } from '../../utils/date';
import Icon from '../common/Icon';

export function ControlledDrugsReport() {
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('mes');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [linhas, setLinhas] = useState(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    window.pdv.time.getStatus().then((s) => setOffsetMs(s.offsetMs || 0));
  }, []);

  useEffect(() => {
    const now = new Date(Date.now() + offsetMs);
    if (periodo === 'hoje') {
      setDataInicio(toISODate(now));
      setDataFim(toISODate(now));
    } else if (periodo === 'mes') {
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
      setDataInicio(toISODate(inicioMes));
      setDataFim(toISODate(now));
    } else if (periodo === 'mesPassado') {
      const inicioMesPassado = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const fimMesPassado = new Date(now.getFullYear(), now.getMonth(), 0);
      setDataInicio(toISODate(inicioMesPassado));
      setDataFim(toISODate(fimMesPassado));
    }
    // 'personalizado' não mexe nas datas — escolhidas manualmente abaixo
  }, [periodo, offsetMs]);

  useEffect(() => {
    if (!dataInicio || !dataFim) return;
    setCarregando(true);
    window.pdv.fiscal.livroDeControlados({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then((list) => {
      setCarregando(false);
      setLinhas(Array.isArray(list) ? list : []);
    });
  }, [dataInicio, dataFim]);

  return (
    <div>
      <p className="screen-hint" style={{ margin: '0 0 12px' }}>
        Toda venda de produto marcado como "medicamento controlado" no cadastro, no período — pronto
        pra prestar contas à vigilância sanitária, sem precisar procurar venda por venda.
      </p>

      <div className="period-selector" style={{ marginBottom: 12 }}>
        {['hoje', 'mes', 'mesPassado', 'personalizado'].map((p) => (
          <button key={p} className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(p)}>
            {p === 'hoje' ? 'Hoje' : p === 'mes' ? 'Este mês' : p === 'mesPassado' ? 'Mês passado' : 'Personalizado'}
          </button>
        ))}
      </div>

      {periodo === 'personalizado' && (
        <div className="inline-form" style={{ marginBottom: 12 }}>
          <label>De<input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} /></label>
          <label>Até<input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} /></label>
        </div>
      )}

      {linhas && linhas.length > 0 && (
        <button className="btn-secondary" style={{ marginBottom: 12 }} onClick={() => window.print()}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="printer" size={15} /> Imprimir</span></button>
      )}

      {carregando && <p className="empty-state">Carregando...</p>}
      {!carregando && linhas !== null && linhas.length === 0 && <p className="empty-state">Nenhuma venda de controlado nesse período.</p>}
      {!carregando && linhas !== null && linhas.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Data/hora</th><th>Produto</th><th>Princípio ativo</th><th>Qtd</th><th>Cliente</th><th>CPF</th><th>Operador</th></tr></thead>
          <tbody>
            {linhas.map((l, i) => (
              <tr key={i}>
                <td>{new Date(l.dataHora + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                <td>{l.produtoNome}</td>
                <td>{l.principioAtivo || '—'}</td>
                <td>{l.quantidade}</td>
                <td>{l.clienteNome || '—'}</td>
                <td>{l.clienteCpf || '—'}</td>
                <td>{l.operadorNome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
