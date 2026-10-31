import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ProductPicker } from './SupplyScreen';
import Icon from '../common/Icon';
import { brl, brlCusto, qtd, dataBR, hojeLocal, somarDias } from './erpUtils';

/** Estoque do ERP (Fase 3): inventário (contagem) e movimentação por produto. */

const STATUS = { aberta: ['chip-atualizar', 'Contando'], fechada: ['chip-novo', 'Fechada'], cancelada: ['chip-erro', 'Cancelada'] };
const dataHora = (utc) => (utc ? new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function InventarioTab() {
  const { currentUser } = useSession();
  const [lista, setLista] = useState(null);
  const [abertaId, setAbertaId] = useState(null);
  const [novo, setNovo] = useState({ cega: true, categoria: '' });
  const [categorias, setCategorias] = useState([]);
  const [erro, setErro] = useState('');

  const carregar = () => window.pdv.inventario.listar({ locationId: window.APP_LOCATION_ID }).then((l) => setLista(Array.isArray(l) ? l : []));
  useEffect(() => {
    carregar();
    window.pdv.products.listCategories().then((c) => setCategorias(Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.categoria)).filter(Boolean) : []));
  }, []);

  async function abrir() {
    setErro('');
    const r = await window.pdv.inventario.abrir({ locationId: window.APP_LOCATION_ID, operadorId: currentUser.id, cega: novo.cega, categoria: novo.categoria || null });
    if (!r?.ok) return setErro(r?.error);
    setAbertaId(r.id);
  }

  if (abertaId) return <Contagem id={abertaId} onVoltar={() => { setAbertaId(null); carregar(); }} />;
  const temAberta = lista?.some((c) => c.status === 'aberta');
  return (
    <div>
      <section className="settings-section">
        <h2><Icon name="clipboard" size={16} /> Nova contagem</h2>
        <p className="screen-hint">
          A loja pode continuar vendendo: o que sair durante a contagem é descontado no fechamento. Na contagem cega
          quem conta não vê o saldo do sistema — o número fica mais honesto.
        </p>
        <div className="inline-form">
          <label>Produtos<select value={novo.categoria} onChange={(e) => setNovo({ ...novo, categoria: e.target.value })}>
            <option value="">Todos</option>{categorias.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="nfe-opcao" style={{ alignSelf: 'center' }}><input type="checkbox" checked={novo.cega} onChange={(e) => setNovo({ ...novo, cega: e.target.checked })} /> Contagem cega</label>
          <button className="btn-primary" onClick={abrir} disabled={temAberta}><Icon name="add" size={15} /> Começar contagem</button>
        </div>
        {temAberta && <p className="screen-hint" style={{ marginTop: 8 }}>Já existe uma contagem em andamento — continue por ela na lista abaixo.</p>}
        {erro && <p className="modal-error" style={{ marginTop: 8 }}>{erro}</p>}
      </section>
      {lista === null ? <p className="empty-state">Carregando...</p> : lista.length === 0 ? <p className="empty-state">Nenhuma contagem feita ainda.</p> : (
        <table className="data-table">
          <thead><tr><th>Nº</th><th>Aberta em</th><th>Por</th><th>Produtos</th><th>Contados</th><th style={{ textAlign: 'right' }}>Diferença em R$</th><th>Situação</th><th></th></tr></thead>
          <tbody>{lista.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.numero}</strong></td><td>{dataHora(c.aberta_em)}</td><td>{c.aberta_por_nome}</td>
              <td>{c.itens}{c.categoria ? ` (${c.categoria})` : ''}</td><td>{c.contados}</td>
              <td style={{ textAlign: 'right' }} className={c.valor_diferenca < 0 ? 'text-danger' : ''}>{c.status === 'fechada' ? brl(c.valor_diferenca) : '—'}</td>
              <td><span className={`chip-situacao ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}</span></td>
              <td><button className="btn-link" onClick={() => setAbertaId(c.id)}>{c.status === 'aberta' ? 'Continuar' : 'Ver'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function Contagem({ id, onVoltar }) {
  const { currentUser } = useSession();
  const [c, setC] = useState(null);
  const [filtro, setFiltro] = useState('todos');
  const [busca, setBusca] = useState('');
  const [leitura, setLeitura] = useState({ codigo: '', quantidade: 1 });
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [zerar, setZerar] = useState(false);
  const leitorRef = useRef(null);

  const carregar = () => window.pdv.inventario.obter({ id, filtro, busca }).then(setC);
  useEffect(() => { carregar(); }, [filtro, busca]);

  async function bipar(e) {
    e.preventDefault();
    if (!leitura.codigo.trim()) return;
    const r = await window.pdv.inventario.registrarContagem({ countId: id, codigo: leitura.codigo, quantidade: Number(leitura.quantidade) || 1, modo: 'somar', operadorId: currentUser.id });
    if (!r?.ok) { setErro(r?.error); setMsg(''); } else { setErro(''); setMsg(`${r.nome}: ${qtd(r.qtdContada)} contado(s)`); }
    setLeitura({ codigo: '', quantidade: 1 });
    leitorRef.current?.focus();
    carregar();
  }
  async function definir(item, valor) {
    if (valor === '' || valor === null) {
      await window.pdv.inventario.limparContagem({ countId: id, itemId: item.id });
    } else {
      const r = await window.pdv.inventario.registrarContagem({ countId: id, productId: item.product_id, quantidade: Number(valor), modo: 'definir', operadorId: currentUser.id });
      if (!r?.ok) setErro(r?.error);
    }
    carregar();
  }
  async function fechar() {
    const pendentes = c.resumo.itens - c.resumo.contados;
    const aviso = pendentes > 0 ? (zerar ? `\n${pendentes} produto(s) não contados vão ficar com estoque ZERO.` : `\n${pendentes} produto(s) não contados ficam como estão.`) : '';
    if (!confirm(`Fechar a contagem nº ${c.numero}? As diferenças viram ajuste de estoque.${aviso}`)) return;
    const r = await window.pdv.inventario.fechar({ countId: id, operadorId: currentUser.id, deviceId: window.APP_DEVICE_ID, zerarNaoContados: zerar });
    if (!r?.ok) return setErro(r?.error);
    setMsg(`Contagem fechada: ${r.ajustes} ajuste(s); perdas ${brl(Math.abs(r.perdas))}, sobras ${brl(r.sobras)}.`);
    setFiltro('diferencas');
    carregar();
  }

  if (!c) return <p className="empty-state">Carregando...</p>;
  const aberta = c.status === 'aberta';
  return (
    <div>
      <button className="btn-link" onClick={onVoltar} style={{ marginBottom: 8 }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="arrowLeft" size={14} /> Contagens</span></button>
      <div className="screen-header">
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>Contagem nº {c.numero}
          <span className={`chip-situacao ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}</span></h1>
        {aberta && (
          <div className="screen-actions">
            <button className="btn-secondary" onClick={async () => { if (confirm('Cancelar a contagem? Nada no estoque muda.')) { await window.pdv.inventario.cancelar({ countId: id, operadorId: currentUser.id }); onVoltar(); } }}>Cancelar contagem</button>
            <button className="btn-primary" onClick={fechar}><Icon name="checkCircle" size={15} /> Fechar e ajustar estoque</button>
          </div>
        )}
      </div>
      <p className="screen-hint">Aberta em {dataHora(c.aberta_em)}{c.categoria ? ` · categoria ${c.categoria}` : ''}{c.cega ? ' · cega' : ''}</p>
      <div className="dashboard-stats">
        <div className="stat-card"><span>Contados</span><strong>{c.resumo.contados} de {c.resumo.itens}</strong></div>
        {!aberta && <div className="stat-card"><span>Perdas</span><strong className="valor-erro">{brl(Math.abs(c.resumo.perdas))}</strong></div>}
        {!aberta && <div className="stat-card"><span>Sobras</span><strong>{brl(c.resumo.sobras)}</strong></div>}
      </div>
      {erro && <p className="modal-error" style={{ marginBottom: 8 }}>{erro}</p>}
      {msg && <p className="io-message" style={{ marginBottom: 8 }}>{msg}</p>}
      {aberta && (
        <section className="settings-section">
          <h2><Icon name="search" size={16} /> Leitor de código de barras</h2>
          <form onSubmit={bipar} className="inline-form">
            <label>Código<input ref={leitorRef} autoFocus value={leitura.codigo} onChange={(e) => setLeitura({ ...leitura, codigo: e.target.value })} placeholder="Bipe o produto" /></label>
            <label>Quantidade<input type="number" min="0" step="any" style={{ width: 90 }} value={leitura.quantidade} onChange={(e) => setLeitura({ ...leitura, quantidade: e.target.value })} /></label>
            <button className="btn-primary" type="submit">Somar</button>
          </form>
          <p className="screen-hint" style={{ marginTop: 8, marginBottom: 0 }}>Cada leitura soma. Para corrigir, digite o total na linha do produto.</p>
          <label className="nfe-opcao" style={{ marginTop: 10 }}><input type="checkbox" checked={zerar} onChange={(e) => setZerar(e.target.checked)} /> Ao fechar, zerar o que não foi contado (não achei na loja)</label>
        </section>
      )}
      <div className="period-selector">
        {[['todos', 'Todos'], ['pendentes', 'Não contados'], ['contados', 'Contados'], ...(aberta ? [] : [['diferencas', 'Com diferença']])].map(([v, r]) => (
          <button key={v} className={filtro === v ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setFiltro(v)}>{r}</button>
        ))}
        <input placeholder="Buscar produto" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      {c.itens.length === 0 ? <p className="empty-state">Nenhum produto neste filtro.</p> : (
        <table className="data-table">
          <thead><tr><th>Produto</th>{(!c.cega || !aberta) && <th>Sistema</th>}<th>Contado</th>{!aberta && <><th>Esperado</th><th>Diferença</th><th style={{ textAlign: 'right' }}>Em R$</th></>}</tr></thead>
          <tbody>{c.itens.map((i) => (
            <tr key={i.id} className={!aberta && i.diferenca < 0 ? 'row-critical' : !aberta && i.diferenca > 0 ? 'row-warning' : ''}>
              <td>{i.nome}<div className="nfe-item-codigos">{i.codigo_barras || i.sku || ''}</div></td>
              {(!c.cega || !aberta) && <td>{i.qtd_sistema === null ? '—' : `${qtd(i.qtd_sistema)} ${i.unidade || ''}`}</td>}
              <td>{aberta ? (
                <input type="number" min="0" step="any" style={{ width: 90 }} defaultValue={i.qtd_contada ?? ''} key={`${i.id}-${i.qtd_contada}`}
                  onBlur={(e) => { const v = e.target.value; if (String(v) !== String(i.qtd_contada ?? '')) definir(i, v); }} />
              ) : (i.qtd_contada === null ? '—' : qtd(i.qtd_contada))}</td>
              {!aberta && <><td>{i.qtd_esperada === null ? '—' : qtd(i.qtd_esperada)}</td><td>{i.diferenca === null ? '—' : `${i.diferenca > 0 ? '+' : ''}${qtd(i.diferenca)}`}</td>
                <td style={{ textAlign: 'right' }}>{i.diferenca ? brl(i.diferenca * i.custo_unitario) : '—'}</td></>}
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

export function MovimentacaoTab() {
  const [produto, setProduto] = useState(null);
  const [periodo, setPeriodo] = useState({ dataInicio: somarDias(hojeLocal(), -30), dataFim: hojeLocal() });
  const [k, setK] = useState(null);
  useEffect(() => {
    if (!produto) return;
    window.pdv.inventario.kardex({ productId: produto.id, locationId: window.APP_LOCATION_ID, ...periodo }).then(setK);
  }, [produto?.id, periodo]);
  return (
    <div>
      <div className="period-selector">
        <ProductPicker value={produto} onChange={(p) => { if (p) setProduto(p); }} width={280} />
        <input type="date" value={periodo.dataInicio} onChange={(e) => setPeriodo({ ...periodo, dataInicio: e.target.value })} />
        <span className="screen-hint" style={{ margin: 0 }}>até</span>
        <input type="date" value={periodo.dataFim} onChange={(e) => setPeriodo({ ...periodo, dataFim: e.target.value })} />
      </div>
      {!produto ? <p className="empty-state">Escolha um produto para ver tudo o que entrou e saiu, com o saldo depois de cada movimento.</p>
        : !k ? <p className="empty-state">Carregando...</p> : k.ok === false ? <p className="modal-error">{k.error}</p> : (
          <>
            <div className="dashboard-stats">
              <div className="stat-card"><span>Saldo antes</span><strong>{qtd(k.saldoAnterior)}</strong></div>
              <div className="stat-card"><span>Entradas</span><strong>{qtd(k.entradas)}</strong></div>
              <div className="stat-card"><span>Saídas</span><strong className="valor-erro">{qtd(k.saidas)}</strong></div>
              <div className="stat-card"><span>Saldo no fim</span><strong>{qtd(k.saldoFinal)} {k.produto.unidade}</strong></div>
              <div className="stat-card"><span>Custo médio atual</span><strong>{brlCusto(k.produto.custo)}</strong></div>
            </div>
            <div className="erp-duas-colunas" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
              <section className="settings-section">
                <h2>Movimentos</h2>
                {k.movimentos.length === 0 ? <p className="empty-state">Nenhum movimento no período.</p> : (
                  <table className="data-table">
                    <thead><tr><th>Quando</th><th>Tipo</th><th>Motivo</th><th style={{ textAlign: 'right' }}>Qtd</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
                    <tbody>{k.movimentos.map((m) => (
                      <tr key={m.id}><td>{dataHora(m.criado_em)}</td><td>{m.tipoRotulo}</td><td>{m.motivo || (m.sale_id ? 'Venda' : '—')}{m.operador_nome ? <div className="nfe-item-codigos">{m.operador_nome}</div> : null}</td>
                        <td style={{ textAlign: 'right' }} className={m.quantidade < 0 ? 'text-danger' : ''}>{m.quantidade > 0 ? '+' : ''}{qtd(m.quantidade)}</td><td style={{ textAlign: 'right' }}>{qtd(m.saldo)}</td></tr>
                    ))}</tbody>
                  </table>
                )}
                {k.cortado && <p className="screen-hint">Mostrando os últimos 500 movimentos do período.</p>}
              </section>
              <section className="settings-section">
                <h2>Histórico do custo médio</h2>
                {k.custos.length === 0 ? <p className="empty-state">Sem entradas com custo registradas.</p> : (
                  <table className="data-table">
                    <thead><tr><th>Quando</th><th>Entrada</th><th style={{ textAlign: 'right' }}>Custo</th></tr></thead>
                    <tbody>{k.custos.map((h, i) => (
                      <tr key={i}><td>{dataHora(h.criado_em)}<div className="nfe-item-codigos">{h.tipo === 'estorno' ? 'estorno' : h.origem === 'nfe' ? 'nota fiscal' : h.origem === 'pedido_compra' ? 'pedido' : 'abastecimento'}</div></td>
                        <td>{qtd(h.qtd_movimento)} a {brlCusto(h.custo_movimento)}</td>
                        <td style={{ textAlign: 'right' }}>{brlCusto(h.custo_antes)} → <strong>{brlCusto(h.custo_depois)}</strong></td></tr>
                    ))}</tbody>
                  </table>
                )}
              </section>
            </div>
          </>
        )}
    </div>
  );
}
