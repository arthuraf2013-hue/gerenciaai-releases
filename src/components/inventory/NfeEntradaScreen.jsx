import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import { ProductPicker } from './SupplyScreen';
import Icon from '../common/Icon';
import { brl, brlCusto, qtd, dataBR, ChipStatus } from './erpUtils';

/**
 * Entrada de mercadoria pelo XML da NF-e de compra (ERP, Fase 1).
 * Lista as notas; ao abrir uma, mostra a conferência (rascunho) ou o
 * resumo do que foi lançado (confirmada/estornada).
 */
export function NfeEntradaScreen() {
  const { currentUser } = useSession();
  const [notas, setNotas] = useState(null);
  const [abertaId, setAbertaId] = useState(null);
  const [avisos, setAvisos] = useState([]);
  const [importando, setImportando] = useState(false);
  const [erro, setErro] = useState('');

  async function carregar() {
    const lista = await window.pdv.nfeEntradas.list({});
    setNotas(Array.isArray(lista) ? lista : []);
  }
  useEffect(() => { carregar(); }, []);

  async function handleImportar() {
    setErro('');
    setImportando(true);
    const r = await window.pdv.nfeEntradas.importarXml({ locationId: window.APP_LOCATION_ID, operadorId: currentUser.id });
    setImportando(false);
    if (r?.canceled) return;
    if (!r?.ok) {
      setErro(r?.error || 'Não foi possível ler o XML.');
      if (r?.jaImportada && r.entradaId) { setAvisos([]); setAbertaId(r.entradaId); }
      return;
    }
    setAvisos(r.avisos || []);
    setAbertaId(r.id);
    carregar();
  }

  if (abertaId) {
    return (
      <NfeConferencia
        id={abertaId}
        avisos={avisos}
        erroInicial={erro}
        onVoltar={() => { setAbertaId(null); setAvisos([]); setErro(''); carregar(); }}
      />
    );
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}><Icon name="document" size={20} /> Notas de compra (XML)</h1>
        <button className="btn-primary" onClick={handleImportar} disabled={importando}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="import" size={15} /> {importando ? 'Lendo XML...' : 'Importar XML da NF-e'}</span>
        </button>
      </div>
      <p className="screen-hint">
        Use o arquivo .xml que o fornecedor manda por e-mail. Os itens já vêm casados pelo código de
        barras ou pelo código do fornecedor; você confere a conversão de unidade, lote e validade, e a
        entrada lança estoque, custo médio e contas a pagar de uma vez.
      </p>
      {erro && <p className="modal-error" style={{ marginBottom: 12 }}>{erro}</p>}

      {notas === null ? (
        <p className="empty-state">Carregando...</p>
      ) : notas.length === 0 ? (
        <p className="empty-state">Nenhuma nota importada ainda.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>NF-e</th><th>Fornecedor</th><th>Emissão</th><th style={{ textAlign: 'right' }}>Valor</th><th>Itens</th><th>Situação</th><th></th></tr>
          </thead>
          <tbody>
            {notas.map((n) => (
              <tr key={n.id}>
                <td><strong>{n.numero}</strong>{n.serie ? `/${n.serie}` : ''}</td>
                <td>{n.fornecedor_nome}</td>
                <td>{dataBR(n.emissao)}</td>
                <td style={{ textAlign: 'right' }}>{brl(n.valor_total)}</td>
                <td>
                  {n.qtd_itens}
                  {n.status === 'rascunho' && n.itens_sem_produto > 0 && (
                    <span className="badge-warning" style={{ marginLeft: 6, fontSize: 12 }}>{n.itens_sem_produto} sem produto</span>
                  )}
                </td>
                <td><ChipStatus status={n.status} /></td>
                <td><button className="btn-link" onClick={() => setAbertaId(n.id)}>{n.status === 'rascunho' ? 'Conferir' : 'Ver'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NfeConferencia({ id, avisos, erroInicial, onVoltar }) {
  const { currentUser } = useSession();
  const [nota, setNota] = useState(null);
  const [pedidos, setPedidos] = useState([]);
  const [erro, setErro] = useState(erroInicial || '');
  const [mensagem, setMensagem] = useState('');
  const [modoConta, setModoConta] = useState(null);
  const [vencimento, setVencimento] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [estornando, setEstornando] = useState(false);
  const [motivoEstorno, setMotivoEstorno] = useState('');
  useEscToClose(() => setEstornando(false), estornando);

  async function carregar() {
    const n = await window.pdv.nfeEntradas.get({ id });
    if (!n || n.ok === false) { setErro(n?.error || 'Nota não encontrada.'); return; }
    setNota(n);
    setModoConta((atual) => atual ?? (n.duplicatas.length > 0 ? 'duplicatas' : null));
    if (n.status === 'rascunho' && n.fornecedor_id) {
      const lista = await window.pdv.purchaseOrders.listAbertosDoFornecedor({ fornecedorId: n.fornecedor_id });
      setPedidos(Array.isArray(lista) ? lista : []);
    }
  }
  useEffect(() => { carregar(); }, [id]);

  if (!nota) return <div className="screen">{erro ? <p className="modal-error">{erro}</p> : <p className="empty-state">Carregando...</p>}</div>;

  const editavel = nota.status === 'rascunho';

  async function salvarItem(item, mudancas) {
    setErro('');
    // Reflete na hora; o backend recalcula quantidade e custo.
    setNota((n) => ({ ...n, itens: n.itens.map((i) => (i.id === item.id ? { ...i, ...mudancas } : i)) }));
    const payload = { entradaId: nota.id, itemId: item.id };
    if ('produto' in mudancas) payload.productId = mudancas.produto?.id || null;
    for (const k of ['fator', 'lote', 'validade', 'ignorar']) if (k in mudancas) payload[k] = mudancas[k];
    const r = await window.pdv.nfeEntradas.atualizarItem(payload);
    if (!r?.ok) { setErro(r?.error || 'Não foi possível salvar o item.'); }
    carregar();
  }

  async function handleVincularPedido(purchaseOrderId) {
    const r = await window.pdv.nfeEntradas.vincularPedido({ entradaId: nota.id, purchaseOrderId: purchaseOrderId || null });
    if (!r?.ok) setErro(r?.error); else carregar();
  }

  async function handleConfirmar() {
    setErro('');
    setSalvando(true);
    const r = await window.pdv.nfeEntradas.confirmar({
      entradaId: nota.id, locationId: window.APP_LOCATION_ID, operadorId: currentUser.id, deviceId: window.APP_DEVICE_ID,
      contaAPagar: modoConta ? { modo: modoConta, vencimento } : undefined,
    });
    setSalvando(false);
    if (!r?.ok) { setErro(r?.error || 'Não foi possível lançar a nota.'); return; }
    setMensagem(`Entrada lançada: ${r.itens} item(ns) no estoque${r.contas ? `, ${r.contas} conta(s) a pagar no Financeiro` : ''}.`);
    carregar();
  }

  async function handleDescartar() {
    if (!confirm('Descartar esta nota? Nada foi lançado ainda; dá para importar o XML de novo depois.')) return;
    const r = await window.pdv.nfeEntradas.descartar({ entradaId: nota.id });
    if (!r?.ok) setErro(r?.error); else onVoltar();
  }

  async function handleEstornar() {
    const r = await window.pdv.nfeEntradas.estornar({ entradaId: nota.id, motivo: motivoEstorno, operadorId: currentUser.id, deviceId: window.APP_DEVICE_ID });
    if (!r?.ok) { setErro(r?.error || 'Não foi possível estornar.'); setEstornando(false); return; }
    setEstornando(false);
    setMensagem('Entrada estornada: o estoque e o custo voltaram e as contas a pagar em aberto foram canceladas.');
    carregar();
  }

  const itensValidos = nota.itens.filter((i) => !i.ignorar);
  const custoEstoque = itensValidos.reduce((s, i) => s + Number(i.custo_total_previsto || 0), 0);

  return (
    <div className="screen">
      <button className="btn-link" onClick={onVoltar} style={{ marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="arrowLeft" size={14} /> Notas de compra</span>
      </button>
      <div className="screen-header">
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          NF-e {nota.numero}{nota.serie ? `/${nota.serie}` : ''} — {nota.fornecedor_nome || nota.emitente_nome}
          <ChipStatus status={nota.status} />
        </h1>
      </div>
      <p className="screen-hint">
        Emitida em {dataBR(nota.emissao)} · chave {nota.chave.replace(/(\d{4})(?=\d)/g, '$1 ')}
        {!nota.fornecedor_id && editavel && ' · fornecedor novo: será cadastrado com os dados da nota ao lançar'}
      </p>

      {avisos.length > 0 && editavel && avisos.map((a) => (
        <p key={a} className="io-message-aviso" style={{ marginBottom: 8 }}><Icon name="warning" size={15} /> {a}</p>
      ))}
      {erro && <p className="modal-error" style={{ marginBottom: 12 }}>{erro}</p>}
      {mensagem && <p className="io-message" style={{ marginBottom: 12 }}>{mensagem}</p>}

      <div className="dashboard-stats">
        <div className="stat-card"><span>Valor da nota</span><strong>{brl(nota.valor_total)}</strong></div>
        <div className="stat-card"><span>Custo que entra no estoque</span><strong>{brl(custoEstoque)}</strong></div>
        <div className="stat-card"><span>Itens</span><strong>{itensValidos.length}{nota.itens.length !== itensValidos.length ? ` de ${nota.itens.length}` : ''}</strong></div>
        <div className="stat-card">
          <span>Pendências</span>
          <strong className={nota.pendencias > 0 ? 'valor-erro' : undefined}>{editavel ? nota.pendencias : '—'}</strong>
        </div>
      </div>

      <table className="data-table nfe-itens">
        <thead>
          <tr>
            <th>Na nota</th><th>Qtd. nota</th><th>Produto no sistema</th><th>Conversão</th><th>Entra no estoque</th>
            <th style={{ textAlign: 'right' }}>Custo unit.</th><th>Lote</th><th>Validade</th>{editavel && <th>Ignorar</th>}
          </tr>
        </thead>
        <tbody>
          {nota.itens.map((i) => {
            const semProduto = !i.ignorar && !i.product_id;
            const quantidade = editavel ? i.quantidade_entrada_prevista : i.quantidade_entrada;
            const custoUnit = editavel ? i.custo_unitario_previsto : i.custo_unitario;
            return (
              <tr key={i.id} className={semProduto ? 'row-critical' : i.ignorar ? 'nfe-item-ignorado' : ''}>
                <td>
                  <div style={{ fontWeight: 600 }}>{i.descricao}</div>
                  <div className="nfe-item-codigos">cód. {i.codigo_fornecedor || '—'}{i.ean ? ` · EAN ${i.ean}` : ''}</div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{qtd(i.quantidade_nota)} {i.unidade_nota}</td>
                <td>
                  {editavel ? (
                    <ProductPicker
                      value={i.product_id ? { id: i.product_id, nome: i.produto_nome } : null}
                      onChange={(p) => p && salvarItem(i, { produto: p, product_id: p.id, produto_nome: p.nome })}
                      disabled={!!i.ignorar}
                      width={200}
                    />
                  ) : (i.produto_nome || '—')}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {editavel ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      1 {i.unidade_nota} =
                      <input
                        type="number" min="0" step="any" style={{ width: 64 }} defaultValue={i.fator} disabled={!!i.ignorar}
                        key={`${i.id}-${i.fator}`}
                        onBlur={(e) => Number(e.target.value) !== Number(i.fator) && salvarItem(i, { fator: Number(e.target.value) })}
                      />
                      {i.produto_unidade || 'un'}
                    </span>
                  ) : `1 ${i.unidade_nota} = ${qtd(i.fator)} ${i.produto_unidade || 'un'}`}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{i.ignorar ? '—' : `${qtd(quantidade)} ${i.produto_unidade || 'un'}`}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {i.ignorar ? '—' : brlCusto(custoUnit)}
                  {editavel && !i.ignorar && i.product_id && Number(i.produto_custo) > 0 && (
                    <div className="nfe-item-codigos">atual {brlCusto(i.produto_custo)}</div>
                  )}
                </td>
                <td>
                  {editavel ? (
                    <input style={{ width: 84 }} defaultValue={i.lote || ''} key={`${i.id}-lote-${i.lote}`} disabled={!!i.ignorar}
                      onBlur={(e) => e.target.value !== (i.lote || '') && salvarItem(i, { lote: e.target.value })} />
                  ) : (i.lote || '—')}
                </td>
                <td>
                  {editavel ? (
                    <input type="date" value={i.validade || ''} disabled={!!i.ignorar} onChange={(e) => salvarItem(i, { validade: e.target.value })} />
                  ) : dataBR(i.validade)}
                </td>
                {editavel && (
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={!!i.ignorar} title="Não entra no estoque (brinde, material de uso e consumo)"
                      onChange={(e) => salvarItem(i, { ignorar: e.target.checked })} style={{ width: 'auto' }} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {editavel && (
        <p className="screen-hint" style={{ marginTop: 8 }}>
          Custo unitário = valor do item + frete + seguro + outras despesas + IPI + ICMS-ST − desconto, dividido pela
          quantidade que entra no estoque. Ao lançar, o custo do produto vira a média ponderada com o estoque atual.
        </p>
      )}

      {editavel ? (
        <div className="nfe-rodape">
          <section className="settings-section">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="money" size={16} /> Pagamento</h2>
            {nota.duplicatas.length > 0 && (
              <table className="data-table" style={{ marginBottom: 10 }}>
                <thead><tr><th>Duplicata</th><th>Vencimento</th><th style={{ textAlign: 'right' }}>Valor</th></tr></thead>
                <tbody>
                  {nota.duplicatas.map((d) => (
                    <tr key={d.id}><td>{d.numero}</td><td>{dataBR(d.vencimento)}</td><td style={{ textAlign: 'right' }}>{brl(d.valor)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="nfe-opcoes-pagamento">
              {nota.duplicatas.length > 0 && (
                <label className="nfe-opcao"><input type="radio" checked={modoConta === 'duplicatas'} onChange={() => setModoConta('duplicatas')} />
                  Lançar {nota.duplicatas.length === 1 ? 'a duplicata' : `as ${nota.duplicatas.length} duplicatas`} em contas a pagar</label>
              )}
              {nota.duplicatas.length === 0 && (
                <label className="nfe-opcao"><input type="radio" checked={modoConta === 'vencimento'} onChange={() => setModoConta('vencimento')} />
                  Conta a pagar de {brl(nota.valor_total)} com vencimento em
                  <input type="date" value={vencimento} onChange={(e) => { setVencimento(e.target.value); setModoConta('vencimento'); }} style={{ marginLeft: 6 }} />
                </label>
              )}
              <label className="nfe-opcao"><input type="radio" checked={modoConta === 'paga'} onChange={() => setModoConta('paga')} />
                Já foi paga (compra à vista)</label>
              <label className="nfe-opcao"><input type="radio" checked={modoConta === 'nenhuma'} onChange={() => setModoConta('nenhuma')} />
                Não lançar no Financeiro</label>
            </div>
          </section>

          <section className="settings-section">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="clipboard" size={16} /> Pedido de compra</h2>
            {pedidos.length === 0 && !nota.purchase_order_id ? (
              <p className="empty-state">Nenhum pedido em aberto para este fornecedor.</p>
            ) : (
              <label>
                Abater o que chegou de um pedido
                <select value={nota.purchase_order_id || ''} onChange={(e) => handleVincularPedido(e.target.value)}>
                  <option value="">Sem pedido</option>
                  {nota.purchase_order_id && !pedidos.some((p) => p.id === nota.purchase_order_id) && (
                    <option value={nota.purchase_order_id}>Pedido nº {nota.pedido_numero}</option>
                  )}
                  {pedidos.map((p) => <option key={p.id} value={p.id}>Pedido nº {p.numero} — {brl(p.total)} ({p.qtd_itens} itens)</option>)}
                </select>
              </label>
            )}
          </section>
        </div>
      ) : (
        <section className="settings-section" style={{ marginTop: 20 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="money" size={16} /> Contas a pagar desta nota</h2>
          {nota.contas.length === 0 ? (
            <p className="empty-state">{nota.status === 'estornada' ? 'Canceladas no estorno.' : 'Nenhuma conta lançada.'}</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Descrição</th><th>Vencimento</th><th style={{ textAlign: 'right' }}>Valor</th><th>Situação</th></tr></thead>
              <tbody>
                {nota.contas.map((c) => (
                  <tr key={c.id}>
                    <td>{c.descricao}</td><td>{dataBR(c.data_vencimento)}</td><td style={{ textAlign: 'right' }}>{brl(c.valor)}</td>
                    <td>{c.data_pagamento ? <span className="chip-situacao chip-novo">Paga</span> : <span className="chip-situacao chip-atualizar">Em aberto</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {nota.status === 'estornada' && <p className="screen-hint" style={{ marginTop: 10 }}>Estornada em {dataBR(nota.estornada_em)}: {nota.estorno_motivo}</p>}
        </section>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {editavel && (
          <>
            <button className="btn-primary" onClick={handleConfirmar} disabled={salvando || nota.pendencias > 0}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> {salvando ? 'Lançando...' : 'Lançar entrada'}</span>
            </button>
            <button className="btn-secondary" onClick={handleDescartar} disabled={salvando}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="trash" size={15} /> Descartar nota</span>
            </button>
            {nota.pendencias > 0 && <span className="screen-hint" style={{ margin: 0, alignSelf: 'center' }}>Escolha o produto das linhas em vermelho (ou marque "ignorar").</span>}
          </>
        )}
        {nota.status === 'confirmada' && (
          <button className="btn-danger" onClick={() => { setMotivoEstorno(''); setEstornando(true); }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="undo" size={15} /> Estornar entrada</span>
          </button>
        )}
      </div>

      {estornando && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2 style={{ marginTop: 0 }}>Estornar a NF-e {nota.numero}?</h2>
            <p className="modal-subtitle">
              O estoque desta nota sai, o custo médio volta e as contas a pagar em aberto são canceladas. Fica tudo
              registrado na Auditoria.
            </p>
            <label>
              Motivo
              <input autoFocus value={motivoEstorno} onChange={(e) => setMotivoEstorno(e.target.value)} placeholder="Ex.: mercadoria devolvida ao fornecedor" />
            </label>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn-secondary" onClick={() => setEstornando(false)}>Voltar</button>
              <button className="btn-danger" onClick={handleEstornar} disabled={motivoEstorno.trim().length < 5}>Estornar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
