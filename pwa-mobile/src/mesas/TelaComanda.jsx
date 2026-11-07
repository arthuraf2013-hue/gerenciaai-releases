import { useEffect, useMemo, useRef, useState } from 'react';
import { mostrarToast } from '../../pdv-util.js';
import { Contador, Folha, Icone, Opcoes, PedirAutorizacao, PedirTexto, Selo } from './comum.jsx';
import {
  STATUS_PREPARO, agruparComanda, formatarMoeda, formatarQuantidade, rotuloMesa, rotuloMesaComUnidas, rotuloPessoa, tempoDesde,
} from './logica.js';
import { cifrarPin, executar as executarNoComputador, observarComanda } from './servidorMesas.js';

const SITUACAO_ENVIO = {
  na_fila: { rotulo: 'na fila', tom: 'aviso' },
  enviando: { rotulo: 'enviando', tom: 'aviso' },
  enviado: { rotulo: 'enviado', tom: 'neutro' },
};

/** Comanda de uma mesa, agrupada por pessoa, com "Lançar para". */
export default function TelaComanda({
  loja, mesaId, mesasDoc, envios, online, agora, podeOrganizar, podeReceber, pessoaInicial,
  aoVoltar, aoLancar, aoFecharConta, aoTrocarMesa,
}) {
  const [estado, setEstado] = useState({ comanda: null, carregou: false, erro: null });
  const [pessoaAtiva, setPessoaAtiva] = useState(pessoaInicial ?? null);
  const [folha, setFolha] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => observarComanda(loja.installId, mesaId, (r) => setEstado({ comanda: r.comanda, carregou: true, erro: r.erro || null })), [loja.installId, mesaId]);

  const mesa = (mesasDoc?.mesas || []).find((m) => m.id === mesaId) || null;
  const comanda = estado.comanda;
  const pessoas = comanda?.pessoas || [];
  const meusEnvios = envios.filter((e) => e.mesaId === mesaId && e.situacao !== 'erro');
  const grupos = useMemo(() => agruparComanda(comanda, meusEnvios), [comanda, meusEnvios]);
  const conta = comanda?.conta || null;

  // Pessoa removida (por outro celular ou no computador): volta para "Mesa".
  useEffect(() => {
    if (pessoaAtiva != null && comanda && !pessoas.some((p) => p.numero === pessoaAtiva)) setPessoaAtiva(null);
  }, [comanda, pessoas, pessoaAtiva]);

  // A comanda existia e sumiu: conta fechada (aqui ou no computador), mesa
  // transferida ou desocupada. Mesa que ainda vai abrir não entra aqui.
  const viuComanda = useRef(false);
  if (comanda) viuComanda.current = true;
  const fechada = viuComanda.current && estado.carregou && !comanda && meusEnvios.length === 0;

  async function fazer(tipo, campos, { sucesso, depois } = {}) {
    if (ocupado) return null;
    setOcupado(true);
    try {
      const r = await executarNoComputador(loja.installId, tipo, { mesaId, ...campos });
      if (sucesso) mostrarToast(sucesso);
      depois?.(r);
      return r;
    } catch (err) {
      mostrarToast(err.message, 'erro');
      return null;
    } finally {
      setOcupado(false);
    }
  }

  const titulo = mesa ? rotuloMesaComUnidas(mesa) : comanda ? rotuloMesaComUnidas(comanda) : 'Mesa';

  const abrirOpcoesPessoa = (p) => setFolha({
    tipo: 'opcoes',
    titulo: p.clienteId ? `${rotuloPessoa(pessoas, p.numero)} · cliente ${p.clienteNome}` : rotuloPessoa(pessoas, p.numero),
    opcoes: [
      { rotulo: p.nome ? 'Trocar o nome' : 'Dar um nome', aoEscolher: () => setFolha({ tipo: 'nome', pessoa: p }) },
      {
        chave: 'cliente',
        rotulo: p.clienteId ? 'Trocar o cliente do cadastro' : 'Ligar a um cliente do cadastro',
        detalhe: 'O consumo dela aparece na ficha do cliente',
        aoEscolher: () => setFolha({ tipo: 'cliente', pessoa: p }),
      },
      p.clienteId && {
        chave: 'desligar', rotulo: `Desligar de ${p.clienteNome}`,
        aoEscolher: () => { setFolha(null); fazer('vincular_cliente', { numero: p.numero }, { sucesso: 'Pessoa desligada do cliente.' }); },
      },
      p.nome && { rotulo: 'Tirar o nome', aoEscolher: () => { setFolha(null); fazer('renomear_pessoa', { numero: p.numero, nome: '' }); } },
      { rotulo: 'Tirar esta pessoa da mesa', detalhe: 'Os itens dela voltam para "Mesa"', perigo: true,
        aoEscolher: () => { setFolha(null); fazer('remover_pessoa', { numero: p.numero }, { sucesso: 'Pessoa removida.' }); } },
    ],
  });

  const tocarChip = (numero) => {
    if (numero === pessoaAtiva && numero != null) {
      const p = pessoas.find((x) => x.numero === numero);
      if (p) abrirOpcoesPessoa(p);
      return;
    }
    setPessoaAtiva(numero);
  };

  const abrirOpcoesItem = (item) => {
    if (item.provisorio) {
      mostrarToast(item.situacao === 'na_fila' ? 'Esse item está guardado no celular e vai assim que a internet voltar.' : 'Esse item está chegando no computador.');
      return;
    }
    setFolha({
      tipo: 'opcoes',
      titulo: `${formatarQuantidade(item.quantidade, item.unidade)} ${item.nome}`,
      opcoes: [
        { rotulo: 'Mover para outra pessoa', aoEscolher: () => setFolha({ tipo: 'mover', item }) },
        { rotulo: item.observacao ? 'Trocar a observação' : 'Pôr observação', detalhe: item.observacao || 'Ex.: sem gelo', aoEscolher: () => setFolha({ tipo: 'observacao', item }) },
        { rotulo: 'Cancelar item', perigo: true, aoEscolher: () => pedirCancelamento(item) },
      ],
    });
  };

  const pedirCancelamento = (item) => {
    const precisaGerente = !!mesasDoc?.exigeAutorizacaoCancelamento && (conta?.pago || 0) > 0;
    setFolha(precisaGerente ? { tipo: 'autorizar', item } : { tipo: 'cancelar', item });
  };

  const cancelarComAutorizacao = async (item, { autorizadorId, pin, motivo }) => {
    try {
      const pinCifrado = await cifrarPin(mesasDoc.chavePublica, pin);
      setFolha(null);
      await fazer('cancelar_item', { itemId: item.id, autorizadorId, pinCifrado, motivo }, { sucesso: 'Item cancelado.' });
    } catch (err) {
      mostrarToast(err.message, 'erro');
    }
  };

  const menuMesa = () => {
    const unidas = comanda?.unidas || [];
    setFolha({
      tipo: 'opcoes',
      titulo: titulo,
      opcoes: [
        comanda && { rotulo: 'Pessoas na mesa', detalhe: `${pessoas.length}`, aoEscolher: () => setFolha({ tipo: 'pessoas' }) },
        comanda && podeOrganizar && { rotulo: 'Juntar com outra mesa', aoEscolher: () => setFolha({ tipo: 'juntar' }) },
        ...(podeOrganizar ? unidas.map((u) => ({
          chave: `sep-${u.id}`, rotulo: `Separar a mesa ${u.numero}`, detalhe: 'O consumo continua nesta comanda',
          aoEscolher: () => { setFolha(null); fazer('separar', { mesaId: u.id }, { sucesso: `Mesa ${u.numero} separada.` }); },
        })) : []),
        comanda && podeOrganizar && unidas.length === 0 && { rotulo: 'Transferir para outra mesa', aoEscolher: () => setFolha({ tipo: 'transferir' }) },
      ],
    });
  };

  return (
    <div className="pm-tela pm-tela-comanda">
      <header className="pm-barra">
        <button type="button" className="btn-icone" aria-label="Voltar para as mesas" onClick={aoVoltar}><Icone nome="voltar" /></button>
        <div className="pm-barra-titulo">
          <strong>{titulo}</strong>
          {comanda && (
            <span className="subtexto">
              {comanda.abertaEm ? `aberta há ${tempoDesde(comanda.abertaEm, agora)}` : ''}
              {comanda.abertaPorNome ? ` · ${comanda.abertaPorNome}` : ''}
            </span>
          )}
        </div>
        <span className="pm-barra-total">{formatarMoeda(conta?.totalAPagar ?? 0)}</span>
        {comanda && (
          <button type="button" className="btn-icone" aria-label="Mais opções da mesa" onClick={menuMesa}><Icone nome="menu" /></button>
        )}
      </header>

      {estado.erro && <p className="aviso aviso-erro">{estado.erro.message}</p>}
      {fechada && (
        <div className="pm-vazio-grande">
          <p>{mesa ? rotuloMesa(mesa) : 'A mesa'} não está mais aberta{mesa?.status === 'aguardando_limpeza' ? ' (aguardando limpeza)' : ''}.</p>
          <button type="button" className="btn-secundario" onClick={aoVoltar}>Voltar para as mesas</button>
        </div>
      )}

      {!fechada && (
        <>
          <div className="pm-lancar-para">
            <span className="pm-rotulo">Lançar para</span>
            <div className="pm-chips" role="radiogroup" aria-label="Lançar para">
              {pessoas.map((p) => (
                <button key={p.numero} type="button" role="radio" aria-checked={pessoaAtiva === p.numero}
                  className={`chip${pessoaAtiva === p.numero ? ' chip-ativo' : ''}${p.clienteId ? ' pm-chip-cliente' : ''}`} onClick={() => tocarChip(p.numero)}
                  title={p.clienteId ? `Cliente do cadastro: ${p.clienteNome}` : undefined}>
                  {p.clienteId && <Icone nome="usuario" tamanho={13} />}
                  {p.nome || `Pessoa ${p.numero}`}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={pessoaAtiva === null}
                className={`chip${pessoaAtiva === null ? ' chip-ativo' : ''}`} onClick={() => tocarChip(null)}>
                Mesa
              </button>
              {comanda && (
                <button type="button" className="chip pm-chip-mais" aria-label="Adicionar pessoa" disabled={ocupado}
                  onClick={() => setFolha({ tipo: 'nova-pessoa' })}>+ Pessoa</button>
              )}
            </div>
            {pessoaAtiva != null && <span className="subtexto pm-dica">Toque de novo no nome para renomear ou tirar.</span>}
          </div>

          <div className="pm-grupos">
            {!estado.carregou && <p className="estado-vazio"><span className="spinner spinner-pequeno" /> Carregando a comanda...</p>}
            {estado.carregou && !comanda && meusEnvios.length === 0 && (
              <p className="estado-vazio">Mesa sem pedido ainda. Toque em "Adicionar itens".</p>
            )}
            {estado.carregou && !comanda && meusEnvios.length > 0 && (
              <p className="subtexto">A mesa abre no computador quando o primeiro pedido chegar.</p>
            )}
            {grupos.map((g) => (
              <section key={g.pessoaNumero ?? 'mesa'} className={`pm-grupo${pessoaAtiva === g.pessoaNumero ? ' pm-grupo-ativo' : ''}`}>
                <button type="button" className="pm-grupo-topo" onClick={() => setPessoaAtiva(g.pessoaNumero)}>
                  <span className="pm-grupo-nome">{g.rotulo}</span>
                  <span className="pm-grupo-subtotal">{g.itens.length ? formatarMoeda(g.subtotal) : 'sem itens'}</span>
                </button>
                {g.itens.length > 0 && (
                  <ul className="pm-itens">
                    {g.itens.map((i) => {
                      const sit = i.provisorio ? SITUACAO_ENVIO[i.situacao] || SITUACAO_ENVIO.enviado : STATUS_PREPARO[i.situacao] || STATUS_PREPARO.pendente;
                      return (
                        <li key={i.id}>
                          <button type="button" className={`pm-item${i.provisorio ? ' pm-item-provisorio' : ''}`} onClick={() => abrirOpcoesItem(i)}>
                            <span className="pm-item-qtd">{formatarQuantidade(i.quantidade, i.unidade)}</span>
                            <span className="pm-item-nome">
                              {i.nome}
                              {i.observacao && <span className="pm-item-obs">{i.observacao}</span>}
                            </span>
                            <Selo tom={sit.tom}>{sit.rotulo}</Selo>
                            <span className="pm-item-preco">{formatarMoeda(i.total)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </div>

          {conta && conta.pago > 0 && (
            <div className="pm-resumo-conta">
              <span>Pago {formatarMoeda(conta.pago)}</span>
              <strong>Falta {formatarMoeda(conta.restante)}</strong>
            </div>
          )}

          <footer className="pm-rodape">
            <button type="button" className="btn-primario" onClick={() => aoLancar(pessoaAtiva)}>
              Adicionar itens para {rotuloPessoa(pessoas, pessoaAtiva)}
            </button>
            {podeReceber && comanda && conta && conta.totalAPagar > 0 && (
              <button type="button" className="btn-secundario" onClick={aoFecharConta}>
                Fechar conta · {formatarMoeda(conta.restante)}
              </button>
            )}
          </footer>
        </>
      )}

      {!online && <p className="pm-offline">Sem internet: dá para lançar itens (vão quando a conexão voltar). O resto precisa de conexão.</p>}

      {folha?.tipo === 'opcoes' && <Opcoes titulo={folha.titulo} opcoes={folha.opcoes} aoFechar={() => setFolha(null)} />}
      {folha?.tipo === 'nova-pessoa' && (
        <PedirTexto titulo="Nova pessoa na mesa" rotulo="Nome (opcional)" placeholder="Ex.: Ana" textoBotao="Adicionar"
          aoFechar={() => setFolha(null)}
          aoConfirmar={(nome) => { setFolha(null); fazer('adicionar_pessoa', { nome }, { depois: (r) => r?.numero && setPessoaAtiva(r.numero) }); }} />
      )}
      {folha?.tipo === 'nome' && (
        <PedirTexto titulo={rotuloPessoa(pessoas, folha.pessoa.numero)} rotulo="Nome" inicial={folha.pessoa.nome || ''} placeholder="Ex.: Ana"
          aoFechar={() => setFolha(null)}
          aoConfirmar={(nome) => { setFolha(null); fazer('renomear_pessoa', { numero: folha.pessoa.numero, nome }); }} />
      )}
      {folha?.tipo === 'cliente' && (
        <BuscarCliente
          loja={loja}
          titulo={`Cliente de ${rotuloPessoa(pessoas, folha.pessoa.numero)}`}
          atualId={folha.pessoa.clienteId}
          aoFechar={() => setFolha(null)}
          aoEscolher={(c) => {
            const p = folha.pessoa;
            setFolha(null);
            fazer('vincular_cliente', { numero: p.numero, clienteId: c.id }, { sucesso: `Ligada a ${c.nome}.` });
          }}
        />
      )}
      {folha?.tipo === 'observacao' && (
        <PedirTexto titulo={folha.item.nome} rotulo="Observação para a cozinha" inicial={folha.item.observacao || ''} max={200} multilinha
          placeholder="Ex.: sem cebola" aoFechar={() => setFolha(null)}
          aoConfirmar={(obs) => { setFolha(null); fazer('observacao_item', { itemId: folha.item.id, observacao: obs }, { sucesso: 'Observação salva.' }); }} />
      )}
      {folha?.tipo === 'mover' && (
        <Opcoes
          titulo={`Mover ${folha.item.nome} para`}
          aoFechar={() => setFolha(null)}
          opcoes={[
            ...pessoas.map((p) => ({ chave: `p${p.numero}`, rotulo: p.nome || `Pessoa ${p.numero}`, ativa: folha.item.pessoaNumero === p.numero,
              aoEscolher: () => { setFolha(null); fazer('mover_item', { itemId: folha.item.id, pessoaNumero: p.numero }); } })),
            { chave: 'mesa', rotulo: 'Mesa (sem pessoa)', ativa: folha.item.pessoaNumero == null,
              aoEscolher: () => { setFolha(null); fazer('mover_item', { itemId: folha.item.id, pessoaNumero: null }); } },
          ]}
        />
      )}
      {folha?.tipo === 'cancelar' && (
        <PedirTexto titulo={`Cancelar ${folha.item.nome}?`} rotulo="Motivo (opcional)" max={200} textoBotao="Cancelar item"
          placeholder="Ex.: cliente desistiu" aoFechar={() => setFolha(null)}
          aoConfirmar={(motivo) => { setFolha(null); fazer('cancelar_item', { itemId: folha.item.id, motivo }, { sucesso: 'Item cancelado.' }); }} />
      )}
      {folha?.tipo === 'autorizar' && (
        <PedirAutorizacao autorizadores={mesasDoc?.autorizadores || []}
          motivoTexto={`A conta já tem pagamento: cancelar ${folha.item.nome} precisa do PIN de um gerente.`}
          aoFechar={() => setFolha(null)} aoConfirmar={(dados) => cancelarComAutorizacao(folha.item, dados)} />
      )}
      {folha?.tipo === 'pessoas' && (
        <AjustarPessoas atual={pessoas.length} aoFechar={() => setFolha(null)}
          aoConfirmar={(n) => { setFolha(null); fazer('abrir', { pessoas: n }, { sucesso: 'Pessoas atualizadas.' }); }} />
      )}
      {folha?.tipo === 'juntar' && (
        <EscolherMesas
          titulo="Juntar com"
          mesas={(mesasDoc?.mesas || []).filter((m) => m.id !== mesaId && !m.unidaA && (m.status === 'livre' || (m.status === 'ocupada' && !(m.pago > 0))))}
          multiplo
          textoBotao="Juntar"
          aoFechar={() => setFolha(null)}
          aoConfirmar={(ids) => { setFolha(null); fazer('juntar', { mesaIds: ids }, { sucesso: 'Mesas juntas.' }); }}
        />
      )}
      {folha?.tipo === 'transferir' && (
        <EscolherMesas
          titulo="Transferir para"
          mesas={(mesasDoc?.mesas || []).filter((m) => m.status === 'livre')}
          textoBotao="Transferir"
          aoFechar={() => setFolha(null)}
          aoConfirmar={([destino]) => { setFolha(null); fazer('transferir', { destinoId: destino }, { sucesso: 'Mesa transferida.', depois: (r) => r?.mesaId && aoTrocarMesa(r.mesaId) }); }}
        />
      )}
    </div>
  );
}

function AjustarPessoas({ atual, aoFechar, aoConfirmar }) {
  const [n, setN] = useState(Math.max(1, atual));
  return (
    <Folha titulo="Pessoas na mesa" aoFechar={aoFechar}>
      <div className="pm-form">
        <Contador valor={n} min={1} max={200} aoMudar={setN} rotulo="Pessoas na mesa" />
        <p className="subtexto">Para tirar alguém que já tem item ou nome, toque no nome dela em "Lançar para".</p>
        <button type="button" className="btn-primario" onClick={() => aoConfirmar(n)}>Salvar</button>
      </div>
    </Folha>
  );
}

function EscolherMesas({ titulo, mesas, multiplo = false, textoBotao, aoFechar, aoConfirmar }) {
  const [escolhidas, setEscolhidas] = useState([]);
  const alternar = (id) => {
    if (!multiplo) return setEscolhidas([id]);
    return setEscolhidas((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]));
  };
  return (
    <Folha titulo={titulo} aoFechar={aoFechar}>
      {mesas.length === 0 ? <p className="estado-vazio">Nenhuma mesa disponível para isso agora.</p> : (
        <div className="pm-grade-mesas pm-grade-escolha">
          {mesas.map((m) => (
            <button key={m.id} type="button" aria-pressed={escolhidas.includes(m.id)}
              className={`pm-mesa${m.status === 'ocupada' ? ' pm-mesa-ocupada' : ''}${escolhidas.includes(m.id) ? ' pm-mesa-escolhida' : ''}`}
              onClick={() => alternar(m.id)}>
              <span className="pm-mesa-nome">{rotuloMesaComUnidas(m)}</span>
              <span className="pm-mesa-info">{m.status === 'ocupada' ? formatarMoeda(m.total) : 'livre'}</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="btn-primario" disabled={escolhidas.length === 0} onClick={() => aoConfirmar(escolhidas)}>{textoBotao}</button>
    </Folha>
  );
}

/** Procura cliente do cadastro no computador (só nome e fim do telefone voltam). */
function BuscarCliente({ loja, titulo, atualId, aoFechar, aoEscolher }) {
  const [busca, setBusca] = useState('');
  const [estado, setEstado] = useState({ carregando: false, clientes: [], erro: '' });
  const pedido = useRef(0);
  const campo = useRef(null);
  useEffect(() => { campo.current?.focus(); }, []);

  useEffect(() => {
    const texto = busca.trim();
    if (texto.length < 2) { setEstado({ carregando: false, clientes: [], erro: '' }); return undefined; }
    const meu = ++pedido.current;
    setEstado((e) => ({ ...e, carregando: true, erro: '' }));
    const timer = setTimeout(() => {
      executarNoComputador(loja.installId, 'buscar_clientes', { busca: texto })
        .then((r) => { if (meu === pedido.current) setEstado({ carregando: false, clientes: r?.clientes || [], erro: '' }); })
        .catch((err) => { if (meu === pedido.current) setEstado({ carregando: false, clientes: [], erro: err.message }); });
    }, 450);
    return () => clearTimeout(timer);
  }, [busca, loja.installId]);

  const texto = busca.trim();
  return (
    <Folha titulo={titulo} aoFechar={aoFechar}>
      <div className="pm-form">
        <label className="pm-rotulo" htmlFor="pm-busca-cliente">Nome ou telefone do cliente</label>
        <input id="pm-busca-cliente" ref={campo} className="campo" maxLength={40} autoComplete="off" placeholder="Ex.: Ana"
          value={busca} onChange={(e) => setBusca(e.target.value)} />
        {texto.length > 0 && texto.length < 2 && <p className="subtexto">Digite pelo menos 2 letras.</p>}
        {estado.carregando && <p className="subtexto"><span className="spinner spinner-pequeno" /> Procurando...</p>}
        {estado.erro && <p className="aviso aviso-alerta">{estado.erro}</p>}
        {!estado.carregando && !estado.erro && texto.length >= 2 && estado.clientes.length === 0 && (
          <p className="subtexto">Nenhum cliente com esse nome. O cadastro é feito no computador.</p>
        )}
        {estado.clientes.length > 0 && (
          <div className="pm-opcoes">
            {estado.clientes.map((c) => (
              <button key={c.id} type="button" className={`pm-opcao${c.id === atualId ? ' pm-opcao-ativa' : ''}`}
                disabled={c.id === atualId} onClick={() => aoEscolher(c)}>
                <span>{c.nome}</span>
                <span className="pm-opcao-detalhe">{c.id === atualId ? 'cliente atual' : c.telefoneFinal ? `telefone terminado em ${c.telefoneFinal}` : 'sem telefone'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Folha>
  );
}
