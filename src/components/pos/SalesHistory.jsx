import { Fragment, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { toISODate } from '../../utils/date';
import { usePromptModal } from '../../hooks/usePromptModal';
import { PromptModal } from '../common/PromptModal';
import { EditHistoricoModal } from './EditHistoricoModal';

const STATUS_LABEL = {
  aberta: 'Em aberto',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

const METODO_LABEL = {
  dinheiro: 'Dinheiro', cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito',
  pix: 'Pix', fiado: 'Fiado', outro: 'Outro',
};

const NFCE_STATUS_LABEL = {
  pendente: 'pendente de transmissão',
  autorizada: 'autorizada',
  rejeitada: 'rejeitada',
  cancelada: 'cancelada',
  contingencia: 'em contingência',
};



function formatMetodos(str) {
  if (!str) return '—';
  return str.split(',').map((m) => METODO_LABEL[m] || m).join(', ');
}

export function SalesHistory({ onDevolver }) {
  const { currentUser } = useSession();
  const { promptState, promptAsync, confirmarPrompt, cancelarPrompt } = usePromptModal();
  const podeExcluir = currentUser.role === 'gerente' || currentUser.role === 'admin';
  const podeEditarHistorico = currentUser.role === 'admin';
  const [vendaEditando, setVendaEditando] = useState(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [periodo, setPeriodo] = useState('hoje'); // 'hoje' | 'semana' | 'mes' | 'personalizado'
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [sales, setSales] = useState([]);
  const [mostrarExcluidas, setMostrarExcluidas] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [clienteQuery, setClienteQuery] = useState('');
  const [clienteSugestoes, setClienteSugestoes] = useState([]);
  const [clienteSelecionado, setClienteSelecionado] = useState(null);
  const [relatorioCliente, setRelatorioCliente] = useState(null);
  const [exportandoRelatorio, setExportandoRelatorio] = useState(false);
  const [vendaExpandidaId, setVendaExpandidaId] = useState(null);
  const [itensPorVenda, setItensPorVenda] = useState({}); // cache: { [saleId]: itens[] }
  const [nfcePorVenda, setNfcePorVenda] = useState({}); // cache: { [saleId]: nfce[] }
  const [reenviandoNfceId, setReenviandoNfceId] = useState(null);
  const [sincronizacaoAtiva, setSincronizacaoAtiva] = useState(false);
  const [vendasDoGrupo, setVendasDoGrupo] = useState(null);
  const [carregandoGrupo, setCarregandoGrupo] = useState(false);
  const [erroGrupo, setErroGrupo] = useState('');
  const [filtroPdv, setFiltroPdv] = useState('todos');

  useEffect(() => {
    window.pdv.pdvRegistry.getStatus().then((s) => setSincronizacaoAtiva(s.sincronizacaoAtiva));
  }, []);

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

  function recarregarVendas() {
    if (!dataInicio || !dataFim) return;
    window.pdv.sale.listByRange({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim, incluirOcultas: mostrarExcluidas }).then((list) => {
      setSales(Array.isArray(list) ? list : []);
    });
  }

  useEffect(() => {
    recarregarVendas();
  }, [dataInicio, dataFim, mostrarExcluidas]);

  async function carregarHistoricoDoGrupo(mostrarCarregando = true, forcarReenvio = false) {
    if (!sincronizacaoAtiva || !dataInicio || !dataFim) return;
    if (mostrarCarregando) setCarregandoGrupo(true);
    setErroGrupo('');
    if (forcarReenvio) {
      // Corrige na hora qualquer dado desatualizado desta máquina no
      // Firestore antes de reler — sem isso, dependia só do ciclo
      // automático de 15 minutos (ou reabrir o app) pra dado antigo se
      // corrigir sozinho.
      await window.pdv.salesSync.pushTodoOHistorico();
    }
    window.pdv.salesSync.getGroupHistory({ dataInicio, dataFim }).then((result) => {
      setCarregandoGrupo(false);
      if (!result.ok) return setErroGrupo(result.error);
      setVendasDoGrupo(result.vendas);
    });
  }

  useEffect(() => {
    carregarHistoricoDoGrupo(true, true);
  }, [sincronizacaoAtiva, dataInicio, dataFim]);

  useEffect(() => {
    if (!sincronizacaoAtiva) return;
    // O histórico do grupo vem de uma consulta única, não de uma escuta
    // em tempo real — sem atualizar sozinho, uma venda feita em OUTRO
    // PDV só apareceria aqui se você saísse da tela e voltasse. Repete
    // a cada 20s enquanto a tela estiver aberta (sem mostrar o
    // "carregando", pra não piscar a lista à toa).
    const id = setInterval(() => carregarHistoricoDoGrupo(false), 20000);
    return () => clearInterval(id);
  }, [sincronizacaoAtiva, dataInicio, dataFim]);

  async function handleExcluirDoHistorico(saleId) {
    const motivo = await promptAsync('Motivo de excluir essa venda do histórico (opcional — some da lista, mas nada é apagado de verdade):', '');
    if (motivo === null) return; // cancelou o prompt
    const result = await window.pdv.sale.excluirDoHistorico({ saleId, operadorId: currentUser.id, motivo: motivo || null });
    if (result.ok) recarregarVendas();
  }

  async function handleSalvarEdicaoHistorico({ novaDataHora, novoTotal, motivo }) {
    const result = await window.pdv.sale.editarHistorico({
      saleId: vendaEditando.id, novaDataHora, novoTotal, motivo: motivo || null, currentOperatorId: currentUser.id,
    });
    if (!result.ok) { alert(result.error); return; }
    setVendaEditando(null);
    recarregarVendas();
  }

  async function handleReexibir(saleId) {
    const result = await window.pdv.sale.reexibirNoHistorico({ saleId, operadorId: currentUser.id });
    if (result.ok) recarregarVendas();
  }

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
    if (!nfcePorVenda[saleId]) {
      const nfces = await window.pdv.fiscal.listNfceForSale({ saleId });
      setNfcePorVenda((prev) => ({ ...prev, [saleId]: Array.isArray(nfces) ? nfces : [] }));
    }
  }

  async function handleReenviarNfce(saleId, nfceId) {
    setReenviandoNfceId(nfceId);
    await window.pdv.fiscal.reenviarNFCe({ nfceId });
    const nfces = await window.pdv.fiscal.listNfceForSale({ saleId });
    setNfcePorVenda((prev) => ({ ...prev, [saleId]: Array.isArray(nfces) ? nfces : [] }));
    setReenviandoNfceId(null);
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
  const pdvsDisponiveis = vendasDoGrupo ? [...new Set(vendasDoGrupo.map((v) => v.locationNome).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')) : [];
  const vendasDoGrupoFiltradas = !vendasDoGrupo ? [] : filtroPdv === 'todos' ? vendasDoGrupo : vendasDoGrupo.filter((v) => v.locationNome === filtroPdv);

  const totalDia = sincronizacaoAtiva
    ? vendasDoGrupoFiltradas.reduce((acc, v) => acc + (v.total || 0), 0)
    : salesFiltradas.filter((s) => s.status === 'finalizada').reduce((acc, s) => acc + s.total, 0);

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>🧾 Histórico</h1>
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

        {podeExcluir && !sincronizacaoAtiva && (
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 13 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={mostrarExcluidas} onChange={(e) => setMostrarExcluidas(e.target.checked)} />
            Mostrar excluídas do histórico
          </label>
        )}
        {sincronizacaoAtiva && (
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 13 }}>
            Filtrar por PDV:
            <select value={filtroPdv} onChange={(e) => setFiltroPdv(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="todos">Todos os PDVs</option>
              {pdvsDisponiveis.map((nome) => <option key={nome} value={nome}>{nome}</option>)}
            </select>
          </label>
        )}
        {sincronizacaoAtiva && (
          <button className="btn-secondary" onClick={() => carregarHistoricoDoGrupo(true, true)} disabled={carregandoGrupo} title="Reenvia o dado desta máquina (corrige qualquer coisa desatualizada) e busca de novo na hora">
            {carregandoGrupo ? 'Atualizando...' : '↻ Atualizar'}
          </button>
        )}
        <button className="btn-secondary" onClick={handleExport} disabled={exportando} style={{ marginLeft: sincronizacaoAtiva ? 0 : (podeExcluir ? 0 : 'auto') }}>
          {exportando ? 'Exportando...' : '📊 Exportar relatório'}
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
            {exportandoRelatorio ? 'Exportando...' : '📊 Exportar esse relatório'}
          </button>
        </div>
      )}

      {exportMsg && <p className="io-message">{exportMsg}</p>}

      {sincronizacaoAtiva ? (
        <>
          {carregandoGrupo && <p className="empty-state">Carregando vendas do grupo...</p>}
          {erroGrupo && <p className="modal-error">{erroGrupo}</p>}
          {!carregandoGrupo && !erroGrupo && vendasDoGrupoFiltradas.length === 0 && (
            <p className="empty-state">Nenhuma venda do grupo nesse período.</p>
          )}
          {!carregandoGrupo && vendasDoGrupoFiltradas.length > 0 && (
            <table className="data-table">
              <thead>
                <tr><th>Data/hora</th><th>PDV</th><th>Operador</th><th>Itens</th><th>Total</th><th>Pagamento</th></tr>
              </thead>
              <tbody>
                {vendasDoGrupoFiltradas.map((v) => (
                  <Fragment key={v.id}>
                    <tr>
                      <td>{v.finalizadaEm ? new Date(v.finalizadaEm.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) : '—'}</td>
                      <td><strong>{v.locationNome || '—'}</strong></td>
                      <td>{v.operadorNome || '—'}</td>
                      <td>{v.totalItens}</td>
                      <td>R$ {(v.total || 0).toFixed(2)}</td>
                      <td>{formatMetodos((v.metodosPagamento || []).join(','))}</td>
                    </tr>
                    {v.itens && v.itens.length > 0 && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--color-bg)', padding: '4px 16px' }}>
                          <span className="screen-hint">
                            {v.itens.map((i) => `${i.nome} × ${i.quantidade}`).join(', ')}
                          </span>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : salesFiltradas.length === 0 ? (
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
                  className={s.status === 'cancelada' ? 'row-critical' : s.oculta_historico ? 'row-warning' : ''}
                  onClick={() => handleToggleVenda(s.id)}
                  style={{ cursor: 'pointer' }}
                  title="Clique pra ver os produtos dessa venda"
                >
                  <td>{new Date(s.data_efetiva + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}</td>
                  <td>{s.operador_nome}</td>
                  <td>{vendaExpandidaId === s.id ? '▾' : '▸'} {s.total_itens}</td>
                  <td>R$ {s.total.toFixed(2)}</td>
                  <td>{formatMetodos(s.metodos_pagamento)}</td>
                  <td>{STATUS_LABEL[s.status] || s.status}{s.oculta_historico ? ' (excluída)' : ''}</td>
                  <td>
                    {s.status === 'finalizada' && (
                      <button className="btn-link" onClick={(e) => { e.stopPropagation(); onDevolver?.(s.id); }}>↩️ Devolver</button>
                    )}
                    {podeEditarHistorico && (
                      <button className="btn-link" onClick={(e) => { e.stopPropagation(); setVendaEditando(s); }}>✏️ Editar</button>
                    )}
                    {podeExcluir && (
                      s.oculta_historico ? (
                        <button className="btn-link" onClick={(e) => { e.stopPropagation(); handleReexibir(s.id); }}>Reexibir</button>
                      ) : (
                        <button className="btn-link-danger" onClick={(e) => { e.stopPropagation(); handleExcluirDoHistorico(s.id); }}>🗑️ Excluir do histórico</button>
                      )
                    )}
                  </td>
                </tr>
                {vendaExpandidaId === s.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--color-bg)', padding: '4px 16px' }}>
                      {!itensPorVenda[s.id] ? (
                        <p className="screen-hint" style={{ margin: '8px 0' }}>Carregando itens...</p>
                      ) : itensPorVenda[s.id].filter((item) => !item.cancelado).length === 0 ? (
                        <p className="screen-hint" style={{ margin: '8px 0' }}>Nenhum item vendido de verdade nessa venda (tudo foi cancelado).</p>
                      ) : (
                        <ul className="payment-list" style={{ margin: '8px 0' }}>
                          {itensPorVenda[s.id].filter((item) => !item.cancelado).map((item) => (
                            <li key={item.id}>
                              {item.nome} × {item.quantidade} — R$ {(item.preco_unitario * item.quantidade).toFixed(2)}
                              {item.observacao && ` — ${item.observacao}`}
                            </li>
                          ))}
                        </ul>
                      )}
                      {nfcePorVenda[s.id]?.[0] && (
                        <p className="screen-hint" style={{ margin: '4px 0 0' }}>
                          NFC-e: {NFCE_STATUS_LABEL[nfcePorVenda[s.id][0].status] || nfcePorVenda[s.id][0].status}
                          {nfcePorVenda[s.id][0].status === 'rejeitada' && nfcePorVenda[s.id][0].motivo_rejeicao && ` — ${nfcePorVenda[s.id][0].motivo_rejeicao}`}
                          {nfcePorVenda[s.id][0].status === 'pendente' && (
                            <button
                              className="btn-link"
                              onClick={(e) => { e.stopPropagation(); handleReenviarNfce(s.id, nfcePorVenda[s.id][0].id); }}
                              disabled={reenviandoNfceId === nfcePorVenda[s.id][0].id}
                              style={{ marginLeft: 6 }}
                            >
                              {reenviandoNfceId === nfcePorVenda[s.id][0].id ? 'Reenviando...' : '🔄 Tentar transmitir de novo'}
                            </button>
                          )}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {promptState && (
        <PromptModal {...promptState} onConfirmar={confirmarPrompt} onCancelar={cancelarPrompt} />
      )}
      {vendaEditando && (
        <EditHistoricoModal sale={vendaEditando} onConfirmar={handleSalvarEdicaoHistorico} onCancelar={() => setVendaEditando(null)} />
      )}
    </div>
  );
}
