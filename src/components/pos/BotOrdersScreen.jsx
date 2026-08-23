import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import Icon from '../common/Icon';

const STATUS_LABEL = { novo: 'Novo', em_separacao: 'Em separação', pronto: 'Pronto', concluido: 'Concluído', cancelado: 'Cancelado' };
const STATUS_CLASSE = { novo: 'row-warning', em_separacao: '', pronto: '', concluido: '', cancelado: 'row-critical' };
const STATUS_ITEM_LABEL = { pendente: 'Pendente', separado: 'Separado', indisponivel: 'Indisponível', substituido: 'Substituído' };

function formatarPreco(valor) {
  return `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;
}

// ---------- Busca de produto pra adicionar a um pedido novo ----------
function BuscaProdutoParaPedido({ onEscolher }) {
  const [termo, setTermo] = useState('');
  const termoDebounced = useDebouncedValue(termo, 250);
  const [resultados, setResultados] = useState([]);

  useEffect(() => {
    if (!termoDebounced.trim()) { setResultados([]); return; }
    window.pdv.products.list({ query: termoDebounced, limit: 8 }).then((r) => setResultados(Array.isArray(r) ? r : []));
  }, [termoDebounced]);

  return (
    <div className="customer-link-box">
      <input placeholder="Buscar produto pra adicionar..." value={termo} onChange={(e) => setTermo(e.target.value)} />
      {resultados.length > 0 && (
        <ul className="customer-suggestions">
          {resultados.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onEscolher(p); setTermo(''); setResultados([]); }}>
                {p.nome}{p.sku ? ` (${p.sku})` : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Modal: novo pedido (digitado manualmente) ----------
function NovoPedidoModal({ onClose, onCriado }) {
  useEscToClose(onClose);
  const { currentUser } = useSession();
  const [clienteNome, setClienteNome] = useState('');
  const [clienteTelefone, setClienteTelefone] = useState('');
  const [tipoEntrega, setTipoEntrega] = useState('retirada');
  const [endereco, setEndereco] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [itens, setItens] = useState([]);
  const [descricaoLivre, setDescricaoLivre] = useState('');
  const [error, setError] = useState('');
  const [salvando, setSalvando] = useState(false);

  function adicionarProduto(produto) {
    setItens((prev) => [...prev, { key: `p-${produto.id}-${prev.length}`, productId: produto.id, nome: produto.nome, quantidade: 1, precoUnitario: produto.preco }]);
  }
  function adicionarLivre() {
    if (!descricaoLivre.trim()) return;
    setItens((prev) => [...prev, { key: `l-${prev.length}-${descricaoLivre}`, descricaoLivre: descricaoLivre.trim(), nome: descricaoLivre.trim(), quantidade: 1 }]);
    setDescricaoLivre('');
  }
  function removerItem(key) {
    setItens((prev) => prev.filter((i) => i.key !== key));
  }
  function mudarQuantidade(key, quantidade) {
    setItens((prev) => prev.map((i) => (i.key === key ? { ...i, quantidade } : i)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (itens.length === 0) return setError('Adicione pelo menos um item ao pedido.');
    setSalvando(true);
    const resultado = await window.pdv.botOrders.create({
      locationId: window.APP_LOCATION_ID,
      clienteNome, clienteTelefone, tipoEntrega,
      endereco: tipoEntrega === 'entrega' ? endereco : undefined,
      observacoes, origem: 'manual', operadorId: currentUser.id,
      itens: itens.map((i) => ({ productId: i.productId, descricaoLivre: i.descricaoLivre, quantidade: Number(i.quantidade) || 1, precoUnitario: i.precoUnitario })),
    });
    setSalvando(false);
    if (!resultado.ok) { setError(resultado.error); return; }
    onCriado();
    onClose();
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal-card" style={{ width: 'min(460px, 94vw)' }} onSubmit={handleSubmit}>
        <h2><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={18} /> Novo pedido</span></h2>
        <p className="screen-hint" style={{ margin: '0 0 4px' }}>
          Pra digitar um pedido recebido por telefone/WhatsApp manualmente — enquanto o chatbot
          ainda não estiver ativo, é assim que um pedido chega até aqui.
        </p>
        <div className="form-grid">
          <label>Nome do cliente<input value={clienteNome} onChange={(e) => setClienteNome(e.target.value)} required autoFocus /></label>
          <label>Telefone (WhatsApp)<input value={clienteTelefone} onChange={(e) => setClienteTelefone(e.target.value)} required /></label>
        </div>

        <label style={{ flexDirection: 'row', gap: 16 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" name="tipoEntrega" style={{ width: 'auto' }} checked={tipoEntrega === 'retirada'} onChange={() => setTipoEntrega('retirada')} />
            Retirada
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" name="tipoEntrega" style={{ width: 'auto' }} checked={tipoEntrega === 'entrega'} onChange={() => setTipoEntrega('entrega')} />
            Entrega
          </span>
        </label>
        {tipoEntrega === 'entrega' && (
          <label>Endereço<input value={endereco} onChange={(e) => setEndereco(e.target.value)} required /></label>
        )}

        <div>
          <p className="screen-hint" style={{ margin: '0 0 6px' }}>Itens do pedido</p>
          <BuscaProdutoParaPedido onEscolher={adicionarProduto} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input placeholder="Ou descreva o item se não achar o produto..." value={descricaoLivre} onChange={(e) => setDescricaoLivre(e.target.value)} />
            <button type="button" className="btn-secondary" onClick={adicionarLivre}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={15} /> Adicionar</span></button>
          </div>
          {itens.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {itens.map((item) => (
                <li key={item.key} className="customer-chip">
                  <span>{item.nome}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="number" min="1" step="1" value={item.quantidade} onChange={(e) => mudarQuantidade(item.key, e.target.value)} style={{ width: 56 }} />
                    <button type="button" className="btn-link-danger" onClick={() => removerItem(item.key)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="trash" size={15} /> Remover</span></button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label>Observações<input value={observacoes} onChange={(e) => setObservacoes(e.target.value)} /></label>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span></button>
          <button type="submit" className="btn-primary" disabled={salvando}>
            {salvando ? 'Criando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="box" size={15} /> Criar pedido</span>}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- Modal: separar um pedido existente ----------
function SepararPedidoModal({ orderId, onClose, onAtualizado }) {
  useEscToClose(onClose);
  const { currentUser } = useSession();
  const [detalhe, setDetalhe] = useState(null);
  const [erro, setErro] = useState('');
  const [clienteCadastrado, setClienteCadastrado] = useState(null); // null = ainda não checou, true/false = resultado
  const [cadastrando, setCadastrando] = useState(false);

  function carregar() {
    window.pdv.botOrders.getWithItems({ orderId }).then((r) => {
      if (r.ok) setDetalhe(r);
      else setErro(r.error || 'Não consegui carregar o pedido.');
    });
  }
  useEffect(carregar, [orderId]);

  // Só oferece "Cadastrar cliente" se o telefone do pedido ainda não
  // bate com nenhum cliente já cadastrado -- evita duplicar cadastro.
  useEffect(() => {
    if (!detalhe?.pedido?.cliente_telefone) return;
    window.pdv.customers.buscarPorTelefone({ telefone: detalhe.pedido.cliente_telefone }).then((c) => setClienteCadastrado(!!c));
  }, [detalhe?.pedido?.cliente_telefone]);

  async function handleItemStatus(itemId, status) {
    setErro('');
    const resultado = await window.pdv.botOrders.updateItemStatus({ itemId, status });
    if (!resultado?.ok) { setErro(resultado?.error || 'Não consegui atualizar o item.'); return; }
    carregar();
    onAtualizado();
  }

  async function handleStatusPedido(status) {
    setErro('');
    const resultado = await window.pdv.botOrders.updateStatus({ orderId, status, operadorId: currentUser.id });
    if (!resultado?.ok) { setErro(resultado?.error || 'Não consegui atualizar o status do pedido.'); return; }
    onAtualizado();
    if (status === 'concluido' || status === 'cancelado') { onClose(); return; }
    carregar();
  }

  const [lancandoMesa, setLancandoMesa] = useState(false);

  // Pedido de mesa não passa pelo fluxo normal de separação -- entra
  // direto na comanda real da mesa (ver botOrderService.lancarPedidoNaMesa).
  // Nunca chama updateStatus('concluido') pra esse tipo de pedido: isso
  // criaria uma venda avulsa separada em vez de lançar na comanda certa.
  async function handleLancarNaMesa() {
    setErro('');
    setLancandoMesa(true);
    const resultado = await window.pdv.botOrders.lancarNaMesa({
      orderId, operadorId: currentUser.id, deviceId: window.APP_DEVICE_ID,
    });
    setLancandoMesa(false);
    if (!resultado?.ok) { setErro(resultado?.error || 'Não consegui lançar o pedido na mesa.'); return; }
    onAtualizado();
    onClose();
  }

  async function handleCadastrarCliente() {
    setErro('');
    setCadastrando(true);
    const resultado = await window.pdv.customers.upsert({
      nome: detalhe.pedido.cliente_nome,
      telefone: detalhe.pedido.cliente_telefone,
    });
    setCadastrando(false);
    if (!resultado?.ok) { setErro(resultado?.error || 'Não consegui cadastrar o cliente.'); return; }
    setClienteCadastrado(true);
  }

  if (!detalhe) return null;
  const { pedido, itens } = detalhe;
  const todosResolvidos = itens.length > 0 && itens.every((i) => i.status_separacao !== 'pendente');
  const itensPendentes = itens.filter((i) => i.status_separacao === 'pendente').length;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card" style={{ width: 'min(480px, 94vw)' }}>
        <h2>Pedido de {pedido.cliente_nome} · {formatarPreco(pedido.valorTotal)}</h2>
        <p className="screen-hint" style={{ margin: '0 0 4px' }}>
          {pedido.mesa_numero
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={15} /> Mesa {pedido.mesa_numero}</span>
            : pedido.tipo_entrega === 'entrega' ? `Entrega: ${pedido.endereco}` : 'Retirada no local'} · {pedido.cliente_telefone}
          {pedido.observacoes && <> · {pedido.observacoes}</>}
        </p>

        {clienteCadastrado === false && (
          <p className="screen-hint" style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            Esse cliente ainda não está cadastrado.
            <button type="button" className="btn-link" disabled={cadastrando} onClick={handleCadastrarCliente}>
              {cadastrando ? 'Cadastrando...' : '+ Cadastrar cliente'}
            </button>
          </p>
        )}

        {erro && <p className="modal-error">{erro}</p>}

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
          {itens.map((item) => (
            <li key={item.id} className="customer-chip" style={{ alignItems: 'flex-start' }}>
              <div>
                <strong>{item.produtoNome || item.descricao_livre}</strong> × {item.quantidade}
                {item.preco_unitario != null && <> — {formatarPreco(item.preco_unitario * item.quantidade)}</>}
                {item.product_id && (
                  <div className="screen-hint">
                    Estoque atual: {item.estoqueAtual}
                    {Number(item.estoqueAtual) < Number(item.quantidade) && (
                      <span className="badge-warning" style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="warning" size={13} /> insuficiente</span>
                    )}
                  </div>
                )}
                {item.observacao && <div className="screen-hint">Obs: {item.observacao}</div>}
              </div>
              {pedido.mesa_numero ? null : (
                <select value={item.status_separacao} onChange={(e) => handleItemStatus(item.id, e.target.value)}>
                  {Object.entries(STATUS_ITEM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              )}
            </li>
          ))}
        </ul>

        <div className="modal-actions" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn-secondary" onClick={onClose}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Fechar</span></button>
          {pedido.mesa_numero ? (
            <>
              {pedido.status === 'novo' && (
                <>
                  <button className="btn-link-danger" onClick={() => { if (confirm('Cancelar este pedido?')) handleStatusPedido('cancelado'); }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar pedido</span></button>
                  <button className="btn-primary" disabled={lancandoMesa} onClick={handleLancarNaMesa}>
                    {lancandoMesa ? 'Lançando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={15} /> Lançar na Mesa {pedido.mesa_numero}</span>}
                  </button>
                </>
              )}
              {pedido.status === 'concluido' && (
                <span className="screen-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Já lançado na comanda da mesa <Icon name="checkCircle" size={14} /></span>
              )}
            </>
          ) : (
            <>
              {(pedido.status === 'novo' || pedido.status === 'em_separacao') && (
                <button className="btn-link-danger" onClick={() => { if (confirm('Cancelar este pedido?')) handleStatusPedido('cancelado'); }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar pedido</span></button>
              )}
              {pedido.status === 'novo' && (
                <button className="btn-primary" onClick={() => handleStatusPedido('em_separacao')}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="box" size={15} /> Começar separação</span></button>
              )}
              {pedido.status === 'em_separacao' && (
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button
                    className="btn-primary" onClick={() => handleStatusPedido('pronto')} disabled={!todosResolvidos}
                    title={!todosResolvidos ? 'Marque o status de todos os itens antes de avançar' : ''}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> Marcar como pronto</span>
                  </button>
                  {!todosResolvidos && (
                    <span className="screen-hint">
                      Marque o status de cada item na lista acima (Separado / Indisponível / Substituído) — falta {itensPendentes} {itensPendentes === 1 ? 'item' : 'itens'}.
                    </span>
                  )}
                </span>
              )}
              {pedido.status === 'pronto' && (
                <button className="btn-primary" onClick={() => handleStatusPedido('concluido')}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> Concluir ({pedido.tipo_entrega === 'entrega' ? 'saiu pra entrega' : 'retirado pelo cliente'})</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function BotOrdersScreen() {
  const [pedidos, setPedidos] = useState(null);
  const [filtroStatus, setFiltroStatus] = useState('');
  const [showNovo, setShowNovo] = useState(false);
  const [separandoId, setSeparandoId] = useState(null);

  function carregar() {
    window.pdv.botOrders.list({ locationId: window.APP_LOCATION_ID, status: filtroStatus || undefined }).then((list) => setPedidos(Array.isArray(list) ? list : []));
  }
  useEffect(carregar, [filtroStatus]);

  return (
    <div className="screen">
      <h1>Separação</h1>
      <p className="screen-hint" style={{ margin: '-6px 0 14px' }}>
        Pedidos de retirada e entrega — hoje digitados manualmente aqui; quando o chatbot de
        WhatsApp entrar, os pedidos fechados por ele caem direto nessa mesma fila.
      </p>

      <div className="screen-actions" style={{ marginBottom: 12 }}>
        {['', 'novo', 'em_separacao', 'pronto', 'concluido', 'cancelado'].map((s) => (
          <button key={s} className={filtroStatus === s ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setFiltroStatus(s)}>
            {s === '' ? 'Todos' : STATUS_LABEL[s]}
          </button>
        ))}
        <button className="btn-primary" onClick={() => setShowNovo(true)}>+ Novo pedido</button>
      </div>

      {pedidos === null && <p className="empty-state">Carregando...</p>}
      {pedidos !== null && pedidos.length === 0 && <p className="empty-state">Nenhum pedido por aqui.</p>}
      {pedidos && pedidos.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Cliente</th><th>Tipo</th><th>Itens</th><th>Valor</th><th>Origem</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {pedidos.map((p) => (
              <tr key={p.id} className={STATUS_CLASSE[p.status]}>
                <td>{p.cliente_nome}<br /><span className="screen-hint">{p.cliente_telefone}</span></td>
                <td>{p.mesa_numero ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="plate" size={14} /> Mesa {p.mesa_numero}</span> : (p.tipo_entrega === 'entrega' ? 'Entrega' : 'Retirada')}</td>
                <td>{p.itensSeparados || 0}/{p.totalItens}</td>
                <td>{formatarPreco(p.valorTotal)}</td>
                <td>{p.origem === 'whatsapp_bot' ? 'WhatsApp' : 'Manual'}</td>
                <td>{STATUS_LABEL[p.status]}</td>
                <td><button className="btn-link" onClick={() => setSeparandoId(p.id)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="box" size={14} /> Ver / Separar</span></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNovo && <NovoPedidoModal onClose={() => setShowNovo(false)} onCriado={carregar} />}
      {separandoId && <SepararPedidoModal orderId={separandoId} onClose={() => setSeparandoId(null)} onAtualizado={carregar} />}
    </div>
  );
}
