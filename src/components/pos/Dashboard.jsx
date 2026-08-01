import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { AuditLog } from '../users/AuditLog';
import { ProductProfitReport } from './ProductProfitReport';

function toISODate(d) { return d.toISOString().slice(0, 10); }

/** Gráfico de barras simples em SVG — sem depender de nenhuma
 * biblioteca de gráficos, só pra mostrar a tendência de vendas por dia
 * de um jeito mais fácil de ler que uma lista de barras horizontais. */
function VendasPorDiaChart({ dados }) {
  const largura = 700, altura = 200, padTop = 16, padBottom = 28, padSides = 12;
  const areaAltura = altura - padTop - padBottom;
  const max = Math.max(1, ...dados.map((d) => d.total));
  const gap = (largura - padSides * 2) / dados.length;
  const barWidth = Math.min(46, gap * 0.6);

  return (
    <svg viewBox={`0 0 ${largura} ${altura}`} width="100%" style={{ maxWidth: 700, display: 'block' }}>
      {dados.map((d, i) => {
        const barH = (d.total / max) * areaAltura;
        const x = padSides + i * gap + (gap - barWidth) / 2;
        const y = padTop + areaAltura - barH;
        return (
          <g key={d.dia}>
            <rect x={x} y={y} width={barWidth} height={Math.max(barH, 2)} rx="4" style={{ fill: 'var(--color-primary)' }} />
            <text x={x + barWidth / 2} y={altura - padBottom + 16} fontSize="10" textAnchor="middle" style={{ fill: 'var(--color-text-muted)' }}>
              {d.dia.slice(5)}
            </text>
            <text x={x + barWidth / 2} y={y - 4} fontSize="10" textAnchor="middle" style={{ fill: 'var(--color-text)' }}>
              {d.total >= 1000 ? `${(d.total / 1000).toFixed(1)}k` : d.total.toFixed(0)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Dashboard() {
  const { currentUser } = useSession();
  const [aba, setAba] = useState('visaoGeral');
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('semana');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [summary, setSummary] = useState(null);
  const [desperdicioPorDia, setDesperdicioPorDia] = useState([]);
  const [vendasPorOperador, setVendasPorOperador] = useState([]);
  const [erroCarregamento, setErroCarregamento] = useState('');
  const [resumoIA, setResumoIA] = useState(null);
  const [gerandoResumo, setGerandoResumo] = useState(false);
  const [erroResumo, setErroResumo] = useState('');

  const [consolidado, setConsolidado] = useState(null);
  const [conexaoPdvs, setConexaoPdvs] = useState(null); // null = checando, true = ok, false = offline
  const [carregandoConsolidado, setCarregandoConsolidado] = useState(false);
  const [erroConsolidado, setErroConsolidado] = useState('');

  const [parados, setParados] = useState([]);
  const [diasParados, setDiasParados] = useState(30);
  const [carregandoParados, setCarregandoParados] = useState(false);

  useEffect(() => {
    function checar() {
      window.pdv.pdvRegistry.checkConnection().then((r) => setConexaoPdvs(r.ok));
    }
    checar();
    const id = setInterval(checar, 60 * 1000); // confere de novo a cada 1 min enquanto a tela estiver aberta
    return () => clearInterval(id);
  }, []);

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
    window.pdv.waste.getByDay({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then((list) => {
      setDesperdicioPorDia(Array.isArray(list) ? list : []);
    });
    window.pdv.dashboard.getSalesByOperator({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim }).then((list) => {
      setVendasPorOperador(Array.isArray(list) ? list : []);
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

  const maiorQtdProduto = summary ? Math.max(1, ...summary.topProdutos.map((p) => p.quantidade)) : 1;
  const maiorVendaOperador = Math.max(1, ...vendasPorOperador.map((o) => o.total_vendido));

  return (
    <div className="screen">
      <h1>Painel</h1>

      <div className="settings-tabs">
        <button className={aba === 'visaoGeral' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('visaoGeral')}>Visão geral</button>
        <button className={aba === 'produtos' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('produtos')}>Produtos e lucro</button>
        {currentUser.role === 'admin' && (
          <button className={aba === 'auditoria' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('auditoria')}>Auditoria</button>
        )}
      </div>

      {aba === 'auditoria' && currentUser.role === 'admin' ? (
        <AuditLog />
      ) : aba === 'produtos' ? (
        <ProductProfitReport />
      ) : (
      <>
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
              {summary.vendasPorDia.length === 0 ? (
                <p className="empty-state">Sem vendas no período.</p>
              ) : (
                <VendasPorDiaChart dados={summary.vendasPorDia} />
              )}
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

          {desperdicioPorDia.length > 0 && (
            <section className="settings-section">
              <h2>Desperdício por dia</h2>
              <p className="screen-hint">
                Valor perdido em pratos e insumos não aproveitados — registrado na tela Desperdício.
              </p>
              <VendasPorDiaChart dados={desperdicioPorDia} />
            </section>
          )}

          {vendasPorOperador.length > 0 && (
            <section className="settings-section">
              <h2>Vendas por operador</h2>
              <p className="screen-hint">Útil pra calcular comissão ou dividir gorjeta no período.</p>
              {vendasPorOperador.map((o) => (
                <div key={o.operador} className="bar-row">
                  <span className="bar-label" title={o.operador}>{o.operador}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(o.total_vendido / maiorVendaOperador) * 100}%` }} />
                  </div>
                  <span className="bar-value">R$ {o.total_vendido.toFixed(2)} ({o.total_vendas})</span>
                </div>
              ))}
            </section>
          )}

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
            <h2>
              Consolidado entre PDVs
              {conexaoPdvs !== null && (
                <span className={`connection-dot ${conexaoPdvs ? 'connection-dot-ok' : 'connection-dot-off'}`} title={conexaoPdvs ? 'Conectado ao Firebase' : 'Sem conexão com o Firebase agora — o consolidado pode estar desatualizado'}>
                  {conexaoPdvs ? '● conectado' : '○ offline'}
                </span>
              )}
            </h2>
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
      </>
      )}
    </div>
  );
}
