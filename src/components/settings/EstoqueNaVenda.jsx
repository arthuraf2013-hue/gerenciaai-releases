import { useCallback, useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Configurações -> Estoque na venda (estoquePoliticaService):
//  - vender mesmo sem estoque (avisa e deixa negativo) ou travar;
//  - relatório "Vendido sem estoque" (acertar a entrada depois);
//  - comandas esquecidas (abertas há horas, seguram estoque);
//  - unificar no servidor as entradas feitas neste caixa.

const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const qtd = (v) => (Math.round(Number(v) * 1000) / 1000).toLocaleString('pt-BR');

/** 'AAAA-MM-DD HH:MM:SS' (UTC, como o banco grava) -> data e hora daqui. */
function horaLocal(utc) {
  if (!utc) return '—';
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(utc) : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function desde(utc) {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  const h = Math.floor((Date.now() - d.getTime()) / 3600000);
  if (!(h >= 0)) return '';
  return h >= 48 ? `há ${Math.floor(h / 24)} dias` : `há ${h} h`;
}

export function EstoqueNaVenda({ podeMexer }) {
  const [politica, setPolitica] = useState(null);
  const [vendidos, setVendidos] = useState(null);
  const [esquecidas, setEsquecidas] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [msg, setMsg] = useState(null);
  const [cancelando, setCancelando] = useState(null); // { saleId, rotulo }
  const [pin, setPin] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const api = window.pdv.estoqueVenda;
  const carregar = useCallback(async () => {
    const [p, v, e, u] = await Promise.all([
      api.politica().catch(() => null),
      api.vendidosSemEstoque({ dias: 30 }).catch(() => []),
      api.comandasEsquecidas({ horas: 12 }).catch(() => []),
      api.previaUnificacao().catch(() => null),
    ]);
    setPolitica(p); setVendidos(Array.isArray(v) ? v : []); setEsquecidas(Array.isArray(e) ? e : []); setPrevia(u);
  }, [api]);
  useEffect(() => { carregar(); }, [carregar]);

  async function mudarPolitica(vender) {
    const r = await api.setPolitica({ venderSemEstoque: vender });
    if (!r?.ok) { setMsg({ erro: true, texto: r?.error || 'Não consegui salvar.' }); return; }
    setPolitica(r);
    setMsg({ erro: false, texto: vender ? 'A venda não trava mais por falta de estoque: o caixa vê um aviso e o estoque fica negativo.' : 'Sem estoque, o item não entra (trava).' });
  }

  async function confirmarCancelamento(e) {
    e.preventDefault();
    setOcupado(true);
    const r = await api.cancelarComandaEsquecida({
      saleId: cancelando.saleId, pin, locationId: window.APP_LOCATION_ID, deviceId: window.APP_DEVICE_ID,
    }).catch((err) => ({ ok: false, error: err.message }));
    setOcupado(false);
    if (!r?.ok) { setMsg({ erro: true, texto: r?.error || 'Não consegui cancelar.' }); return; }
    setMsg({ erro: false, texto: `${cancelando.rotulo} cancelada: o estoque voltou e a mesa ficou livre.` });
    setCancelando(null); setPin('');
    carregar();
  }

  async function unificar() {
    const itens = previa?.produtos || [];
    if (!itens.length) return;
    if (!window.confirm(
      `Levar ao estoque do servidor ${itens.length} produto(s) lançados neste caixa?\n\n`
      + 'O que foi dado de entrada (ou ajustado) AQUI passa a valer no servidor, e o estoque daqui desses produtos fica zerado.\n'
      + 'Use só se essas entradas NÃO foram lançadas também no servidor (senão conta duas vezes).',
    )) return;
    setOcupado(true);
    const r = await api.unificar({ locationId: window.APP_LOCATION_ID, deviceId: window.APP_DEVICE_ID }).catch((err) => ({ ok: false, error: err.message }));
    setOcupado(false);
    if (!r?.ok) { setMsg({ erro: true, texto: r?.error || 'Não consegui unificar.' }); return; }
    setMsg({ erro: false, texto: `${r.enviados.length} produto(s) enviados ao servidor. Se ele estiver fora do ar, vão sozinhos quando voltar.` });
    carregar();
  }

  if (!politica) return null;
  return (
    <section className="settings-section estoque-venda">
      <h2><Icon name="box" size={16} /> Estoque na venda</h2>
      <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} disabled={!podeMexer} checked={politica.venderSemEstoque} onChange={(e) => mudarPolitica(e.target.checked)} />
        Vender mesmo sem estoque (avisa e deixa o estoque negativo)
      </label>
      <p className="screen-hint">
        Ligado, o pedido nunca para: o caixa vê onde falta (neste computador, no servidor ou em comandas abertas) e o item aparece em
        "Vendido sem estoque" para acertar a entrada. Desligado, o item sem estoque não entra.
        {!politica.escolhido && ` Padrão do seu ramo: ${politica.padrao ? 'ligado' : 'desligado'}.`}
      </p>
      {msg && <p className={msg.erro ? 'modal-error' : 'io-message'}>{msg.texto}</p>}

      <h3><Icon name="warning" size={15} /> Vendido sem estoque (últimos 30 dias)</h3>
      {vendidos?.length ? (
        <table className="data-table">
          <thead><tr><th>Produto</th><th>Vendido sem estoque</th><th>Vendas</th><th>Estoque agora</th><th>Última</th></tr></thead>
          <tbody>
            {vendidos.map((v) => (
              <tr key={v.productId}>
                <td>{v.nome}</td>
                <td>{qtd(v.quantidade)} {v.unidade || 'un'}</td>
                <td>{v.vendas}</td>
                <td className={v.estoqueAtual < 0 ? 'estoque-negativo' : ''}>{v.estoqueAtual == null ? '—' : `${qtd(v.estoqueAtual)} ${v.unidade || 'un'}`}</td>
                <td>{horaLocal(v.ultima)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="screen-hint">Nada vendido sem estoque nos últimos 30 dias.</p>}

      <h3><Icon name="clock" size={15} /> Comandas esquecidas (abertas há mais de 12 h)</h3>
      {esquecidas?.length ? (
        <table className="data-table">
          <thead><tr><th>Comanda</th><th>Aberta</th><th>Operador</th><th>Itens</th><th>Total</th><th /></tr></thead>
          <tbody>
            {esquecidas.map((c) => {
              const rotulo = c.mesa || 'Venda de balcão';
              return (
                <tr key={c.saleId}>
                  <td>{rotulo}</td>
                  <td>{horaLocal(c.abertaEm)} <span className="screen-hint">({desde(c.abertaEm)})</span></td>
                  <td>{c.operador || '—'}</td>
                  <td>{c.itens}</td>
                  <td>{brl(c.total)}{c.pago > 0 ? ` (pago ${brl(c.pago)})` : ''}</td>
                  <td>
                    {podeMexer && c.pago <= 0 && (
                      <button type="button" className="btn-link-danger" onClick={() => { setCancelando({ saleId: c.saleId, rotulo }); setPin(''); }}>Cancelar</button>
                    )}
                    {c.pago > 0 && <span className="screen-hint">tem pagamento: conclua na mesa</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="screen-hint">Nenhuma comanda aberta há mais de 12 horas.</p>}

      {previa?.pode && (
        <>
          <h3><Icon name="link" size={15} /> Unificar estoque no servidor</h3>
          <p className="screen-hint">
            Entradas e ajustes feitos neste caixa ficam só aqui, e o servidor diz "sem estoque". Isto leva esse saldo para o estoque do
            servidor (as vendas daqui já baixam lá ao finalizar).
          </p>
          {previa.produtos.length ? (
            <>
              <table className="data-table">
                <thead><tr><th>Produto</th><th>Vai para o servidor</th><th>Lançamentos</th></tr></thead>
                <tbody>
                  {previa.produtos.map((p) => (
                    <tr key={p.productId}><td>{p.nome}</td><td>{p.quantidade > 0 ? '+' : ''}{qtd(p.quantidade)} {p.unidade || 'un'}</td><td>{p.movimentos}</td></tr>
                  ))}
                </tbody>
              </table>
              {podeMexer && (
                <button type="button" className="btn-primary" disabled={ocupado} onClick={unificar} style={{ marginTop: 10 }}>
                  <Icon name="link" size={15} /> Levar ao servidor
                </button>
              )}
            </>
          ) : <p className="screen-hint">Nenhuma entrada deste caixa para levar: o estoque já está todo no servidor.</p>}
        </>
      )}

      {cancelando && (
        <div className="modal-overlay">
          <form className="modal-card" onSubmit={confirmarCancelamento}>
            <h2>Cancelar {cancelando.rotulo}?</h2>
            <p className="screen-hint">Os itens são cancelados, o estoque volta e a mesa fica livre. Fica registrado na Auditoria.</p>
            <label>Seu PIN
              <input type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setCancelando(null)}>Voltar</button>
              <button type="submit" className="btn-danger" disabled={ocupado || !pin}>Cancelar comanda</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
