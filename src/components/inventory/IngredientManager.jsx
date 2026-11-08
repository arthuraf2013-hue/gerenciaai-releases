import { useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEscToClose } from '../../hooks/useEscToClose';
import { IngredientStockAdjustModal } from './IngredientStockAdjustModal';
import { ConsumoTeoricoVsReal } from './ConsumoTeoricoVsReal';
import Icon from '../common/Icon';
import {
  UNIDADES_INSUMO, unidadesCompativeis, converter, custoPorUnidade, situacaoEstoque,
  formatarQuantidade, formatarReais, lerNumero, arred,
} from '../../utils/cozinha';

const ROTULO_SITUACAO = { ok: 'ok', acabando: 'acabando', sem: 'sem estoque' };
const numeroParaCampo = (n) => (n === null || n === undefined || n === '' ? '' : String(n).replace('.', ','));

/** Cadastro/edição de insumo: o custo pode vir do preço da embalagem. */
function InsumoFormModal({ insumo, onClose, onSaved }) {
  useEscToClose(onClose);
  const editando = !!insumo?.id;
  const [nome, setNome] = useState(insumo?.nome || '');
  const [unidade, setUnidade] = useState(insumo?.unidade || 'kg');
  const [modoCusto, setModoCusto] = useState(editando ? 'direto' : 'embalagem');
  const [valorPago, setValorPago] = useState('');
  const [qtdComprada, setQtdComprada] = useState('1');
  const [unidadeComprada, setUnidadeComprada] = useState(insumo?.unidade || 'kg');
  const [custoDireto, setCustoDireto] = useState(numeroParaCampo(insumo?.custo_unitario));
  const [estoqueInicial, setEstoqueInicial] = useState('');
  const [minimo, setMinimo] = useState(numeroParaCampo(insumo?.estoque_minimo || ''));
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => { if (!unidadesCompativeis(unidade).includes(unidadeComprada)) setUnidadeComprada(unidade); }, [unidade]); // eslint-disable-line react-hooks/exhaustive-deps

  const custo = modoCusto === 'embalagem'
    ? custoPorUnidade({ valorPago: lerNumero(valorPago), quantidade: lerNumero(qtdComprada), unidadeComprada, unidadeBase: unidade })
    : lerNumero(custoDireto);

  async function salvar(e) {
    e.preventDefault();
    setErro('');
    if (!nome.trim()) return setErro('Informe o nome do insumo.');
    if (!(custo >= 0)) return setErro(modoCusto === 'embalagem' ? 'Informe quanto pagou e por quanto.' : 'Informe o custo por unidade.');
    const ini = estoqueInicial === '' ? 0 : lerNumero(estoqueInicial);
    const min = minimo === '' ? 0 : lerNumero(minimo);
    if (!(ini >= 0) || !(min >= 0)) return setErro('Estoque não pode ser negativo.');
    // Comprou já estocando: o estoque inicial pode vir na unidade da compra.
    setSalvando(true);
    const r = await window.pdv.ingredient.upsert({
      id: insumo?.id || null, nome: nome.trim(), unidade, custoUnitario: arred(custo, 4), estoqueAtual: ini, estoqueMinimo: min,
    });
    setSalvando(false);
    if (!r?.ok) return setErro(r?.error || 'Não consegui salvar.');
    onSaved();
  }

  return (
    <div className="modal-overlay">
      <form className="modal-card" style={{ width: 'min(520px, 100%)' }} onSubmit={salvar}>
        <h2>{editando ? 'Editar insumo' : 'Novo insumo'}</h2>
        <label>Nome<input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Arroz branco, Peito de frango" required autoFocus /></label>
        <label>Controlar em
          <select value={unidade} onChange={(e) => setUnidade(e.target.value)} disabled={editando && insumo.usado_em > 0}
            title={editando && insumo.usado_em > 0 ? 'Está em ficha técnica: trocar a unidade mudaria as quantidades das receitas.' : undefined}>
            {UNIDADES_INSUMO.map((u) => <option key={u.valor} value={u.valor}>{u.rotulo}</option>)}
          </select>
        </label>
        {editando && insumo.usado_em > 0 && (
          <p className="screen-hint" style={{ margin: '-6px 0 0' }}>A unidade fica travada porque o insumo está em {insumo.usado_em} ficha(s) técnica(s).</p>
        )}

        <div>
          <div className="ficha-criar-modo" style={{ marginBottom: 8 }}>
            <button type="button" className={modoCusto === 'embalagem' ? 'ativo' : ''} onClick={() => setModoCusto('embalagem')}>Pelo preço que paguei</button>
            <button type="button" className={modoCusto === 'direto' ? 'ativo' : ''} onClick={() => setModoCusto('direto')}>Custo por {unidade}</button>
          </div>
          {modoCusto === 'embalagem' ? (
            <div className="ficha-criar-linha">
              <label>Paguei (R$)<input inputMode="decimal" placeholder="25,90" value={valorPago} onChange={(e) => setValorPago(e.target.value)} /></label>
              <label>Por
                <span style={{ display: 'flex', gap: 6 }}>
                  <input inputMode="decimal" value={qtdComprada} onChange={(e) => setQtdComprada(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                  {unidadesCompativeis(unidade).length > 1 ? (
                    <select value={unidadeComprada} onChange={(e) => setUnidadeComprada(e.target.value)} style={{ width: 70 }}>
                      {unidadesCompativeis(unidade).map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  ) : <span className="ficha-unidade" style={{ alignSelf: 'center' }}>{unidade}</span>}
                </span>
              </label>
              <div className="ficha-criar-resultado">{custo !== null && custo >= 0 ? <>= <strong>{formatarReais(custo)}</strong> / {unidade}</> : <span className="ficha-sub">o sistema calcula</span>}</div>
            </div>
          ) : (
            <label>Custo por {unidade} (R$)<input inputMode="decimal" value={custoDireto} onChange={(e) => setCustoDireto(e.target.value)} /></label>
          )}
          {editando && Number(insumo.custo_unitario) > 0 && custo >= 0 && Math.abs(custo - insumo.custo_unitario) > 0.00005 && (
            <p className="screen-hint" style={{ margin: '6px 0 0' }}>
              Antes: {formatarReais(insumo.custo_unitario)} / {unidade}. O custo de todos os pratos com este insumo muda junto.
            </p>
          )}
        </div>

        <div className="ficha-criar-linha">
          {!editando && (
            <label>Tenho em estoque agora ({unidade})<input inputMode="decimal" placeholder="0" value={estoqueInicial} onChange={(e) => setEstoqueInicial(e.target.value)} /></label>
          )}
          <label>Avisar quando ficar abaixo de ({unidade})<input inputMode="decimal" placeholder="opcional" value={minimo} onChange={(e) => setMinimo(e.target.value)} /></label>
        </div>
        {editando && (
          <p className="screen-hint" style={{ margin: 0 }}>
            Estoque atual: {formatarQuantidade(insumo.estoque_atual, unidade)}. Para mudar, use "Registrar compra", "Conferir estoque" ou "Movimentar".
          </p>
        )}
        {erro && <p className="modal-error">{erro}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={16} /> Cancelar</button>
          <button type="submit" className="btn-primary" disabled={salvando}>{salvando ? 'Salvando…' : <><Icon name="save" size={16} /> Salvar</>}</button>
        </div>
      </form>
    </div>
  );
}

let chaveCompra = 1;
const linhaCompraVazia = () => ({ chave: chaveCompra++, ingredientId: '', quantidade: '', unidade: '', valor: '' });

/** Compra em lote: a nota do hortifruti inteira de uma vez. */
function RegistrarCompraModal({ insumos, sugeridos, onClose, onSaved }) {
  useEscToClose(onClose);
  const porId = useMemo(() => Object.fromEntries(insumos.map((i) => [i.id, i])), [insumos]);
  const [fornecedor, setFornecedor] = useState('');
  const [atualizarCusto, setAtualizarCusto] = useState(true);
  const [linhas, setLinhas] = useState(() => [linhaCompraVazia()]);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function mudar(chave, campo, valor) {
    setLinhas((prev) => {
      const novas = prev.map((l) => {
        if (l.chave !== chave) return l;
        const nova = { ...l, [campo]: valor };
        if (campo === 'ingredientId') nova.unidade = porId[valor]?.unidade || '';
        return nova;
      });
      // Sempre sobra uma linha vazia no fim para o próximo item da nota.
      if (novas[novas.length - 1].ingredientId) novas.push(linhaCompraVazia());
      return novas;
    });
  }
  function remover(chave) {
    setLinhas((prev) => {
      const novas = prev.filter((l) => l.chave !== chave);
      return novas.length && !novas[novas.length - 1].ingredientId ? novas : [...novas, linhaCompraVazia()];
    });
  }
  function trazerAcabando() {
    const usados = new Set(linhas.map((l) => l.ingredientId));
    const novas = sugeridos.filter((i) => !usados.has(i.id)).map((i) => ({ ...linhaCompraVazia(), ingredientId: i.id, unidade: i.unidade }));
    setLinhas((prev) => [...prev.filter((l) => l.ingredientId), ...novas, linhaCompraVazia()]);
  }

  const preenchidas = linhas.filter((l) => l.ingredientId);
  const total = preenchidas.reduce((s, l) => s + (lerNumero(l.valor) > 0 ? lerNumero(l.valor) : 0), 0);

  async function salvar() {
    setErro('');
    if (preenchidas.length === 0) return setErro('Escolha pelo menos um insumo.');
    const itens = [];
    for (const l of preenchidas) {
      const ins = porId[l.ingredientId];
      const qtdBase = converter(lerNumero(l.quantidade), l.unidade || ins.unidade, ins.unidade);
      if (!(qtdBase > 0)) return setErro(`Falta a quantidade de "${ins.nome}".`);
      const valor = l.valor === '' ? undefined : lerNumero(l.valor);
      if (valor !== undefined && !(valor >= 0)) return setErro(`Valor pago inválido em "${ins.nome}".`);
      itens.push({ ingredientId: l.ingredientId, quantidade: arred(qtdBase, 4), valorTotal: valor });
    }
    setSalvando(true);
    const r = await window.pdv.ingredient.registrarCompra({ itens, atualizarCusto, fornecedor });
    setSalvando(false);
    if (!r?.ok) return setErro(r?.error || 'Não consegui registrar a compra.');
    onSaved(`Compra registrada: ${itens.length} insumo(s) entraram no estoque${atualizarCusto && itens.some((i) => i.valorTotal > 0) ? ' e o custo foi atualizado' : ''}.`);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-wide" style={{ width: 'min(860px, 100%)' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="cart" size={20} /> Registrar compra de insumos</h2>
        <p className="modal-subtitle">Lance a nota ou a sacola inteira de uma vez. Tudo entra no estoque com o seu nome no histórico.</p>
        <div className="ficha-criar-linha">
          <label>De quem comprou (opcional)<input value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} placeholder="Ex.: Hortifruti do Zé, Atacadão" /></label>
          {sugeridos.length > 0 && (
            <button type="button" className="btn-secondary" onClick={trazerAcabando} style={{ flex: '0 0 auto' }}>
              <Icon name="warning" size={15} /> Trazer os que estão acabando ({sugeridos.length})
            </button>
          )}
        </div>
        <table className="tabela-lancamento">
          <thead><tr><th style={{ width: '38%' }}>Insumo</th><th>Quantidade</th><th>Valor pago (R$)</th><th className="num">Custo novo</th><th></th></tr></thead>
          <tbody>
            {linhas.map((l) => {
              const ins = porId[l.ingredientId];
              const usados = new Set(linhas.filter((x) => x.chave !== l.chave).map((x) => x.ingredientId));
              const qtdBase = ins ? converter(lerNumero(l.quantidade), l.unidade || ins.unidade, ins.unidade) : NaN;
              const valor = lerNumero(l.valor);
              const custoNovo = ins && qtdBase > 0 && valor > 0 ? valor / qtdBase : null;
              const variacao = custoNovo && ins.custo_unitario > 0 ? ((custoNovo - ins.custo_unitario) / ins.custo_unitario) * 100 : null;
              return (
                <tr key={l.chave}>
                  <td>
                    <select value={l.ingredientId} onChange={(e) => mudar(l.chave, 'ingredientId', e.target.value)} aria-label="Insumo">
                      <option value="">{l.ingredientId ? '' : 'Escolha o insumo…'}</option>
                      {insumos.filter((i) => i.id === l.ingredientId || !usados.has(i.id)).map((i) => (
                        <option key={i.id} value={i.id}>{i.nome} ({i.unidade})</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {ins && (
                      <span style={{ display: 'flex', gap: 6 }}>
                        <input inputMode="decimal" value={l.quantidade} placeholder="0" onChange={(e) => mudar(l.chave, 'quantidade', e.target.value)} aria-label={`Quantidade de ${ins.nome}`} />
                        {unidadesCompativeis(ins.unidade).length > 1 ? (
                          <select value={l.unidade} onChange={(e) => mudar(l.chave, 'unidade', e.target.value)} style={{ width: 64 }} aria-label="Unidade">
                            {unidadesCompativeis(ins.unidade).map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        ) : <span className="ficha-unidade" style={{ alignSelf: 'center' }}>{ins.unidade}</span>}
                      </span>
                    )}
                  </td>
                  <td>{ins && <input inputMode="decimal" value={l.valor} placeholder="opcional" onChange={(e) => mudar(l.chave, 'valor', e.target.value)} aria-label={`Valor pago em ${ins.nome}`} />}</td>
                  <td className="num">
                    {custoNovo ? (
                      <>
                        {formatarReais(custoNovo)}/{ins.unidade}
                        {variacao !== null && Math.abs(variacao) >= 0.5 && (
                          <div className={variacao > 0 ? 'texto-alta' : 'texto-baixa'} style={{ fontSize: 12 }}>
                            {variacao > 0 ? '▲' : '▼'} {Math.abs(variacao).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%
                          </div>
                        )}
                      </>
                    ) : ins ? <span className="ficha-sub">{formatarReais(ins.custo_unitario)}/{ins.unidade}</span> : ''}
                  </td>
                  <td>{ins && <button type="button" className="btn-link-danger" onClick={() => remover(l.chave)} aria-label="Tirar linha"><Icon name="trash" size={14} /></button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <label className="check-linha" style={{ alignSelf: 'flex-start', padding: 0 }}>
          <input type="checkbox" checked={atualizarCusto} onChange={(e) => setAtualizarCusto(e.target.checked)} />
          Atualizar o custo dos insumos com o preço desta compra (o custo dos pratos acompanha)
        </label>
        {erro && <p className="modal-error">{erro}</p>}
        <div className="modal-actions" style={{ alignItems: 'center' }}>
          {total > 0 && <span style={{ marginRight: 'auto', fontWeight: 600 }}>Total da compra: {formatarReais(total)}</span>}
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={16} /> Cancelar</button>
          <button type="button" className="btn-primary" onClick={salvar} disabled={salvando || preenchidas.length === 0}>
            {salvando ? 'Registrando…' : <><Icon name="check" size={16} /> Registrar compra</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Conferência: conta a despensa e o sistema corrige só a diferença. */
function ConferirEstoqueModal({ insumos, onClose, onSaved }) {
  useEscToClose(onClose);
  const [contados, setContados] = useState({});
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const visiveis = insumos.filter((i) => !busca.trim() || i.nome.toLowerCase().includes(busca.trim().toLowerCase()));
  const informados = insumos.filter((i) => contados[i.id] !== undefined && contados[i.id] !== '');
  const valorDiferenca = informados.reduce((s, i) => {
    const c = lerNumero(contados[i.id]);
    return c >= 0 ? s + (c - i.estoque_atual) * i.custo_unitario : s;
  }, 0);

  async function salvar() {
    setErro('');
    if (informados.length === 0) return setErro('Informe o que contou em pelo menos um insumo.');
    const itens = [];
    for (const i of informados) {
      const c = lerNumero(contados[i.id]);
      if (!(c >= 0)) return setErro(`Quantidade contada inválida em "${i.nome}".`);
      itens.push({ ingredientId: i.id, contado: c });
    }
    setSalvando(true);
    const r = await window.pdv.ingredient.registrarContagem({ itens });
    setSalvando(false);
    if (!r?.ok) return setErro(r?.error || 'Não consegui registrar a conferência.');
    const partes = [`${r.ajustados} insumo(s) corrigido(s)`];
    if (r.semDiferenca) partes.push(`${r.semDiferenca} batendo certinho`);
    if (r.valorDiferenca) partes.push(`diferença de ${formatarReais(r.valorDiferenca)}`);
    onSaved(`Conferência registrada: ${partes.join(', ')}.`);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-wide" style={{ width: 'min(760px, 100%)' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="clipboard" size={20} /> Conferir estoque</h2>
        <p className="modal-subtitle">
          Conte o que tem na despensa e digite. Só os insumos que você preencher são corrigidos; a diferença fica registrada
          e aparece no relatório "consumo pela ficha × estoque real".
        </p>
        <input className="search-input" placeholder="Filtrar insumo…" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ marginBottom: 0 }} />
        <table className="tabela-lancamento">
          <thead><tr><th>Insumo</th><th className="num">No sistema</th><th style={{ width: 150 }}>Contei</th><th className="num">Diferença</th></tr></thead>
          <tbody>
            {visiveis.map((i) => {
              const c = lerNumero(contados[i.id]);
              const dif = contados[i.id] !== undefined && contados[i.id] !== '' && c >= 0 ? arred(c - i.estoque_atual, 3) : null;
              return (
                <tr key={i.id}>
                  <td>{i.nome}</td>
                  <td className="num">{formatarQuantidade(i.estoque_atual, i.unidade)}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input inputMode="decimal" value={contados[i.id] ?? ''} placeholder="—"
                        onChange={(e) => setContados((prev) => ({ ...prev, [i.id]: e.target.value }))} aria-label={`Contado de ${i.nome}`} />
                      <span className="ficha-unidade">{i.unidade}</span>
                    </span>
                  </td>
                  <td className="num">
                    {dif === null ? '' : dif === 0 ? <span className="pilula pilula-ok">bateu</span> : (
                      <span className={dif < 0 ? 'texto-alta' : 'texto-baixa'}>
                        {dif > 0 ? '+' : ''}{formatarQuantidade(dif, i.unidade)}
                        <div style={{ fontSize: 12, fontWeight: 400 }}>{formatarReais(dif * i.custo_unitario)}</div>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visiveis.length === 0 && <p className="empty-state">Nenhum insumo com esse nome.</p>}
        {erro && <p className="modal-error">{erro}</p>}
        <div className="modal-actions" style={{ alignItems: 'center' }}>
          {informados.length > 0 && (
            <span style={{ marginRight: 'auto', fontWeight: 600 }}>
              {informados.length} conferido(s){valorDiferenca ? ` · diferença ${formatarReais(valorDiferenca)}` : ''}
            </span>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={16} /> Cancelar</button>
          <button type="button" className="btn-primary" onClick={salvar} disabled={salvando || informados.length === 0}>
            {salvando ? 'Registrando…' : <><Icon name="check" size={16} /> Registrar conferência</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function IngredientManager() {
  const [ingredients, setIngredients] = useState([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [filtro, setFiltro] = useState('todos'); // 'todos' | 'acabando' | 'semUso'
  const [editando, setEditando] = useState(null); // null = fechado, {} = novo, {...} = editar
  const [ajustando, setAjustando] = useState(null);
  const [comprando, setComprando] = useState(false);
  const [conferindo, setConferindo] = useState(false);
  const [mensagem, setMensagem] = useState('');
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    let ignore = false;
    window.pdv.ingredient.list({ query: debouncedQuery || undefined }).then((list) => {
      if (!ignore) setIngredients(Array.isArray(list) ? list : []);
    });
    return () => { ignore = true; };
  }, [debouncedQuery, versao]);

  // Compra e conferência trabalham com TODOS os insumos, não só os da busca.
  const [todos, setTodos] = useState([]);
  useEffect(() => {
    window.pdv.ingredient.list({}).then((list) => setTodos(Array.isArray(list) ? list : []));
  }, [versao]);

  const recarregar = (msg) => { setMensagem(msg || ''); setVersao((v) => v + 1); };
  const acabando = todos.filter((i) => situacaoEstoque(i) !== 'ok');
  const semUso = todos.filter((i) => !i.usado_em);
  const lista = ingredients.filter((i) => (filtro === 'acabando' ? situacaoEstoque(i) !== 'ok' : filtro === 'semUso' ? !i.usado_em : true));

  async function remover(ing) {
    const aviso = ing.usado_em > 0
      ? `"${ing.nome}" está em ${ing.usado_em} ficha(s) técnica(s). Removido, ele some da lista para fichas novas, mas as fichas atuais continuam usando o custo dele. Remover mesmo assim?`
      : `Remover o insumo "${ing.nome}"?`;
    if (!confirm(aviso)) return;
    await window.pdv.ingredient.deactivate({ id: ing.id });
    recarregar(`"${ing.nome}" removido.`);
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1><Icon name="ingredient" size={18} /> Insumos</h1>
        <div className="screen-actions">
          <button className="btn-secondary" onClick={() => setConferindo(true)} disabled={todos.length === 0}><Icon name="clipboard" size={16} /> Conferir estoque</button>
          <button className="btn-secondary" onClick={() => setComprando(true)} disabled={todos.length === 0}><Icon name="cart" size={16} /> Registrar compra</button>
          <button className="btn-primary" onClick={() => setEditando({})}><Icon name="add" size={16} /> Novo insumo</button>
        </div>
      </div>
      <p className="screen-hint">
        A matéria-prima dos pratos (arroz, frango, óleo…). O custo de cada prato sai da ficha técnica, montada no
        cadastro do prato. Chegou mercadoria? <strong>Registrar compra</strong>. Fim do dia ou da semana?
        <strong> Conferir estoque</strong>.
      </p>
      {mensagem && <p className="io-message">{mensagem}</p>}

      <div className="insumos-filtros">
        <input className="search-input" placeholder="Buscar insumo..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chips-categorias" style={{ marginTop: 0 }}>
          <button className={filtro === 'todos' ? 'ativo' : ''} onClick={() => setFiltro('todos')}>Todos ({todos.length})</button>
          <button className={filtro === 'acabando' ? 'ativo' : ''} onClick={() => setFiltro('acabando')}>Acabando ({acabando.length})</button>
          <button className={filtro === 'semUso' ? 'ativo' : ''} onClick={() => setFiltro('semUso')}>Fora das fichas ({semUso.length})</button>
        </div>
      </div>

      {lista.length === 0 ? (
        <p className="empty-state">
          {todos.length === 0 ? 'Nenhum insumo cadastrado ainda. Dá para criar aqui ou direto na ficha técnica de um prato.'
            : filtro === 'acabando' ? 'Nada acabando. Tudo acima do mínimo.'
            : filtro === 'semUso' ? 'Todos os insumos estão em alguma ficha técnica.' : 'Nenhum insumo com esse nome.'}
        </p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Insumo</th><th>Custo</th><th>Estoque</th><th>Usado em</th><th></th></tr></thead>
          <tbody>
            {lista.map((ing) => {
              const sit = situacaoEstoque(ing);
              return (
                <tr key={ing.id}>
                  <td><strong>{ing.nome}</strong></td>
                  <td>{formatarReais(ing.custo_unitario)} / {ing.unidade}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {formatarQuantidade(ing.estoque_atual, ing.unidade)}
                      {sit !== 'ok' && <span className={`pilula pilula-${sit}`}>{ROTULO_SITUACAO[sit]}</span>}
                    </span>
                    {ing.estoque_minimo > 0 && <div className="ficha-sub">mínimo {formatarQuantidade(ing.estoque_minimo, ing.unidade)}</div>}
                  </td>
                  <td>{ing.usado_em ? `${ing.usado_em} prato${ing.usado_em > 1 ? 's' : ''}` : <span className="pilula pilula-neutra">nenhum</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                      <button className="btn-link" onClick={() => setEditando(ing)}><Icon name="edit" size={14} /> Editar</button>
                      <button className="btn-link" onClick={() => setAjustando(ing)} title="Entrada avulsa, perda ou correção"><Icon name="box" size={14} /> Movimentar</button>
                      <button className="btn-link-danger" onClick={() => remover(ing)} aria-label={`Remover ${ing.nome}`}><Icon name="trash" size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {todos.length > 0 && <ConsumoTeoricoVsReal />}

      {editando && (
        <InsumoFormModal
          insumo={editando.id ? editando : null}
          onClose={() => setEditando(null)}
          onSaved={() => { const novo = !editando.id; setEditando(null); recarregar(novo ? 'Insumo cadastrado.' : 'Insumo atualizado.'); }}
        />
      )}
      {comprando && (
        <RegistrarCompraModal insumos={todos} sugeridos={acabando} onClose={() => setComprando(false)}
          onSaved={(msg) => { setComprando(false); recarregar(msg); }} />
      )}
      {conferindo && (
        <ConferirEstoqueModal insumos={todos} onClose={() => setConferindo(false)}
          onSaved={(msg) => { setConferindo(false); recarregar(msg); }} />
      )}
      {ajustando && (
        <IngredientStockAdjustModal
          ingredient={ajustando}
          onClose={() => setAjustando(null)}
          onAdjusted={() => { setAjustando(null); recarregar(); }}
        />
      )}
    </div>
  );
}
