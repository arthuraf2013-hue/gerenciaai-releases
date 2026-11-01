import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';
import { Termo } from './Glossario';
import { useEscToClose } from '../../hooks/useEscToClose';
import { ProductPicker } from './SupplyScreen';
import { brl, dataBR, hojeLocal } from './erpUtils';
import { MotorXCadastro } from './CadastroAutomatico';

/** Motor tributário (ERP, Fase 4): regras versionadas + simulador. */

const TRIBUTOS = ['ICMS', 'ICMS_ST', 'FCP', 'PIS', 'COFINS', 'IPI', 'ISS', 'IBS', 'CBS', 'IS'];
const ROTULO_TRIBUTO = { ICMS_ST: 'ICMS-ST', IS: 'Imposto Seletivo' };
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const REGIMES = { mei: 'MEI', simples_nacional: 'Simples Nacional', lucro_presumido: 'Lucro Presumido', lucro_real: 'Lucro Real' };
const PERFIS = { consumidor_final: 'Consumidor final', contribuinte: 'Contribuinte do ICMS', nao_contribuinte: 'Não contribuinte' };
const NATUREZAS = { venda: 'Venda', devolucao: 'Devolução', transferencia: 'Transferência', remessa: 'Remessa', outra: 'Outra' };
const pct = (v) => `${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;

function criterios(r) {
  const c = [];
  if (r.regime) c.push(REGIMES[r.regime]);
  if (r.uf_origem || r.uf_destino) c.push(`${r.uf_origem || '*'} → ${r.uf_destino || '*'}`);
  if (r.ncm_prefixo) c.push(`NCM ${r.ncm_prefixo}…`);
  if (r.cfop) c.push(`CFOP ${r.cfop}`);
  if (r.cst_csosn_item) c.push(`produto ${r.cst_csosn_item}`);
  if (r.natureza) c.push(NATUREZAS[r.natureza]);
  if (r.perfil_cliente) c.push(PERFIS[r.perfil_cliente]);
  return c.length ? c.join(' · ') : 'qualquer operação';
}

const FORM_VAZIO = {
  nome: '', tributo: 'ICMS', regime: '', ufOrigem: '', ufDestino: '', ncmPrefixo: '', cfop: '', cstCsosnItem: '', natureza: '', perfilCliente: '',
  cst: '', cclassTrib: '', aliquota: '', reducaoBase: '', mva: '', aliquotaInternaDestino: '', recolhidoNoDas: false, informativo: false,
  fundamento: '', vigenciaInicio: '', vigenciaFim: '', difalBase: '',
};

function paraForm(r) {
  return {
    nome: r.nome, tributo: r.tributo, regime: r.regime || '', ufOrigem: r.uf_origem || '', ufDestino: r.uf_destino || '',
    ncmPrefixo: r.ncm_prefixo || '', cfop: r.cfop || '', cstCsosnItem: r.cst_csosn_item || '', natureza: r.natureza || '', perfilCliente: r.perfil_cliente || '',
    cst: r.cst || '', cclassTrib: r.cclass_trib || '', aliquota: r.aliquota || '', reducaoBase: r.reducao_base || '', mva: r.mva || '',
    aliquotaInternaDestino: r.aliquota_interna_destino ?? '', recolhidoNoDas: !!r.recolhido_no_das, informativo: !!r.informativo,
    fundamento: r.fundamento || '', vigenciaInicio: hojeLocal(), vigenciaFim: '', difalBase: r.difal_base || '',
  };
}

export function RegrasTributariasTab() {
  const { currentUser } = useSession();
  const [dados, setDados] = useState(null);
  const [filtro, setFiltro] = useState('');
  const [historico, setHistorico] = useState(false);
  const [form, setForm] = useState(null); // { modo: 'nova'|'versao', grupoId?, campos }
  const [erro, setErro] = useState('');
  const [msg, setMsg] = useState('');
  useEscToClose(() => setForm(null), !!form);
  const carregar = () => window.pdv.tributacao.listar({ tributo: filtro || undefined, incluirInativas: historico }).then(setDados);
  useEffect(() => { carregar(); }, [filtro, historico]);

  async function salvar(e) {
    e.preventDefault();
    const r = form.modo === 'versao'
      ? await window.pdv.tributacao.novaVersao({ grupoId: form.grupoId, ...form.campos, operadorId: currentUser.id })
      : await window.pdv.tributacao.criar({ ...form.campos, operadorId: currentUser.id });
    if (!r?.ok) return setErro(r?.error || 'Não foi possível salvar.');
    setErro(''); setForm(null); setMsg(form.modo === 'versao' ? `Versão ${r.versao} criada; a anterior foi encerrada na véspera.` : 'Regra criada.');
    carregar();
  }
  async function desativar(r) {
    if (!confirm(`Desativar "${r.nome}" (versão ${r.versao})? Ela deixa de valer e fica no histórico.`)) return;
    const res = await window.pdv.tributacao.desativar({ id: r.id });
    setMsg(res?.ok ? 'Regra desativada.' : res?.error);
    carregar();
  }
  const set = (k, v) => setForm({ ...form, campos: { ...form.campos, [k]: v } });

  if (!dados) return <p className="empty-state">Carregando...</p>;
  if (dados.ok === false) return <p className="modal-error">{dados.error}</p>;
  const hoje = hojeLocal();
  return (
    <div>
      <SimuladorTributario contexto={dados.contexto} />
      <NaturezasOperacao />
      <MotorXCadastro key={dados.regras.length + (msg || '')} />
      <section className="settings-section">
        <div className="screen-header" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}><Icon name="sliders" size={16} /> Regras tributárias</h2>
          <button className="btn-primary" onClick={() => { setErro(''); setForm({ modo: 'nova', campos: { ...FORM_VAZIO, regime: dados.contexto.regime || '', vigenciaInicio: hoje } }); }}><Icon name="add" size={15} /> Nova regra</button>
        </div>
        <p className="screen-hint">Vence a regra mais específica que bate com a operação; no empate, a da loja vence a do sistema. Mudar uma regra cria uma versão nova com data de início: o histórico fica.</p>
        <div className="period-selector">
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Todos os tributos</option>
            {TRIBUTOS.map((t) => <option key={t} value={t}>{ROTULO_TRIBUTO[t] || t}</option>)}
          </select>
          <label className="nfe-opcao"><input type="checkbox" checked={historico} onChange={(e) => setHistorico(e.target.checked)} /> Mostrar desativadas</label>
        </div>
        {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
        {dados.regras.length === 0 ? <p className="empty-state">Nenhuma regra com esse filtro.</p> : (
          <table className="data-table">
            <thead><tr><th>Regra</th><th>Vale para</th><th>Resultado</th><th>Vigência</th><th></th></tr></thead>
            <tbody>{dados.regras.map((r) => {
              const vigente = r.ativo && r.vigencia_inicio <= hoje && (!r.vigencia_fim || r.vigencia_fim >= hoje);
              return (
                <tr key={r.id} style={r.ativo ? undefined : { opacity: 0.55 }}>
                  <td><strong>{ROTULO_TRIBUTO[r.tributo] || r.tributo}</strong> — {r.nome}
                    <div className="nfe-item-codigos">v{r.versao} · {r.origem === 'sistema' ? 'do sistema' : 'da loja'}{r.informativo ? ' · informativa' : ''}{!r.ativo ? ' · desativada' : ''}</div></td>
                  <td>{criterios(r)}</td>
                  <td>{r.cst ? `CST/CSOSN ${r.cst}` : ''}{r.cclass_trib ? ` · cClassTrib ${r.cclass_trib}` : ''}
                    <div className="nfe-item-codigos">{r.recolhido_no_das ? 'recolhido no DAS' : `${pct(r.tributo === 'ICMS_ST' ? (r.aliquota_interna_destino ?? r.aliquota) : r.aliquota)}${r.reducao_base ? ` · base reduzida ${pct(r.reducao_base)}` : ''}${r.mva ? ` · MVA ${pct(r.mva)}` : ''}`}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{dataBR(r.vigencia_inicio)} a {r.vigencia_fim ? dataBR(r.vigencia_fim) : 'sem fim'}
                    {vigente && <div><span className="chip-situacao chip-novo">em vigor</span></div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{!!r.ativo && (
                    <>
                      <button className="btn-link" title={r.fundamento || ''} onClick={() => { setErro(''); setForm({ modo: 'versao', grupoId: r.grupo_id, campos: paraForm(r) }); }}>Nova versão</button>
                      <button className="btn-link-danger" onClick={() => desativar(r)}>Desativar</button>
                    </>
                  )}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>

      {form && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={salvar} style={{ width: "min(820px, 100%)" }}>
            <h2><Icon name="sliders" size={18} /> {form.modo === 'versao' ? 'Nova versão da regra' : 'Nova regra tributária'}</h2>
            <p className="screen-hint">Critério em branco = vale para qualquer valor. Na dúvida, preencha com o contador.</p>
            <div className="form-grid">
              <label>Nome<input value={form.campos.nome} onChange={(e) => set('nome', e.target.value)} required maxLength={120} /></label>
              <label>Tributo<select value={form.campos.tributo} onChange={(e) => set('tributo', e.target.value)} disabled={form.modo === 'versao'}>
                {TRIBUTOS.map((t) => <option key={t} value={t}>{ROTULO_TRIBUTO[t] || t}</option>)}</select></label>
              <label>Regime<select value={form.campos.regime} onChange={(e) => set('regime', e.target.value)}><option value="">Qualquer</option>
                {Object.entries(REGIMES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <label>UF de origem<select value={form.campos.ufOrigem} onChange={(e) => set('ufOrigem', e.target.value)}><option value="">Qualquer</option>{UFS.map((u) => <option key={u}>{u}</option>)}</select></label>
              <label>UF de destino<select value={form.campos.ufDestino} onChange={(e) => set('ufDestino', e.target.value)}><option value="">Qualquer</option>{UFS.map((u) => <option key={u}>{u}</option>)}</select></label>
              <label>NCM (início)<input value={form.campos.ncmPrefixo} onChange={(e) => set('ncmPrefixo', e.target.value)} placeholder="ex.: 2202" inputMode="numeric" /></label>
              <label>CFOP<input value={form.campos.cfop} onChange={(e) => set('cfop', e.target.value)} placeholder="ex.: 5102" inputMode="numeric" /></label>
              <label>CST/CSOSN do produto<input value={form.campos.cstCsosnItem} onChange={(e) => set('cstCsosnItem', e.target.value)} inputMode="numeric" /></label>
              <label>Natureza<select value={form.campos.natureza} onChange={(e) => set('natureza', e.target.value)}><option value="">Qualquer</option>
                {Object.entries(NATUREZAS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <label>Cliente<select value={form.campos.perfilCliente} onChange={(e) => set('perfilCliente', e.target.value)}><option value="">Qualquer</option>
                {Object.entries(PERFIS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <label>CST/CSOSN a usar<input value={form.campos.cst} onChange={(e) => set('cst', e.target.value)} inputMode="numeric" /></label>
              <label>cClassTrib (IBS/CBS)<input value={form.campos.cclassTrib} onChange={(e) => set('cclassTrib', e.target.value)} inputMode="numeric" maxLength={6} /></label>
              <label>Alíquota (%)<input type="number" step="0.0001" min="0" max="100" value={form.campos.aliquota} onChange={(e) => set('aliquota', e.target.value)} /></label>
              <label>Redução da base (%)<input type="number" step="0.0001" min="0" max="99.9999" value={form.campos.reducaoBase} onChange={(e) => set('reducaoBase', e.target.value)} /></label>
              {form.campos.tributo === 'ICMS_ST' && <>
                <label>MVA (%)<input type="number" step="0.0001" min="0" value={form.campos.mva} onChange={(e) => set('mva', e.target.value)} /></label>
                <label>Alíquota interna do destino (%)<input type="number" step="0.0001" min="0" max="100" value={form.campos.aliquotaInternaDestino} onChange={(e) => set('aliquotaInternaDestino', e.target.value)} /></label>
              </>}
              {form.campos.tributo === 'ICMS' && <label>Base do DIFAL (venda para outra UF)<select value={form.campos.difalBase} onChange={(e) => set('difalBase', e.target.value)}>
                <option value="">Não se aplica / única</option><option value="unica">Base única</option><option value="dupla">Base dupla</option></select></label>}
              <label>Início da vigência<input type="date" value={form.campos.vigenciaInicio} onChange={(e) => set('vigenciaInicio', e.target.value)} required /></label>
              <label>Fim da vigência (opcional)<input type="date" value={form.campos.vigenciaFim} onChange={(e) => set('vigenciaFim', e.target.value)} /></label>
            </div>
            <label className="nfe-opcao" style={{ marginTop: 8 }}><input type="checkbox" checked={form.campos.recolhidoNoDas} onChange={(e) => set('recolhidoNoDas', e.target.checked)} /> Recolhido no DAS (Simples/MEI: não destaca valor no item)</label>
            <label className="nfe-opcao"><input type="checkbox" checked={form.campos.informativo} onChange={(e) => set('informativo', e.target.checked)} /> Só informativo (não soma no total de tributos)</label>
            <label>Fundamento legal / observação<textarea rows={2} value={form.campos.fundamento} onChange={(e) => set('fundamento', e.target.value)} maxLength={1000} /></label>
            {erro && <p className="modal-error">{erro}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setForm(null)}><Icon name="close" size={15} /> Cancelar</button>
              <button type="submit" className="btn-primary"><Icon name="save" size={15} /> Salvar</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/** Natureza da operação → CFOP: escolhe o que está fazendo e o destino. */
function NaturezasOperacao() {
  const [d, setD] = useState(null);
  const [q, setQ] = useState({ codigo: 'venda_revenda', ufDestino: '', comSt: false });
  const [r, setR] = useState(null);
  useEffect(() => { window.pdv.tributacao.naturezas().then(setD); }, []);
  useEffect(() => {
    if (!d?.ok) return;
    window.pdv.tributacao.cfopPorNatureza({ codigo: q.codigo, ufEmitente: d.contexto.ufOrigem, ufDestino: q.ufDestino || d.contexto.ufOrigem, comSt: q.comSt, regime: d.contexto.regime }).then(setR);
  }, [d, q]);
  if (!d) return null;
  if (d.ok === false) return <p className="modal-error">{d.error}</p>;
  return (
    <section className="settings-section">
      <h2><Icon name="document" size={16} /> <Termo t="Natureza da operação" /> → <Termo t="CFOP" /></h2>
      <p className="screen-hint">Diga o que a nota vai fazer e para onde: o sistema mostra o CFOP certo (dentro ou fora do estado, com ou sem <Termo t="ICMS-ST" />). Fonte: tabela CFOP oficial; confirme com o contador operações fora do dia a dia.</p>
      <div className="period-selector" style={{ flexWrap: 'wrap' }}>
        <select value={q.codigo} onChange={(e) => setQ({ ...q, codigo: e.target.value })} style={{ maxWidth: 380 }}>
          {['saida', 'entrada'].map((tipo) => (
            <optgroup key={tipo} label={tipo === 'saida' ? 'Saídas' : 'Entradas'}>
              {d.naturezas.filter((n) => n.tipo === tipo).map((n) => <option key={n.codigo} value={n.codigo}>{n.nome}</option>)}
            </optgroup>
          ))}
        </select>
        <select value={q.ufDestino} onChange={(e) => setQ({ ...q, ufDestino: e.target.value })} title="UF do destinatário / remetente">
          <option value="">{d.contexto.ufOrigem ? `Mesma UF (${d.contexto.ufOrigem})` : 'Mesma UF'}</option>{UFS.map((u) => <option key={u}>{u}</option>)}
        </select>
        <label className="nfe-opcao"><input type="checkbox" checked={q.comSt} onChange={(e) => setQ({ ...q, comSt: e.target.checked })} /> Mercadoria com ICMS-ST já retido</label>
      </div>
      {!r ? null : r.ok === false ? <p className="io-message-aviso">{r.error}</p> : (
        <div className="dashboard-stats" style={{ marginTop: 10 }}>
          <div className="stat-card"><span>CFOP</span><strong>{r.cfop}</strong></div>
          <div className="stat-card"><span>Finalidade da nota</span><strong style={{ fontSize: 15 }}>{r.finalidade === 4 ? '4 — devolução' : '1 — normal'}</strong></div>
          {r.csosnSugerido && <div className="stat-card"><span><Termo t="CSOSN" /></span><strong>{r.csosnSugerido}</strong></div>}
          <div className="stat-card"><span>Destino</span><strong style={{ fontSize: 15 }}>{r.interestadual ? 'Outro estado' : 'Dentro do estado'}</strong></div>
        </div>
      )}
      {r?.aviso && <p className="io-message-aviso" style={{ marginTop: 6 }}><Icon name="warning" size={14} /> {r.aviso}</p>}
    </section>
  );
}

function SimuladorTributario({ contexto }) {
  const [produto, setProduto] = useState(null);
  const [p, setP] = useState({ quantidade: 1, precoUnitario: '', ufDestino: '', perfilCliente: 'consumidor_final', natureza: 'venda', data: hojeLocal() });
  const [r, setR] = useState(null);
  useEffect(() => {
    if (!produto) return;
    window.pdv.tributacao.simularProduto({
      productId: produto.id, quantidade: Number(p.quantidade) || 1, precoUnitario: p.precoUnitario === '' ? undefined : Number(p.precoUnitario),
      ufDestino: p.ufDestino || undefined, perfilCliente: p.perfilCliente, natureza: p.natureza, data: p.data,
    }).then(setR);
  }, [produto?.id, p]);
  return (
    <section className="settings-section">
      <h2><Icon name="sparkle" size={16} /> Simulador</h2>
      <p className="screen-hint">Regime {REGIMES[contexto.regime] || 'não informado'}{contexto.ufOrigem ? `, loja em ${contexto.ufOrigem}` : ''}. Mostra qual regra vale para o produto e quanto daria cada tributo. Não muda a emissão da NFC-e.</p>
      <div className="period-selector" style={{ flexWrap: 'wrap' }}>
        <ProductPicker value={produto} onChange={(x) => { if (x) setProduto(x); }} width={260} />
        <input type="number" min="0.001" step="0.001" value={p.quantidade} onChange={(e) => setP({ ...p, quantidade: e.target.value })} style={{ width: 80 }} title="Quantidade" />
        <input type="number" min="0" step="0.01" placeholder="Preço (cadastro)" value={p.precoUnitario} onChange={(e) => setP({ ...p, precoUnitario: e.target.value })} style={{ width: 140 }} />
        <select value={p.ufDestino} onChange={(e) => setP({ ...p, ufDestino: e.target.value })} title="UF de destino"><option value="">Destino: mesma UF</option>{UFS.map((u) => <option key={u}>{u}</option>)}</select>
        <select value={p.perfilCliente} onChange={(e) => setP({ ...p, perfilCliente: e.target.value })}>{Object.entries(PERFIS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
        <input type="date" value={p.data} onChange={(e) => setP({ ...p, data: e.target.value })} title="Data da operação" />
      </div>
      {!produto ? <p className="empty-state">Escolha um produto.</p> : !r ? <p className="empty-state">Calculando...</p> : r.ok === false ? <p className="modal-error">{r.error}</p> : (
        <>
          <p className="screen-hint" style={{ marginTop: 0 }}>NCM {r.produto.ncm || '—'} · CFOP {r.produto.cfop || '—'} · CST/CSOSN do cadastro {r.produto.cstCsosn || '—'} · base {brl(r.baseOperacao)}</p>
          {[...r.avisos, ...r.divergencias].map((a) => <p key={a} className="io-message-aviso" style={{ marginBottom: 6 }}><Icon name="warning" size={14} /> {a}</p>)}
          {r.tributos.length === 0 ? <p className="empty-state">Nenhuma regra vale para esta operação.</p> : (
            <table className="data-table">
              <thead><tr><th>Tributo</th><th>CST/CSOSN</th><th style={{ textAlign: 'right' }}>Base</th><th style={{ textAlign: 'right' }}>Alíquota</th><th style={{ textAlign: 'right' }}>Valor</th><th>Regra usada</th></tr></thead>
              <tbody>{r.tributos.map((t) => (
                <tr key={t.tributo}>
                  <td><strong>{ROTULO_TRIBUTO[t.tributo] || t.tributo}</strong>{t.informativo && <div className="nfe-item-codigos">informativo</div>}</td>
                  <td>{t.cst || '—'}{t.cclassTrib ? <div className="nfe-item-codigos">cClassTrib {t.cclassTrib}</div> : null}</td>
                  <td style={{ textAlign: 'right' }}>{t.recolhidoNoDas ? '—' : brl(t.base)}</td>
                  <td style={{ textAlign: 'right' }}>{t.recolhidoNoDas ? 'no DAS' : pct(t.aliquota)}</td>
                  <td style={{ textAlign: 'right' }}>{brl(t.valor)}</td>
                  <td title={t.regra.fundamento || ''}>{t.regra.nome} <span className="nfe-item-codigos">v{t.regra.versao} · {t.regra.origem === 'sistema' ? 'sistema' : 'loja'}</span>
                    {t.avisoEmpate && <div className="nfe-item-codigos">{t.avisoEmpate}</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <p className="screen-hint">Total de tributos destacados (sem os informativos): <strong>{brl(r.totalDestacado)}</strong></p>
        </>
      )}
    </section>
  );
}
