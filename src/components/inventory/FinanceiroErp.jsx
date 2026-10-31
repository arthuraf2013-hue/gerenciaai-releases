import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';
import { brl, dataBR, mesCurto, mesAtualLocal, somarMeses, hojeLocal, somarDias } from './erpUtils';

/** Abas do financeiro do ERP (Fase 2): contas a receber, fluxo de caixa,
 * DRE e ajustes (saldo inicial, maquininhas, despesas fixas). */

export const CATEGORIAS_DESPESA = [
  { value: 'aluguel', label: 'Aluguel' },
  { value: 'contas_consumo', label: 'Água/Luz/Internet' },
  { value: 'fornecedor', label: 'Fornecedor (compra de mercadoria)' },
  { value: 'salario', label: 'Salário' },
  { value: 'impostos', label: 'Impostos' },
  { value: 'taxas_bancarias', label: 'Tarifas bancárias' },
  { value: 'manutencao', label: 'Manutenção' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'servicos_terceiros', label: 'Serviços de terceiros' },
  { value: 'retirada_socio', label: 'Retirada do dono (pró-labore)' },
  { value: 'outro', label: 'Outro' },
];
export const CATEGORIA_LABEL = Object.fromEntries(CATEGORIAS_DESPESA.map((c) => [c.value, c.label]));

const METODO_LABEL = { cartao_debito: 'Débito', cartao_credito: 'Crédito' };

// ---------------- contas a receber ----------------

export function ContasAReceberTab() {
  const { currentUser } = useSession();
  const [dados, setDados] = useState(null);
  const [form, setForm] = useState(null);
  const [erro, setErro] = useState('');
  const [baixando, setBaixando] = useState(null);
  useEscToClose(() => { setForm(null); setBaixando(null); }, !!form || !!baixando);

  const carregar = () => window.pdv.financeiro.contasAReceber({ locationId: window.APP_LOCATION_ID }).then(setDados);
  useEffect(() => { carregar(); }, []);

  async function salvar(e) {
    e.preventDefault();
    const r = await window.pdv.financeiro.criarRecebivel({ ...form, valor: Number(String(form.valor).replace(',', '.')), locationId: window.APP_LOCATION_ID, operadorId: currentUser.id });
    if (!r?.ok) return setErro(r?.error);
    setForm(null); setErro(''); carregar();
  }
  async function baixar(e) {
    e.preventDefault();
    const r = await window.pdv.financeiro.receberRecebivel({ id: baixando.id, data: baixando.data, valor: Number(String(baixando.valor).replace(',', '.')) });
    if (!r?.ok) return setErro(r?.error);
    setBaixando(null); setErro(''); carregar();
  }

  if (!dados) return <p className="empty-state">Carregando...</p>;
  return (
    <div>
      <div className="dashboard-stats">
        <div className="stat-card"><span>Cartão a cair</span><strong>{brl(dados.totais.cartao)}</strong></div>
        <div className="stat-card"><span>Contas lançadas</span><strong>{brl(dados.totais.manuais)}</strong></div>
        <div className="stat-card"><span>Fiado em aberto</span><strong>{brl(dados.totais.fiado)}</strong></div>
      </div>
      {erro && <p className="modal-error" style={{ marginBottom: 10 }}>{erro}</p>}

      <section className="settings-section">
        <h2><Icon name="card" size={16} /> Cartão a cair</h2>
        <p className="screen-hint">Vendas já feitas no cartão, na data em que o dinheiro cai, já sem a taxa da maquininha (ajuste em Ajustes).</p>
        {dados.cartao.length === 0 ? <p className="empty-state">Nada a receber de cartão.</p> : (
          <table className="data-table">
            <thead><tr><th>Cai em</th><th>Tipo</th><th>Vendas</th><th style={{ textAlign: 'right' }}>Bruto</th><th style={{ textAlign: 'right' }}>Taxa</th><th style={{ textAlign: 'right' }}>Líquido</th></tr></thead>
            <tbody>{dados.cartao.map((c) => (
              <tr key={`${c.data}-${c.metodo}`}><td>{dataBR(c.data)}</td><td>{METODO_LABEL[c.metodo]}</td><td>{c.vendas}</td>
                <td style={{ textAlign: 'right' }}>{brl(c.bruto)}</td><td style={{ textAlign: 'right' }}>{brl(c.taxa)}</td><td style={{ textAlign: 'right' }}><strong>{brl(c.liquido)}</strong></td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <div className="screen-header"><h2 style={{ margin: 0 }}><Icon name="receipt" size={16} /> Contas a receber lançadas</h2>
          <button className="btn-primary" onClick={() => setForm({ descricao: '', valor: '', vencimento: hojeLocal() })}><Icon name="add" size={15} /> Nova conta a receber</button></div>
        {dados.manuais.length === 0 ? <p className="empty-state">Nenhuma conta a receber em aberto.</p> : (
          <table className="data-table">
            <thead><tr><th>Vencimento</th><th>Descrição</th><th>Cliente</th><th style={{ textAlign: 'right' }}>Valor</th><th></th></tr></thead>
            <tbody>{dados.manuais.map((r) => (
              <tr key={r.id} className={r.vencida ? 'row-warning' : ''}>
                <td>{dataBR(r.vencimento)}{r.vencida && <span className="badge-warning" style={{ marginLeft: 6, fontSize: 12 }}>vencida</span>}</td>
                <td>{r.descricao}</td><td>{r.cliente_nome || '—'}</td><td style={{ textAlign: 'right' }}>{brl(r.valor)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-link" onClick={() => setBaixando({ id: r.id, descricao: r.descricao, data: hojeLocal(), valor: r.valor })}><Icon name="checkCircle" size={14} /> Recebi</button>
                  <button className="btn-link-danger" onClick={async () => { if (confirm('Cancelar esta conta a receber?')) { await window.pdv.financeiro.cancelarRecebivel({ id: r.id }); carregar(); } }}><Icon name="close" size={14} /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <h2><Icon name="users" size={16} /> Fiado em aberto</h2>
        <p className="screen-hint">O recebimento do fiado continua na tela de Clientes; aqui é a visão de quanto está na rua.</p>
        {dados.fiado.length === 0 ? <p className="empty-state">Nenhum cliente devendo.</p> : (
          <table className="data-table">
            <thead><tr><th>Cliente</th><th>Telefone</th><th>Devendo desde</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
            <tbody>{dados.fiado.map((f) => (
              <tr key={f.id}><td>{f.nome}</td><td>{f.telefone || '—'}</td><td>{dataBR(f.desde)}</td><td style={{ textAlign: 'right' }}>{brl(f.saldo)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      {form && (
        <div className="modal-overlay"><div className="modal-card"><form onSubmit={salvar}>
          <h2><Icon name="add" size={18} /> Nova conta a receber</h2>
          <label>Descrição<input autoFocus value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} required /></label>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>Valor (R$)<input type="number" step="0.01" min="0.01" value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} required /></label>
            <label>Vencimento<input type="date" value={form.vencimento} onChange={(e) => setForm({ ...form, vencimento: e.target.value })} required /></label>
          </div>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}>Cancelar</button>
            <button type="submit" className="btn-primary"><Icon name="save" size={16} /> Salvar</button>
          </div>
        </form></div></div>
      )}
      {baixando && (
        <div className="modal-overlay"><div className="modal-card"><form onSubmit={baixar}>
          <h2><Icon name="checkCircle" size={18} /> Recebimento — {baixando.descricao}</h2>
          <div className="form-grid">
            <label>Recebido em<input type="date" value={baixando.data} max={hojeLocal()} onChange={(e) => setBaixando({ ...baixando, data: e.target.value })} required /></label>
            <label>Valor recebido (R$)<input type="number" step="0.01" min="0.01" value={baixando.valor} onChange={(e) => setBaixando({ ...baixando, valor: e.target.value })} required /></label>
          </div>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={() => setBaixando(null)}>Voltar</button>
            <button type="submit" className="btn-primary">Confirmar recebimento</button>
          </div>
        </form></div></div>
      )}
    </div>
  );
}

// ---------------- fluxo de caixa ----------------

/** Linha do saldo dia a dia; a parte prevista vem tracejada. SVG puro. */
function GraficoSaldo({ dias, hoje }) {
  if (!dias || dias.length < 2) return null;
  const W = 900; const H = 200; const P = { e: 64, d: 12, t: 12, b: 26 };
  const vals = dias.map((d) => d.saldo);
  let min = Math.min(0, ...vals); let max = Math.max(0, ...vals);
  if (max === min) max = min + 1;
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x = (i) => P.e + (i / (dias.length - 1)) * (W - P.e - P.d);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const iHoje = dias.findIndex((d) => d.data > hoje);
  const pontos = dias.map((d, i) => `${x(i).toFixed(1)},${y(d.saldo).toFixed(1)}`);
  const real = iHoje === -1 ? pontos : pontos.slice(0, Math.max(1, iHoje));
  const prev = iHoje === -1 ? [] : pontos.slice(Math.max(0, iHoje - 1));
  const ticks = [min + pad, (min + max) / 2, max - pad];
  const marcas = [0, Math.floor((dias.length - 1) / 2), dias.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="erp-grafico" role="img" aria-label="Saldo dia a dia">
      {ticks.map((t) => (
        <g key={t}><line x1={P.e} x2={W - P.d} y1={y(t)} y2={y(t)} className="erp-grafico-grade" />
          <text x={P.e - 8} y={y(t) + 4} textAnchor="end" className="erp-grafico-rotulo">{brl(t).replace(/,\d\d$/, '')}</text></g>
      ))}
      {min < 0 && max > 0 && <line x1={P.e} x2={W - P.d} y1={y(0)} y2={y(0)} className="erp-grafico-zero" />}
      <polyline points={real.join(' ')} className="erp-grafico-linha" />
      {prev.length > 1 && <polyline points={prev.join(' ')} className="erp-grafico-linha erp-grafico-prevista" />}
      {marcas.map((i) => <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === dias.length - 1 ? 'end' : 'middle'} className="erp-grafico-rotulo">{dataBR(dias[i].data).slice(0, 5)}</text>)}
    </svg>
  );
}

export function FluxoCaixaTab() {
  const hoje = hojeLocal();
  const [periodo, setPeriodo] = useState({ dataInicio: somarDias(hoje, -15), dataFim: somarDias(hoje, 45) });
  const [f, setF] = useState(null);
  const [soMovimento, setSoMovimento] = useState(true);
  useEffect(() => { window.pdv.financeiro.fluxoDeCaixa({ locationId: window.APP_LOCATION_ID, ...periodo }).then(setF); }, [periodo]);
  if (!f) return <p className="empty-state">Carregando...</p>;
  if (f.ok === false) return <p className="modal-error">{f.error}</p>;
  const dias = soMovimento ? f.dias.filter((d) => d.entradas || d.saidas) : f.dias;
  const atalhos = [['Próximos 30 dias', hoje, somarDias(hoje, 30)], ['Próximos 90 dias', hoje, somarDias(hoje, 90)], ['Últimos 30 + próximos 30', somarDias(hoje, -30), somarDias(hoje, 30)]];
  return (
    <div>
      <div className="period-selector">
        {atalhos.map(([r, a, b]) => <button key={r} className="category-btn" onClick={() => setPeriodo({ dataInicio: a, dataFim: b })}>{r}</button>)}
        <input type="date" value={periodo.dataInicio} onChange={(e) => setPeriodo({ ...periodo, dataInicio: e.target.value })} />
        <span className="screen-hint" style={{ margin: 0 }}>até</span>
        <input type="date" value={periodo.dataFim} onChange={(e) => setPeriodo({ ...periodo, dataFim: e.target.value })} />
      </div>
      {f.avisos.map((a) => <p key={a} className="io-message-aviso" style={{ marginBottom: 8 }}><Icon name="warning" size={15} /> {a}</p>)}
      <div className="dashboard-stats">
        <div className="stat-card"><span>Saldo no início</span><strong>{brl(f.saldoInicialPeriodo)}</strong></div>
        <div className="stat-card"><span>Entradas</span><strong>{brl(f.totais.entradas)}</strong></div>
        <div className="stat-card"><span>Saídas</span><strong className="valor-erro">{brl(f.totais.saidas)}</strong></div>
        <div className="stat-card"><span>Saldo no fim</span><strong className={f.saldoFinal < 0 ? 'valor-erro' : undefined}>{brl(f.saldoFinal)}</strong></div>
      </div>
      <section className="settings-section">
        <h2><Icon name="trendUp" size={16} /> Saldo dia a dia</h2>
        <p className="screen-hint">Linha cheia: o que já aconteceu. Tracejada: previsão (cartão a cair, contas a pagar e a receber, despesas fixas).</p>
        <GraficoSaldo dias={f.dias} hoje={f.hoje} />
      </section>
      <div className="erp-duas-colunas">
        <section className="settings-section">
          <h2>De onde vem e para onde vai</h2>
          <table className="data-table">
            <thead><tr><th>Origem</th><th style={{ textAlign: 'right' }}>Realizado</th><th style={{ textAlign: 'right' }}>Previsto</th></tr></thead>
            <tbody>{f.porOrigem.map((o) => (
              <tr key={`${o.tipo}${o.origem}`}><td>{o.tipo === 'saida' ? '− ' : '+ '}{o.origem}</td>
                <td style={{ textAlign: 'right' }}>{o.realizado ? brl(o.realizado) : '—'}</td><td style={{ textAlign: 'right' }}>{o.previsto ? brl(o.previsto) : '—'}</td></tr>
            ))}</tbody>
          </table>
        </section>
        <section className="settings-section">
          <div className="screen-header"><h2 style={{ margin: 0 }}>Dia a dia</h2>
            <label className="nfe-opcao" style={{ fontSize: 13 }}><input type="checkbox" checked={soMovimento} onChange={(e) => setSoMovimento(e.target.checked)} /> Só dias com movimento</label></div>
          {dias.length === 0 ? <p className="empty-state">Nenhum movimento no período.</p> : (
            <table className="data-table">
              <thead><tr><th>Dia</th><th style={{ textAlign: 'right' }}>Entradas</th><th style={{ textAlign: 'right' }}>Saídas</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
              <tbody>{dias.map((d) => (
                <tr key={d.data} className={d.saldo < 0 ? 'row-critical' : d.previsto ? 'erp-linha-prevista' : ''}>
                  <td>{dataBR(d.data)}{d.data === f.hoje ? ' (hoje)' : ''}</td><td style={{ textAlign: 'right' }}>{d.entradas ? brl(d.entradas) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{d.saidas ? brl(d.saidas) : '—'}</td><td style={{ textAlign: 'right' }}>{brl(d.saldo)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------- DRE ----------------

export function DreTab() {
  const [qtdMeses, setQtdMeses] = useState(3);
  const [dre, setDre] = useState(null);
  const competencias = useMemo(() => {
    const atual = mesAtualLocal();
    return Array.from({ length: qtdMeses }, (_, i) => somarMeses(atual, i - qtdMeses + 1));
  }, [qtdMeses]);
  useEffect(() => { window.pdv.financeiro.dre({ locationId: window.APP_LOCATION_ID, competencias }).then(setDre); }, [competencias]);
  if (!dre) return <p className="empty-state">Carregando...</p>;
  if (dre.ok === false) return <p className="modal-error">{dre.error}</p>;
  const m = dre.meses;
  const categorias = [...new Set(m.flatMap((x) => x.despesas.map((d) => d.categoria)))];
  const linha = (rotulo, campo, { forte, menos, pct, cls } = {}) => (
    <tr className={forte ? 'erp-dre-total' : cls}>
      <td>{rotulo}</td>
      {m.map((x) => {
        const v = typeof campo === 'function' ? campo(x) : x[campo];
        return <td key={x.competencia} style={{ textAlign: 'right' }}>{v === null || v === undefined ? '—' : `${menos && v ? '− ' : ''}${brl(v)}`}{pct && x[pct] !== null ? <span className="erp-pct"> {x[pct]}%</span> : ''}</td>;
      })}
    </tr>
  );
  const estimado = m.some((x) => x.impostosOrigem !== 'despesas');
  const itensEstimados = m.reduce((s, x) => s + x.cmvItensEstimados, 0);
  return (
    <div>
      <div className="period-selector">
        {[3, 6, 12].map((n) => <button key={n} className={qtdMeses === n ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setQtdMeses(n)}>Últimos {n} meses</button>)}
      </div>
      <section className="settings-section" style={{ overflowX: 'auto' }}>
        <table className="data-table erp-dre">
          <thead><tr><th>Demonstração do resultado</th>{m.map((x) => <th key={x.competencia} style={{ textAlign: 'right' }}>{mesCurto(x.competencia)}</th>)}</tr></thead>
          <tbody>
            {linha('Vendas (bruto)', 'receitaBruta')}
            {linha('Descontos', 'descontos', { menos: true })}
            {linha('Devoluções', 'devolucoes', { menos: true })}
            {linha('Receita líquida', 'receitaLiquida', { forte: true })}
            {linha(estimado ? 'Impostos sobre vendas (estimado)' : 'Impostos', 'impostos', { menos: true })}
            {linha('Custo das mercadorias vendidas (CMV)', 'cmv', { menos: true })}
            {linha('Lucro bruto', 'lucroBruto', { forte: true, pct: 'margemBruta' })}
            {linha('Taxas de cartão', 'taxasCartao', { menos: true })}
            {categorias.map((c) => <tr key={c}><td className="erp-dre-sub">{CATEGORIA_LABEL[c] || c}</td>{m.map((x) => { const d = x.despesas.find((y) => y.categoria === c); return <td key={x.competencia} style={{ textAlign: 'right' }}>{d ? `− ${brl(d.total)}` : '—'}</td>; })}</tr>)}
            {linha('Total de despesas', 'totalDespesas', { menos: true })}
            {linha('Resultado', 'resultado', { forte: true, pct: 'margemLiquida' })}
            {linha('Retiradas do dono', 'retiradas', { cls: 'erp-dre-info' })}
            {linha('Compras de mercadoria (vão para o estoque)', 'comprasMercadoria', { cls: 'erp-dre-info' })}
          </tbody>
        </table>
      </section>
      <p className="screen-hint">
        CMV pelo custo médio do produto na hora de cada venda. Compra de mercadoria não é despesa: entra no estoque e vira CMV quando vende.
        {estimado && ' Imposto estimado: DAS do MEI ou alíquota efetiva do Simples (Anexo I) — o valor certo é o do contador.'}
        {itensEstimados > 0 && ` ${itensEstimados} item(ns) vendidos antes desta versão usaram o custo atual do produto.`}
      </p>
    </div>
  );
}

// ---------------- ajustes ----------------

export function AjustesFinanceiroTab() {
  const { currentUser } = useSession();
  const [config, setConfig] = useState(null);
  const [taxas, setTaxas] = useState([]);
  const [recorrencias, setRecorrencias] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [nova, setNova] = useState(null);
  const [parcelada, setParcelada] = useState(null);
  const [saldo, setSaldo] = useState({ valor: '', data: '' });
  useEscToClose(() => { setNova(null); setParcelada(null); }, !!nova || !!parcelada);

  const carregar = () => {
    window.pdv.erp.getConfig().then((c) => { setConfig(c); setSaldo({ valor: c?.saldo_inicial ?? '', data: c?.data_saldo_inicial || '' }); });
    window.pdv.financeiro.getTaxas().then((t) => setTaxas(Array.isArray(t) ? t.map((x) => ({ metodo: x.metodo, taxaPercentual: x.taxa_percentual, prazoDias: x.prazo_dias })) : []));
    window.pdv.financeiro.listarRecorrencias().then((r) => setRecorrencias(Array.isArray(r) ? r : []));
  };
  useEffect(() => { carregar(); window.pdv.suppliers.list({}).then((l) => setFornecedores(Array.isArray(l) ? l : [])); }, []);
  const ok = (r, texto) => { if (!r?.ok) { setErro(r?.error || 'Não foi possível salvar.'); setMsg(''); return false; } setErro(''); setMsg(texto); carregar(); return true; };

  if (!config) return <p className="empty-state">Carregando...</p>;
  return (
    <div>
      {erro && <p className="modal-error" style={{ marginBottom: 10 }}>{erro}</p>}
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      <div className="erp-duas-colunas">
        <section className="settings-section">
          <h2><Icon name="cash" size={16} /> Saldo inicial do fluxo de caixa</h2>
          <p className="screen-hint">Quanto havia em caixa + banco no começo de um dia. O fluxo de caixa soma tudo a partir daí.</p>
          <div className="form-grid">
            <label>Saldo (R$)<input type="number" step="0.01" value={saldo.valor} onChange={(e) => setSaldo({ ...saldo, valor: e.target.value })} /></label>
            <label>No começo do dia<input type="date" value={saldo.data} onChange={(e) => setSaldo({ ...saldo, data: e.target.value })} /></label>
          </div>
          <div className="settings-actions"><button className="btn-primary" onClick={async () => ok(await window.pdv.erp.salvarConfig({
            saldoInicial: saldo.valor, dataSaldoInicial: saldo.data,
          }), 'Saldo inicial salvo.')}>Salvar saldo</button></div>
        </section>
        <section className="settings-section">
          <h2><Icon name="card" size={16} /> Maquininha de cartão</h2>
          <p className="screen-hint">Taxa cobrada e em quantos dias o dinheiro cai. Usado em contas a receber, fluxo de caixa e DRE.</p>
          {taxas.map((t, i) => (
            <div key={t.metodo} className="form-grid" style={{ marginBottom: 8 }}>
              <label>{METODO_LABEL[t.metodo]} — taxa (%)<input type="number" step="0.01" min="0" value={t.taxaPercentual} onChange={(e) => setTaxas(taxas.map((x, j) => (j === i ? { ...x, taxaPercentual: e.target.value } : x)))} /></label>
              <label>Cai em (dias)<input type="number" step="1" min="0" value={t.prazoDias} onChange={(e) => setTaxas(taxas.map((x, j) => (j === i ? { ...x, prazoDias: e.target.value } : x)))} /></label>
            </div>
          ))}
          <div className="settings-actions"><button className="btn-primary" onClick={async () => ok(await window.pdv.financeiro.salvarTaxas({ taxas: taxas.map((t) => ({ ...t, taxaPercentual: Number(t.taxaPercentual), prazoDias: Number(t.prazoDias) })) }), 'Taxas salvas.')}>Salvar taxas</button></div>
        </section>
      </div>

      <section className="settings-section">
        <div className="screen-header"><h2 style={{ margin: 0 }}><Icon name="calendar" size={16} /> Despesas fixas (todo mês)</h2>
          <div className="screen-actions">
            <button className="btn-secondary" onClick={() => setParcelada({ descricao: '', categoria: 'manutencao', valorTotal: '', parcelas: 3, primeiroVencimento: somarDias(hojeLocal(), 30) })}>Despesa parcelada</button>
            <button className="btn-primary" onClick={() => setNova({ descricao: '', categoria: 'aluguel', valor: '', diaVencimento: 10, competenciaInicio: mesAtualLocal(), fornecedorId: '' })}><Icon name="add" size={15} /> Nova despesa fixa</button>
          </div></div>
        <p className="screen-hint">Cada mês entra sozinha em contas a pagar. Excluir a conta de um mês não faz ela voltar.</p>
        {recorrencias.length === 0 ? <p className="empty-state">Nenhuma despesa fixa cadastrada.</p> : (
          <table className="data-table">
            <thead><tr><th>Descrição</th><th>Categoria</th><th>Vence dia</th><th style={{ textAlign: 'right' }}>Valor</th><th>Situação</th><th></th></tr></thead>
            <tbody>{recorrencias.map((r) => (
              <tr key={r.id} className={r.ativa ? '' : 'nfe-item-ignorado'}>
                <td>{r.descricao}{r.fornecedor_nome ? ` (${r.fornecedor_nome})` : ''}</td><td>{CATEGORIA_LABEL[r.categoria] || r.categoria}</td><td>{r.dia_vencimento}</td>
                <td style={{ textAlign: 'right' }}>{brl(r.valor)}</td><td>{r.ativa ? <span className="chip-situacao chip-novo">Ativa</span> : <span className="chip-situacao chip-neutro">Parada</span>}</td>
                <td><button className="btn-link" onClick={async () => ok(await window.pdv.financeiro.alterarRecorrencia({ id: r.id, ativa: !r.ativa }), r.ativa ? 'Despesa fixa parada.' : 'Despesa fixa reativada.')}>{r.ativa ? 'Parar' : 'Reativar'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      {nova && (
        <div className="modal-overlay"><div className="modal-card"><form onSubmit={async (e) => { e.preventDefault(); if (ok(await window.pdv.financeiro.criarRecorrencia({ ...nova, valor: Number(nova.valor), diaVencimento: Number(nova.diaVencimento), locationId: window.APP_LOCATION_ID, operadorId: currentUser.id }), 'Despesa fixa criada.')) setNova(null); }}>
          <h2><Icon name="calendar" size={18} /> Nova despesa fixa</h2>
          <label>Descrição<input autoFocus value={nova.descricao} onChange={(e) => setNova({ ...nova, descricao: e.target.value })} required placeholder="Ex.: Aluguel da loja" /></label>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>Categoria<select value={nova.categoria} onChange={(e) => setNova({ ...nova, categoria: e.target.value })}>{CATEGORIAS_DESPESA.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
            <label>Valor (R$)<input type="number" step="0.01" min="0.01" value={nova.valor} onChange={(e) => setNova({ ...nova, valor: e.target.value })} required /></label>
            <label>Vence todo dia<input type="number" min="1" max="31" value={nova.diaVencimento} onChange={(e) => setNova({ ...nova, diaVencimento: e.target.value })} required /></label>
            <label>A partir de<input type="month" value={nova.competenciaInicio} onChange={(e) => setNova({ ...nova, competenciaInicio: e.target.value })} required /></label>
          </div>
          <label style={{ marginTop: 12 }}>Fornecedor (opcional)<select value={nova.fornecedorId} onChange={(e) => setNova({ ...nova, fornecedorId: e.target.value })}><option value="">(nenhum)</option>{fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</select></label>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}><button type="button" className="btn-secondary" onClick={() => setNova(null)}>Cancelar</button><button type="submit" className="btn-primary">Salvar</button></div>
        </form></div></div>
      )}
      {parcelada && (
        <div className="modal-overlay"><div className="modal-card"><form onSubmit={async (e) => { e.preventDefault(); if (ok(await window.pdv.financeiro.criarDespesaParcelada({ ...parcelada, valorTotal: Number(parcelada.valorTotal), parcelas: Number(parcelada.parcelas), locationId: window.APP_LOCATION_ID, operadorId: currentUser.id }), 'Parcelas lançadas em contas a pagar.')) setParcelada(null); }}>
          <h2><Icon name="receipt" size={18} /> Despesa parcelada</h2>
          <label>Descrição<input autoFocus value={parcelada.descricao} onChange={(e) => setParcelada({ ...parcelada, descricao: e.target.value })} required placeholder="Ex.: Freezer novo" /></label>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>Categoria<select value={parcelada.categoria} onChange={(e) => setParcelada({ ...parcelada, categoria: e.target.value })}>{CATEGORIAS_DESPESA.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
            <label>Valor total (R$)<input type="number" step="0.01" min="0.01" value={parcelada.valorTotal} onChange={(e) => setParcelada({ ...parcelada, valorTotal: e.target.value })} required /></label>
            <label>Parcelas<input type="number" min="2" max="60" value={parcelada.parcelas} onChange={(e) => setParcelada({ ...parcelada, parcelas: e.target.value })} required /></label>
            <label>1º vencimento<input type="date" value={parcelada.primeiroVencimento} onChange={(e) => setParcelada({ ...parcelada, primeiroVencimento: e.target.value })} required /></label>
          </div>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}><button type="button" className="btn-secondary" onClick={() => setParcelada(null)}>Cancelar</button><button type="submit" className="btn-primary">Lançar parcelas</button></div>
        </form></div></div>
      )}
    </div>
  );
}
