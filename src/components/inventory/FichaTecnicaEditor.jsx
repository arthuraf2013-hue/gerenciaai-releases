import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../common/Icon';
import {
  UNIDADES_INSUMO, unidadesCompativeis, quantidadePorPorcao, custoDaPorcao, custoPorUnidade,
  formatarReais, lerNumero,
} from '../../utils/cozinha';

let proximaChave = 1;
const novaChave = () => `l${proximaChave++}`;

/** Linha vazia da ficha (a pessoa ainda vai escolher o insumo). */
export function linhaFichaVazia() {
  return { chave: novaChave(), ingredientId: '', nome: '', unidadeBase: '', custoUnitario: 0, quantidade: '', unidade: '' };
}

/** Linha da ficha a partir de um insumo da lista (unidade de digitação = a mais natural). */
export function linhaFichaDoInsumo(insumo, extra = {}) {
  const base = insumo.unidade || 'un';
  const unidadeDigitada = base === 'kg' ? 'g' : base === 'l' ? 'ml' : base;
  return {
    chave: novaChave(), ingredientId: insumo.id, nome: insumo.nome, unidadeBase: base,
    custoUnitario: Number(insumo.custo_unitario) || 0, quantidade: '', unidade: unidadeDigitada, ...extra,
  };
}

/** Linhas prontas para salvar: quantidade POR PORÇÃO na unidade do insumo. */
export function linhasParaSalvar(linhas, rendimento) {
  return (linhas || [])
    .map((l) => ({
      ingredientId: l.ingredientId,
      quantidade: quantidadePorPorcao({ quantidade: lerNumero(l.quantidade), unidade: l.unidade, unidadeBase: l.unidadeBase, rendimento }),
    }))
    .filter((l) => l.ingredientId && l.quantidade > 0);
}

/** Custo de uma porção com as linhas como estão na tela. */
export function custoDasLinhas(linhas, rendimento) {
  return custoDaPorcao((linhas || []).map((l) => ({ ...l, quantidade: lerNumero(l.quantidade) })), rendimento);
}

/**
 * Busca de insumo com sugestões e "criar agora" -- teclado: setas escolhem,
 * Enter confirma (sem salvar o formulário do prato), Esc fecha a lista.
 */
function BuscaInsumo({ insumos, jaUsados, onEscolher, onCriar, autoFocus }) {
  const [texto, setTexto] = useState('');
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(0);
  const caixa = useRef(null);

  const termo = texto.trim().toLowerCase();
  const opcoes = useMemo(() => {
    const lista = insumos
      .filter((i) => !jaUsados.has(i.id))
      .filter((i) => !termo || i.nome.toLowerCase().includes(termo))
      .slice(0, 8)
      .map((i) => ({ tipo: 'insumo', insumo: i }));
    const exato = insumos.some((i) => i.nome.trim().toLowerCase() === termo);
    if (termo && !exato) lista.push({ tipo: 'criar', nome: texto.trim() });
    return lista;
  }, [insumos, jaUsados, termo, texto]);

  useEffect(() => { setDestaque(0); }, [termo]);
  useEffect(() => {
    function fora(e) { if (caixa.current && !caixa.current.contains(e.target)) setAberto(false); }
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, []);

  function escolher(op) {
    if (!op) return;
    if (op.tipo === 'insumo') onEscolher(op.insumo);
    else onCriar(op.nome);
    setTexto('');
    setAberto(false);
  }

  function teclado(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAberto(true); setDestaque((d) => Math.min(d + 1, opcoes.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setDestaque((d) => Math.max(d - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (aberto || termo) escolher(opcoes[destaque]); }
    else if (e.key === 'Escape' && aberto) { e.stopPropagation(); setAberto(false); }
  }

  return (
    <div className="ficha-busca" ref={caixa}>
      <Icon name="search" size={15} />
      <input
        value={texto} autoFocus={autoFocus}
        placeholder="Adicionar insumo: digite o nome (ex.: arroz, frango, óleo)…"
        onChange={(e) => { setTexto(e.target.value); setAberto(true); }}
        onFocus={() => setAberto(true)}
        onKeyDown={teclado}
        aria-label="Buscar insumo para a ficha técnica"
      />
      {aberto && opcoes.length > 0 && (
        <ul className="ficha-sugestoes" role="listbox">
          {opcoes.map((op, i) => (
            <li key={op.tipo === 'insumo' ? op.insumo.id : `criar-${op.nome}`}>
              <button
                type="button" role="option" aria-selected={i === destaque}
                className={i === destaque ? 'ativo' : ''}
                onMouseEnter={() => setDestaque(i)}
                onClick={() => escolher(op)}
              >
                {op.tipo === 'insumo' ? (
                  <>
                    <span>{op.insumo.nome}</span>
                    <span className="ficha-sugestao-info">{formatarReais(op.insumo.custo_unitario)} / {op.insumo.unidade}</span>
                  </>
                ) : (
                  <span className="ficha-sugestao-criar"><Icon name="add" size={14} /> Criar o insumo "{op.nome}"</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Mini cadastro de insumo dentro da ficha: nome, unidade e quanto pagou. */
function CriarInsumoRapido({ nomeInicial, onCriado, onCancelar }) {
  const [nome, setNome] = useState(nomeInicial);
  const [unidade, setUnidade] = useState('kg');
  const [modo, setModo] = useState('embalagem'); // 'embalagem' | 'direto'
  const [valorPago, setValorPago] = useState('');
  const [qtdComprada, setQtdComprada] = useState('1');
  const [custoDireto, setCustoDireto] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const custo = modo === 'embalagem'
    ? custoPorUnidade({ valorPago: lerNumero(valorPago), quantidade: lerNumero(qtdComprada), unidadeComprada: unidade, unidadeBase: unidade })
    : lerNumero(custoDireto);

  async function salvar() {
    setErro('');
    if (!nome.trim()) return setErro('Dê um nome ao insumo.');
    if (!(custo >= 0)) return setErro(modo === 'embalagem' ? 'Informe quanto pagou e por quanto.' : 'Informe o custo por unidade.');
    setSalvando(true);
    const r = await window.pdv.ingredient.upsert({ nome: nome.trim(), unidade, custoUnitario: custo, estoqueAtual: 0, estoqueMinimo: 0 });
    setSalvando(false);
    if (!r?.ok) return setErro(r?.error || 'Não consegui criar o insumo.');
    onCriado({ id: r.id, nome: nome.trim(), unidade, custo_unitario: custo, estoque_atual: 0, estoque_minimo: 0 });
  }

  function enterSalva(e) { if (e.key === 'Enter') { e.preventDefault(); salvar(); } }

  return (
    <div className="ficha-criar" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelar(); } }}>
      <strong><Icon name="ingredient" size={15} /> Novo insumo</strong>
      <div className="ficha-criar-linha">
        <label>Nome<input value={nome} onChange={(e) => setNome(e.target.value)} onKeyDown={enterSalva} autoFocus /></label>
        <label>Controlar em
          <select value={unidade} onChange={(e) => setUnidade(e.target.value)}>
            {UNIDADES_INSUMO.map((u) => <option key={u.valor} value={u.valor}>{u.rotulo}</option>)}
          </select>
        </label>
      </div>
      <div className="ficha-criar-modo">
        <button type="button" className={modo === 'embalagem' ? 'ativo' : ''} onClick={() => setModo('embalagem')}>Pelo preço que paguei</button>
        <button type="button" className={modo === 'direto' ? 'ativo' : ''} onClick={() => setModo('direto')}>Já sei o custo por {unidade}</button>
      </div>
      {modo === 'embalagem' ? (
        <div className="ficha-criar-linha">
          <label>Paguei (R$)<input inputMode="decimal" placeholder="25,90" value={valorPago} onChange={(e) => setValorPago(e.target.value)} onKeyDown={enterSalva} /></label>
          <label>por quantos {unidade}<input inputMode="decimal" value={qtdComprada} onChange={(e) => setQtdComprada(e.target.value)} onKeyDown={enterSalva} /></label>
          <div className="ficha-criar-resultado">{custo >= 0 && custo !== null ? <>= <strong>{formatarReais(custo)}</strong> / {unidade}</> : 'Informe o valor'}</div>
        </div>
      ) : (
        <div className="ficha-criar-linha">
          <label>Custo por {unidade} (R$)<input inputMode="decimal" placeholder="5,18" value={custoDireto} onChange={(e) => setCustoDireto(e.target.value)} onKeyDown={enterSalva} /></label>
        </div>
      )}
      {erro && <p className="modal-error">{erro}</p>}
      <div className="ficha-criar-acoes">
        <button type="button" className="btn-link" onClick={onCancelar}>Cancelar</button>
        <button type="button" className="btn-primary" onClick={salvar} disabled={salvando}>
          {salvando ? 'Criando…' : <><Icon name="check" size={15} /> Criar e usar na ficha</>}
        </button>
      </div>
    </div>
  );
}

/**
 * Ficha técnica do prato, editada junto com o cadastro (salva no mesmo
 * "Salvar" do ProductForm). Controlada: o pai guarda `linhas` e `rendimento`.
 */
export function FichaTecnicaEditor({ linhas, rendimento, insumos, onLinhas, onRendimento, onInsumoCriado }) {
  const [criando, setCriando] = useState(null); // nome sugerido do insumo novo, ou null
  const jaUsados = useMemo(() => new Set(linhas.map((l) => l.ingredientId).filter(Boolean)), [linhas]);
  const ultimaQtd = useRef(null);
  const [focarUltima, setFocarUltima] = useState(false);

  useEffect(() => {
    if (focarUltima && ultimaQtd.current) { ultimaQtd.current.focus(); setFocarUltima(false); }
  }, [focarUltima, linhas]);

  function adicionar(insumo) {
    onLinhas([...linhas, linhaFichaDoInsumo(insumo)]);
    setFocarUltima(true);
  }
  function mudar(chave, campo, valor) {
    onLinhas(linhas.map((l) => (l.chave === chave ? { ...l, [campo]: valor } : l)));
  }
  function remover(chave) { onLinhas(linhas.filter((l) => l.chave !== chave)); }

  const porcoes = Math.max(1, Number(lerNumero(rendimento)) || 1);

  return (
    <div className="ficha-editor">
      <div className="ficha-rendimento">
        <span>Esta receita rende</span>
        <input
          inputMode="numeric" value={rendimento} aria-label="Quantas porções a receita rende"
          onChange={(e) => onRendimento(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
        />
        <span>{porcoes === 1 ? 'porção' : 'porções'}</span>
        <span className="ficha-dica">
          {porcoes === 1 ? 'Digite o que vai em UM prato. Faz em panela? Digite a receita inteira e quantas porções ela rende.'
            : `Digite a receita inteira: o sistema divide por ${porcoes} na hora de baixar o estoque.`}
        </span>
      </div>

      {linhas.length > 0 && (
        <table className="ficha-tabela">
          <thead>
            <tr><th>Insumo</th><th>Quantidade {porcoes > 1 ? '(receita inteira)' : '(por porção)'}</th><th>Custo por porção</th><th></th></tr>
          </thead>
          <tbody>
            {linhas.map((l, i) => {
              const qtdPorcao = quantidadePorPorcao({ quantidade: lerNumero(l.quantidade), unidade: l.unidade, unidadeBase: l.unidadeBase, rendimento: porcoes });
              const custo = qtdPorcao ? qtdPorcao * l.custoUnitario : null;
              const unidades = unidadesCompativeis(l.unidadeBase);
              const vazia = !(qtdPorcao > 0);
              return (
                <tr key={l.chave}>
                  <td>
                    <strong>{l.nome}</strong>
                    <div className="ficha-sub">{formatarReais(l.custoUnitario)} / {l.unidadeBase}</div>
                  </td>
                  <td>
                    <div className="ficha-qtd">
                      <input
                        ref={i === linhas.length - 1 ? ultimaQtd : undefined}
                        inputMode="decimal" value={l.quantidade} placeholder="0"
                        className={vazia ? 'ficha-qtd-vazia' : ''}
                        aria-label={`Quantidade de ${l.nome}`}
                        onChange={(e) => mudar(l.chave, 'quantidade', e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                      />
                      {unidades.length > 1 ? (
                        <select value={l.unidade} onChange={(e) => mudar(l.chave, 'unidade', e.target.value)} aria-label="Unidade">
                          {unidades.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      ) : <span className="ficha-unidade">{l.unidade}</span>}
                    </div>
                  </td>
                  <td className="ficha-custo">{custo !== null ? formatarReais(custo) : <span className="ficha-sub">falta a quantidade</span>}</td>
                  <td>
                    <button type="button" className="btn-link-danger" onClick={() => remover(l.chave)} aria-label={`Tirar ${l.nome} da ficha`}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {criando !== null ? (
        <CriarInsumoRapido
          nomeInicial={criando}
          onCancelar={() => setCriando(null)}
          onCriado={(novo) => { setCriando(null); onInsumoCriado?.(novo); adicionar(novo); }}
        />
      ) : (
        <BuscaInsumo insumos={insumos} jaUsados={jaUsados} onEscolher={adicionar} onCriar={(nome) => setCriando(nome)} />
      )}

      {linhas.length === 0 && criando === null && (
        <p className="ficha-dica" style={{ margin: 0 }}>
          Sem ficha técnica o prato vende normalmente, mas o sistema não sabe o custo dele nem baixa os insumos.
        </p>
      )}
      <p className="ficha-dica" style={{ margin: 0 }}>Total desta ficha por porção: <strong>{formatarReais(custoDasLinhas(linhas, porcoes))}</strong></p>
    </div>
  );
}
