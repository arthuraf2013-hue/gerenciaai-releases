import { lazy, Suspense, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';
import { VazioGuia } from '../common/VazioGuia';
import { Abas, brl, brlCusto, qtd, dataBR, hojeLocal, somarDias } from '../inventory/erpUtils';

/**
 * Perfil Almoxarifado: itens com endereço, saldo e validade; endereços
 * físicos; lotes em ordem FEFO; setores; kardex com custo médio (gestão).
 * Backend em electron/services/almoxarifadoService.js (canais almox:*).
 */

const TrainingPresentationModal = lazy(() => import('../pos/TrainingPresentationModal').then((m) => ({ default: m.TrainingPresentationModal })));

const GESTAO = ['gerente', 'admin', 'suporte'];
const SITUACAO = {
  vencido: ['chip-erro', 'vencido'],
  vencendo: ['chip-atualizar', 'vence em breve'],
  ok: ['chip-novo', 'no prazo'],
  sem_validade: ['chip-neutro', 'sem validade'],
};
const FILTROS_ITENS = [
  { id: 'todos', rotulo: 'Todos' },
  { id: 'sem_endereco', rotulo: 'Sem endereço' },
  { id: 'abaixo_minimo', rotulo: 'Abaixo do mínimo' },
  { id: 'vencendo', rotulo: 'Vencidos ou vencendo' },
];

function Chip({ situacao }) {
  const [classe, rotulo] = SITUACAO[situacao] || SITUACAO.sem_validade;
  return <span className={`chip-situacao ${classe}`}>{rotulo}</span>;
}

// jsbarcode só carrega quando alguém imprime (igual ao ProductForm).
async function imagemDoCodigo(codigo) {
  if (!codigo) return null;
  const { default: JsBarcode } = await import('jsbarcode');
  const canvas = document.createElement('canvas');
  try {
    JsBarcode(canvas, codigo, { format: 'CODE128', displayValue: false, margin: 0, height: 60 });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function ModalEtiquetas({ etiquetas, onClose }) {
  const [tamanho, setTamanho] = useState('50x30');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  useEscToClose(onClose, true);
  async function imprimir() {
    setEnviando(true);
    const prontas = [];
    for (const e of etiquetas) prontas.push({ ...e, barcodeDataUrl: await imagemDoCodigo(e.codigo) });
    const r = await window.pdv.almox.imprimirEtiquetas({ etiquetas: prontas, tamanho });
    setEnviando(false);
    if (!r?.ok) return setErro(r?.error || 'Não foi possível imprimir.');
    onClose();
  }
  return (
    <div className="modal-overlay"><div className="modal-card">
      <h2><Icon name="printer" size={18} /> Imprimir {etiquetas.length} etiqueta(s)</h2>
      <label>Tamanho da etiqueta
        <select value={tamanho} onChange={(e) => setTamanho(e.target.value)}>
          <option value="50x30">50 × 30 mm</option>
          <option value="100x50">100 × 50 mm</option>
        </select>
      </label>
      <p className="screen-hint">Prévia: <strong>{etiquetas[0]?.titulo}</strong>{etiquetas[0]?.linhas?.length ? ` · ${etiquetas[0].linhas.join(' · ')}` : ''}{etiquetas[0]?.codigo ? ` · ${etiquetas[0].codigo}` : ''}</p>
      {etiquetas.some((e) => !e.codigo) && <p className="io-message-aviso">Itens sem código de barras nem SKU saem sem código: cadastre um em Produtos para ler com o leitor.</p>}
      {erro && <p className="modal-error">{erro}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={15} /> Cancelar</button>
        <button type="button" className="btn-primary" onClick={imprimir} disabled={enviando}><Icon name="printer" size={15} /> {enviando ? 'Enviando...' : 'Imprimir'}</button>
      </div>
    </div></div>
  );
}

function ModalEnderecosDoItem({ item, onClose, onMudou }) {
  const [ends, setEnds] = useState(null);
  const [todos, setTodos] = useState([]);
  const [escolhido, setEscolhido] = useState('');
  const [erro, setErro] = useState('');
  useEscToClose(onClose, true);
  const carregar = () => window.pdv.almox.enderecosDoItem({ productId: item.id }).then(setEnds);
  useEffect(() => { carregar(); window.pdv.almox.enderecos({}).then((l) => setTodos(Array.isArray(l) ? l : [])); }, [item.id]);
  async function acao(promessa) {
    const r = await promessa;
    if (r?.ok === false) return setErro(r.error);
    setErro(''); carregar(); onMudou();
  }
  const livres = todos.filter((e) => !ends?.some((x) => x.id === e.id));
  return (
    <div className="modal-overlay"><div className="modal-card">
      <h2><Icon name="map" size={18} /> Onde fica: {item.nome}</h2>
      {ends === null ? <p className="empty-state">Carregando...</p> : ends.length === 0 ? <p className="empty-state">Este item ainda não tem endereço.</p> : (
        <table className="data-table">
          <thead><tr><th>Endereço</th><th>Descrição</th><th></th></tr></thead>
          <tbody>{ends.map((e) => (
            <tr key={e.id}>
              <td><strong>{e.codigo}</strong>{e.principal === 1 && <span className="chip-situacao chip-novo" style={{ marginLeft: 6 }}>principal</span>}</td>
              <td>{e.descricao || '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {e.principal !== 1 && <button className="btn-link" onClick={() => acao(window.pdv.almox.vincularEndereco({ productId: item.id, enderecoId: e.id, principal: true }))}>Tornar principal</button>}
                <button className="btn-link" onClick={() => acao(window.pdv.almox.desvincularEndereco({ productId: item.id, enderecoId: e.id }))}>Tirar</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {todos.length === 0 ? <p className="screen-hint">Cadastre os endereços na aba <strong>Endereços</strong> primeiro.</p> : (
        <div className="inline-form" style={{ marginTop: 10 }}>
          <select value={escolhido} onChange={(e) => setEscolhido(e.target.value)}>
            <option value="">Escolha um endereço...</option>
            {livres.map((e) => <option key={e.id} value={e.id}>{e.codigo}{e.descricao ? ` — ${e.descricao}` : ''}</option>)}
          </select>
          <button className="btn-primary" disabled={!escolhido} onClick={() => { acao(window.pdv.almox.vincularEndereco({ productId: item.id, enderecoId: escolhido })); setEscolhido(''); }}><Icon name="add" size={15} /> Guardar aqui</button>
        </div>
      )}
      {erro && <p className="modal-error">{erro}</p>}
      <div className="modal-actions"><button type="button" className="btn-secondary" onClick={onClose}><Icon name="check" size={15} /> Pronto</button></div>
    </div></div>
  );
}

function AbaItens({ gestao, onKardex, onPainelMudou }) {
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [itens, setItens] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [enderecoDe, setEnderecoDe] = useState(null);
  const [etiquetas, setEtiquetas] = useState(null);
  const carregar = () => window.pdv.almox.itens({ locationId: window.APP_LOCATION_ID, busca, filtro }).then((l) => setItens(Array.isArray(l) ? l : []));
  useEffect(() => { const t = setTimeout(carregar, 250); return () => clearTimeout(t); }, [busca, filtro]);
  const alternar = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function abrirEtiquetas() {
    const dados = await window.pdv.almox.dadosEtiquetas({ productIds: [...sel] });
    setEtiquetas((Array.isArray(dados) ? dados : []).map((d) => ({ titulo: d.nome, linhas: [d.endereco ? `End.: ${d.endereco}` : '', d.unidade ? `Unid.: ${d.unidade}` : ''].filter(Boolean), codigo: d.codigo })));
  }
  return (
    <>
      <div className="inline-form" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <input placeholder="Buscar por nome, código ou endereço (ex.: A-03)" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ minWidth: 300 }} autoFocus />
        {FILTROS_ITENS.map((f) => (
          <button key={f.id} className={filtro === f.id ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setFiltro(f.id)}>{f.rotulo}</button>
        ))}
        <button className="btn-secondary" disabled={sel.size === 0} onClick={abrirEtiquetas}><Icon name="printer" size={15} /> Etiquetas ({sel.size})</button>
      </div>
      {itens === null ? <p className="empty-state">Carregando...</p> : itens.length === 0 ? (
        <VazioGuia icone="box" titulo={busca || filtro !== 'todos' ? 'Nenhum item encontrado.' : 'Nenhum item cadastrado ainda.'}>
          {busca || filtro !== 'todos' ? 'Tente outra busca ou outro filtro.' : <>Cadastre os materiais em <strong>Produtos</strong> e depois diga onde cada um fica.</>}
        </VazioGuia>
      ) : (
        <table className="data-table">
          <thead><tr>
            <th style={{ width: 32 }}><input type="checkbox" aria-label="Selecionar todos" checked={sel.size > 0 && sel.size === itens.length} onChange={(e) => setSel(e.target.checked ? new Set(itens.map((i) => i.id)) : new Set())} /></th>
            <th>Item</th><th style={{ textAlign: 'right' }}>Saldo</th><th>Endereço</th><th>Próxima validade</th><th></th>
          </tr></thead>
          <tbody>{itens.map((i) => (
            <tr key={i.id}>
              <td><input type="checkbox" aria-label={`Selecionar ${i.nome}`} checked={sel.has(i.id)} onChange={() => alternar(i.id)} /></td>
              <td><strong>{i.nome}</strong><div className="nfe-item-codigos">{[i.codigo_barras || i.sku, i.categoria].filter(Boolean).join(' · ') || '—'}</div></td>
              <td style={{ textAlign: 'right' }} className={i.abaixoMinimo ? 'text-danger' : ''}>
                {qtd(i.saldo)} {i.unidade}
                {Number(i.estoque_minimo) > 0 && <div className="nfe-item-codigos">mín. {qtd(i.estoque_minimo)}</div>}
              </td>
              <td>{i.endereco ? <><strong>{i.endereco}</strong>{i.qtd_enderecos > 1 && <span className="nfe-item-codigos"> +{i.qtd_enderecos - 1}</span>}</> : <span className="nfe-item-codigos">sem endereço</span>}</td>
              <td>{i.proxima_validade ? <>{dataBR(i.proxima_validade)} <Chip situacao={i.situacaoValidade} /></> : <span className="nfe-item-codigos">—</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn-link" onClick={() => setEnderecoDe(i)}>Endereço</button>
                {gestao && <button className="btn-link" onClick={() => onKardex(i)}>Kardex</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {enderecoDe && <ModalEnderecosDoItem item={enderecoDe} onClose={() => setEnderecoDe(null)} onMudou={() => { carregar(); onPainelMudou(); }} />}
      {etiquetas && <ModalEtiquetas etiquetas={etiquetas} onClose={() => { setEtiquetas(null); setSel(new Set()); }} />}
    </>
  );
}

const ENDERECO_VAZIO = { rua: '', prateleira: '', posicao: '', descricao: '' };
function codigoPrevia({ rua, prateleira, posicao }) {
  return [rua, prateleira, posicao].map((p) => String(p || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')).filter(Boolean).join('-');
}

function AbaEnderecos({ gestao, onPainelMudou }) {
  const [lista, setLista] = useState(null);
  const [inativos, setInativos] = useState(false);
  const [form, setForm] = useState(null);
  const [itensDe, setItensDe] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [etiquetas, setEtiquetas] = useState(null);
  const [erro, setErro] = useState('');
  useEscToClose(() => { setForm(null); setItensDe(null); }, !!form || !!itensDe);
  const carregar = () => window.pdv.almox.enderecos({ incluirInativos: inativos }).then((l) => setLista(Array.isArray(l) ? l : []));
  useEffect(() => { carregar(); }, [inativos]);
  async function salvar(e) {
    e.preventDefault();
    const r = await window.pdv.almox.salvarEndereco(form);
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setForm(null); carregar(); onPainelMudou();
  }
  async function ativar(end, ativo) {
    const r = await window.pdv.almox.ativarEndereco({ id: end.id, ativo });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); carregar(); onPainelMudou();
  }
  async function verItens(end) {
    const itens = await window.pdv.almox.itensDoEndereco({ enderecoId: end.id, locationId: window.APP_LOCATION_ID });
    setItensDe({ end, itens: Array.isArray(itens) ? itens : [] });
  }
  const alternar = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <div className="inline-form" style={{ marginBottom: 10 }}>
        {gestao && <button className="btn-primary" onClick={() => { setErro(''); setForm({ ...ENDERECO_VAZIO }); }}><Icon name="add" size={15} /> Novo endereço</button>}
        <button className="btn-secondary" disabled={sel.size === 0} onClick={() => setEtiquetas((lista || []).filter((e) => sel.has(e.id)).map((e) => ({ titulo: e.codigo, linhas: e.descricao ? [e.descricao] : [], codigo: e.codigo })))}><Icon name="printer" size={15} /> Etiquetas ({sel.size})</button>
        <label className="nfe-opcao"><input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} /> Mostrar desativados</label>
      </div>
      {erro && !form && <p className="modal-error">{erro}</p>}
      {lista === null ? <p className="empty-state">Carregando...</p> : lista.length === 0 ? (
        <VazioGuia icone="map" titulo="Nenhum endereço cadastrado.">Crie os endereços por rua, prateleira e posição (ex.: <strong>A-03-02</strong>) e imprima a etiqueta de cada um para colar na prateleira.</VazioGuia>
      ) : (
        <table className="data-table">
          <thead><tr><th style={{ width: 32 }}></th><th>Endereço</th><th>Descrição</th><th style={{ textAlign: 'right' }}>Itens</th><th></th></tr></thead>
          <tbody>{lista.map((e) => (
            <tr key={e.id} style={e.ativo ? undefined : { opacity: 0.55 }}>
              <td><input type="checkbox" aria-label={`Selecionar ${e.codigo}`} checked={sel.has(e.id)} onChange={() => alternar(e.id)} /></td>
              <td><strong>{e.codigo}</strong></td>
              <td>{e.descricao || '—'}</td>
              <td style={{ textAlign: 'right' }}>{e.itens}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn-link" onClick={() => verItens(e)}>Ver itens</button>
                {gestao && <button className="btn-link" onClick={() => { setErro(''); setForm({ id: e.id, rua: e.rua, prateleira: e.prateleira || '', posicao: e.posicao || '', descricao: e.descricao || '' }); }}>Editar</button>}
                {gestao && <button className="btn-link" onClick={() => ativar(e, !e.ativo)}>{e.ativo ? 'Desativar' : 'Reativar'}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {form && (
        <div className="modal-overlay"><form className="modal-card" onSubmit={salvar}>
          <h2><Icon name="map" size={18} /> {form.id ? 'Editar endereço' : 'Novo endereço'}</h2>
          <div className="form-grid">
            <label>Rua / área<input value={form.rua} onChange={(e) => setForm({ ...form, rua: e.target.value })} required maxLength={12} placeholder="A" autoFocus /></label>
            <label>Prateleira<input value={form.prateleira} onChange={(e) => setForm({ ...form, prateleira: e.target.value })} maxLength={12} placeholder="03" /></label>
            <label>Posição<input value={form.posicao} onChange={(e) => setForm({ ...form, posicao: e.target.value })} maxLength={12} placeholder="02" /></label>
            <label>Descrição<input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} maxLength={120} placeholder="EPI, parafusos..." /></label>
          </div>
          <p className="screen-hint">Código: <strong>{codigoPrevia(form) || '—'}</strong></p>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}><Icon name="close" size={15} /> Cancelar</button>
            <button type="submit" className="btn-primary"><Icon name="save" size={15} /> Salvar</button>
          </div>
        </form></div>
      )}
      {itensDe && (
        <div className="modal-overlay"><div className="modal-card">
          <h2><Icon name="box" size={18} /> Itens em {itensDe.end.codigo}</h2>
          {itensDe.itens.length === 0 ? <p className="empty-state">Nenhum item guardado aqui.</p> : (
            <table className="data-table">
              <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
              <tbody>{itensDe.itens.map((i) => (
                <tr key={i.id}><td><strong>{i.nome}</strong>{i.principal === 1 && <span className="chip-situacao chip-novo" style={{ marginLeft: 6 }}>principal</span>}</td><td style={{ textAlign: 'right' }}>{qtd(i.saldo)} {i.unidade}</td></tr>
              ))}</tbody>
            </table>
          )}
          <div className="modal-actions"><button type="button" className="btn-secondary" onClick={() => setItensDe(null)}><Icon name="close" size={15} /> Fechar</button></div>
        </div></div>
      )}
      {etiquetas && <ModalEtiquetas etiquetas={etiquetas} onClose={() => { setEtiquetas(null); setSel(new Set()); }} />}
    </>
  );
}

function AbaLotes({ diasAlerta }) {
  const [situacao, setSituacao] = useState('todos');
  const [busca, setBusca] = useState('');
  const [lista, setLista] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => window.pdv.almox.lotes({ locationId: window.APP_LOCATION_ID, situacao, busca }).then((l) => setLista(Array.isArray(l) ? l : [])), 250);
    return () => clearTimeout(t);
  }, [situacao, busca]);
  return (
    <>
      <p className="screen-hint">Ordem de saída FEFO: o lote que vence primeiro sai primeiro. "Vence em breve" = até {diasAlerta} dias.</p>
      <div className="inline-form" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <input placeholder="Buscar item, lote ou código" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ minWidth: 260 }} />
        {[['todos', 'Todos'], ['vencido', 'Vencidos'], ['vencendo', 'Vencendo'], ['ok', 'No prazo'], ['sem_validade', 'Sem validade']].map(([id, rot]) => (
          <button key={id} className={situacao === id ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setSituacao(id)}>{rot}</button>
        ))}
      </div>
      {lista === null ? <p className="empty-state">Carregando...</p> : lista.length === 0 ? (
        <VazioGuia icone="calendar" titulo="Nenhum lote com saldo aqui.">Os lotes entram pelo <strong>Abastecimento</strong>, com número e validade.</VazioGuia>
      ) : (
        <table className="data-table">
          <thead><tr><th>Item</th><th>Lote</th><th>Validade</th><th style={{ textAlign: 'right' }}>Saldo</th><th>Saída</th></tr></thead>
          <tbody>{lista.map((l) => (
            <tr key={l.id}>
              <td><strong>{l.produto_nome}</strong>{l.fornecedor_nome && <div className="nfe-item-codigos">{l.fornecedor_nome}</div>}</td>
              <td>{l.lote || '—'}</td>
              <td>{l.validade ? dataBR(l.validade) : '—'} <Chip situacao={l.situacao} />
                {l.diasParaVencer !== null && l.situacao !== 'ok' && <div className="nfe-item-codigos">{l.diasParaVencer < 0 ? `venceu há ${-l.diasParaVencer} dia(s)` : `faltam ${l.diasParaVencer} dia(s)`}</div>}</td>
              <td style={{ textAlign: 'right' }}>{qtd(l.saldo)} {l.unidade}{l.estimado && <div className="nfe-item-codigos" title="Lote anterior ao controle por lote: saldo = quantidade de entrada.">estimado</div>}</td>
              <td>{l.ordemFefo === 1 ? <span className="chip-situacao chip-novo">usar primeiro</span> : <span className="nfe-item-codigos">{l.ordemFefo}º</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}

const SETOR_VAZIO = { nome: '', responsavel: '', limiteMensal: '' };
function AbaSetores({ gestao }) {
  const [lista, setLista] = useState(null);
  const [inativos, setInativos] = useState(false);
  const [form, setForm] = useState(null);
  const [erro, setErro] = useState('');
  useEscToClose(() => setForm(null), !!form);
  const carregar = () => window.pdv.almox.setores({ incluirInativos: inativos }).then((l) => setLista(Array.isArray(l) ? l : []));
  useEffect(() => { carregar(); }, [inativos]);
  async function salvar(e) {
    e.preventDefault();
    const r = await window.pdv.almox.salvarSetor(form);
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setForm(null); carregar();
  }
  async function ativar(s) {
    const r = await window.pdv.almox.ativarSetor({ id: s.id, ativo: !s.ativo });
    if (!r?.ok) return setErro(r?.error);
    carregar();
  }
  return (
    <>
      <div className="inline-form" style={{ marginBottom: 10 }}>
        {gestao && <button className="btn-primary" onClick={() => { setErro(''); setForm({ ...SETOR_VAZIO }); }}><Icon name="add" size={15} /> Novo setor</button>}
        <label className="nfe-opcao"><input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} /> Mostrar desativados</label>
      </div>
      {lista === null ? <p className="empty-state">Carregando...</p> : lista.length === 0 ? (
        <VazioGuia icone="users" titulo="Nenhum setor cadastrado.">Cadastre os setores que pedem material (manutenção, limpeza, obras...) para saber quem consome o quê.</VazioGuia>
      ) : (
        <table className="data-table">
          <thead><tr><th>Setor</th><th>Responsável</th><th style={{ textAlign: 'right' }}>Limite mensal</th><th></th></tr></thead>
          <tbody>{lista.map((s) => (
            <tr key={s.id} style={s.ativo ? undefined : { opacity: 0.55 }}>
              <td><strong>{s.nome}</strong></td>
              <td>{s.responsavel || '—'}</td>
              <td style={{ textAlign: 'right' }}>{s.limite_mensal === null ? 'sem limite' : brl(s.limite_mensal)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{gestao && <>
                <button className="btn-link" onClick={() => { setErro(''); setForm({ id: s.id, nome: s.nome, responsavel: s.responsavel || '', limiteMensal: s.limite_mensal ?? '' }); }}>Editar</button>
                <button className="btn-link" onClick={() => ativar(s)}>{s.ativo ? 'Desativar' : 'Reativar'}</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {form && (
        <div className="modal-overlay"><form className="modal-card" onSubmit={salvar}>
          <h2><Icon name="users" size={18} /> {form.id ? 'Editar setor' : 'Novo setor'}</h2>
          <div className="form-grid">
            <label>Nome<input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required maxLength={60} autoFocus /></label>
            <label>Responsável<input value={form.responsavel} onChange={(e) => setForm({ ...form, responsavel: e.target.value })} maxLength={80} /></label>
            <label>Limite mensal (R$, opcional)<input type="number" min="0" step="0.01" value={form.limiteMensal} onChange={(e) => setForm({ ...form, limiteMensal: e.target.value })} /></label>
          </div>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}><Icon name="close" size={15} /> Cancelar</button>
            <button type="submit" className="btn-primary"><Icon name="save" size={15} /> Salvar</button>
          </div>
        </form></div>
      )}
    </>
  );
}

function AbaKardex({ itemInicial }) {
  const [item, setItem] = useState(itemInicial || null);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState([]);
  const [inicio, setInicio] = useState(somarDias(hojeLocal(), -90));
  const [fim, setFim] = useState(hojeLocal());
  const [k, setK] = useState(null);
  useEffect(() => { if (itemInicial) setItem(itemInicial); }, [itemInicial]);
  useEffect(() => {
    if (busca.trim().length < 2) { setAchados([]); return undefined; }
    const t = setTimeout(() => window.pdv.almox.itens({ locationId: window.APP_LOCATION_ID, busca }).then((l) => setAchados(Array.isArray(l) ? l.slice(0, 12) : [])), 250);
    return () => clearTimeout(t);
  }, [busca]);
  useEffect(() => {
    if (!item) return;
    setK(null);
    window.pdv.almox.kardex({ productId: item.id, locationId: window.APP_LOCATION_ID, dataInicio: inicio, dataFim: fim }).then(setK);
  }, [item?.id, inicio, fim]);
  return (
    <>
      <div className="inline-form" style={{ marginBottom: 10, flexWrap: 'wrap', position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <input placeholder="Buscar item..." value={busca} onChange={(e) => setBusca(e.target.value)} style={{ minWidth: 260 }} />
          {achados.length > 0 && (
            <div className="modal-card" style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, padding: 6, width: 340 }}>
              {achados.map((a) => <button key={a.id} className="btn-link" style={{ display: 'block', textAlign: 'left', width: '100%' }} onClick={() => { setItem(a); setBusca(''); setAchados([]); }}>{a.nome}</button>)}
            </div>
          )}
        </div>
        <label>De<input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} /></label>
        <label>Até<input type="date" value={fim} onChange={(e) => setFim(e.target.value)} /></label>
      </div>
      {!item ? <VazioGuia icone="document" titulo="Escolha um item.">A ficha mostra cada entrada e saída, o saldo depois dela e o custo médio daquele momento.</VazioGuia>
        : k === null ? <p className="empty-state">Carregando...</p>
        : k.ok === false ? <p className="modal-error">{k.error}</p> : (
        <>
          <h3 style={{ margin: '4px 0 8px' }}>{k.produto.nome}</h3>
          <div className="dashboard-stats">
            <div className="stat-card"><span>Saldo anterior</span><strong>{qtd(k.saldoAnterior)}</strong></div>
            <div className="stat-card"><span>Entradas</span><strong>{qtd(k.entradas)} · {brl(k.valorEntradas)}</strong></div>
            <div className="stat-card"><span>Saídas</span><strong>{qtd(k.saidas)} · {brl(k.valorSaidas)}</strong></div>
            <div className="stat-card"><span>Saldo final</span><strong>{qtd(k.saldoFinal)} · {brl(k.saldoValor)}</strong></div>
            <div className="stat-card"><span>Custo médio atual</span><strong>{brlCusto(k.custoAtual)}</strong></div>
          </div>
          {k.movimentos.length === 0 ? <p className="empty-state">Nenhuma movimentação no período.</p> : (
            <table className="data-table">
              <thead><tr><th>Data</th><th>Tipo</th><th>Motivo</th><th style={{ textAlign: 'right' }}>Qtd.</th><th style={{ textAlign: 'right' }}>Custo médio</th><th style={{ textAlign: 'right' }}>Valor</th><th style={{ textAlign: 'right' }}>Saldo</th><th style={{ textAlign: 'right' }}>Saldo (R$)</th></tr></thead>
              <tbody>{k.movimentos.map((m) => (
                <tr key={m.id}>
                  <td>{dataBR(m.criado_em)}</td>
                  <td>{m.tipoRotulo}</td>
                  <td>{m.motivo || '—'}{m.operador_nome && <div className="nfe-item-codigos">{m.operador_nome}</div>}</td>
                  <td style={{ textAlign: 'right' }} className={m.quantidade < 0 ? 'text-danger' : ''}>{qtd(m.quantidade)}</td>
                  <td style={{ textAlign: 'right' }}>{brlCusto(m.custoMedio)}</td>
                  <td style={{ textAlign: 'right' }}>{brl(m.valor)}</td>
                  <td style={{ textAlign: 'right' }}>{qtd(m.saldo)}</td>
                  <td style={{ textAlign: 'right' }}>{brl(m.saldoValor)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {k.cortado && <p className="screen-hint">Mostrando os 500 movimentos mais recentes do período.</p>}
        </>
      )}
    </>
  );
}

export function AlmoxarifadoScreen() {
  const { currentUser } = useSession();
  const gestao = GESTAO.includes(currentUser?.role);
  const [aba, setAba] = useState('itens');
  const [painel, setPainel] = useState(null);
  const [kardexItem, setKardexItem] = useState(null);
  const [treinamento, setTreinamento] = useState(false);
  const carregarPainel = () => window.pdv.almox.painel({ locationId: window.APP_LOCATION_ID }).then(setPainel);
  useEffect(() => { carregarPainel(); }, []);
  const abas = [
    { id: 'itens', rotulo: 'Itens', icone: 'box' },
    { id: 'enderecos', rotulo: 'Endereços', icone: 'map' },
    { id: 'lotes', rotulo: 'Lotes e validade', icone: 'calendar' },
    { id: 'setores', rotulo: 'Setores', icone: 'users' },
    ...(gestao ? [{ id: 'kardex', rotulo: 'Kardex', icone: 'document' }] : []),
  ];
  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="archive" size={20} /> Almoxarifado</h1>
        <button className="btn-secondary" onClick={() => setTreinamento(true)}><Icon name="graduation" size={15} /> Treinamento</button>
      </div>
      {painel && painel.ok !== false && (
        <div className="dashboard-stats">
          <div className="stat-card"><span>Itens</span><strong>{painel.itens}</strong></div>
          <div className="stat-card"><span>Sem endereço</span><strong className={painel.semEndereco ? 'text-danger' : ''}>{painel.semEndereco}</strong></div>
          <div className="stat-card"><span>Abaixo do mínimo</span><strong className={painel.abaixoMinimo ? 'text-danger' : ''}>{painel.abaixoMinimo}</strong></div>
          <div className="stat-card"><span>Lotes vencidos · vencendo</span><strong className={painel.lotesVencidos ? 'text-danger' : ''}>{painel.lotesVencidos} · {painel.lotesVencendo}</strong></div>
          <div className="stat-card"><span>Endereços</span><strong>{painel.enderecos}</strong></div>
        </div>
      )}
      <Abas abas={abas} atual={aba} onChange={setAba} />
      {aba === 'itens' && <AbaItens gestao={gestao} onPainelMudou={carregarPainel} onKardex={(i) => { setKardexItem(i); setAba('kardex'); }} />}
      {aba === 'enderecos' && <AbaEnderecos gestao={gestao} onPainelMudou={carregarPainel} />}
      {aba === 'lotes' && <AbaLotes diasAlerta={painel?.diasAlerta || 30} />}
      {aba === 'setores' && <AbaSetores gestao={gestao} />}
      {aba === 'kardex' && gestao && <AbaKardex itemInicial={kardexItem} />}
      {treinamento && <Suspense fallback={null}><TrainingPresentationModal onClose={() => setTreinamento(false)} /></Suspense>}
    </div>
  );
}
