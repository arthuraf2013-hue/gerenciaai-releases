import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import { ProductPicker } from './SupplyScreen';
import { DropdownMenu, DropdownMenuItem } from '../common/DropdownMenu';
import Icon from '../common/Icon';
import { brl, brlCusto, qtd, dataBR, ChipStatus } from './erpUtils';

const FILTROS = [
  ['abertos', 'Em aberto'], ['', 'Todos'], ['rascunho', 'Rascunho'], ['enviado', 'Enviados'],
  ['parcial', 'Recebidos em parte'], ['recebido', 'Recebidos'], ['cancelado', 'Cancelados'],
];

/** Pedido de compra (ERP, Fase 1): lista, edição do rascunho, envio ao
 * fornecedor e recebimento sem nota. O recebimento com nota é pela tela
 * de Notas de compra (XML), vinculando a nota ao pedido. */
export function PurchaseOrdersScreen() {
  const { currentUser } = useSession();
  const [filtro, setFiltro] = useState('abertos');
  const [pedidos, setPedidos] = useState(null);
  const [editando, setEditando] = useState(null); // null | 'novo' | id
  const [abertoId, setAbertoId] = useState(null);
  const [mensagem, setMensagem] = useState('');
  const [erro, setErro] = useState('');

  async function carregar() {
    const lista = await window.pdv.purchaseOrders.list({ status: filtro && filtro !== 'abertos' ? filtro : undefined });
    const arr = Array.isArray(lista) ? lista : [];
    setPedidos(filtro === 'abertos' ? arr.filter((p) => ['rascunho', 'enviado', 'parcial'].includes(p.status)) : arr);
  }
  useEffect(() => { carregar(); }, [filtro]);

  async function handleDaSugestao() {
    setErro(''); setMensagem('');
    const r = await window.pdv.purchaseOrders.criarDaSugestao({ locationId: window.APP_LOCATION_ID, operadorId: currentUser.id });
    if (!r?.ok) return setErro(r?.error || 'Não foi possível gerar os pedidos.');
    if (r.totalSugestoes === 0) return setMensagem('Nenhum produto precisa de reposição agora.');
    setMensagem(`${r.criados.length} pedido(s) em rascunho criado(s).${r.semFornecedor ? ` ${r.semFornecedor} produto(s) sem fornecedor no cadastro ficaram de fora.` : ''}`);
    setFiltro('abertos');
    carregar();
  }

  if (editando) {
    return <PedidoEditor id={editando === 'novo' ? null : editando} onFechar={(salvo) => { setEditando(null); if (salvo) carregar(); }} />;
  }
  if (abertoId) {
    return <PedidoDetalhe id={abertoId} onVoltar={() => { setAbertoId(null); carregar(); }} onEditar={(id) => { setAbertoId(null); setEditando(id); }} />;
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}><Icon name="clipboard" size={20} /> Pedidos de compra</h1>
        <div className="screen-actions">
          <button className="btn-secondary" onClick={handleDaSugestao}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="sparkle" size={15} /> Gerar da sugestão de compra</span>
          </button>
          <button className="btn-primary" onClick={() => setEditando('novo')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={15} /> Novo pedido</span>
          </button>
        </div>
      </div>
      <p className="screen-hint">
        A sugestão separa um pedido por fornecedor com o que vai faltar antes da próxima entrega. Quando a
        mercadoria chegar, vincule a nota (XML) ao pedido ou registre o recebimento sem nota.
      </p>
      {erro && <p className="modal-error" style={{ marginBottom: 12 }}>{erro}</p>}
      {mensagem && <p className="io-message" style={{ marginBottom: 12 }}>{mensagem}</p>}

      <div className="period-selector">
        {FILTROS.map(([v, rotulo]) => (
          <button key={v || 'todos'} className={filtro === v ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setFiltro(v)}>{rotulo}</button>
        ))}
      </div>

      {pedidos === null ? (
        <p className="empty-state">Carregando...</p>
      ) : pedidos.length === 0 ? (
        <p className="empty-state">Nenhum pedido {filtro === 'abertos' ? 'em aberto' : 'neste filtro'}.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Nº</th><th>Fornecedor</th><th>Criado em</th><th>Previsão</th><th>Itens</th><th style={{ textAlign: 'right' }}>Total</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {pedidos.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.numero}</strong></td>
                <td>{p.fornecedor_nome}</td>
                <td>{new Date(`${p.criado_em.replace(' ', 'T')}Z`).toLocaleDateString('pt-BR')}</td>
                <td>{dataBR(p.previsao_entrega)}</td>
                <td>{p.qtd_itens}</td>
                <td style={{ textAlign: 'right' }}>{brl(p.total)}</td>
                <td><ChipStatus status={p.status} rascunhoPedido /></td>
                <td><button className="btn-link" onClick={() => setAbertoId(p.id)}>Abrir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PedidoEditor({ id, onFechar }) {
  const { currentUser } = useSession();
  const [fornecedores, setFornecedores] = useState([]);
  const [fornecedorId, setFornecedorId] = useState('');
  const [previsao, setPrevisao] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [linhas, setLinhas] = useState([]);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    window.pdv.suppliers.list({}).then((l) => setFornecedores(Array.isArray(l) ? l : []));
    if (id) {
      window.pdv.purchaseOrders.get({ id }).then((p) => {
        if (!p || p.ok === false) return;
        setFornecedorId(p.fornecedor_id); setPrevisao(p.previsao_entrega || ''); setObservacoes(p.observacoes || '');
        setLinhas(p.itens.map((i) => ({ key: i.id, produto: { id: i.product_id, nome: i.produto_nome }, quantidade: i.quantidade, custoUnitario: i.custo_unitario })));
      });
    } else {
      setLinhas([{ key: 'l0', produto: null, quantidade: 1, custoUnitario: 0 }]);
    }
  }, [id]);

  const atualizar = (key, m) => setLinhas((ls) => ls.map((l) => (l.key === key ? { ...l, ...m } : l)));
  const total = linhas.reduce((s, l) => s + Number(l.quantidade || 0) * Number(l.custoUnitario || 0), 0);

  async function handleSalvar() {
    setErro('');
    setSalvando(true);
    const r = await window.pdv.purchaseOrders.save({
      id, fornecedorId, previsaoEntrega: previsao || null, observacoes,
      itens: linhas.filter((l) => l.produto).map((l) => ({ productId: l.produto.id, quantidade: Number(l.quantidade), custoUnitario: Number(l.custoUnitario) })),
      locationId: window.APP_LOCATION_ID, operadorId: currentUser.id,
    });
    setSalvando(false);
    if (!r?.ok) return setErro(r?.error || 'Não foi possível salvar.');
    onFechar(true);
  }

  return (
    <div className="screen">
      <button className="btn-link" onClick={() => onFechar(false)} style={{ marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="arrowLeft" size={14} /> Pedidos de compra</span>
      </button>
      <h1 style={{ marginTop: 0 }}>{id ? 'Editar pedido' : 'Novo pedido de compra'}</h1>
      <div className="form-grid-3" style={{ maxWidth: 820, marginBottom: 16 }}>
        <label>
          Fornecedor
          <select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
            <option value="">Escolha...</option>
            {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
        </label>
        <label>
          Entrega desejada até
          <input type="date" value={previsao} onChange={(e) => setPrevisao(e.target.value)} />
        </label>
        <label>
          Observações
          <input value={observacoes} onChange={(e) => setObservacoes(e.target.value)} placeholder="Opcional" />
        </label>
      </div>

      <table className="data-table">
        <thead><tr><th>Produto</th><th>Quantidade</th><th>Custo unit. combinado</th><th style={{ textAlign: 'right' }}>Subtotal</th><th></th></tr></thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.key} className={!l.produto ? 'row-critical' : ''}>
              <td><ProductPicker value={l.produto} onChange={(p) => atualizar(l.key, { produto: p, ...(p && !l.custoUnitario ? { custoUnitario: p.custo || 0 } : {}) })} width={260} /></td>
              <td><input type="number" min="0" step="any" style={{ width: 90 }} value={l.quantidade} onChange={(e) => atualizar(l.key, { quantidade: e.target.value })} /></td>
              <td><input type="number" min="0" step="0.01" style={{ width: 110 }} value={l.custoUnitario} onChange={(e) => atualizar(l.key, { custoUnitario: e.target.value })} /></td>
              <td style={{ textAlign: 'right' }}>{brl(Number(l.quantidade || 0) * Number(l.custoUnitario || 0))}</td>
              <td><button className="btn-link-danger" onClick={() => setLinhas((ls) => ls.filter((x) => x.key !== l.key))}><Icon name="trash" size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <button className="btn-link" onClick={() => setLinhas((ls) => [...ls, { key: `l${Date.now()}`, produto: null, quantidade: 1, custoUnitario: 0 }])}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="add" size={14} /> Adicionar produto</span>
        </button>
        <strong>Total {brl(total)}</strong>
      </div>
      {erro && <p className="modal-error" style={{ marginTop: 12 }}>{erro}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn-primary" onClick={handleSalvar} disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar rascunho'}</button>
        <button className="btn-secondary" onClick={() => onFechar(false)}>Cancelar</button>
      </div>
    </div>
  );
}

function PedidoDetalhe({ id, onVoltar, onEditar }) {
  const { currentUser } = useSession();
  const [pedido, setPedido] = useState(null);
  const [erro, setErro] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [recebendo, setRecebendo] = useState(null); // { [itemId]: { quantidade, lote, validade } }
  useEscToClose(() => setRecebendo(null), !!recebendo);

  async function carregar() {
    const p = await window.pdv.purchaseOrders.get({ id });
    if (!p || p.ok === false) return setErro(p?.error || 'Pedido não encontrado.');
    setPedido(p);
  }
  useEffect(() => { carregar(); }, [id]);
  if (!pedido) return <div className="screen">{erro ? <p className="modal-error">{erro}</p> : <p className="empty-state">Carregando...</p>}</div>;

  const aberto = ['rascunho', 'enviado', 'parcial'].includes(pedido.status);
  const acao = async (fn, ok) => {
    setErro(''); setMensagem('');
    const r = await fn();
    if (!r?.ok) return setErro(r?.error || 'Não foi possível concluir.');
    if (ok) setMensagem(ok);
    carregar();
  };

  async function copiarTexto() {
    const r = await window.pdv.purchaseOrders.texto({ id });
    if (!r?.ok) return setErro(r?.error);
    await navigator.clipboard.writeText(r.texto);
    setMensagem('Pedido copiado — cole no e-mail ou na conversa com o fornecedor.');
  }

  function abrirRecebimento() {
    setRecebendo(Object.fromEntries(pedido.itens.map((i) => [i.id, { quantidade: Math.max(0, i.quantidade - i.quantidade_recebida), lote: '', validade: '' }])));
  }

  async function confirmarRecebimento() {
    const itens = Object.entries(recebendo).map(([itemId, v]) => ({ itemId, quantidade: Number(v.quantidade), lote: v.lote, validade: v.validade }));
    const r = await window.pdv.purchaseOrders.receberSemNota({ orderId: id, itens, locationId: window.APP_LOCATION_ID, operadorId: currentUser.id, deviceId: window.APP_DEVICE_ID });
    if (!r?.ok) return setErro(r?.error || 'Não foi possível registrar o recebimento.');
    setRecebendo(null);
    setMensagem('Recebimento registrado: estoque e custo médio atualizados.');
    carregar();
  }

  return (
    <div className="screen">
      <button className="btn-link" onClick={onVoltar} style={{ marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="arrowLeft" size={14} /> Pedidos de compra</span>
      </button>
      <div className="screen-header">
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          Pedido nº {pedido.numero} — {pedido.fornecedor_nome} <ChipStatus status={pedido.status} rascunhoPedido />
        </h1>
        <div className="screen-actions">
          {pedido.status === 'rascunho' && <button className="btn-secondary" onClick={() => onEditar(id)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="edit" size={15} /> Editar</span></button>}
          {aberto && (
            <DropdownMenu label="Enviar ao fornecedor">
              <DropdownMenuItem onClick={() => acao(() => window.pdv.purchaseOrders.enviarWhatsapp({ id }), 'WhatsApp aberto com o pedido.')}>Abrir no WhatsApp</DropdownMenuItem>
              <DropdownMenuItem onClick={copiarTexto}>Copiar texto do pedido</DropdownMenuItem>
              {pedido.status === 'rascunho' && <DropdownMenuItem onClick={() => acao(() => window.pdv.purchaseOrders.marcarEnviado({ id }), 'Pedido marcado como enviado.')}>Marcar como enviado</DropdownMenuItem>}
            </DropdownMenu>
          )}
          {aberto && <button className="btn-primary" onClick={abrirRecebimento}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="box" size={15} /> Receber sem nota</span></button>}
        </div>
      </div>
      <p className="screen-hint">
        Criado em {new Date(`${pedido.criado_em.replace(' ', 'T')}Z`).toLocaleDateString('pt-BR')}
        {pedido.previsao_entrega ? ` · entrega até ${dataBR(pedido.previsao_entrega)}` : ''}
        {pedido.observacoes ? ` · ${pedido.observacoes}` : ''}
      </p>
      {erro && <p className="modal-error" style={{ marginBottom: 12 }}>{erro}</p>}
      {mensagem && <p className="io-message" style={{ marginBottom: 12 }}>{mensagem}</p>}

      <table className="data-table">
        <thead><tr><th>Produto</th><th>Pedido</th><th>Recebido</th><th style={{ textAlign: 'right' }}>Custo unit.</th><th style={{ textAlign: 'right' }}>Subtotal</th></tr></thead>
        <tbody>
          {pedido.itens.map((i) => (
            <tr key={i.id}>
              <td>{i.produto_nome}</td>
              <td>{qtd(i.quantidade)} {i.unidade}</td>
              <td>
                {qtd(i.quantidade_recebida)} {i.unidade}
                {i.quantidade_recebida > 0 && i.quantidade_recebida < i.quantidade && <span className="badge-warning" style={{ marginLeft: 6, fontSize: 12 }}>falta {qtd(i.quantidade - i.quantidade_recebida)}</span>}
              </td>
              <td style={{ textAlign: 'right' }}>{brlCusto(i.custo_unitario)}</td>
              <td style={{ textAlign: 'right' }}>{brl(i.quantidade * i.custo_unitario)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ textAlign: 'right', marginTop: 8 }}><strong>Total {brl(pedido.total)}</strong></p>
      {aberto && (
        <button className="btn-link-danger" onClick={() => confirm(`Cancelar o pedido nº ${pedido.numero}?`) && acao(() => window.pdv.purchaseOrders.cancelar({ id }), 'Pedido cancelado.')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="close" size={14} /> Cancelar pedido</span>
        </button>
      )}

      {recebendo && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-wide">
            <h2 style={{ marginTop: 0 }}>Receber sem nota — pedido nº {pedido.numero}</h2>
            <p className="modal-subtitle">Entra no estoque com o custo do pedido. Se a nota chegar depois, não importe o XML desta mesma mercadoria de novo.</p>
            <table className="data-table">
              <thead><tr><th>Produto</th><th>Chegou</th><th>Lote</th><th>Validade</th></tr></thead>
              <tbody>
                {pedido.itens.map((i) => (
                  <tr key={i.id}>
                    <td>{i.produto_nome}</td>
                    <td><input type="number" min="0" step="any" style={{ width: 80 }} value={recebendo[i.id].quantidade}
                      onChange={(e) => setRecebendo((r) => ({ ...r, [i.id]: { ...r[i.id], quantidade: e.target.value } }))} /></td>
                    <td><input style={{ width: 90 }} value={recebendo[i.id].lote} onChange={(e) => setRecebendo((r) => ({ ...r, [i.id]: { ...r[i.id], lote: e.target.value } }))} /></td>
                    <td><input type="date" value={recebendo[i.id].validade} onChange={(e) => setRecebendo((r) => ({ ...r, [i.id]: { ...r[i.id], validade: e.target.value } }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn-secondary" onClick={() => setRecebendo(null)}>Voltar</button>
              <button className="btn-primary" onClick={confirmarRecebimento}>Confirmar recebimento</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
