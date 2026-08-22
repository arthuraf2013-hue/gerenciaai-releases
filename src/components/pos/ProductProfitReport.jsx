import { useEffect, useMemo, useState } from 'react';
import { toISODate } from '../../utils/date';


export function ProductProfitReport() {
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('hoje');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [relatorio, setRelatorio] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [ordenacao, setOrdenacao] = useState('lucro'); // 'lucro' | 'quantidade' | 'receita' | 'nome' | 'recente'

  useEffect(() => {
    window.pdv.time.getStatus().then((s) => setOffsetMs(s.offsetMs || 0));
  }, []);

  useEffect(() => {
    const now = new Date(Date.now() + offsetMs);
    if (periodo === 'hoje') {
      setDataInicio(toISODate(now));
      setDataFim(toISODate(now));
    } else if (periodo === 'semana') {
      const diaSemana = now.getDay() === 0 ? 7 : now.getDay();
      const inicioSemana = new Date(now);
      inicioSemana.setDate(now.getDate() - (diaSemana - 1));
      setDataInicio(toISODate(inicioSemana));
      setDataFim(toISODate(now));
    } else if (periodo === 'mes') {
      const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
      setDataInicio(toISODate(inicioMes));
      setDataFim(toISODate(now));
    }
    // 'personalizado' não mexe nas datas — escolhidas manualmente abaixo
  }, [periodo, offsetMs]);

  useEffect(() => {
    if (!dataInicio || !dataFim) return;
    setCarregando(true);
    window.pdv.dashboard.getRelatorioProdutos({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then((r) => {
      setCarregando(false);
      setRelatorio(r);
    });
  }, [dataInicio, dataFim]);

  // useMemo -- sem isso, a soma e a ordenação (potencialmente centenas de
  // produtos) rodavam de novo em todo re-render deste componente, mesmo
  // sem `relatorio`/`ordenacao` terem mudado (ex: qualquer state de um
  // componente pai acima re-renderizando).
  const totalReceita = useMemo(() => relatorio?.produtos.reduce((acc, p) => acc + p.receita, 0) || 0, [relatorio]);
  const totalLucro = useMemo(() => relatorio?.produtos.reduce((acc, p) => acc + p.lucro, 0) || 0, [relatorio]);
  const maiorQtdHora = useMemo(
    () => (relatorio ? Math.max(1, ...relatorio.horariosPorMovimento.map((h) => h.quantidade)) : 1),
    [relatorio]
  );

  const produtosOrdenados = useMemo(() => (
    relatorio ? [...relatorio.produtos].sort((a, b) => {
      if (ordenacao === 'nome') return a.nome.localeCompare(b.nome, 'pt-BR');
      if (ordenacao === 'quantidade') return b.quantidade - a.quantidade;
      if (ordenacao === 'receita') return b.receita - a.receita;
      if (ordenacao === 'recente') return new Date(b.ultima_venda) - new Date(a.ultima_venda);
      return b.lucro - a.lucro; // 'lucro', padrão
    }) : []
  ), [relatorio, ordenacao]);

  return (
    <div>
      <div className="period-selector">
        {['hoje', 'semana', 'mes', 'personalizado'].map((p) => (
          <button key={p} className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(p)}>
            {p === 'hoje' ? 'Hoje' : p === 'semana' ? 'Últimos 7 dias' : p === 'mes' ? 'Este mês' : 'Personalizado'}
          </button>
        ))}
        {periodo === 'personalizado' && (
          <>
            <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
            <span>até</span>
            <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
          </>
        )}
      </div>

      {carregando ? (
        <p className="empty-state">Carregando...</p>
      ) : !relatorio || relatorio.produtos.length === 0 ? (
        <p className="empty-state">Nenhuma venda finalizada nesse período.</p>
      ) : (
        <>
          <div className="period-selector" style={{ marginTop: 16 }}>
            <span className="screen-hint">
              <strong>{relatorio.totalVendasNoPeriodo}</strong> venda(s) · Receita total <strong>R$ {totalReceita.toFixed(2)}</strong> ·
              Lucro total <strong>R$ {totalLucro.toFixed(2)}</strong>
              {relatorio.horaDeMaiorMovimento !== null && (
                <> · Horário de maior movimento: <strong>{String(relatorio.horaDeMaiorMovimento).padStart(2, '0')}h</strong></>
              )}
            </span>
          </div>

          <div className="period-selector" style={{ marginTop: 12 }}>
            <span className="screen-hint" style={{ marginRight: 4 }}>Ordenar por:</span>
            {[
              { valor: 'lucro', label: 'Lucro' },
              { valor: 'quantidade', label: 'Mais vendido' },
              { valor: 'receita', label: 'Receita' },
              { valor: 'recente', label: 'Vendido recentemente' },
              { valor: 'nome', label: 'Alfabética' },
            ].map((op) => (
              <button
                key={op.valor}
                className={ordenacao === op.valor ? 'category-btn category-btn-active' : 'category-btn'}
                onClick={() => setOrdenacao(op.valor)}
              >
                {op.label}
              </button>
            ))}
          </div>

          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Produto</th><th>Categoria</th><th>Quantidade</th><th>Receita</th><th>Lucro</th></tr>
            </thead>
            <tbody>
              {produtosOrdenados.map((p) => (
                <tr key={p.nome + p.categoria}>
                  <td>{p.nome}</td>
                  <td>{p.categoria || '—'}</td>
                  <td>{p.quantidade}</td>
                  <td>R$ {p.receita.toFixed(2)}</td>
                  <td style={{ color: p.lucro >= 0 ? 'var(--color-primary)' : 'var(--color-danger)' }}>
                    R$ {p.lucro.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ marginTop: 24 }}>📊 Movimento por horário do dia</h2>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 100, marginTop: 12 }}>
            {relatorio.horariosPorMovimento.map((h) => (
              <div
                key={h.hora}
                title={`${String(h.hora).padStart(2, '0')}h — ${h.quantidade} venda(s)`}
                style={{
                  flex: 1, height: `${Math.max(2, (h.quantidade / maiorQtdHora) * 100)}%`,
                  background: h.hora === relatorio.horaDeMaiorMovimento ? 'var(--color-primary)' : 'var(--color-border)',
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
            {relatorio.horariosPorMovimento.map((h) => (
              <div key={h.hora} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: 'var(--color-text-muted)' }}>
                {h.hora % 3 === 0 ? h.hora : ''}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
