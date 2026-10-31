import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';
import { brl, brlCusto, qtd } from './erpUtils';

/** Cadastro automático: produtos novos da nota, NCM pela IA e motor x cadastro. */

const ARREDONDAMENTO = { x9: 'Terminar em 9 centavos (9,49)', x90: 'Terminar em ,90 (9,90)', nenhum: 'Sem arredondar' };

export function ProdutosDaNotaModal({ entradaId, onClose, onFeito }) {
  const { currentUser } = useSession();
  useEscToClose(onClose, true);
  const [margem, setMargem] = useState('');
  const [arred, setArred] = useState('x9');
  const [categoria, setCategoria] = useState('');
  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [iniciado, setIniciado] = useState(false);

  async function carregar(m = margem, a = arred, c = categoria) {
    const r = await window.pdv.nfeEntradas.produtosNovos({ entradaId, margemPercentual: m === '' ? undefined : Number(m), arredondamento: a, categoria: c });
    if (!r?.ok) { setErro(r?.error || 'Não foi possível montar a prévia.'); return; }
    setErro('');
    setPrevia(r);
    if (!iniciado) {
      setIniciado(true);
      if (r.margem !== null && r.margem !== undefined) setMargem(String(r.margem));
      setArred(r.arredondamento);
    }
  }
  useEffect(() => { carregar(); }, []);
  useEffect(() => { if (iniciado) carregar(); }, [margem, arred, categoria]);

  async function cadastrar(e) {
    e.preventDefault();
    setSalvando(true);
    const r = await window.pdv.nfeEntradas.cadastrarProdutosNovos({
      entradaId, margemPercentual: margem === '' ? undefined : Number(margem), arredondamento: arred, categoria, operadorId: currentUser.id,
    });
    setSalvando(false);
    if (!r?.ok) { setErro(r?.error || 'Não foi possível cadastrar.'); return; }
    onFeito(r);
  }

  const criar = previa?.itens.filter((i) => i.acao === 'criar').length || 0;
  const vincular = previa?.itens.filter((i) => i.acao === 'vincular').length || 0;
  return (
    <div className="modal-overlay">
      <form className="modal-card" onSubmit={cadastrar} style={{ width: 'min(1040px, 100%)' }}>
        <h2><Icon name="sparkle" size={18} /> Cadastrar produtos da nota</h2>
        <p className="screen-hint" style={{ margin: 0 }}>
          Cada item sem produto vira um produto novo: nome limpo, código de barras da unidade, custo da nota, preço pela sua margem,
          categoria e dados fiscais tirados de produtos parecidos da loja (ou do CFOP do fornecedor). Dá para editar depois em Produtos.
        </p>
        <div className="form-grid">
          <label>Margem sobre o custo (%)<input type="number" min="0" max="1000" step="0.1" value={margem} onChange={(e) => setMargem(e.target.value)} required placeholder="ex.: 40" /></label>
          <label>Preço final<select value={arred} onChange={(e) => setArred(e.target.value)}>{Object.entries(ARREDONDAMENTO).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          <label>Categoria (vazio = automática pelo NCM)<input value={categoria} onChange={(e) => setCategoria(e.target.value)} maxLength={60} /></label>
        </div>
        {erro && <p className="modal-error">{erro}</p>}
        {!previa ? <p className="empty-state">Montando a prévia...</p> : previa.itens.length === 0 ? <p className="empty-state">Todos os itens já têm produto.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Produto</th><th>Código</th><th>Unid.</th><th style={{ textAlign: 'right' }}>Custo</th><th style={{ textAlign: 'right' }}>Preço</th><th>Categoria</th><th>Fiscal</th></tr></thead>
              <tbody>{previa.itens.map((i) => (
                <tr key={i.itemId}>
                  <td>{i.acao === 'vincular' ? <><span className="chip-situacao chip-novo">já existe</span> {i.nomeExistente}</> : <strong>{i.nome}</strong>}
                    <div className="nfe-item-codigos">na nota: {i.descricao}</div></td>
                  <td>{i.codigoBarras || '—'}{i.eanEmProdutoInativo && <div className="nfe-item-codigos">código de produto desativado: fica sem</div>}</td>
                  <td>{i.unidade}{i.fator > 1 && <div className="nfe-item-codigos">caixa com {qtd(i.fator)}</div>}</td>
                  <td style={{ textAlign: 'right' }}>{brlCusto(i.custo)}</td>
                  <td style={{ textAlign: 'right' }}>{i.acao === 'vincular' ? '—' : i.preco ? <strong>{brl(i.preco)}</strong> : '—'}</td>
                  <td>{i.acao === 'vincular' ? '—' : i.categoria || '—'}</td>
                  <td>{i.acao === 'vincular' ? '—' : i.cfop ? `${i.cfop} / ${i.cstCsosn}${i.cest ? ` · CEST ${i.cest}` : ''}` : <span className="valor-erro">sem regra</span>}
                    {i.acao !== 'vincular' && <div className="nfe-item-codigos">NCM {i.ncm || '—'}{i.fonteFiscal ? ` · ${i.fonteFiscal}` : ''}</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={15} /> Cancelar</button>
          <button type="submit" className="btn-primary" disabled={salvando || !previa || previa.itens.length === 0 || margem === ''}>
            <Icon name="add" size={15} /> {salvando ? 'Cadastrando...' : `Cadastrar ${criar}${vincular ? ` e vincular ${vincular}` : ''}`}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Fiscal → Cadastro fiscal: NCM sugerido pela IA para quem não tem nota. */
export function NcmPorIa({ semNcm, onAplicado }) {
  const { currentUser } = useSession();
  const [estado, setEstado] = useState(null); // null | 'carregando' | resultado
  const [marcados, setMarcados] = useState({});
  const [msg, setMsg] = useState('');
  async function sugerir() {
    setEstado('carregando'); setMsg('');
    const r = await window.pdv.assistenteFiscal.sugerirNcmIA({ limite: 30 });
    if (!r?.ok) { setEstado(null); setMsg(r?.error || 'A IA não respondeu.'); return; }
    setEstado(r);
    setMarcados(Object.fromEntries(r.sugestoes.map((s) => [s.productId, s.confianca === 'alta'])));
  }
  async function aplicar() {
    const itens = estado.sugestoes.filter((s) => marcados[s.productId]).map((s) => ({ productId: s.productId, ncm: s.ncm, cest: s.cest }));
    const r = await window.pdv.assistenteFiscal.aplicarNcm({ itens, operadorId: currentUser.id });
    if (!r?.ok) { setMsg(r?.error); return; }
    setMsg(`NCM gravado em ${r.ncmGravados} produto(s); ${r.completadosPelaLoja} completado(s) com CFOP/CSOSN pelo que a loja já usa.`);
    setEstado(null);
    onAplicado();
  }
  return (
    <section className="settings-section">
      <h2><Icon name="sparkle" size={16} /> Sem nota de compra? NCM pela IA</h2>
      <p className="screen-hint">{semNcm} produto(s) sem NCM. A IA sugere pelo nome (30 por vez); você confere e grava. Só preenche quem está sem NCM, e o resto do cadastro fiscal vem dos produtos da loja com o mesmo NCM.</p>
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      {estado === null && <button className="btn-secondary" onClick={sugerir} disabled={!semNcm}><Icon name="sparkle" size={15} /> Sugerir NCM</button>}
      {estado === 'carregando' && <p className="empty-state">Consultando a IA...</p>}
      {estado && estado !== 'carregando' && (
        estado.sugestoes.length === 0 ? <p className="empty-state">A IA não teve segurança para nenhum produto.</p> : (
          <>
            <table className="data-table">
              <thead><tr><th></th><th>Produto</th><th>NCM sugerido</th><th>Confiança</th><th>Fiscal da loja para esse NCM</th></tr></thead>
              <tbody>{estado.sugestoes.map((s) => (
                <tr key={s.productId}>
                  <td><input type="checkbox" checked={!!marcados[s.productId]} onChange={(e) => setMarcados({ ...marcados, [s.productId]: e.target.checked })} /></td>
                  <td>{s.nome}</td>
                  <td><strong>{s.ncm}</strong>{s.cest ? ` · CEST ${s.cest}` : ''}<div className="nfe-item-codigos">{s.descricao}</div></td>
                  <td><span className={`chip-situacao ${s.confianca === 'alta' ? 'chip-novo' : s.confianca === 'media' ? 'chip-atualizar' : 'chip-erro'}`}>{s.confianca}</span></td>
                  <td>{s.fiscalDaLoja ? `${s.fiscalDaLoja.cfop} / ${s.fiscalDaLoja.cstCsosn} (${s.fiscalDaLoja.produtos} produto(s))` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
            {estado.semSugestao.length > 0 && <p className="screen-hint">Sem sugestão segura: {estado.semSugestao.map((p) => p.nome).join(', ')}.</p>}
            <div className="settings-actions">
              <button className="btn-primary" onClick={aplicar} disabled={!Object.values(marcados).some(Boolean)}><Icon name="checkCircle" size={15} /> Gravar os marcados</button>
              <button className="btn-secondary" onClick={() => setEstado(null)}>Descartar</button>
            </div>
          </>
        )
      )}
    </section>
  );
}

/** Fiscal → Regras tributárias: o cadastro bate com as regras? */
export function MotorXCadastro() {
  const { currentUser } = useSession();
  const [r, setR] = useState(null);
  const [msg, setMsg] = useState('');
  const carregar = () => window.pdv.tributacao.conferirCadastro().then(setR);
  useEffect(() => { carregar(); }, []);
  async function aplicar() {
    if (!confirm(`Gravar o CST/CSOSN indicado pelas regras em ${r.total} produto(s)? Fica na Auditoria.`)) return;
    const res = await window.pdv.tributacao.aplicarAoCadastro({ operadorId: currentUser.id });
    setMsg(res?.ok ? `${res.aplicados} produto(s) ajustado(s).` : res?.error);
    carregar();
  }
  if (!r) return null;
  return (
    <section className="settings-section">
      <h2><Icon name="checkCircle" size={16} /> Cadastro × regras</h2>
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      {r.ok === false ? <p className="screen-hint">{r.error}</p> : r.total === 0 ? <p className="screen-hint">O CST/CSOSN dos produtos bate com as regras vigentes.</p> : (
        <>
          <p className="screen-hint">{r.total} produto(s) com CST/CSOSN diferente do que as regras indicam. Regra genérica do sistema só corrige vazio ou incoerente; regra da loja vale sempre.</p>
          <table className="data-table">
            <thead><tr><th>Produto</th><th>CFOP</th><th>Hoje</th><th>Regra indica</th><th>Por quê</th></tr></thead>
            <tbody>{r.divergentes.slice(0, 20).map((d) => (
              <tr key={d.id}><td>{d.nome}</td><td>{d.cfop}</td><td>{d.atual || '—'}</td><td><strong>{d.indicado}</strong><div className="nfe-item-codigos">{d.regra} v{d.versao}</div></td><td>{d.motivo}</td></tr>
            ))}</tbody>
          </table>
          {r.total > 20 && <p className="screen-hint">Mostrando 20 de {r.total}.</p>}
          <div className="settings-actions"><button className="btn-primary" onClick={aplicar}><Icon name="checkCircle" size={15} /> Aplicar as regras ao cadastro</button></div>
        </>
      )}
    </section>
  );
}

/** Depois de lançar a nota: preços que ficaram abaixo da margem padrão com o custo novo. */
export function ReajustePrecos({ entradaId }) {
  const { currentUser } = useSession();
  const [r, setR] = useState(null);
  const [marcados, setMarcados] = useState({});
  const [msg, setMsg] = useState('');
  useEffect(() => {
    window.pdv.nfeEntradas.reajustePrecos({ entradaId }).then((x) => {
      setR(x);
      if (x?.ok) setMarcados(Object.fromEntries(x.itens.map((i) => [i.productId, true])));
    });
  }, [entradaId]);
  async function aplicar() {
    const itens = r.itens.filter((i) => marcados[i.productId]).map((i) => ({ productId: i.productId, preco: i.precoSugerido, precoAnterior: i.precoAtual }));
    const res = await window.pdv.nfeEntradas.aplicarReajuste({ itens, operadorId: currentUser.id });
    setMsg(res?.ok ? `Preço de ${res.aplicados} produto(s) atualizado.` : res?.error);
    if (res?.ok) setR({ ...r, itens: [] });
  }
  if (msg) return <p className="io-message" style={{ marginTop: 12 }}>{msg}</p>;
  if (!r?.ok || r.itens.length === 0) return null;
  return (
    <section className="settings-section" style={{ marginTop: 16 }}>
      <h2><Icon name="trendUp" size={16} /> Preços abaixo da sua margem ({r.margem}%)</h2>
      <p className="screen-hint">Com o custo novo desta nota, estes produtos ficaram abaixo da margem padrão. Marque os que quer reajustar.</p>
      <table className="data-table">
        <thead><tr><th></th><th>Produto</th><th style={{ textAlign: 'right' }}>Custo médio</th><th style={{ textAlign: 'right' }}>Preço hoje</th><th style={{ textAlign: 'right' }}>Margem hoje</th><th style={{ textAlign: 'right' }}>Preço sugerido</th></tr></thead>
        <tbody>{r.itens.map((i) => (
          <tr key={i.productId}>
            <td><input type="checkbox" checked={!!marcados[i.productId]} onChange={(e) => setMarcados({ ...marcados, [i.productId]: e.target.checked })} /></td>
            <td>{i.nome}</td>
            <td style={{ textAlign: 'right' }}>{brlCusto(i.custo)}</td>
            <td style={{ textAlign: 'right' }}>{brl(i.precoAtual)}</td>
            <td style={{ textAlign: 'right' }} className={i.margemAtual !== null && i.margemAtual < 0 ? 'valor-erro' : undefined}>{i.margemAtual === null ? '—' : `${i.margemAtual}%`}</td>
            <td style={{ textAlign: 'right' }}><strong>{brl(i.precoSugerido)}</strong></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="settings-actions"><button className="btn-primary" onClick={aplicar} disabled={!Object.values(marcados).some(Boolean)}><Icon name="checkCircle" size={15} /> Aplicar preços marcados</button></div>
    </section>
  );
}
