import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscToClose } from '../../hooks/useEscToClose';
import { EyewearModal } from './EyewearModal';
import { PetsModal } from './PetsModal';
import Icon from '../common/Icon';
import {
  PERIODOS, SITUACAO_PET, STATUS_AGENDA, STATUS_ENTREGA, STATUS_ORCAMENTO, STATUS_RESERVA,
  dataCalendario, dataDoBanco, dataHora, dataHoraLocal, dioptria, eixo, intervaloDoPeriodo, moeda, quantidade,
  receitaDaCompra, secoesDaFicha, valorDaEspecificacao,
} from '../../utils/fichaCliente';

/**
 * Ficha do cliente -- abre ao clicar no nome (Clientes e filtro de cliente do
 * Histórico), em qualquer perfil: dados do cliente, o que ele comprou em cada
 * compra (itens com as especificações do produto guardadas na hora da venda),
 * totais do período e o que é próprio de cada perfil (receitas da ótica,
 * animais do petshop, agenda do salão, reservas do restaurante, garantia na
 * construção, tamanhos na loja de roupas...). Período igual ao do Histórico.
 * Dados: customer:getFicha (fichaClienteService.js).
 */
export function FichaClienteModal({ customerId, nomeInicial, onFechar }) {
  const [periodo, setPeriodo] = useState('tudo');
  const [datas, setDatas] = useState({ dataInicio: '', dataFim: '' });
  const [offsetMs, setOffsetMs] = useState(0);
  const [ficha, setFicha] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [editando, setEditando] = useState(null); // 'receitas' | 'pets' | null
  useEscToClose(onFechar, !editando);

  useEffect(() => {
    window.pdv.time?.getStatus?.().then((s) => setOffsetMs(s?.offsetMs || 0)).catch(() => {});
  }, []);

  // Período e datas mudam juntos (num efeito separado, a ficha buscaria uma
  // vez com o período novo e as datas velhas).
  function escolherPeriodo(p) {
    const intervalo = intervaloDoPeriodo(p, new Date(Date.now() + offsetMs));
    setPeriodo(p);
    if (intervalo) setDatas(intervalo);
  }

  // Só a resposta do último pedido vale (trocar de período rápido não deixa
  // uma resposta atrasada sobrescrever a certa).
  const pedido = useRef(0);
  const carregar = useCallback(async () => {
    const { dataInicio, dataFim } = datas;
    // Personalizado com uma das datas em branco: espera completar.
    if (periodo !== 'tudo' && (!dataInicio || !dataFim)) return;
    const meu = ++pedido.current;
    setCarregando(true);
    const r = await window.pdv.customers.getFicha({
      customerId, dataInicio: periodo === 'tudo' ? null : dataInicio, dataFim: periodo === 'tudo' ? null : dataFim,
    }).catch((err) => ({ ok: false, error: err?.message }));
    if (meu !== pedido.current) return;
    setCarregando(false);
    if (!r?.ok) {
      setErro(r?.error || 'Não foi possível carregar a ficha.');
      return;
    }
    setErro('');
    setFicha(r);
  }, [customerId, datas, periodo]);

  useEffect(() => { carregar(); }, [carregar]);

  function imprimir() {
    document.body.classList.add('imprimindo-ficha');
    const limpar = () => {
      document.body.classList.remove('imprimindo-ficha');
      window.removeEventListener('afterprint', limpar);
    };
    window.addEventListener('afterprint', limpar);
    window.print();
    // Alguns ambientes não disparam afterprint: garante que a classe sai.
    setTimeout(limpar, 1000);
  }

  const c = ficha?.cliente;
  const resumo = ficha?.resumo;
  const documento = c?.cnpj ? `CNPJ ${c.cnpj}` : c?.cpf ? `CPF ${c.cpf}` : null;
  const { antes, depois } = secoesDaFicha(ficha);
  const secao = (nome) => {
    const props = { ficha, periodoAtivo: !!ficha?.periodo };
    if (nome === 'receitas') return <SecaoReceitas key={nome} {...props} aoEditar={() => setEditando('receitas')} />;
    if (nome === 'pets') return <SecaoPets key={nome} {...props} aoEditar={() => setEditando('pets')} />;
    if (nome === 'agenda') return <SecaoAgenda key={nome} {...props} />;
    if (nome === 'reservas') return <SecaoReservas key={nome} {...props} />;
    if (nome === 'orcamentos') return <SecaoOrcamentos key={nome} {...props} />;
    if (nome === 'preferencias') return <SecaoPreferencias key={nome} {...props} />;
    if (nome === 'entregas') return <SecaoEntregas key={nome} {...props} />;
    if (nome === 'fiado') return <SecaoFiado key={nome} {...props} />;
    return null;
  };

  // Direto no <body>: a impressão mostra só a ficha (ver @media print em theme.css).
  return createPortal((
    <div className="modal-overlay ficha-cliente-fundo">
      <div className="modal-card ficha-cliente" role="dialog" aria-modal="true" aria-label={`Ficha de ${c?.nome || nomeInicial || 'cliente'}`}>
        <div className="ficha-topo">
          <div>
            <span className="ficha-rotulo"><Icon name="user" size={14} /> Ficha do cliente{ficha?.perfil?.nome ? ` · ${ficha.perfil.nome}` : ''}</span>
            <h2 className="ficha-nome">{c?.nome || nomeInicial}</h2>
            {c && (
              <p className="ficha-contato">
                {[c.telefone, documento, c.dataNascimento && `nasceu em ${dataCalendario(c.dataNascimento)}`].filter(Boolean).join(' · ') || 'Sem telefone ou documento cadastrado'}
              </p>
            )}
          </div>
          <div className="ficha-acoes nao-imprimir">
            <button type="button" className="btn-secondary" onClick={imprimir} disabled={!ficha}>
              <span className="ficha-btn"><Icon name="printer" size={15} /> Imprimir ficha</span>
            </button>
            <button type="button" className="btn-secondary" onClick={onFechar} aria-label="Fechar ficha">
              <span className="ficha-btn"><Icon name="close" size={15} /> Fechar</span>
            </button>
          </div>
        </div>

        {c && (
          <div className="ficha-etiquetas">
            <span className="ficha-etiqueta">Cliente desde {dataDoBanco(c.clienteDesde)}</span>
            <span className="ficha-etiqueta">{c.comprasNoTotal} compra{c.comprasNoTotal === 1 ? '' : 's'} no total</span>
            {c.ultimaCompra && <span className="ficha-etiqueta">Última compra {dataDoBanco(c.ultimaCompra)}</span>}
            {c.pontos > 0 && <span className="ficha-etiqueta">{c.pontos} pontos</span>}
            {c.saldoFiado > 0 && <span className="ficha-etiqueta ficha-etiqueta-alerta">Deve {moeda(c.saldoFiado)} no fiado</span>}
            {!c.ativo && <span className="ficha-etiqueta ficha-etiqueta-alerta">Cadastro desativado</span>}
          </div>
        )}

        <div className="period-selector ficha-periodo nao-imprimir">
          {PERIODOS.map((p) => (
            <button key={p.chave} type="button"
              className={periodo === p.chave ? 'category-btn category-btn-active' : 'category-btn'}
              onClick={() => escolherPeriodo(p.chave)}>
              {p.rotulo}
            </button>
          ))}
          {periodo === 'personalizado' && (
            <>
              <input type="date" aria-label="De" value={datas.dataInicio} onChange={(e) => setDatas((d) => ({ ...d, dataInicio: e.target.value }))} />
              <span>até</span>
              <input type="date" aria-label="Até" value={datas.dataFim} onChange={(e) => setDatas((d) => ({ ...d, dataFim: e.target.value }))} />
            </>
          )}
        </div>
        <p className="screen-hint ficha-periodo-texto">
          {ficha?.periodo
            ? `De ${dataCalendario(ficha.periodo.dataInicio)} a ${dataCalendario(ficha.periodo.dataFim)}`
            : 'Todo o histórico'}
          {carregando && ' · carregando...'}
        </p>

        {erro && <p className="modal-error">{erro}</p>}

        {resumo && (
          <div className="ficha-resumo">
            <div className="ficha-numero"><span>Compras</span><strong>{resumo.compras}</strong></div>
            <div className="ficha-numero">
              <span>Total gasto</span><strong>{moeda(resumo.liquido)}</strong>
              {resumo.totalDevolvido > 0 && <small>{moeda(resumo.totalGasto)} − {moeda(resumo.totalDevolvido)} devolvido</small>}
            </div>
            <div className="ficha-numero"><span>Ticket médio</span><strong>{moeda(resumo.ticketMedio)}</strong></div>
            <div className="ficha-numero"><span>Itens</span><strong>{quantidade(resumo.itens)}</strong></div>
          </div>
        )}

        {resumo?.maisComprados?.length > 0 && (
          <div className="ficha-secao">
            <h3>Mais comprados</h3>
            <div className="ficha-etiquetas">
              {resumo.maisComprados.map((p) => (
                <span key={p.nome} className="ficha-etiqueta">{p.nome} · {quantidade(p.quantidade, p.unidade)}</span>
              ))}
            </div>
          </div>
        )}

        {antes.map(secao)}
        {ficha && <SecaoCompras ficha={ficha} />}
        {depois.map(secao)}
      </div>

      {editando === 'receitas' && c && (
        <EyewearModal customer={{ id: c.id, nome: c.nome }} onFechar={() => { setEditando(null); carregar(); }} />
      )}
      {editando === 'pets' && c && (
        <PetsModal customer={{ id: c.id, nome: c.nome }} onFechar={() => { setEditando(null); carregar(); }} />
      )}
    </div>
  ), document.body);
}

function Secao({ icone, titulo, acao, children }) {
  return (
    <section className="ficha-secao">
      <div className="ficha-secao-topo">
        <h3>{icone && <Icon name={icone} size={16} />} {titulo}</h3>
        {acao}
      </div>
      {children}
    </section>
  );
}

function BotaoEditar({ rotulo, aoClicar }) {
  return (
    <button type="button" className="btn-link nao-imprimir" onClick={aoClicar}>
      <span className="ficha-btn"><Icon name="edit" size={14} /> {rotulo}</span>
    </button>
  );
}

const vazio = (texto) => <p className="screen-hint">{texto}</p>;

// ---------------------------------------------------------------- ótica
function SecaoReceitas({ ficha, aoEditar }) {
  const receitas = ficha.receitas || [];
  return (
    <Secao icone="glasses" titulo="Receitas" acao={<BotaoEditar rotulo={receitas.length ? 'Editar receitas' : 'Cadastrar receita'} aoClicar={aoEditar} />}>
      {receitas.length === 0 ? vazio('Nenhuma receita cadastrada.') : (
        <table className="data-table ficha-receitas">
          <thead>
            <tr><th>Data</th><th>Olho</th><th>Esférico</th><th>Cilíndrico</th><th>Eixo</th><th>Adição</th><th>DP</th><th>Lente</th></tr>
          </thead>
          <tbody>
            {receitas.map((r) => (
              [['OD', r.od], ['OE', r.oe]].map(([olho, o], idx) => (
                <tr key={`${r.id}-${olho}`} className={idx === 0 ? 'ficha-receita-inicio' : ''}>
                  {idx === 0 && <td rowSpan={2}><strong>{r.dataReceita ? dataCalendario(r.dataReceita) : 'Sem data'}</strong></td>}
                  <td>{olho}</td>
                  <td>{dioptria(o.esferico)}</td>
                  <td>{dioptria(o.cilindrico)}</td>
                  <td>{eixo(o.eixo)}</td>
                  <td>{o.adicao == null ? '—' : dioptria(o.adicao)}</td>
                  {idx === 0 && <td rowSpan={2}>{r.distanciaPupilar == null ? '—' : `${String(r.distanciaPupilar).replace('.', ',')} mm`}</td>}
                  {idx === 0 && <td rowSpan={2}>{r.tipoLente || '—'}{r.observacoes && <div className="screen-hint">{r.observacoes}</div>}</td>}
                </tr>
              ))
            ))}
          </tbody>
        </table>
      )}
    </Secao>
  );
}

// ---------------------------------------------------------------- petshop
function SituacaoPet({ rotulo, ultima, proxima, situacao }) {
  if (!ultima && !proxima) return <div className="screen-hint">{rotulo}: sem registro</div>;
  return (
    <div className={`ficha-pet-data${situacao ? ` ficha-pet-${situacao}` : ''}`}>
      {rotulo}: {ultima ? `última ${dataCalendario(ultima)}` : 'sem a última'}
      {proxima && <> · próxima <strong>{dataCalendario(proxima)}</strong>{situacao && situacao !== 'em_dia' && ` (${SITUACAO_PET[situacao]})`}</>}
    </div>
  );
}

function SecaoPets({ ficha, aoEditar }) {
  const pets = ficha.pets || [];
  return (
    <Secao icone="paw" titulo="Animais" acao={<BotaoEditar rotulo={pets.length ? 'Editar animais' : 'Cadastrar animal'} aoClicar={aoEditar} />}>
      {pets.length === 0 ? vazio('Nenhum animal cadastrado.') : (
        <div className="ficha-cartoes">
          {pets.map((p) => (
            <div key={p.id} className="ficha-cartao">
              <strong>{p.nome}</strong>
              <span className="screen-hint">{[p.especie, p.raca].filter(Boolean).join(' · ') || 'Espécie não informada'}</span>
              <SituacaoPet rotulo="Vacina" ultima={p.ultimaVacina} proxima={p.proximaVacina} situacao={p.situacaoVacina} />
              <SituacaoPet rotulo="Vermífugo" ultima={p.ultimoVermifugo} proxima={p.proximoVermifugo} situacao={p.situacaoVermifugo} />
              {p.observacoes && <span className="screen-hint">{p.observacoes}</span>}
            </div>
          ))}
        </div>
      )}
    </Secao>
  );
}

// ---------------------------------------------------------------- salão
function LinhaAgenda({ a }) {
  return (
    <tr className={a.status === 'faltou' || a.status === 'cancelado' ? 'ficha-linha-apagada' : ''}>
      <td>{dataHoraLocal(a.inicio)}</td>
      <td><strong>{a.servico}</strong>{a.observacoes && <div className="screen-hint">{a.observacoes}</div>}</td>
      <td>{a.profissional || '—'}</td>
      <td>{a.duracaoMinutos} min</td>
      <td><span className={`ficha-status ficha-status-${a.status}`}>{STATUS_AGENDA[a.status] || a.status}</span></td>
    </tr>
  );
}

function SecaoAgenda({ ficha, periodoAtivo }) {
  const { proximos = [], historico = [], concluidos = 0, faltas = 0, cancelados = 0 } = ficha.agenda || {};
  return (
    <Secao icone="calendar" titulo="Agenda">
      {proximos.length === 0 && historico.length === 0 && vazio('Nenhum horário marcado.')}
      {proximos.length > 0 && (
        <>
          <span className="ficha-subtitulo">Próximos horários</span>
          <table className="data-table ficha-tabela"><tbody>{proximos.map((a) => <LinhaAgenda key={a.id} a={a} />)}</tbody></table>
        </>
      )}
      {historico.length > 0 && (
        <>
          <span className="ficha-subtitulo">
            Atendimentos {periodoAtivo ? 'no período' : 'anteriores'}: {concluidos} concluído{concluidos === 1 ? '' : 's'}
            {faltas > 0 && ` · ${faltas} falta${faltas === 1 ? '' : 's'}`}
            {cancelados > 0 && ` · ${cancelados} cancelado${cancelados === 1 ? '' : 's'}`}
          </span>
          <table className="data-table ficha-tabela"><tbody>{historico.map((a) => <LinhaAgenda key={a.id} a={a} />)}</tbody></table>
        </>
      )}
    </Secao>
  );
}

// ---------------------------------------------------------------- restaurante / padaria
function SecaoReservas({ ficha, periodoAtivo }) {
  const reservas = ficha.reservas || [];
  return (
    <Secao icone="calendar" titulo="Reservas">
      {reservas.length === 0
        ? vazio(ficha.cliente?.telefone
          ? `Nenhuma reserva com o telefone dela${periodoAtivo ? ' no período' : ''}.`
          : 'Cadastre o telefone do cliente para ver as reservas dele.')
        : (
          <table className="data-table ficha-tabela">
            <tbody>
              {reservas.map((r) => (
                <tr key={r.id}>
                  <td>{dataHoraLocal(r.dataHora)}</td>
                  <td>{r.pessoas} pessoa{r.pessoas === 1 ? '' : 's'}</td>
                  <td><span className={`ficha-status ficha-status-${r.status}`}>{STATUS_RESERVA[r.status] || r.status}</span></td>
                  <td className="screen-hint">{r.observacoes || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Secao>
  );
}

// ---------------------------------------------------------------- orçamentos (material de construção e outros)
function SecaoOrcamentos({ ficha, periodoAtivo }) {
  const orcamentos = ficha.orcamentos || [];
  return (
    <Secao icone="document" titulo="Orçamentos">
      {orcamentos.length === 0 ? vazio(`Nenhum orçamento${periodoAtivo ? ' no período' : ''}.`) : (
        <table className="data-table ficha-tabela">
          <tbody>
            {orcamentos.map((o) => (
              <tr key={o.id}>
                <td>{dataDoBanco(o.criadoEm)}</td>
                <td>{o.itens} ite{o.itens === 1 ? 'm' : 'ns'}</td>
                <td className="num">{moeda(o.total)}</td>
                <td>
                  <span className={`ficha-status ficha-status-orc-${o.vencido ? 'vencido' : o.status}`}>
                    {o.vencido ? 'Vencido' : STATUS_ORCAMENTO[o.status] || o.status}
                  </span>
                  {o.validadeAte && o.status === 'aberto' && <span className="screen-hint"> · vale até {dataCalendario(o.validadeAte)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Secao>
  );
}

// ---------------------------------------------------------------- loja de roupas / petshop
function SecaoPreferencias({ ficha }) {
  const preferencias = ficha.preferencias || [];
  return (
    <Secao icone="tag" titulo="Costuma levar">
      {preferencias.length === 0 ? vazio('Ainda sem compras com tamanho ou cor cadastrados no produto.') : (
        <div className="ficha-preferencias">
          {preferencias.map((p) => (
            <div key={p.campo}>
              <span className="ficha-subtitulo">{p.label}</span>
              <div className="ficha-etiquetas">
                {p.valores.map((v) => (
                  <span key={v.valor} className="ficha-etiqueta ficha-etiqueta-forte">{v.valor} <small>× {v.vezes}</small></span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Secao>
  );
}

// ---------------------------------------------------------------- entregas
function SecaoEntregas({ ficha }) {
  const { lista = [], enderecos = [] } = ficha.entregas || {};
  return (
    <Secao icone="truck" titulo="Entregas">
      {enderecos.length > 0 && (
        <div className="ficha-etiquetas">
          {enderecos.map((e) => <span key={e} className="ficha-etiqueta"><Icon name="map" size={12} /> {e}</span>)}
        </div>
      )}
      <table className="data-table ficha-tabela">
        <tbody>
          {lista.map((d) => (
            <tr key={d.id}>
              <td>{dataHora(d.criadoEm)}</td>
              <td>{d.endereco || '—'}</td>
              <td className="num">{d.taxa > 0 ? `taxa ${moeda(d.taxa)}` : ''}</td>
              <td><span className={`ficha-status ficha-status-${d.status}`}>{STATUS_ENTREGA[d.status] || d.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Secao>
  );
}

// ---------------------------------------------------------------- fiado
function SecaoFiado({ ficha, periodoAtivo }) {
  const movimentos = ficha.fiado || [];
  const saldo = ficha.cliente?.saldoFiado || 0;
  return (
    <Secao icone="money" titulo="Fiado">
      <p className={saldo > 0 ? 'ficha-fiado-saldo ficha-fiado-devendo' : 'ficha-fiado-saldo'}>
        Saldo hoje: <strong>{saldo > 0 ? `deve ${moeda(saldo)}` : 'nada a pagar'}</strong>
      </p>
      {movimentos.length === 0 ? vazio(`Nenhum movimento de fiado${periodoAtivo ? ' no período' : ''}.`) : (
        <table className="data-table ficha-tabela">
          <tbody>
            {movimentos.map((m) => (
              <tr key={m.id}>
                <td>{dataHora(m.criadoEm)}</td>
                <td>{m.tipo === 'divida' ? (m.saleId ? 'Compra no fiado' : (m.motivo || 'Dívida lançada')) : 'Pagamento'}</td>
                <td className={`num ${m.tipo === 'divida' ? 'text-danger' : 'ficha-pago'}`}>{m.tipo === 'divida' ? '+' : '−'} {moeda(m.valor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Secao>
  );
}

// ---------------------------------------------------------------- compras (todos)
function SecaoCompras({ ficha }) {
  const ehOtica = ficha.perfil?.id === 'otica';
  return (
    <Secao icone="receipt" titulo="Compras">
      {ficha.vendas.length === 0 && <p className="empty-state">Nenhuma compra {ficha.periodo ? 'nesse período' : 'registrada para este cliente'}.</p>}
      {ficha.truncado && (
        <p className="screen-hint">Mostrando as {ficha.limite} compras mais recentes. Escolha um período para ver as mais antigas.</p>
      )}
      {ficha.vendas.map((v) => {
        // Receita só nas compras com produto de especificação (lente, armação...), não em acessório.
        const temEspecificacao = v.itens.some((i) => i.especificacoes.length > 0);
        const receita = ehOtica && temEspecificacao ? receitaDaCompra(ficha.receitas, v.finalizadaEm) : null;
        return (
          <article key={v.id} className="ficha-compra">
            <header className="ficha-compra-topo">
              <div>
                <strong>{dataHora(v.finalizadaEm)}</strong>
                <span className="screen-hint">
                  {[v.mesa, v.operador && `por ${v.operador}`, v.pagamentos.map((p) => p.rotulo).join(' + '),
                    v.anexos > 0 && `${v.anexos} anexo${v.anexos === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="ficha-compra-total">
                <strong>{moeda(v.total)}</strong>
                {v.desconto > 0 && <span className="screen-hint">desconto {moeda(v.desconto)}</span>}
                {v.valorDevolvido > 0 && <span className="ficha-devolvido">devolvido {moeda(v.valorDevolvido)}</span>}
              </div>
            </header>
            {receita && (
              <p className="screen-hint ficha-receita-da-compra">
                Receita de {dataCalendario(receita.dataReceita)}: OD {dioptria(receita.od.esferico)} {dioptria(receita.od.cilindrico)} {eixo(receita.od.eixo)}
                {' · '}OE {dioptria(receita.oe.esferico)} {dioptria(receita.oe.cilindrico)} {eixo(receita.oe.eixo)}
              </p>
            )}
            <table className="ficha-itens">
              <thead>
                <tr><th>Produto</th><th>Especificações</th><th className="num">Qtd.</th><th className="num">Unitário</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {v.itens.map((i) => <LinhaItem key={i.id} i={i} />)}
              </tbody>
            </table>
          </article>
        );
      })}
    </Secao>
  );
}

function LinhaItem({ i }) {
  // Sim/não marcado vira selo (farmácia: controlado, exige receita; armazém: perecível...).
  const selos = i.especificacoes.filter((e) => e.tipo === 'boolean' && e.valor);
  const campos = i.especificacoes.filter((e) => !(e.tipo === 'boolean' && e.valor) && !(e.campo === 'garantia_meses' && i.garantiaAte));
  const nada = campos.length === 0 && selos.length === 0 && !i.observacao && !i.garantiaAte;
  return (
    <tr>
      <td>
        <strong>{i.nome}</strong>
        {i.servico && <span className="ficha-selo ficha-selo-servico">serviço</span>}
        {(i.categoria || i.codigo) && <div className="screen-hint">{[i.categoria, i.codigo].filter(Boolean).join(' · ')}</div>}
        {i.pessoa && <div className="screen-hint">para {i.pessoa}</div>}
      </td>
      <td>
        {nada && <span className="screen-hint">—</span>}
        {selos.length > 0 && (
          <div className="ficha-selos">{selos.map((e) => <span key={e.campo} className="ficha-selo">{e.label}</span>)}</div>
        )}
        {campos.length > 0 && (
          <dl className="ficha-especificacoes">
            {campos.map((e) => (
              <div key={e.campo}><dt>{e.label}</dt><dd>{valorDaEspecificacao(e)}</dd></div>
            ))}
          </dl>
        )}
        {i.garantiaAte && (
          <div className={`ficha-garantia ${i.garantiaVigente ? 'ficha-garantia-ok' : 'ficha-garantia-vencida'}`}>
            {i.garantiaVigente ? 'Garantia até' : 'Garantia vencida em'} {dataCalendario(i.garantiaAte)}
          </div>
        )}
        {i.especificacoesDoCadastroAtual && (
          <div className="screen-hint" title="Venda de antes desta versão: o sistema ainda não guardava a especificação no dia da venda.">
            (cadastro atual do produto)
          </div>
        )}
        {i.observacao && <div className="ficha-observacao">Obs.: {i.observacao}</div>}
      </td>
      <td className="num">
        {quantidade(i.quantidade, i.unidade)}
        {i.quantidadeDevolvida > 0 && <div className="ficha-devolvido">{quantidade(i.quantidadeDevolvida, i.unidade)} devolvido</div>}
      </td>
      <td className="num">{moeda(i.precoUnitario)}</td>
      <td className="num">{moeda(i.total)}</td>
    </tr>
  );
}
