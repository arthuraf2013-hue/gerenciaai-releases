import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import { brl, dataBR, hojeLocal, somarDias, useModulosErp, ModuloInativo } from './erpUtils';

/** Painel executivo (ERP, BI): números do período, comparação, ABC, estoque parado, clientes e alertas. */

const PERIODOS = [['mes', 'Este mês'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['ano', 'Este ano']];
const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR')}%`);

function Variacao({ v }) {
  if (v === null || v === undefined) return <span className="erp-pct">sem base</span>;
  return <span className="erp-pct" style={{ color: v >= 0 ? 'var(--color-primary)' : 'var(--color-danger)' }}>{pct(v)} vs. anterior</span>;
}

function Barras({ serie }) {
  const max = Math.max(1, ...serie.map((d) => d.valor));
  return (
    <div className="erp-barras-mes" style={{ height: 140 }}>
      {serie.map((d) => (
        <div key={d.data} className="erp-barra-mes" title={`${dataBR(d.data)}: ${brl(d.valor)}`}>
          <div className="erp-barra-mes-valor" style={{ height: `${d.valor ? Math.max(2, (d.valor / max) * 100) : 0}%` }} />
          {serie.length <= 31 && <span>{d.data.slice(8, 10)}</span>}
        </div>
      ))}
    </div>
  );
}

export function PainelExecutivoScreen() {
  const modulos = useModulosErp();
  const [periodo, setPeriodo] = useState('mes');
  const [p, setP] = useState(null);
  useEffect(() => {
    if (!modulos?.bi) return;
    const hoje = hojeLocal();
    const de = periodo === 'mes' ? `${hoje.slice(0, 7)}-01` : periodo === 'ano' ? `${hoje.slice(0, 4)}-01-01` : somarDias(hoje, -(Number(periodo) - 1));
    setP(null);
    window.pdv.bi.painel({ locationId: window.APP_LOCATION_ID, dataInicio: de, dataFim: hoje }).then(setP);
  }, [periodo, modulos?.bi]);
  if (modulos === null) return <div className="screen"><p className="empty-state">Carregando...</p></div>;
  if (!modulos.bi) return <ModuloInativo modulo="financeiro" semPermissao={modulos.financeiroLicenciado && modulos.semPermissao.bi} />;
  return (
    <div className="screen">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="chart" size={20} /> Painel executivo</h1>
      <div className="period-selector">{PERIODOS.map(([v, t]) => <button key={v} className={periodo === v ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(v)}>{t}</button>)}</div>
      {!p ? <p className="empty-state">Calculando...</p> : p.ok === false ? <p className="modal-error">{p.error}</p> : (
        <>
          {p.alertas.length > 0 && (
            <section className="settings-section">
              <h2><Icon name="warning" size={16} /> Atenção</h2>
              {p.alertas.map((a) => (
                <p key={a.texto} className={a.nivel === 'critico' ? 'modal-error erp-aviso' : a.nivel === 'aviso' ? 'io-message-aviso' : 'io-message'} style={{ marginBottom: 6 }}>
                  <strong style={{ textTransform: 'capitalize' }}>{a.area}:</strong> {a.texto}
                </p>
              ))}
            </section>
          )}
          <div className="dashboard-stats">
            <div className="stat-card"><span>Faturamento</span><strong>{brl(p.atual.faturamento)}</strong><Variacao v={p.variacao.faturamento} /></div>
            <div className="stat-card"><span>Lucro bruto</span><strong>{brl(p.atual.lucroBruto)}</strong><Variacao v={p.variacao.lucroBruto} /></div>
            <div className="stat-card"><span>Margem bruta</span><strong>{p.atual.margemBruta === null ? '—' : `${p.atual.margemBruta}%`}</strong><span className="erp-pct">antes: {p.anterior.margemBruta === null ? '—' : `${p.anterior.margemBruta}%`}</span></div>
            <div className="stat-card"><span>Vendas · ticket médio</span><strong>{p.atual.vendas} · {brl(p.atual.ticketMedio)}</strong><Variacao v={p.variacao.ticketMedio} /></div>
            <div className="stat-card"><span>Despesas pagas</span><strong>{brl(p.atual.despesasPagas)}</strong><span className="erp-pct">sobra: {brl(p.atual.resultadoCaixa)}</span></div>
            {p.projecaoMes !== null && <div className="stat-card"><span>Mês fecha em (ritmo atual)</span><strong>{brl(p.projecaoMes)}</strong></div>}
          </div>
          <section className="settings-section">
            <h2><Icon name="trendUp" size={16} /> Faturamento por dia ({dataBR(p.de)} a {dataBR(p.ate)})</h2>
            <Barras serie={p.serie} />
            <p className="screen-hint">Comparado com {dataBR(p.anteriorDe)} a {dataBR(p.anteriorAte)}: {brl(p.anterior.faturamento)}.</p>
          </section>
          <div className="erp-duas-colunas">
            <section className="settings-section">
              <h2><Icon name="star" size={16} /> Curva ABC</h2>
              <div className="period-selector">{p.abcResumo.map((c) => <span key={c.classe} className="chip-situacao chip-neutro">{c.classe}: {c.produtos} produto(s) · {brl(c.receita)}</span>)}</div>
              {p.abc.length === 0 ? <p className="empty-state">Sem vendas no período.</p> : (
                <table className="data-table">
                  <thead><tr><th>Produto</th><th>Classe</th><th style={{ textAlign: 'right' }}>Receita</th><th style={{ textAlign: 'right' }}>Margem</th></tr></thead>
                  <tbody>{p.abc.slice(0, 15).map((x) => (
                    <tr key={x.productId}><td>{x.nome}<div className="nfe-item-codigos">{x.participacao}% da receita</div></td><td><strong>{x.classe}</strong></td>
                      <td style={{ textAlign: 'right' }}>{brl(x.receita)}</td><td style={{ textAlign: 'right' }} className={x.margem !== null && x.margem < 10 ? 'valor-erro' : undefined}>{x.margem === null ? '—' : `${x.margem}%`}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>
            <section className="settings-section">
              <h2><Icon name="box" size={16} /> Estoque parado (60+ dias sem venda)</h2>
              <p className="screen-hint">{brl(p.valorParado)} parados pelo custo médio.</p>
              {p.estoqueParado.length === 0 ? <p className="empty-state">Nada parado.</p> : (
                <table className="data-table">
                  <thead><tr><th>Produto</th><th style={{ textAlign: 'right' }}>Estoque</th><th style={{ textAlign: 'right' }}>Valor</th><th>Última venda</th></tr></thead>
                  <tbody>{p.estoqueParado.slice(0, 15).map((x) => (
                    <tr key={x.productId}><td>{x.nome}</td><td style={{ textAlign: 'right' }}>{x.estoque}</td><td style={{ textAlign: 'right' }}>{brl(x.valorParado)}</td><td>{x.ultimaVenda ? dataBR(x.ultimaVenda) : 'nunca'}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {p.ruptura.length > 0 && <p className="modal-error" style={{ marginTop: 10 }}>Curva A no mínimo: {p.ruptura.map((r) => `${r.nome} (${r.estoque})`).join(', ')}</p>}
            </section>
          </div>
          <section className="settings-section">
            <h2><Icon name="users" size={16} /> Clientes que mais dão lucro</h2>
            {p.clientes.length === 0 ? <p className="empty-state">Nenhuma venda com cliente identificado no período.</p> : (
              <table className="data-table">
                <thead><tr><th>Cliente</th><th style={{ textAlign: 'right' }}>Compras</th><th style={{ textAlign: 'right' }}>Receita</th><th style={{ textAlign: 'right' }}>Lucro</th></tr></thead>
                <tbody>{p.clientes.map((c) => <tr key={c.customerId}><td>{c.nome}</td><td style={{ textAlign: 'right' }}>{c.compras}</td><td style={{ textAlign: 'right' }}>{brl(c.receita)}</td><td style={{ textAlign: 'right' }}><strong>{brl(c.lucro)}</strong></td></tr>)}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
