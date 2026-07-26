import { useEffect, useState } from 'react';

function toISODate(d) { return d.toISOString().slice(0, 10); }

export function Dashboard() {
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('semana');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [summary, setSummary] = useState(null);
  const [erroCarregamento, setErroCarregamento] = useState('');
  const [resumoIA, setResumoIA] = useState(null);
  const [gerandoResumo, setGerandoResumo] = useState(false);
  const [erroResumo, setErroResumo] = useState('');

  const [consolidado, setConsolidado] = useState(null);
  const [carregandoConsolidado, setCarregandoConsolidado] = useState(false);
  const [erroConsolidado, setErroConsolidado] = useState('');

  const [parados, setParados] = useState([]);
  const [diasParados, setDiasParados] = useState(30);
  const [carregandoParados, setCarregandoParados] = useState(false);

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
    setErroCarregamento('');
    window.pdv.dashboard.getSummary({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then((result) => {
      if (!result || !Array.isArray(result.vendasPorDia)) {
        setSummary(null);
        setErroCarregamento(result?.error || 'Não foi possível carregar o painel.');
        return;
      }
      setSummary(result);
    });
    setResumoIA(null);
    setConsolidado(null);
  }, [dataInicio, dataFim]);

  async function handleResumoIA() {
    if (!summary) return;
    setGerandoResumo(true);
    setErroResumo('');
    const sales = await window.pdv.sale.listByRange({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim });
    const result = await window.pdv.ai.summarizeSales({ sales, periodo: `${dataInicio} a ${dataFim}` });
    setGerandoResumo(false);
    if (!result.ok) return setErroResumo(result.error);
    setResumoIA(result.resumo);
  }

  async function handleCarregarConsolidado() {
    setCarregandoConsolidado(true);
    setErroConsolidado('');
    const result = await window.pdv.salesSync.getConsolidated({ dataInicio, dataFim });
    setCarregandoConsolidado(false);
    if (!result.ok) return setErroConsolidado(result.error);
    setConsolidado(result);
  }

  async function carregarParados(dias) {
    setCarregandoParados(true);
    const list = await window.pdv.dashboard.listStaleProducts({ locationId: window.APP_LOCATION_ID, dias });
    setCarregandoParados(false);
    setParados(Array.isArray(list) ? list : []);
  }

  useEffect(() => { carregarParados(diasParados); }, [diasParados]);

  const maiorValorDia = summary ? Math.max(1, ...summary.vendasPorDia.map((d) => d.total)) : 1;
  const maiorQtdProduto = summary ? Math.max(1, ...summary.topProdutos.map((p) => p.quantidade)) : 1;

  return (
    <div className="screen">
      <h1>Painel</h1>

      <div className="period-selector">
        {['hoje', 'semana', 'mes'].map((p) => (
          <button key={p} className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(p)}>
            {p === 'hoje' ? 'Hoje' : p === 'semana' ? 'Últimos 7 dias' : 'Este mês'}
          </button>
        ))}
      </div>

      {erroCarregamento && <p className="modal-error">{erroCarregamento}</p>}

      {summary && (
        <>
          <div className="dashboard-stats">
            <div className="stat-card">
              <span>Vendas finalizadas</span>
              <strong>{summary.totalVendas}</strong>
            </div>
            <div className="stat-card">
              <span>Total faturado</span>
              <strong>R$ {summary.totalFaturado.toFixed(2)}</strong>
            </div>
            <div className="stat-card">
              <span>Devoluções</span>
              <strong>{summary.devolucoes.total} (R$ {summary.devolucoes.valor.toFixed(2)})</strong>
            </div>
            <div className="stat-card">
              <span>Lucro bruto estimado</span>
              <strong>R$ {summary.lucroBrutoEstimado.toFixed(2)}</strong>
            </div>
          </div>

          <section className="settings-section">
            <h2>Margem por produto (estimada)</h2>
            <p className="screen-hint">
              Usa o custo cadastrado hoje no produto, não o custo real de quando a venda aconteceu —
              se o custo mudou desde então, o número fica aproximado.
            </p>
            {summary.margemPorProduto.length === 0 ? (
              <p className="empty-state">Sem vendas no período.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Produto</th><th>Qtd</th><th>Vendido</th><th>Custo estimado</th><th>Lucro</th><th>Margem</th></tr></thead>
                <tbody>
                  {summary.margemPorProduto.map((p) => (
                    <tr key={p.nome}>
                      <td>{p.nome}</td>
                      <td>{p.quantidade}</td>
                      <td>R$ {p.valorVendido.toFixed(2)}</td>
                      <td>R$ {p.custoEstimado.toFixed(2)}</td>
                      <td className={p.lucro < 0 ? 'text-danger' : ''}>R$ {p.lucro.toFixed(2)}</td>
                      <td>{p.margemPercentual.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <div className="dashboard-columns">
            <section className="settings-section">
              <h2>Vendas por dia</h2>
              {summary.vendasPorDia.length === 0 && <p className="empty-state">Sem vendas no período.</p>}
              {summary.vendasPorDia.map((d) => (
                <div key={d.dia} className="bar-row">
                  <span className="bar-label">{d.dia.slice(5)}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(d.total / maiorValorDia) * 100}%` }} />
                  </div>
                  <span className="bar-value">R$ {d.total.toFixed(0)}</span>
                </div>
              ))}
            </section>

            <section className="settings-section">
              <h2>Produtos mais vendidos</h2>
              {summary.topProdutos.length === 0 && <p className="empty-state">Sem vendas no período.</p>}
              {summary.topProdutos.map((p) => (
                <div key={p.nome} className="bar-row">
                  <span className="bar-label" title={p.nome}>{p.nome}</span>
                  <div className="bar-track">
                    <div className="bar-fill bar-fill-gold" style={{ width: `${(p.quantidade / maiorQtdProduto) * 100}%` }} />
                  </div>
                  <span className="bar-value">{p.quantidade}</span>
                </div>
              ))}
            </section>
          </div>

          <section className="settings-section">
            <h2>Resumo por IA</h2>
            <button className="btn-secondary" onClick={handleResumoIA} disabled={gerandoResumo}>
              {gerandoResumo ? 'Gerando...' : 'Resumir este período com IA'}
            </button>
            {erroResumo && <p className="modal-error">{erroResumo}</p>}
            {resumoIA && <p style={{ marginTop: 12, lineHeight: 1.6 }}>{resumoIA}</p>}
          </section>

          <section className="settings-section">
            <h2>Produtos parados</h2>
            <p className="screen-hint">
              Tem estoque, mas sem nenhuma venda no período — diferente do alerta de validade,
              que só avisa quando já está perto de vencer. Ajuda a achar o que está encalhado.
            </p>
            <div className="period-selector">
              {[15, 30, 60, 90].map((d) => (
                <button
                  key={d}
                  className={diasParados === d ? 'category-btn category-btn-active' : 'category-btn'}
                  onClick={() => setDiasParados(d)}
                >
                  {d} dias
                </button>
              ))}
            </div>
            {carregandoParados ? (
              <p className="empty-state">Carregando...</p>
            ) : parados.length === 0 ? (
              <p className="empty-state">Nenhum produto parado nesse período — ótimo sinal.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Produto</th><th>Categoria</th><th>Estoque</th><th>Última venda</th></tr></thead>
                <tbody>
                  {parados.map((p) => (
                    <tr key={p.id}>
                      <td>{p.nome}</td>
                      <td>{p.categoria || '—'}</td>
                      <td>{p.estoque_atual}</td>
                      <td>{p.ultima_venda_em ? new Date(p.ultima_venda_em + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Nunca vendido'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="settings-section">
            <h2>Consolidado entre PDVs</h2>
            <p className="screen-hint">
              Soma as vendas de todos os PDVs registrados com o mesmo CNPJ (Configurações →
              Sincronização) — vem do Firebase, não só deste terminal. Só funciona com a
              sincronização configurada e ativada.
            </p>
            <button className="btn-secondary" onClick={handleCarregarConsolidado} disabled={carregandoConsolidado}>
              {carregandoConsolidado ? 'Consultando...' : 'Consultar consolidado'}
            </button>
            {erroConsolidado && <p className="modal-error">{erroConsolidado}</p>}
            {consolidado && (
              <div style={{ marginTop: 14 }}>
                <p><strong>Total geral:</strong> {consolidado.totalVendas} venda(s) — R$ {consolidado.totalFaturado.toFixed(2)}</p>
                {consolidado.porPdv.length > 0 && (
                  <table className="data-table">
                    <thead><tr><th>PDV</th><th>Vendas</th><th>Faturado</th></tr></thead>
                    <tbody>
                      {consolidado.porPdv.map((p) => (
                        <tr key={p.numeroPdv}>
                          <td>{p.numeroPdv}</td>
                          <td>{p.totalVendas}</td>
                          <td>R$ {p.totalFaturado.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
