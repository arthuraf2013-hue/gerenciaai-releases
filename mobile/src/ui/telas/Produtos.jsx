import { useEffect, useState } from 'react';
import { useApp, useTentar, useCarregar, useDebounce, podeGerenciar } from '../contexto.jsx';
import { modoTerminal } from '../../services/terminal.js';
import { buscarProdutos, salvarProduto, obterProduto, movimentarEstoque, estoqueBaixo, definirProdutoAtivo, historicoDoProduto } from '../../services/produtos.js';
import { formatarCentavos, formatarQuantidade, lerCentavos, lerQuantidadeMil, ErroDeNegocio } from '../../services/base.js';
import { lerCodigoDeBarras } from '../../app/plataforma.js';
import Modal from '../comp/Modal.jsx';
import Icone from '../comp/Icone.jsx';

const fmt = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
const fmtQ = (q, u) => (q == null ? '' : u === 'kg' ? (q / 1000).toFixed(3).replace('.', ',') : String(q / 1000).replace('.', ','));
const TIPO_MOV = { inicial: 'Estoque inicial', entrada: 'Entrada', ajuste: 'Contagem', venda: 'Venda', cancelamento_venda: 'Venda cancelada' };

function lerQtdOuZero(texto) {
  if (String(texto || '').trim() === '') return 0;
  const q = lerQuantidadeMil(texto);
  if (q === null) throw new ErroDeNegocio('Quantidade inválida.');
  return q;
}

function FormProduto({ produto, codigoInicial, aoFechar, aoSalvar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const novo = !produto;
  const [f, setF] = useState(() => ({
    nome: produto?.nome || '',
    preco: fmt(produto?.preco_centavos),
    custo: fmt(produto?.custo_centavos || null),
    codigo: produto?.codigo_barras || codigoInicial || '',
    unidade: produto?.unidade || 'un',
    categoria: produto?.categoria || '',
    estoqueInicial: '',
    minimo: produto ? fmtQ(produto.estoque_minimo_mil, produto.unidade) : '',
    controla: produto ? !!produto.controla_estoque : true,
  }));
  const m = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const salvar = () => tentar(async () => {
    const preco = lerCentavos(f.preco);
    if (preco == null || preco < 0) throw new ErroDeNegocio('Preço inválido.');
    const custo = f.custo.trim() ? lerCentavos(f.custo) : 0;
    if (custo == null || custo < 0) throw new ErroDeNegocio('Custo inválido.');
    await salvarProduto(servicos.db, {
      id: produto?.id, nome: f.nome, precoCentavos: preco, custoCentavos: custo, codigoBarras: f.codigo, unidade: f.unidade,
      categoria: f.categoria, estoqueMinimoMil: lerQtdOuZero(f.minimo), controlaEstoque: f.controla,
      estoqueInicialMil: novo && f.controla ? lerQtdOuZero(f.estoqueInicial) : 0,
    }, usuario.id);
    aoSalvar();
  }, { sucesso: novo ? 'Produto cadastrado.' : 'Produto atualizado.' });

  return (
    <Modal titulo={novo ? 'Novo produto' : 'Editar produto'} aoFechar={aoFechar} rodape={<button type="button" className="btn primario grande" onClick={salvar}>Salvar</button>}>
      <label className="campo">Nome<input autoFocus={novo} value={f.nome} onChange={m('nome')} /></label>
      <div className="segmentado">
        <button type="button" className={f.unidade === 'un' ? 'ativo' : ''} onClick={() => setF({ ...f, unidade: 'un' })}>Por unidade</button>
        <button type="button" className={f.unidade === 'kg' ? 'ativo' : ''} onClick={() => setF({ ...f, unidade: 'kg' })}>Por kg</button>
      </div>
      <div className="grade-2">
        <label className="campo">Preço {f.unidade === 'kg' ? 'do kg' : ''} (R$)<input value={f.preco} onChange={m('preco')} inputMode="decimal" placeholder="0,00" /></label>
        <label className="campo">Custo (R$)<input value={f.custo} onChange={m('custo')} inputMode="decimal" placeholder="opcional" /></label>
      </div>
      <label className="campo">Código de barras
        <div className="busca">
          <input value={f.codigo} onChange={m('codigo')} inputMode="numeric" placeholder="opcional" />
          <button type="button" className="btn" aria-label="Ler código" onClick={() => tentar(async () => { const c = await lerCodigoDeBarras(); if (c) setF((x) => ({ ...x, codigo: c })); })}><Icone nome="scan" /></button>
        </div>
      </label>
      <label className="campo">Categoria<input value={f.categoria} onChange={m('categoria')} placeholder="opcional" /></label>
      <label className="check"><input type="checkbox" checked={f.controla} onChange={m('controla')} />Controlar estoque deste produto</label>
      {f.controla && (
        <div className="grade-2">
          {novo && <label className="campo">Estoque inicial<input value={f.estoqueInicial} onChange={m('estoqueInicial')} inputMode="decimal" placeholder={f.unidade === 'kg' ? '0,000 kg' : '0'} /></label>}
          <label className="campo">Avisar abaixo de<input value={f.minimo} onChange={m('minimo')} inputMode="decimal" placeholder="0" /></label>
        </div>
      )}
      {!novo && (
        <button type="button" className="btn contorno-perigo" onClick={() => tentar(async () => {
          if (!confirm(`Desativar "${produto.nome}"? Ele some da busca do PDV, mas o histórico de vendas fica.`)) return;
          await definirProdutoAtivo(servicos.db, produto.id, false, usuario.id);
          aoSalvar();
        }, { sucesso: 'Produto desativado.' })}>Desativar produto</button>
      )}
    </Modal>
  );
}

function Estoque({ produto, aoFechar, aoSalvar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const [modo, setModo] = useState('entrada');
  const [q, setQ] = useState('');
  const [motivo, setMotivo] = useState('');
  const hist = useCarregar(() => historicoDoProduto(servicos.db, produto.id, 20), [produto.id]);
  return (
    <Modal titulo={produto.nome} aoFechar={aoFechar}>
      <div className="entre"><span className="muted">Estoque atual</span><span className="forte num">{formatarQuantidade(produto.estoque_mil, produto.unidade)}</span></div>
      <div className="segmentado">
        <button type="button" className={modo === 'entrada' ? 'ativo' : ''} onClick={() => setModo('entrada')}>Entrada</button>
        <button type="button" className={modo === 'contagem' ? 'ativo' : ''} onClick={() => setModo('contagem')}>Contagem</button>
      </div>
      <label className="campo">{modo === 'entrada' ? 'Quantidade que chegou' : 'Quantidade contada na prateleira'}
        <input value={q} onChange={(e) => setQ(e.target.value)} inputMode="decimal" placeholder={produto.unidade === 'kg' ? '0,000' : '0'} />
        <span className="dica muted">{modo === 'entrada' ? 'Soma ao estoque.' : 'Substitui o estoque pelo número contado (a diferença fica registrada).'}</span>
      </label>
      <label className="campo">Observação<input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="opcional (ex.: nota 1234)" /></label>
      <button type="button" className="btn primario grande" onClick={() => tentar(async () => {
        const qtd = modo === 'contagem' && q.trim() === '0' ? 0 : lerQuantidadeMil(q);
        if (qtd == null) throw new ErroDeNegocio('Quantidade inválida.');
        await movimentarEstoque(servicos.db, { produtoId: produto.id, modo, qtdMil: qtd, motivo }, usuario.id);
        aoSalvar();
      }, { sucesso: 'Estoque atualizado.' })}>Salvar</button>
      <div className="secao-titulo">Últimas movimentações</div>
      <div className="cartao plano">
        {(hist.dados || []).map((h) => (
          <div className="item" key={h.id}>
            <div className="cresce"><div>{TIPO_MOV[h.tipo] || h.tipo}</div><div className="muted peq">{new Date(h.criado_em).toLocaleString('pt-BR')}{h.motivo ? ` · ${h.motivo}` : ''}</div></div>
            <span className={`num forte ${h.qtd_mil < 0 ? 'estoque-baixo' : ''}`}>{h.qtd_mil > 0 ? '+' : ''}{formatarQuantidade(h.qtd_mil, produto.unidade)}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function Produtos({ parametros }) {
  const { servicos, usuario, terminal } = useApp();
  // Terminal: produtos, preços e estoque são do computador -- aqui só consulta.
  const emTerminal = modoTerminal();
  const gerencia = podeGerenciar(usuario) && !emTerminal;
  const [termo, setTermo] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const t = useDebounce(termo, 150);
  const versaoCatalogo = terminal?.catalogo?.versao || null;
  const lista = useCarregar(() => (filtro === 'baixo' ? estoqueBaixo(servicos.db) : buscarProdutos(servicos.db, t, { limite: 200 })), [t, filtro, versaoCatalogo]);
  const [form, setForm] = useState(null);
  const [estoque, setEstoque] = useState(null);

  useEffect(() => {
    if (!gerencia) return;
    if (parametros?.novoComCodigo) setForm({ codigoInicial: parametros.novoComCodigo });
    else if (parametros?.novo) setForm({});
  }, [parametros, gerencia]);

  const recarregar = async (fechar = true) => { if (fechar) { setForm(null); setEstoque(null); } lista.recarregar(); };

  return (
    <>
      <header className="topo">
        <h1>Produtos</h1>
        {gerencia && <button type="button" className="btn primario peq" onClick={() => setForm({})}><Icone nome="mais1" />Novo</button>}
      </header>
      <main className="conteudo">
        {emTerminal && (
          <div className="aviso info">
            <Icone nome="computador" />
            <span>
              Produtos, preços e estoque vêm do <strong>{terminal?.servidorNome || 'computador'}</strong> — cadastre e ajuste por lá.
              {terminal?.catalogo?.aplicadoEmMs ? ` Atualizado em ${new Date(terminal.catalogo.aplicadoEmMs).toLocaleString('pt-BR')}.` : ' Esperando a primeira lista do computador (precisa de internet).'}
              {' '}O estoque mostrado já desconta o que este celular vendeu e ainda não chegou lá.
            </span>
          </div>
        )}
        <div className="busca"><input value={termo} onChange={(e) => setTermo(e.target.value)} placeholder="Buscar produto ou código" /></div>
        <div className="segmentado">
          <button type="button" className={filtro === 'todos' ? 'ativo' : ''} onClick={() => setFiltro('todos')}>Todos</button>
          <button type="button" className={filtro === 'baixo' ? 'ativo' : ''} onClick={() => setFiltro('baixo')}>Estoque baixo</button>
        </div>
        <div className="cartao plano">
          {(lista.dados || []).map((p) => {
            const baixo = p.controla_estoque && p.estoque_mil <= p.estoque_minimo_mil;
            return (
              <div className="item" key={p.id}>
                <button type="button" className="cresce" style={{ textAlign: 'left' }} onClick={() => gerencia && obterProduto(servicos.db, p.id).then((x) => setForm({ produto: x }))}>
                  <div className="forte corta">{p.nome}</div>
                  <div className={`peq ${baixo ? 'estoque-baixo' : 'muted'}`}>
                    {formatarCentavos(p.preco_centavos)}{p.unidade === 'kg' ? '/kg' : ''} · {p.controla_estoque ? `estoque ${formatarQuantidade(p.estoque_mil, p.unidade)}` : 'sem controle'}
                  </div>
                </button>
                {gerencia && p.controla_estoque ? <button type="button" className="btn peq" onClick={() => setEstoque(p)}>Estoque</button> : null}
              </div>
            );
          })}
          {lista.dados?.length === 0 && <div className="vazio">{filtro === 'baixo' ? 'Nenhum produto com estoque baixo.' : 'Nenhum produto.'}</div>}
        </div>
        {!gerencia && !emTerminal && <p className="muted peq centro">Só gerente ou administrador cadastra e edita produtos.</p>}
      </main>
      {form && <FormProduto produto={form.produto} codigoInicial={form.codigoInicial} aoFechar={() => setForm(null)} aoSalvar={() => recarregar()} />}
      {estoque && <Estoque produto={estoque} aoFechar={() => setEstoque(null)} aoSalvar={() => recarregar()} />}
    </>
  );
}
