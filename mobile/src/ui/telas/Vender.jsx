import { useEffect, useRef, useState } from 'react';
import { useApp, useTentar, useCarregar, useDebounce, podeGerenciar } from '../contexto.jsx';
import { buscarProdutos, produtoPorCodigo } from '../../services/produtos.js';
import { caixaAberto, abrirCaixa } from '../../services/caixa.js';
import { formatarCentavos, formatarQuantidade, lerCentavos, lerQuantidadeMil, totalItemCentavos, ErroDeNegocio, ctx as ctxServicos } from '../../services/base.js';
import { textoDoBloqueio } from '../../services/licenca.js';
import { modoTerminal } from '../../services/terminal.js';
import { lerCodigoDeBarras } from '../../app/plataforma.js';
import Icone from '../comp/Icone.jsx';
import Modal from '../comp/Modal.jsx';
import Carrinho from './Carrinho.jsx';
import Pagamento from './Pagamento.jsx';
import VendaConcluida from './VendaConcluida.jsx';
import { totalDoCarrinho, CARRINHO_VAZIO } from '../carrinhoUtil.js';

const ctxTerminalNome = () => ctxServicos().servidorNome || 'computador';

function AbrirCaixa({ aoAbrir }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const [valor, setValor] = useState('');
  return (
    <div className="cartao pilha">
      <div className="linha"><Icone nome="caixa" width="26" height="26" /><h2>Abrir o caixa</h2></div>
      <p className="muted">Informe quanto tem de dinheiro na gaveta agora (troco inicial). Pode ser zero.</p>
      <label className="campo">Dinheiro na abertura (R$)
        <input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" placeholder="0,00" />
      </label>
      <button
        type="button"
        className="btn primario grande"
        onClick={() => tentar(async () => {
          const c = valor.trim() === '' ? 0 : lerCentavos(valor);
          if (c === null || c < 0) throw new ErroDeNegocio('Valor inválido.');
          await abrirCaixa(servicos.db, { valorAberturaCentavos: c }, usuario.id);
          aoAbrir();
        }, { sucesso: 'Caixa aberto. Boas vendas!' })}
      >Abrir caixa e vender</button>
    </div>
  );
}

function QuantidadeKg({ produto, aoConfirmar, aoFechar }) {
  const [q, setQ] = useState('');
  const qtd = lerQuantidadeMil(q);
  return (
    <Modal titulo={produto.nome} aoFechar={aoFechar}>
      <p className="muted">{formatarCentavos(produto.preco_centavos)} o kg</p>
      <label className="campo">Peso (kg)
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} inputMode="decimal" placeholder="0,000"
          onKeyDown={(e) => { if (e.key === 'Enter' && qtd) aoConfirmar(qtd); }} />
      </label>
      <div className="entre"><span className="muted">Total</span><span className="forte num">{qtd ? formatarCentavos(totalItemCentavos(produto.preco_centavos, qtd)) : '—'}</span></div>
      <button type="button" className="btn primario grande" disabled={!qtd} onClick={() => aoConfirmar(qtd)}>Adicionar</button>
    </Modal>
  );
}

export default function Vender() {
  const { servicos, usuario, carrinho, setCarrinho, licencaStatus, toast, irPara } = useApp();
  const tentar = useTentar();
  const [termo, setTermo] = useState('');
  const t = useDebounce(termo, 150);
  const [pedirKg, setPedirKg] = useState(null);
  const [etapa, setEtapa] = useState(null); // null | 'carrinho' | 'pagamento'
  const [concluida, setConcluida] = useState(null);
  const inputRef = useRef(null);
  const caixa = useCarregar(() => caixaAberto(servicos.db), []);
  const resultados = useCarregar(() => buscarProdutos(servicos.db, t, { limite: 40 }), [t]);

  useEffect(() => { if (!concluida && !etapa) inputRef.current?.focus({ preventScroll: true }); }, [concluida, etapa]);

  const itens = carrinho.itens;
  const qtdNoCarrinho = (id) => itens.filter((i) => i.produtoId === id).reduce((s, i) => s + i.qtdMil, 0);

  const adicionar = (p, qtdMil = 1000) => {
    setCarrinho((c) => {
      const existente = c.itens.find((i) => i.produtoId === p.id);
      const novos = existente
        ? c.itens.map((i) => (i.produtoId === p.id ? { ...i, qtdMil: i.qtdMil + qtdMil } : i))
        : [...c.itens, { produtoId: p.id, nome: p.nome, unidade: p.unidade, precoCentavos: p.preco_centavos, qtdMil, controlaEstoque: !!p.controla_estoque, estoqueMil: p.estoque_mil }];
      return { ...c, itens: novos };
    });
    if (p.controla_estoque && qtdNoCarrinho(p.id) + qtdMil > p.estoque_mil) {
      toast(`Atenção: estoque de ${p.nome} é ${formatarQuantidade(Math.max(0, p.estoque_mil), p.unidade)}.`, 'erro');
    }
  };

  const tocarProduto = (p) => {
    if (p.unidade === 'kg') setPedirKg(p);
    else adicionar(p);
  };

  const porCodigo = async (codigo) => {
    const p = await produtoPorCodigo(servicos.db, codigo);
    if (!p) {
      if (modoTerminal()) {
        // Cadastro é no computador: só avisa (abrir o formulário aqui não adiantaria).
        toast(`Código ${codigo} não cadastrado. Cadastre no ${ctxTerminalNome()} — chega aqui sozinho.`, 'erro', 5000);
        return;
      }
      toast(`Código ${codigo} não cadastrado.`, 'erro');
      if (podeGerenciar(usuario)) irPara('produtos', { novoComCodigo: codigo });
      return;
    }
    tocarProduto(p);
    setTermo('');
  };

  const escanear = () => tentar(async () => {
    const codigo = await lerCodigoDeBarras();
    if (codigo) await porCodigo(codigo);
  });

  if (concluida) {
    return <VendaConcluida venda={concluida} aoNovaVenda={() => { setConcluida(null); caixa.recarregar(); }} />;
  }

  const bloqueado = licencaStatus && !licencaStatus.podeVender;
  const total = totalDoCarrinho(itens);
  const nItens = itens.reduce((s, i) => s + (i.unidade === 'kg' ? 1 : i.qtdMil / 1000), 0);

  return (
    <>
      <header className="topo">
        <h1>Vender</h1>
        {caixa.dados && <span className="selo ok">Caixa aberto</span>}
      </header>
      <main className="conteudo">
        {bloqueado ? (
          <div className="aviso perigo"><Icone nome="cadeado" /><span>{textoDoBloqueio(licencaStatus)}</span></div>
        ) : caixa.carregando ? null : !caixa.dados ? (
          <AbrirCaixa aoAbrir={() => caixa.recarregar()} />
        ) : (
          <>
            <div className="busca">
              <input
                ref={inputRef}
                value={termo}
                onChange={(e) => setTermo(e.target.value)}
                onKeyDown={(e) => {
                  // Leitor de código USB/Bluetooth "digita" o código e manda Enter.
                  if (e.key === 'Enter' && termo.trim()) porCodigo(termo.trim());
                }}
                placeholder="Buscar produto ou código"
                aria-label="Buscar produto ou código"
                enterKeyHint="search"
              />
              <button type="button" className="btn" onClick={escanear} aria-label="Ler código de barras"><Icone nome="scan" /></button>
            </div>
            <div className="cartao plano">
              {(resultados.dados || []).map((p) => {
                const noCarrinho = qtdNoCarrinho(p.id);
                const baixo = p.controla_estoque && p.estoque_mil <= p.estoque_minimo_mil;
                return (
                  <button type="button" key={p.id} className="item produto-linha" onClick={() => tocarProduto(p)}>
                    <div className="cresce">
                      <div className="corta forte">{p.nome}</div>
                      <div className={`peq ${baixo ? 'estoque-baixo' : 'muted'}`}>
                        {p.controla_estoque ? `Estoque: ${formatarQuantidade(Math.max(0, p.estoque_mil), p.unidade)}` : 'Sem controle de estoque'}
                        {p.codigo_barras ? ` · ${p.codigo_barras}` : ''}
                      </div>
                    </div>
                    <span className="preco num">{formatarCentavos(p.preco_centavos)}{p.unidade === 'kg' ? '/kg' : ''}</span>
                    {noCarrinho > 0 && <span className="qtd-badge">{p.unidade === 'kg' ? '✓' : noCarrinho / 1000}</span>}
                  </button>
                );
              })}
              {resultados.dados?.length === 0 && (
                <div className="vazio">
                  {termo ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}
                  {podeGerenciar(usuario) && !modoTerminal() && <div style={{ marginTop: 12 }}><button type="button" className="btn" onClick={() => irPara('produtos', { novo: true })}>Cadastrar produto</button></div>}
                  {modoTerminal() && !termo && <div className="muted peq" style={{ marginTop: 8 }}>Os produtos vêm do {ctxTerminalNome()} — chegam assim que houver internet.</div>}
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {!bloqueado && itens.length > 0 && (
        <div className="carrinho-barra">
          <div className="cresce" role="button" tabIndex={0} onClick={() => setEtapa('carrinho')}>
            <div className="peq">{nItens} {nItens === 1 ? 'item' : 'itens'} · ver carrinho</div>
            <div className="total num">{formatarCentavos(total - (carrinho.descontoCentavos || 0))}</div>
          </div>
          <button type="button" className="btn" onClick={() => setEtapa('pagamento')}>Cobrar</button>
        </div>
      )}

      {pedirKg && <QuantidadeKg produto={pedirKg} aoFechar={() => setPedirKg(null)} aoConfirmar={(q) => { adicionar(pedirKg, q); setPedirKg(null); setTermo(''); }} />}
      {etapa === 'carrinho' && <Carrinho aoFechar={() => setEtapa(null)} aoCobrar={() => setEtapa('pagamento')} />}
      {etapa === 'pagamento' && (
        <Pagamento
          aoFechar={() => setEtapa(null)}
          aoConcluir={(venda) => { setEtapa(null); setCarrinho(CARRINHO_VAZIO); setConcluida(venda); }}
        />
      )}
    </>
  );
}
