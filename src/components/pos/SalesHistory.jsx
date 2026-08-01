import { Fragment, useEffect, useState } from 'react';

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

export function SalesHistory({ onDevolver }) {
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('hoje'); // 'hoje' | 'semana' | 'mes' | 'personalizado'
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [sales, setSales] = useState([]);
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [clienteQuery, setClienteQuery] = useState('');
  const [clienteSugestoes, setClienteSugestoes] = useState([]);
  const [clienteSelecionado, setClienteSelecionado] = useState(null);
  const [relatorioCliente, setRelatorioCliente] = useState(null);
  const [exportandoRelatorio, setExportandoRelatorio] = useState(false);
  const [vendaExpandidaId, setVendaExpandidaId] = useState(null);
  const [itensPorVenda, setItensPorVenda] = useState({}); // cache: { [saleId]: itens[] }

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

  // Busca clientes conforme digita (nome, telefone, CPF ou CNPJ) — só
  // dispara quando tem texto e ainda não escolheu ninguém.
  useEffect(() => {
    if (!clienteQuery.trim() || clienteSelecionado) { setClienteSugestoes([]); return; }
    let ignore = false;
    window.pdv.customers.list({ query: clienteQuery }).then((list) => {
      if (!ignore) setClienteSugestoes(Array.isArray(list) ? list.slice(0, 8) : []);
    });
    return () => { ignore = true; };
  }, [clienteQuery, clienteSelecionado]);

  // Carrega o relatório sempre que o cliente ou o período mudam.
  useEffect(() => {
    if (!clienteSelecionado || !dataInicio || !dataFim) { setRelatorioCliente(null); return; }
    window.pdv.report.getCustomerPurchase({ customerId: clienteSelecionado.id, dataInicio, dataFim }).then((r) => {
      setRelatorioCliente(r.ok ? r : null);
    });
  }, [clienteSelecionado, dataInicio, dataFim]);

  function selecionarCliente(cliente) {
    setClienteSelecionado(cliente);
    setClienteQuery(cliente.nome);
    setClienteSugestoes([]);
  }

  function limparFiltroCliente() {
    setClienteSelecionado(null);
    setClienteQuery('');
    setRelatorioCliente(null);
  }

  async function handleExportCustomerReport() {
    setExportandoRelatorio(true);
    const result = await window.pdv.report.exportCustomerPurchase({
      customerId: clienteSelecionado.id, dataInicio, dataFim, nomeCliente: clienteSelecionado.nome,
    });
    setExportandoRelatorio(false);
    if (result.canceled) return;
    setExportMsg(result.ok
      ? `Relatório do cliente exportado: ${result.totalPedidos} pedido(s), R$ ${result.totalGasto.toFixed(2)}.`
      : result.error);
  }

  async function handleToggleVenda(saleId) {
    if (vendaExpandidaId === saleId) {
      setVendaExpandidaId(null);
      return;
    }
    setVendaExpandidaId(saleId);
    if (!itensPorVenda[saleId]) {
      const itens = await window.pdv.sale.getItemsDetail({ saleId });
      setItensPorVenda((prev) => ({ ...prev, [saleId]: Array.isArray(itens) ? itens : [] }));
    }
  }

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

  const salesFiltradas = clienteSelecionado ? sales.filter((s) => s.customer_id === clienteSelecionado.id) : sales;

  const totalDia = salesFiltradas
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

      <div className="customer-filter-box">
        <div className="customer-filter-input-wrap">
          <input
            value={clienteQuery}
            onChange={(e) => { setClienteQuery(e.target.value); setClienteSelecionado(null); }}
            placeholder="Filtrar por cliente (nome, CPF ou CNPJ)..."
          />
          {clienteSugestoes.length > 0 && (
            <ul className="customer-filter-suggestions">
              {clienteSugestoes.map((c) => (
                <li key={c.id} onClick={() => selecionarCliente(c)}>
                  {c.nome} {(c.cnpj || c.cpf) && <span className="screen-hint">({c.cnpj || c.cpf})</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {clienteSelecionado && <button className="btn-link" onClick={limparFiltroCliente}>Limpar filtro</button>}
      </div>

      {clienteSelecionado && relatorioCliente && (
        <div className="customer-report-box">
          <h2>
            {relatorioCliente.cliente.nome}
            {(relatorioCliente.cliente.cnpj || relatorioCliente.cliente.cpf) && (
              <span className="screen-hint" style={{ fontWeight: 400 }}> — {relatorioCliente.cliente.cnpj ? 'CNPJ' : 'CPF'}: {relatorioCliente.cliente.cnpj || relatorioCliente.cliente.cpf}</span>
            )}
          </h2>
          <p className="screen-hint" style={{ margin: '0 0 12px' }}>
            Período de {new Date(dataInicio + 'T00:00:00').toLocaleDateString('pt-BR')} a {new Date(dataFim + 'T00:00:00').toLocaleDateString('pt-BR')} —{' '}
            <strong>{relatorioCliente.totalPedidos} pedido(s)</strong>, <strong>R$ {relatorioCliente.totalGasto.toFixed(2)}</strong> no total.
          </p>

          {relatorioCliente.categorias.length === 0 ? (
            <p className="empty-state">Nenhuma compra finalizada nesse período.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Categoria</th><th>Produto</th><th>Quantidade</th><th>Valor</th></tr>
              </thead>
              <tbody>
                {relatorioCliente.categorias.map((cat) => (
                  <Fragment key={cat.categoria}>
                    <tr className="row-warning">
                      <td colSpan={2}><strong>{cat.categoria}</strong></td>
                      <td><strong>{cat.quantidadeTotal}</strong></td>
                      <td><strong>R$ {cat.valorTotal.toFixed(2)}</strong></td>
                    </tr>
                    {cat.produtos.map((p) => (
                      <tr key={cat.categoria + p.nome}>
                        <td></td>
                        <td>{p.nome}</td>
                        <td>{p.quantidade}</td>
                        <td>R$ {p.valor.toFixed(2)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}

          <button className="btn-secondary" onClick={handleExportCustomerReport} disabled={exportandoRelatorio} style={{ marginTop: 12 }}>
            {exportandoRelatorio ? 'Exportando...' : 'Exportar esse relatório'}
          </button>
        </div>
      )}

      {exportMsg && <p className="io-message">{exportMsg}</p>}

      {salesFiltradas.length === 0 ? (
        <p className="empty-state">Nenhuma venda nesse período.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Data/hora</th><th>Operador</th><th>Itens</th><th>Total</th><th>Pagamento</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {salesFiltradas.map((s) => (
              <Fragment key={s.id}>
                <tr
                  className={s.status === 'cancelada' ? 'row-critical' : ''}
                  onClick={() => handleToggleVenda(s.id)}
                  style={{ cursor: 'pointer' }}
                  title="Clique pra ver os produtos dessa venda"
                >
                  <td>{new Date(s.data_efetiva + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}</td>
                  <td>{s.operador_nome}</td>
                  <td>{vendaExpandidaId === s.id ? '▾' : '▸'} {s.total_itens}</td>
                  <td>R$ {s.total.toFixed(2)}</td>
                  <td>{formatMetodos(s.metodos_pagamento)}</td>
                  <td>{STATUS_LABEL[s.status] || s.status}</td>
                  <td>
                    {s.status === 'finalizada' && (
                      <button className="btn-link" onClick={(e) => { e.stopPropagation(); onDevolver?.(s.id); }}>Devolver</button>
                    )}
                  </td>
                </tr>
                {vendaExpandidaId === s.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--color-bg)', padding: '4px 16px' }}>
                      {!itensPorVenda[s.id] ? (
                        <p className="screen-hint" style={{ margin: '8px 0' }}>Carregando itens...</p>
                      ) : itensPorVenda[s.id].length === 0 ? (
                        <p className="screen-hint" style={{ margin: '8px 0' }}>Nenhum item nessa venda.</p>
                      ) : (
                        <ul className="payment-list" style={{ margin: '8px 0' }}>
                          {itensPorVenda[s.id].map((item) => (
                            <li key={item.id} style={item.cancelado ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>
                              {item.nome} × {item.quantidade} — R$ {(item.preco_unitario * item.quantidade).toFixed(2)}
                              {item.cancelado ? ' (cancelado)' : ''}
                              {item.observacao && ` — ${item.observacao}`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
