import { useEffect, useMemo, useState } from 'react';
import { Folha, Icone } from './comum.jsx';
import {
  categoriasDo, centavos, filtrarCatalogo, formatarMoeda, formatarQuantidade, itensParaLancar, lerValor, quantidadeNoCarrinho,
  resumoCarrinho, rotuloMesa, rotuloPessoa, somarNoCarrinho, unidadeFracionada,
} from './logica.js';
import { observarComanda } from './servidorMesas.js';

const chaveCarrinho = (installId, mesaId) => `gerenciaai_mesas_carrinho_${installId}_${mesaId}`;

function lerCarrinho(installId, mesaId) {
  try {
    const l = JSON.parse(localStorage.getItem(chaveCarrinho(installId, mesaId)) || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

/** Escolher produtos para uma pessoa (ou para a mesa) e mandar para a comanda. */
export default function TelaLancar({ loja, mesaId, mesa, pessoaInicial, catalogo, pessoasAoAbrir, aoVoltar, aoEnviar }) {
  const [pessoas, setPessoas] = useState([]);
  const [para, setPara] = useState(pessoaInicial ?? null);
  const [busca, setBusca] = useState('');
  const [categoria, setCategoria] = useState('todas');
  const [carrinho, setCarrinho] = useState(() => lerCarrinho(loja.installId, mesaId));
  const [folha, setFolha] = useState(null);

  useEffect(() => observarComanda(loja.installId, mesaId, (r) => setPessoas(r.comanda?.pessoas || [])), [loja.installId, mesaId]);
  useEffect(() => {
    try { localStorage.setItem(chaveCarrinho(loja.installId, mesaId), JSON.stringify(carrinho)); } catch { /* sem armazenamento */ }
  }, [carrinho, loja.installId, mesaId]);

  const produtos = catalogo?.produtos || [];
  const categorias = useMemo(() => categoriasDo(produtos), [produtos]);
  const lista = useMemo(() => filtrarCatalogo(produtos, { busca, categoria }), [produtos, busca, categoria]);
  const resumo = resumoCarrinho(carrinho);
  // Mesa sem comanda ainda: "Pessoa N" da escolha feita ao abrir.
  const pessoasDaTela = pessoas.length ? pessoas : Array.from({ length: pessoasAoAbrir || 0 }, (_, i) => ({ numero: i + 1, nome: null }));

  const semEstoque = (p) => p.tipo !== 'servico' && p.estoque != null && p.estoque <= 0;

  const tocarProduto = (p) => {
    if (semEstoque(p)) return;
    if (unidadeFracionada(p.unidade)) return setFolha({ tipo: 'peso', produto: p });
    setCarrinho((c) => somarNoCarrinho(c, p, para, 1));
    if (navigator.vibrate) navigator.vibrate(10);
  };

  const enviar = () => {
    if (carrinho.length === 0) return;
    const itens = itensParaLancar(carrinho);
    const itensTela = carrinho.map((l) => ({
      nome: l.nome, quantidade: l.quantidade, preco: l.preco, unidade: l.unidade, pessoaNumero: l.pessoaNumero ?? null,
      observacao: l.observacao?.trim() || null,
    }));
    aoEnviar({ itens, itensTela });
    setCarrinho([]);
    try { localStorage.removeItem(chaveCarrinho(loja.installId, mesaId)); } catch { /* ok */ }
  };

  return (
    <div className="pm-tela pm-tela-lancar">
      <header className="pm-barra">
        <button type="button" className="btn-icone" aria-label="Voltar para a comanda" onClick={aoVoltar}><Icone nome="voltar" /></button>
        <div className="pm-barra-titulo">
          <strong>Lançar · {mesa ? rotuloMesa(mesa) : 'Mesa'}</strong>
          <span className="subtexto">Para: {rotuloPessoa(pessoasDaTela, para)}</span>
        </div>
      </header>

      <div className="pm-chips pm-chips-para" role="radiogroup" aria-label="Lançar para">
        {pessoasDaTela.map((p) => (
          <button key={p.numero} type="button" role="radio" aria-checked={para === p.numero}
            className={`chip${para === p.numero ? ' chip-ativo' : ''}`} onClick={() => setPara(p.numero)}>
            {p.nome || `Pessoa ${p.numero}`}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={para === null} className={`chip${para === null ? ' chip-ativo' : ''}`} onClick={() => setPara(null)}>Mesa</button>
      </div>

      <div className="pm-busca">
        <div className="campo-busca">
          <Icone nome="busca" />
          <input type="search" placeholder="Buscar produto" aria-label="Buscar produto" autoComplete="off" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
      </div>
      {categorias.length > 1 && (
        <div className="pm-chips pm-chips-categorias">
          <button type="button" className={`chip${categoria === 'todas' ? ' chip-ativo' : ''}`} onClick={() => setCategoria('todas')}>Todas</button>
          {categorias.map((c) => (
            <button key={c} type="button" className={`chip${categoria === c ? ' chip-ativo' : ''}`} onClick={() => setCategoria(c)}>{c}</button>
          ))}
        </div>
      )}

      <div className="pm-produtos">
        {produtos.length === 0 && <p className="estado-vazio">Carregando o cardápio... (o computador publica a cada ~25 s)</p>}
        {produtos.length > 0 && lista.length === 0 && <p className="estado-vazio">Nada encontrado.</p>}
        {lista.map((p) => {
          const qtd = quantidadeNoCarrinho(carrinho, p.id);
          const fora = semEstoque(p);
          return (
            <button key={p.id} type="button" className={`pm-produto${qtd ? ' pm-produto-no-carrinho' : ''}${fora ? ' pm-produto-sem-estoque' : ''}`}
              onClick={() => tocarProduto(p)} disabled={fora}>
              <span className="pm-produto-nome">{p.nome}</span>
              <span className="pm-produto-preco">{formatarMoeda(p.preco)}{unidadeFracionada(p.unidade) ? `/${p.unidade}` : ''}</span>
              {fora && <span className="pm-produto-aviso">sem estoque</span>}
              {qtd > 0 && <span className="badge-qtd">{unidadeFracionada(p.unidade) ? formatarQuantidade(qtd, p.unidade) : qtd}</span>}
            </button>
          );
        })}
      </div>

      <footer className="pm-rodape pm-rodape-lancar">
        <button type="button" className="btn-secundario" disabled={carrinho.length === 0} onClick={() => setFolha({ tipo: 'pedido' })}>
          Ver pedido{carrinho.length ? ` (${resumo.linhas})` : ''}
        </button>
        <button type="button" className="btn-primario" disabled={carrinho.length === 0} onClick={enviar}>
          Enviar{carrinho.length ? ` · ${formatarMoeda(resumo.total)}` : ''}
        </button>
      </footer>

      {folha?.tipo === 'peso' && (
        <QuantidadeFracionada produto={folha.produto} aoFechar={() => setFolha(null)}
          aoConfirmar={(q) => { setFolha(null); setCarrinho((c) => somarNoCarrinho(c, folha.produto, para, q)); }} />
      )}
      {folha?.tipo === 'pedido' && (
        <RevisarPedido carrinho={carrinho} pessoas={pessoasDaTela} aoMudar={setCarrinho} aoFechar={() => setFolha(null)}
          aoEnviar={() => { setFolha(null); enviar(); }} />
      )}
    </div>
  );
}

function QuantidadeFracionada({ produto, aoFechar, aoConfirmar }) {
  const [texto, setTexto] = useState('');
  const q = lerValor(texto);
  const valido = Number.isFinite(q) && q > 0 && q <= 1000;
  return (
    <Folha titulo={produto.nome} aoFechar={aoFechar}>
      <form className="pm-form" onSubmit={(e) => { e.preventDefault(); if (valido) aoConfirmar(Math.round(q * 1000) / 1000); }}>
        <label className="pm-rotulo" htmlFor="pm-peso">Quantidade ({produto.unidade})</label>
        <input id="pm-peso" className="campo campo-grande" inputMode="decimal" autoComplete="off" placeholder="0,000" autoFocus
          value={texto} onChange={(e) => setTexto(e.target.value)} />
        {valido && <p className="subtexto">{formatarMoeda(centavos(produto.preco * q) / 100)}</p>}
        <button type="submit" className="btn-primario" disabled={!valido}>Adicionar</button>
      </form>
    </Folha>
  );
}

function RevisarPedido({ carrinho, pessoas, aoMudar, aoFechar, aoEnviar }) {
  const [editandoObs, setEditandoObs] = useState(null);
  const mudarQtd = (chave, delta) => aoMudar((c) => c
    .map((l) => (l.chave === chave ? { ...l, quantidade: Math.round((l.quantidade + delta) * 1000) / 1000 } : l))
    .filter((l) => l.quantidade > 0));
  const remover = (chave) => aoMudar((c) => c.filter((l) => l.chave !== chave));
  const porPessoa = new Map();
  for (const l of carrinho) {
    const k = l.pessoaNumero ?? 'mesa';
    if (!porPessoa.has(k)) porPessoa.set(k, []);
    porPessoa.get(k).push(l);
  }
  const resumo = resumoCarrinho(carrinho);
  return (
    <Folha titulo="Pedido" aoFechar={aoFechar}>
      <div className="pm-revisao">
        {[...porPessoa.entries()].map(([k, linhas]) => (
          <section key={k} className="pm-revisao-grupo">
            <h3>{rotuloPessoa(pessoas, k === 'mesa' ? null : k)}</h3>
            {linhas.map((l) => (
              <div key={l.chave} className="pm-revisao-linha">
                <div className="pm-revisao-info">
                  <span className="pm-item-nome">{l.nome}</span>
                  {editandoObs === l.chave ? (
                    <input className="campo" maxLength={200} autoFocus placeholder="Observação (ex.: sem gelo)" value={l.observacao}
                      onChange={(e) => aoMudar((c) => c.map((x) => (x.chave === l.chave ? { ...x, observacao: e.target.value } : x)))}
                      onBlur={() => setEditandoObs(null)} />
                  ) : (
                    <button type="button" className="btn-link-inline" onClick={() => setEditandoObs(l.chave)}>
                      {l.observacao ? l.observacao : '+ observação'}
                    </button>
                  )}
                </div>
                {unidadeFracionada(l.unidade) ? (
                  <span className="pm-item-qtd">{formatarQuantidade(l.quantidade, l.unidade)}</span>
                ) : (
                  <div className="pm-contador pm-contador-pequeno">
                    <button type="button" className="btn-icone pm-contador-btn" aria-label="Menos" onClick={() => mudarQtd(l.chave, -1)}>−</button>
                    <span className="pm-contador-valor">{l.quantidade}</span>
                    <button type="button" className="btn-icone pm-contador-btn" aria-label="Mais" onClick={() => mudarQtd(l.chave, 1)}>+</button>
                  </div>
                )}
                <button type="button" className="btn-icone" aria-label={`Tirar ${l.nome}`} onClick={() => remover(l.chave)}><Icone nome="lixeira" /></button>
              </div>
            ))}
          </section>
        ))}
        <div className="pm-revisao-total"><span>Total</span><strong>{formatarMoeda(resumo.total)}</strong></div>
        <button type="button" className="btn-primario" disabled={carrinho.length === 0} onClick={aoEnviar}>Enviar para a comanda</button>
      </div>
    </Folha>
  );
}
