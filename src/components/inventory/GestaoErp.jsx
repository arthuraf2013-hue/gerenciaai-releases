import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';
import { brl, dataBR, mesCurto, mesAtualLocal, somarMeses, hojeLocal, Abas } from './erpUtils';
import { CATEGORIAS_DESPESA, CATEGORIA_LABEL } from './FinanceiroErp';

/** ERP, segunda leva: inadimplência, conciliação, comissões, contabilidade e centros de custo. */

function SeletorMes({ valor, onChange, meses = 13 }) {
  const atual = mesAtualLocal();
  return (
    <select value={valor} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 160 }}>
      {Array.from({ length: meses }, (_, i) => somarMeses(atual, -i)).map((m) => <option key={m} value={m}>{mesCurto(m)}</option>)}
    </select>
  );
}

// ---------- inadimplência (aba Contas a receber) ----------

export function InadimplenciaSecao() {
  const [prazo, setPrazo] = useState(30);
  const [r, setR] = useState(null);
  const [copiado, setCopiado] = useState('');
  useEffect(() => { window.pdv.financeiro.inadimplencia({ prazoFiadoDias: prazo }).then(setR); }, [prazo]);
  async function copiar(c) {
    const m = await window.pdv.financeiro.mensagemCobranca({ customerId: c.customerId, prazoFiadoDias: prazo });
    if (!m?.ok) return;
    await navigator.clipboard.writeText(m.texto);
    setCopiado(c.customerId);
  }
  if (!r || r.ok === false) return null;
  return (
    <section className="settings-section">
      <h2><Icon name="warning" size={16} /> Inadimplência</h2>
      <div className="period-selector">
        <span className="screen-hint" style={{ margin: 0 }}>Fiado vence em</span>
        <input type="number" min="0" max="365" value={prazo} onChange={(e) => setPrazo(Number(e.target.value) || 0)} style={{ width: 80 }} />
        <span className="screen-hint" style={{ margin: 0 }}>dias (o pagamento abate a compra mais antiga)</span>
      </div>
      <div className="dashboard-stats">
        <div className="stat-card"><span>Em aberto</span><strong>{brl(r.totalAberto)}</strong></div>
        <div className="stat-card"><span>Vencido</span><strong className={r.totalVencido ? 'valor-erro' : undefined}>{brl(r.totalVencido)}</strong></div>
        {r.faixas.map((f) => <div key={f.chave} className="stat-card"><span>{f.rotulo}</span><strong>{brl(f.valor)}</strong></div>)}
      </div>
      {r.clientes.length === 0 ? <p className="empty-state">Nenhum cliente com valor em aberto.</p> : (
        <table className="data-table">
          <thead><tr><th>Cliente</th><th style={{ textAlign: 'right' }}>Em aberto</th><th style={{ textAlign: 'right' }}>Vencido</th><th>Desde</th><th>Atraso</th><th></th></tr></thead>
          <tbody>{r.clientes.slice(0, 50).map((c) => (
            <tr key={c.customerId} className={c.diasAtraso > 60 ? 'row-critical' : c.diasAtraso > 0 ? 'row-warning' : ''}>
              <td>{c.nome}<div className="nfe-item-codigos">{c.telefone || 'sem telefone'} · {c.origens.join(' + ')}</div></td>
              <td style={{ textAlign: 'right' }}>{brl(c.aberto)}</td>
              <td style={{ textAlign: 'right' }}>{c.vencido ? brl(c.vencido) : '—'}</td>
              <td>{dataBR(c.maisAntigo)}</td>
              <td>{c.diasAtraso ? `${c.diasAtraso} dia(s)` : '—'}</td>
              <td><button className="btn-link" onClick={() => copiar(c)}>{copiado === c.customerId ? 'Mensagem copiada' : 'Copiar cobrança'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

// ---------- limite de fiado por cliente ----------

export function LimitesFiadoSecao() {
  const [busca, setBusca] = useState('');
  const [clientes, setClientes] = useState(null);
  const [edicao, setEdicao] = useState({}); // id -> { limite, bloqueado }
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const carregar = (q) => window.pdv.customers.list({ query: q || undefined }).then((l) => setClientes(Array.isArray(l) ? l : []));
  useEffect(() => {
    const t = setTimeout(() => carregar(busca.trim()), 250);
    return () => clearTimeout(t);
  }, [busca]);
  const valor = (c) => edicao[c.id] || { limite: c.limite_fiado ?? '', bloqueado: !!c.fiado_bloqueado };
  async function salvar(c) {
    const e = valor(c);
    const r = await window.pdv.financeiro.definirLimiteFiado({ customerId: c.id, limite: e.limite === '' ? null : e.limite, bloqueado: e.bloqueado });
    if (!r?.ok) { setErro(r?.error); setMsg(''); return; }
    setErro(''); setMsg(`Fiado de ${c.nome} atualizado.`);
    setEdicao((x) => { const n = { ...x }; delete n[c.id]; return n; });
    carregar(busca.trim());
  }
  // Mostra quem deve ou já tem regra; a busca acha qualquer cliente.
  const lista = (clientes || []).filter((c) => busca.trim() || c.saldoFiado > 0 || c.limite_fiado !== null || c.fiado_bloqueado).slice(0, 30);
  return (
    <section className="settings-section">
      <h2><Icon name="sliders" size={16} /> Limite de fiado por cliente</h2>
      <p className="screen-hint">Com limite, o PDV recusa o fiado que passar dele (e diz quanto ainda cabe). Bloqueado, o cliente não compra fiado até ser liberado. Vazio = sem limite.</p>
      <input placeholder="Buscar cliente por nome, telefone ou CPF" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ maxWidth: 360, marginBottom: 10 }} />
      {msg && <p className="io-message" style={{ marginBottom: 8 }}>{msg}</p>}
      {erro && <p className="modal-error" style={{ marginBottom: 8 }}>{erro}</p>}
      {clientes === null ? <p className="empty-state">Carregando...</p> : lista.length === 0 ? <p className="empty-state">{busca ? 'Nenhum cliente encontrado.' : 'Ninguém devendo nem com limite definido. Busque um cliente para definir o limite.'}</p> : (
        <table className="data-table">
          <thead><tr><th>Cliente</th><th style={{ textAlign: 'right' }}>Deve hoje</th><th>Limite (R$)</th><th>Bloqueado</th><th></th></tr></thead>
          <tbody>{lista.map((c) => {
            const e = valor(c);
            const mudou = !!edicao[c.id];
            return (
              <tr key={c.id} className={c.limite_fiado !== null && c.saldoFiado > c.limite_fiado ? 'row-warning' : ''}>
                <td>{c.nome}<div className="nfe-item-codigos">{c.telefone || 'sem telefone'}</div></td>
                <td style={{ textAlign: 'right' }}>{brl(c.saldoFiado || 0)}</td>
                <td><input type="number" step="0.01" min="0" value={e.limite} placeholder="sem limite" style={{ width: 120 }}
                  onChange={(ev) => setEdicao({ ...edicao, [c.id]: { ...e, limite: ev.target.value } })} /></td>
                <td><label className="nfe-opcao"><input type="checkbox" checked={e.bloqueado} onChange={(ev) => setEdicao({ ...edicao, [c.id]: { ...e, bloqueado: ev.target.checked } })} /> {e.bloqueado ? 'sim' : 'não'}</label></td>
                <td><button className="btn-link" disabled={!mudou} onClick={() => salvar(c)}><Icon name="save" size={14} /> Salvar</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </section>
  );
}

// ---------- conciliação bancária ----------

export function ConciliacaoTab() {
  const { currentUser } = useSession();
  const [status, setStatus] = useState('pendente');
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [nova, setNova] = useState(null); // { linha, categoria }
  const carregar = () => window.pdv.financeiro.extrato({ locationId: window.APP_LOCATION_ID, status }).then(setD);
  useEffect(() => { carregar(); }, [status]);
  const feito = (r, texto) => { if (!r?.ok) { setErro(r?.error || 'Não foi possível.'); return false; } setErro(''); setMsg(texto); carregar(); return true; };
  async function importar() {
    const r = await window.pdv.financeiro.importarOfx({ operadorId: currentUser.id });
    if (r?.canceled) return;
    feito(r, `Extrato ${r.conta}: ${r.importadas} lançamento(s) novo(s) de ${dataBR(r.de)} a ${dataBR(r.ate)}${r.repetidas ? `, ${r.repetidas} já importado(s)` : ''}.`);
  }
  if (!d) return <p className="empty-state">Carregando...</p>;
  if (d.ok === false) return <p className="modal-error">{d.error}</p>;
  return (
    <div>
      <div className="period-selector">
        <button className="btn-primary" onClick={importar}><Icon name="import" size={15} /> Importar extrato (OFX)</button>
        {[['pendente', 'A conciliar'], ['conciliado', 'Conciliados'], ['ignorado', 'Ignorados'], ['todos', 'Todos']].map(([v, t]) => (
          <button key={v} className={status === v ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setStatus(v)}>{t}{d.resumo[v] ? ` (${d.resumo[v].qtd})` : ''}</button>
        ))}
      </div>
      <p className="screen-hint">Baixe o extrato em OFX no site ou app do banco. Cada lançamento é casado com uma conta paga, uma conta a receber ou o repasse do cartão; conta em aberto é baixada na data do extrato. Importar o mesmo arquivo de novo não duplica.</p>
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      {erro && <p className="modal-error" style={{ marginBottom: 10 }}>{erro}</p>}
      {d.linhas.length === 0 ? <p className="empty-state">{status === 'pendente' ? 'Nada a conciliar. Importe um extrato.' : 'Nenhum lançamento.'}</p> : (
        <table className="data-table">
          <thead><tr><th>Data</th><th>No extrato</th><th style={{ textAlign: 'right' }}>Valor</th><th>Casar com</th></tr></thead>
          <tbody>{d.linhas.map((l) => (
            <tr key={l.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{dataBR(l.data)}</td>
              <td>{l.descricao || '—'}<div className="nfe-item-codigos">{l.conta}</div></td>
              <td style={{ textAlign: 'right' }} className={l.valor < 0 ? 'valor-erro' : undefined}>{brl(l.valor)}</td>
              <td>
                {l.status !== 'pendente' ? (
                  <span>{l.status === 'ignorado' ? 'Ignorado' : `Conciliado (${l.vinculo_tipo})`} · <button className="btn-link" onClick={async () => feito(await window.pdv.financeiro.desfazerExtrato({ linhaId: l.id }), 'Voltou para conciliar.')}>Desfazer</button></span>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {l.sugestoes.map((s) => (
                      <button key={`${s.tipo}${s.id}`} className="btn-secondary" onClick={async () => feito(await window.pdv.financeiro.conciliar({ linhaId: l.id, tipo: s.tipo, vinculoId: s.id, operadorId: currentUser.id }), 'Conciliado.')}>
                        <Icon name="checkCircle" size={14} /> {s.descricao} · {brl(s.valor)}{s.pendente ? ' (baixa)' : ''}
                      </button>
                    ))}
                    {l.valor < 0 && <button className="btn-link" onClick={() => setNova({ linha: l, categoria: 'taxas_bancarias' })}>Lançar como despesa</button>}
                    <button className="btn-link" onClick={async () => feito(await window.pdv.financeiro.ignorarExtrato({ linhaId: l.id, operadorId: currentUser.id }), 'Ignorado.')}>Ignorar</button>
                  </div>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {nova && (
        <div className="modal-overlay"><div className="modal-card">
          <h2>Lançar como despesa paga</h2>
          <p className="screen-hint">{dataBR(nova.linha.data)} · {nova.linha.descricao} · {brl(Math.abs(nova.linha.valor))}</p>
          <label>Categoria<select value={nova.categoria} onChange={(e) => setNova({ ...nova, categoria: e.target.value })}>
            {CATEGORIAS_DESPESA.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setNova(null)}><Icon name="close" size={15} /> Cancelar</button>
            <button className="btn-primary" onClick={async () => { if (feito(await window.pdv.financeiro.criarDespesaDoExtrato({ linhaId: nova.linha.id, categoria: nova.categoria, locationId: window.APP_LOCATION_ID, operadorId: currentUser.id }), 'Despesa lançada e conciliada.')) setNova(null); }}><Icon name="save" size={15} /> Lançar</button>
          </div>
        </div></div>
      )}
    </div>
  );
}

// ---------- comissões e metas ----------

export function ComissoesTab() {
  const [comp, setComp] = useState(mesAtualLocal());
  const [r, setR] = useState(null);
  const [regras, setRegras] = useState([]);
  const [erro, setErro] = useState('');
  const carregar = () => {
    window.pdv.comissoes.relatorio({ locationId: window.APP_LOCATION_ID, competencia: comp }).then(setR);
    window.pdv.comissoes.regras().then((x) => setRegras(Array.isArray(x) ? x : []));
  };
  useEffect(() => { carregar(); }, [comp]);
  async function salvar(fn) { const x = await fn; if (!x?.ok) setErro(x?.error || 'Não foi possível salvar.'); else { setErro(''); carregar(); } }
  if (!r) return <p className="empty-state">Carregando...</p>;
  if (r.ok === false) return <p className="modal-error">{r.error}</p>;
  const barra = (pct) => <div className="bar-track" style={{ height: 8, minWidth: 90 }}><div className="bar-fill" style={{ width: `${Math.min(100, pct || 0)}%`, background: pct >= 100 ? 'var(--color-primary)' : 'var(--color-warning-text)' }} /></div>;
  return (
    <div>
      <div className="period-selector"><span className="screen-hint" style={{ margin: 0 }}>Mês</span><SeletorMes valor={comp} onChange={setComp} /></div>
      {erro && <p className="modal-error" style={{ marginBottom: 10 }}>{erro}</p>}
      <div className="dashboard-stats">
        <div className="stat-card"><span>Vendas da loja</span><strong>{brl(r.loja.base)}</strong></div>
        <div className="stat-card"><span>Meta da loja</span><strong>{r.loja.meta ? `${r.loja.atingido}%` : '—'}</strong>{r.loja.meta && barra(r.loja.atingido)}</div>
        <div className="stat-card"><span>No ritmo atual, fecha em</span><strong>{brl(r.loja.projecao)}</strong></div>
        <div className="stat-card"><span>Comissões do mês</span><strong>{brl(r.totalComissoes)}</strong></div>
      </div>
      <section className="settings-section">
        <h2><Icon name="users" size={16} /> Por vendedor</h2>
        <p className="screen-hint">Vendedor = quem registrou a venda. Base = vendas − descontos − devoluções do mês (sem taxa de serviço).</p>
        {r.vendedores.length === 0 ? <p className="empty-state">Sem vendas no mês.</p> : (
          <table className="data-table">
            <thead><tr><th>Vendedor</th><th style={{ textAlign: 'right' }}>Vendas</th><th style={{ textAlign: 'right' }}>Base</th><th style={{ textAlign: 'right' }}>Comissão</th><th>Meta</th></tr></thead>
            <tbody>{r.vendedores.map((v) => (
              <tr key={v.userId}>
                <td>{v.nome}</td><td style={{ textAlign: 'right' }}>{v.vendas}</td>
                <td style={{ textAlign: 'right' }}>{brl(v.base)}{v.devolucoes ? <div className="nfe-item-codigos">− {brl(v.devolucoes)} devolvido</div> : null}</td>
                <td style={{ textAlign: 'right' }}>{v.comissao === null ? '—' : <><strong>{brl(v.comissao)}</strong><div className="nfe-item-codigos">{v.percentual}%</div></>}</td>
                <td>{v.meta ? <>{barra(v.atingido)}<div className="nfe-item-codigos">{v.atingido}% de {brl(v.meta)}</div></> : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <section className="settings-section">
        <h2><Icon name="sliders" size={16} /> Percentuais e metas de {mesCurto(comp)}</h2>
        <table className="data-table">
          <thead><tr><th>Quem</th><th>Comissão (%)</th><th>Meta do mês (R$)</th></tr></thead>
          <tbody>
            <tr><td><strong>Loja</strong></td><td>—</td>
              <td><input type="number" min="0" step="100" defaultValue={r.loja.meta ?? ''} key={`loja${comp}${r.loja.meta}`} style={{ width: 140 }} onBlur={(e) => salvar(window.pdv.comissoes.salvarMeta({ competencia: comp, valor: e.target.value }))} /></td></tr>
            {regras.filter((u) => u.ativo).map((u) => {
              const meta = r.vendedores.find((v) => v.userId === u.userId)?.meta ?? '';
              return (
                <tr key={u.userId}><td>{u.nome}</td>
                  <td><input type="number" min="0" max="100" step="0.1" defaultValue={u.percentual ?? ''} key={`p${u.userId}${u.percentual}`} style={{ width: 90 }} onBlur={(e) => salvar(window.pdv.comissoes.salvarRegra({ userId: u.userId, percentual: e.target.value }))} /></td>
                  <td><input type="number" min="0" step="100" defaultValue={meta} key={`m${u.userId}${comp}${meta}`} style={{ width: 140 }} onBlur={(e) => salvar(window.pdv.comissoes.salvarMeta({ competencia: comp, userId: u.userId, valor: e.target.value }))} /></td></tr>
              );
            })}
          </tbody>
        </table>
        <p className="screen-hint">Vazio = sem comissão / sem meta. Salva ao sair do campo e fica na Auditoria.</p>
      </section>
    </div>
  );
}

// ---------- contabilidade ----------

const VISOES_CONTABIL = [
  { id: 'lancamentos', icone: 'book', rotulo: 'Lançamentos e balancete' },
  { id: 'manual', icone: 'add', rotulo: 'Lançamento manual' },
  { id: 'razao', icone: 'receipt', rotulo: 'Razão' },
  { id: 'dre', icone: 'chart', rotulo: 'DRE contábil' },
];

export function ContabilTab() {
  const { currentUser } = useSession();
  const [comp, setComp] = useState(somarMeses(mesAtualLocal(), -1));
  const [visao, setVisao] = useState('lancamentos');
  const [r, setR] = useState(null);
  const [plano, setPlano] = useState(null);
  const [contas, setContas] = useState([]);
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [manual, setManual] = useState(null);
  const [conta, setConta] = useState('banco');
  const [razao, setRazao] = useState(null);
  const [dre, setDre] = useState(null);
  const [reabrindo, setReabrindo] = useState(null);
  const loc = window.APP_LOCATION_ID;
  const recarregar = () => window.pdv.financeiro.contabilLancamentos({ locationId: loc, competencia: comp }).then(setR);
  useEffect(() => { setR(null); recarregar(); }, [comp]);
  useEffect(() => { window.pdv.financeiro.contabilPlano().then((p) => setContas(Array.isArray(p) ? p : [])); }, []);
  useEffect(() => {
    if (visao === 'razao') window.pdv.financeiro.contabilRazao({ locationId: loc, competencia: comp, conta }).then(setRazao);
    if (visao === 'dre') window.pdv.financeiro.contabilDre({ locationId: loc, competencia: comp }).then(setDre);
  }, [visao, comp, conta, r]);
  const avisar = (x, ok) => { if (x?.ok) { setErro(''); setMsg(ok); } else { setMsg(''); setErro(x?.error || 'Não foi possível.'); } };
  async function exportar() {
    const x = await window.pdv.financeiro.exportarContabil({ locationId: loc, competencia: comp });
    if (x?.canceled) return;
    avisar(x, x?.ok ? `Planilha salva: ${x.arquivo} (${x.linhas} lançamento(s)).` : '');
  }
  async function salvarPlano() {
    const x = await window.pdv.financeiro.salvarContabilPlano({ contas: plano });
    if (!x?.ok) return setErro(x?.error);
    setErro(''); setPlano(null); setMsg('Plano de contas salvo.');
    recarregar();
  }
  async function lancar(e) {
    e.preventDefault();
    const x = await window.pdv.financeiro.contabilLancarManual({ locationId: loc, ...manual, valor: Number(String(manual.valor).replace(',', '.')) });
    avisar(x, 'Lançamento gravado.');
    if (x?.ok) { setManual(null); if (manual.data.slice(0, 7) !== comp) setComp(manual.data.slice(0, 7)); else recarregar(); }
  }
  async function estornar(l) {
    if (!confirm(`Estornar "${l.historico}" (${brl(l.valor)})? O estorno entra com a data de hoje.`)) return;
    const x = await window.pdv.financeiro.contabilEstornar({ id: l.id, locationId: loc });
    avisar(x, 'Estorno lançado com a data de hoje.');
    recarregar();
  }
  async function fechar() {
    if (!confirm(`Fechar ${mesCurto(comp)}? Os lançamentos ficam congelados e nada com data nesse mês pode ser lançado, pago ou excluído até reabrir.`)) return;
    const x = await window.pdv.financeiro.contabilFecharMes({ locationId: loc, competencia: comp });
    avisar(x, `${mesCurto(comp)} fechado.`);
    recarregar();
  }
  async function reabrir(e) {
    e.preventDefault();
    const x = await window.pdv.financeiro.contabilReabrirMes({ locationId: loc, competencia: comp, motivo: reabrindo });
    avisar(x, `${mesCurto(comp)} reaberto.`);
    if (x?.ok) setReabrindo(null);
    recarregar();
  }
  const podeReabrir = ['admin', 'suporte'].includes(currentUser?.role);
  const mesPassado = comp < mesAtualLocal();
  return (
    <div>
      <div className="period-selector">
        <span className="screen-hint" style={{ margin: 0 }}>Mês</span><SeletorMes valor={comp} onChange={setComp} />
        <button className="btn-primary" onClick={exportar}><Icon name="export" size={15} /> Exportar para o contador (.xlsx)</button>
        <button className="btn-secondary" onClick={async () => setPlano(await window.pdv.financeiro.contabilPlano())}><Icon name="sliders" size={15} /> Plano de contas (de-para)</button>
        {r?.ok && (r.fechado
          ? (podeReabrir && <button className="btn-secondary" onClick={() => setReabrindo('')}><Icon name="lock" size={15} /> Reabrir mês</button>)
          : (mesPassado && <button className="btn-secondary" onClick={fechar}><Icon name="lock" size={15} /> Fechar mês</button>))}
      </div>
      {r?.fechado && <p className="io-message-aviso" style={{ marginBottom: 10 }}><Icon name="lock" size={14} /> {mesCurto(comp)} está fechado desde {dataBR(String(r.fechado.em).slice(0, 10))}: os números abaixo são a foto do fechamento.</p>}
      <p className="screen-hint">Lançamentos em partidas dobradas: os automáticos saem das vendas, cartão, fiado, compras, despesas e CMV; os manuais (capital, empréstimo, ajuste do contador) você lança aqui. Lançamento não se apaga: corrige-se com estorno. Fechar o mês trava tudo que tem data nele. Não substitui a escrituração oficial: o contador confere e importa.</p>
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      {erro && <p className="modal-error" style={{ marginBottom: 10 }}>{erro}</p>}
      <Abas abas={VISOES_CONTABIL} atual={visao} onChange={setVisao} />
      {plano && (
        <section className="settings-section">
          <h2>Plano de contas do escritório</h2>
          <p className="screen-hint">Troque os códigos pelos do plano que o contador usa; os lançamentos saem com eles.</p>
          <table className="data-table"><thead><tr><th>Código</th><th>Conta</th></tr></thead>
            <tbody>{plano.map((c, i) => (
              <tr key={c.chave}>
                <td><input value={c.codigo} onChange={(e) => setPlano(plano.map((x, j) => (j === i ? { ...x, codigo: e.target.value } : x)))} style={{ width: 140 }} /></td>
                <td><input value={c.nome} onChange={(e) => setPlano(plano.map((x, j) => (j === i ? { ...x, nome: e.target.value } : x)))} style={{ width: '100%' }} /></td>
              </tr>
            ))}</tbody></table>
          <div className="settings-actions"><button className="btn-primary" onClick={salvarPlano}><Icon name="save" size={15} /> Salvar plano</button><button className="btn-secondary" onClick={() => setPlano(null)}>Fechar</button></div>
        </section>
      )}
      {visao === 'manual' && (
        <section className="settings-section" style={{ maxWidth: 760 }}>
          <h2><Icon name="add" size={16} /> Lançamento manual</h2>
          <p className="screen-hint">Use para o que não passa pelo caixa do app: dinheiro que os sócios colocaram (capital), empréstimo recebido, compra de máquina, ajuste pedido pelo contador. Débito é para onde o valor vai; crédito, de onde vem.</p>
          {!manual ? <button className="btn-primary" onClick={() => setManual({ data: hojeDoMes(comp), debito: 'banco', credito: 'capital_social', valor: '', historico: '' })}><Icon name="add" size={15} /> Novo lançamento</button> : (
            <form onSubmit={lancar}>
              <div className="form-grid">
                <label>Data<input type="date" value={manual.data} max={hojeLocal()} onChange={(e) => setManual({ ...manual, data: e.target.value })} required /></label>
                <label>Valor (R$)<input type="number" step="0.01" min="0.01" value={manual.valor} onChange={(e) => setManual({ ...manual, valor: e.target.value })} required /></label>
                <label>Débito (vai para)<select value={manual.debito} onChange={(e) => setManual({ ...manual, debito: e.target.value })}>{contas.map((c) => <option key={c.chave} value={c.chave}>{c.codigo} — {c.nome}</option>)}</select></label>
                <label>Crédito (vem de)<select value={manual.credito} onChange={(e) => setManual({ ...manual, credito: e.target.value })}>{contas.map((c) => <option key={c.chave} value={c.chave}>{c.codigo} — {c.nome}</option>)}</select></label>
              </div>
              <label style={{ marginTop: 10 }}>Histórico<input value={manual.historico} maxLength={200} placeholder="Ex.: Integralização de capital pelos sócios" onChange={(e) => setManual({ ...manual, historico: e.target.value })} required /></label>
              <div className="settings-actions"><button className="btn-primary" type="submit"><Icon name="save" size={15} /> Lançar</button><button type="button" className="btn-secondary" onClick={() => setManual(null)}>Cancelar</button></div>
            </form>
          )}
        </section>
      )}
      {visao === 'razao' && (
        <section className="settings-section">
          <h2><Icon name="receipt" size={16} /> Razão da conta</h2>
          <select value={conta} onChange={(e) => setConta(e.target.value)} style={{ maxWidth: 420, marginBottom: 10 }}>{contas.map((c) => <option key={c.chave} value={c.chave}>{c.codigo} — {c.nome}</option>)}</select>
          {!razao ? <p className="empty-state">Carregando...</p> : razao.ok === false ? <p className="modal-error">{razao.error}</p> : razao.movimentos.length === 0 ? <p className="empty-state">Sem movimento nesta conta no mês.</p> : (
            <table className="data-table"><thead><tr><th>Data</th><th>Histórico</th><th>Contrapartida</th><th style={{ textAlign: 'right' }}>Débito</th><th style={{ textAlign: 'right' }}>Crédito</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
              <tbody>{razao.movimentos.map((m, i) => (
                <tr key={i}><td>{dataBR(m.data)}</td><td>{m.historico}</td><td>{m.contrapartida}</td><td style={{ textAlign: 'right' }}>{m.debito ? brl(m.debito) : ''}</td><td style={{ textAlign: 'right' }}>{m.credito ? brl(m.credito) : ''}</td><td style={{ textAlign: 'right' }}>{brl(m.saldo)}</td></tr>
              ))}</tbody></table>
          )}
          <p className="screen-hint">Saldo do mês (débitos − créditos). Saldo acumulado de anos anteriores fica com o contador.</p>
        </section>
      )}
      {visao === 'dre' && (
        <section className="settings-section" style={{ maxWidth: 620 }}>
          <h2><Icon name="chart" size={16} /> DRE contábil — {mesCurto(comp)}</h2>
          {!dre ? <p className="empty-state">Carregando...</p> : dre.ok === false ? <p className="modal-error">{dre.error}</p> : (
            <table className="data-table"><tbody>{dre.linhas.map((l) => (
              <tr key={l.rotulo} className={l.total ? 'erp-dre-total' : ''}><td>{l.rotulo}</td><td style={{ textAlign: 'right' }} className={l.valor < 0 ? 'valor-erro' : undefined}>{brl(l.valor)}</td></tr>
            ))}</tbody></table>
          )}
          <p className="screen-hint">Pelos lançamentos do mês (competência). Diferente do DRE gerencial, aqui entram os lançamentos manuais e os juros separados. IRPJ/CSLL e o imposto do Simples ficam com o contador.</p>
        </section>
      )}
      {visao === 'lancamentos' && (!r ? <p className="empty-state">Carregando...</p> : r.ok === false ? <p className="modal-error">{r.error}</p> : r.linhas.length === 0 ? <p className="empty-state">Sem movimento no mês.</p> : (
        <div className="erp-duas-colunas">
          <section className="settings-section">
            <h2>Lançamentos ({r.linhas.length})</h2>
            <table className="data-table"><thead><tr><th>Débito</th><th>Crédito</th><th style={{ textAlign: 'right' }}>Valor</th></tr></thead>
              <tbody>{r.linhas.map((l) => (
                <tr key={l.numero}><td>{l.debitoCodigo}<div className="nfe-item-codigos">{l.debitoNome}</div></td><td>{l.creditoCodigo}<div className="nfe-item-codigos">{l.creditoNome}</div></td>
                  <td style={{ textAlign: 'right' }}>{brl(l.valor)}<div className="nfe-item-codigos">{l.manual && <span className="chip-neutro" style={{ marginRight: 4 }}>{l.estornoDeId ? 'estorno' : 'manual'}</span>}{l.historico}</div>
                    {l.manual && !l.estornoDeId && !r.fechado && <button className="btn-link" onClick={() => estornar(l)}>Estornar</button>}</td></tr>
              ))}</tbody></table>
          </section>
          <section className="settings-section">
            <h2>Balancete</h2>
            <table className="data-table"><thead><tr><th>Conta</th><th style={{ textAlign: 'right' }}>Débitos</th><th style={{ textAlign: 'right' }}>Créditos</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
              <tbody>{r.balancete.map((b) => (
                <tr key={b.chave}><td>{b.codigo}<div className="nfe-item-codigos">{b.nome}</div></td><td style={{ textAlign: 'right' }}>{brl(b.debitos)}</td><td style={{ textAlign: 'right' }}>{brl(b.creditos)}</td><td style={{ textAlign: 'right' }}>{brl(b.saldo)}</td></tr>
              ))}
                <tr className="erp-dre-total"><td>Total</td><td style={{ textAlign: 'right' }}>{brl(r.totalDebitos)}</td><td style={{ textAlign: 'right' }}>{brl(r.totalCreditos)}</td><td style={{ textAlign: 'right' }}>{brl(0)}</td></tr>
              </tbody></table>
          </section>
        </div>
      ))}
      {reabrindo !== null && (
        <div className="modal-overlay"><div className="modal-card"><form onSubmit={reabrir}>
          <h2><Icon name="lock" size={18} /> Reabrir {mesCurto(comp)}</h2>
          <p className="screen-hint">Fica registrado na Auditoria. Depois de ajustar, feche o mês de novo.</p>
          <label>Motivo<input autoFocus value={reabrindo} onChange={(e) => setReabrindo(e.target.value)} placeholder="Ex.: contador pediu ajuste da provisão" required minLength={5} /></label>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={() => setReabrindo(null)}>Voltar</button>
            <button type="submit" className="btn-primary">Reabrir</button>
          </div>
        </form></div></div>
      )}
    </div>
  );
}

/** Hoje, ou o último dia do mês escolhido se ele já passou. */
function hojeDoMes(comp) {
  const hoje = hojeLocal();
  if (comp >= hoje.slice(0, 7)) return hoje;
  const [a, m] = comp.split('-').map(Number);
  return `${comp}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// ---------- centros de custo ----------

export function DespesasPorCentro() {
  const [r, setR] = useState(null);
  useEffect(() => {
    const atual = mesAtualLocal();
    window.pdv.financeiro.despesasPorCentro({ locationId: window.APP_LOCATION_ID, competencias: [somarMeses(atual, -2), somarMeses(atual, -1), atual] }).then(setR);
  }, []);
  if (!r?.ok || r.centros.length === 0 || (r.centros.length === 1 && !r.centros[0].centroCustoId)) return null;
  return (
    <section className="settings-section" style={{ marginTop: 16 }}>
      <h2><Icon name="sliders" size={16} /> Despesas por centro de custo</h2>
      <table className="data-table erp-dre">
        <thead><tr><th>Centro de custo</th>{r.competencias.map((c) => <th key={c} style={{ textAlign: 'right' }}>{mesCurto(c)}</th>)}<th style={{ textAlign: 'right' }}>Total</th></tr></thead>
        <tbody>{r.centros.map((c) => (
          <tr key={c.centro}><td>{c.centro}</td>{r.competencias.map((m) => <td key={m} style={{ textAlign: 'right' }}>{brl(c.meses[m])}</td>)}<td style={{ textAlign: 'right' }}><strong>{brl(c.total)}</strong></td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}

export function CentrosDeCustoSecao() {
  const [lista, setLista] = useState(null);
  const [nome, setNome] = useState('');
  const [erro, setErro] = useState('');
  const carregar = () => window.pdv.financeiro.centros({ incluirInativos: true }).then((x) => setLista(Array.isArray(x) ? x : []));
  useEffect(() => { carregar(); }, []);
  async function criar(e) {
    e.preventDefault();
    const r = await window.pdv.financeiro.salvarCentro({ nome });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setNome(''); carregar();
  }
  if (!lista) return null;
  return (
    <section className="settings-section" style={{ marginTop: 16 }}>
      <h2><Icon name="sliders" size={16} /> Centros de custo</h2>
      <p className="screen-hint">Separe as despesas por área (ex.: Cozinha, Delivery, Loja 2). Escolha o centro ao lançar a despesa; o DRE mostra o total de cada um.</p>
      <form className="inline-form" onSubmit={criar}>
        <label>Novo centro<input value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} /></label>
        <button className="btn-primary" type="submit" disabled={!nome.trim()}><Icon name="add" size={15} /> Criar</button>
      </form>
      {erro && <p className="modal-error" style={{ marginTop: 8 }}>{erro}</p>}
      {lista.length === 0 ? <p className="empty-state">Nenhum centro de custo.</p> : (
        <table className="data-table" style={{ marginTop: 10 }}>
          <tbody>{lista.map((c) => (
            <tr key={c.id} style={c.ativo ? undefined : { opacity: 0.55 }}><td>{c.nome}</td>
              <td style={{ textAlign: 'right' }}><button className="btn-link" onClick={async () => { await window.pdv.financeiro.ativarCentro({ id: c.id, ativo: !c.ativo }); carregar(); }}>{c.ativo ? 'Desativar' : 'Reativar'}</button></td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

export { CATEGORIA_LABEL };
