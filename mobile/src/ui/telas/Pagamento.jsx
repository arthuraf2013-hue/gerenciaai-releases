import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { useApp, useTentar } from '../contexto.jsx';
import { formatarCentavos, lerCentavos, ErroDeNegocio } from '../../services/base.js';
import { finalizarVenda, METODOS } from '../../services/vendas.js';
import { configPix, montarPayloadPix } from '../../services/pix.js';
import { totalDoCarrinho } from '../carrinhoUtil.js';
import Modal from '../comp/Modal.jsx';
import Icone from '../comp/Icone.jsx';
import SelecionarCliente from '../comp/SelecionarCliente.jsx';

const ICONE_METODO = { dinheiro: 'dinheiro', pix: 'pix', credito: 'cartao', debito: 'cartao', fiado: 'fiado' };
const ORDEM = ['dinheiro', 'pix', 'debito', 'credito', 'fiado'];
const fmtCampo = (c) => (c / 100).toFixed(2).replace('.', ',');

function PixQr({ valorCentavos, aoConfirmar, aoVoltar }) {
  const { servicos } = useApp();
  const tentar = useTentar();
  const [qr, setQr] = useState(null);
  const [erro, setErro] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const cfg = await configPix(servicos.db);
        const p = montarPayloadPix({ ...cfg, valorCentavos, referencia: `PDV${Date.now().toString(36).toUpperCase()}` });
        setQr({ payload: p, imagem: await QRCode.toDataURL(p, { margin: 1, width: 440, errorCorrectionLevel: 'M' }) });
      } catch (err) { setErro(err); }
    })();
  }, [servicos.db, valorCentavos]);

  if (erro) return <div className="pilha"><div className="aviso perigo"><Icone nome="alerta" /><span>{erro.message}</span></div><button type="button" className="btn" onClick={aoVoltar}>Voltar</button></div>;
  if (!qr) return <div className="carregando"><div className="spinner" /></div>;
  return (
    <div className="pilha">
      <p className="centro">Peça para o cliente ler o QR no app do banco.</p>
      <div className="centro total-grande num">{formatarCentavos(valorCentavos)}</div>
      <div className="qr"><img src={qr.imagem} alt="QR Code Pix" /></div>
      <button type="button" className="btn" onClick={() => tentar(() => navigator.clipboard.writeText(qr.payload), { sucesso: 'Código copiado.' })}><Icone nome="copiar" />Copiar "copia e cola"</button>
      <div className="aviso info"><Icone nome="alerta" /><span>Confira no app do <b>seu</b> banco se o Pix caiu antes de confirmar. O app não recebe aviso automático do banco.</span></div>
      <button type="button" className="btn primario grande" onClick={aoConfirmar}>Recebi o Pix</button>
      <button type="button" className="btn" onClick={aoVoltar}>Voltar</button>
    </div>
  );
}

export default function Pagamento({ aoFechar, aoConcluir }) {
  const { servicos, usuario, carrinho, setCarrinho } = useApp();
  const tentar = useTentar();
  const subtotal = totalDoCarrinho(carrinho.itens);
  const desconto = Math.min(carrinho.descontoCentavos || 0, subtotal);
  const total = subtotal - desconto;
  const [pagamentos, setPagamentos] = useState([]);
  const pago = pagamentos.reduce((s, p) => s + p.valorCentavos, 0);
  const restante = total - pago;
  const [metodo, setMetodo] = useState(null);
  const [valor, setValor] = useState('');
  const [recebido, setRecebido] = useState('');
  const [mostrarPix, setMostrarPix] = useState(false);
  const [escolherCliente, setEscolherCliente] = useState(false);
  const [finalizando, setFinalizando] = useState(false);

  useEffect(() => { setValor(restante > 0 ? fmtCampo(restante) : ''); setRecebido(''); }, [metodo, restante]);

  const valorC = lerCentavos(valor);
  const recebidoC = lerCentavos(recebido);
  const trocoPrevisto = metodo === 'dinheiro' && recebidoC != null && valorC != null ? recebidoC - Math.min(valorC, restante) : 0;
  const sugestoesDinheiro = useMemo(() => {
    const base = valorC || restante;
    const notas = [500, 1000, 2000, 5000, 10000, 20000];
    const s = new Set([base]);
    for (const n of notas) if (n > base) { s.add(Math.ceil(base / n) * n); }
    return [...s].sort((a, b) => a - b).slice(0, 4);
  }, [valorC, restante]);

  const adicionar = (m = metodo, extra = {}) => tentar(async () => {
    if (valorC == null || valorC <= 0) throw new ErroDeNegocio('Informe o valor.');
    if (valorC > restante) throw new ErroDeNegocio(`O valor passa do que falta (${formatarCentavos(restante)}).`);
    if (m === 'fiado' && !carrinho.cliente) { setEscolherCliente(true); return; }
    const p = { metodo: m, valorCentavos: valorC, ...extra };
    if (m === 'dinheiro') {
      const rec = recebido.trim() === '' ? valorC : recebidoC;
      if (rec == null || rec < valorC) throw new ErroDeNegocio('O valor recebido é menor que o valor a pagar.');
      p.recebidoCentavos = rec;
    }
    setPagamentos((l) => [...l, p]);
    setMetodo(null);
    setMostrarPix(false);
  });

  const finalizar = async () => {
    setFinalizando(true);
    const venda = await tentar(() => finalizarVenda(servicos.db, {
      itens: carrinho.itens.map((i) => ({ produtoId: i.produtoId, qtdMil: i.qtdMil, nome: i.nome })),
      descontoCentavos: desconto,
      pagamentos,
      clienteId: carrinho.cliente?.id || null,
      pinGerenteDesconto: carrinho.pinGerenteDesconto,
    }, usuario.id));
    setFinalizando(false);
    if (venda) aoConcluir(venda);
  };

  const troco = pagamentos.reduce((s, p) => s + (p.recebidoCentavos ? p.recebidoCentavos - p.valorCentavos : 0), 0);

  return (
    <Modal titulo="Pagamento" aoFechar={aoFechar}>
      <div className="cartao centro pilha-p">
        <span className="muted">{restante > 0 ? 'Falta pagar' : 'Total'}</span>
        <span className="total-grande num">{formatarCentavos(restante > 0 ? restante : total)}</span>
        {pago > 0 && restante > 0 && <span className="muted peq num">de {formatarCentavos(total)}</span>}
        {carrinho.cliente && <span className="selo">Cliente: {carrinho.cliente.nome}</span>}
      </div>

      {mostrarPix ? (
        <PixQr valorCentavos={valorC} aoVoltar={() => setMostrarPix(false)} aoConfirmar={() => adicionar('pix')} />
      ) : restante > 0 ? (
        <>
          <div className="metodos">
            {ORDEM.map((m) => (
              <button type="button" key={m} className={`metodo ${metodo === m ? 'ativo' : ''}`} onClick={() => setMetodo(m)}>
                <Icone nome={ICONE_METODO[m]} />{m === 'credito' ? 'Crédito' : m === 'debito' ? 'Débito' : METODOS[m]}
              </button>
            ))}
          </div>
          {metodo && (
            <div className="cartao pilha">
              <label className="campo">Valor em {METODOS[metodo].toLowerCase()} (R$)
                <input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" />
              </label>
              {metodo === 'dinheiro' && (
                <>
                  <label className="campo">Valor recebido (R$)
                    <input autoFocus value={recebido} onChange={(e) => setRecebido(e.target.value)} inputMode="decimal" placeholder={valor} />
                  </label>
                  <div className="linha" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {sugestoesDinheiro.map((c) => <button type="button" key={c} className="btn peq" onClick={() => setRecebido(fmtCampo(c))}>{formatarCentavos(c)}</button>)}
                  </div>
                  {trocoPrevisto > 0 && <div className="troco"><div className="peq">Troco</div><div className="valor num">{formatarCentavos(trocoPrevisto)}</div></div>}
                </>
              )}
              {(metodo === 'credito' || metodo === 'debito') && <p className="muted peq">Passe na maquininha e confirme quando aprovar.</p>}
              {metodo === 'fiado' && !carrinho.cliente && <p className="muted peq">Fiado precisa de cliente — você vai escolher em seguida.</p>}
              {metodo === 'pix'
                ? <button type="button" className="btn primario grande" disabled={!valorC || valorC > restante} onClick={() => setMostrarPix(true)}>Mostrar QR do Pix</button>
                : <button type="button" className="btn primario grande" onClick={() => adicionar()}>Confirmar {METODOS[metodo].toLowerCase()}</button>}
            </div>
          )}
        </>
      ) : null}

      {pagamentos.length > 0 && (
        <div className="cartao plano">
          {pagamentos.map((p, i) => (
            <div className="item" key={i}>
              <Icone nome={ICONE_METODO[p.metodo]} width="22" height="22" />
              <div className="cresce">
                <div className="forte">{METODOS[p.metodo]}</div>
                {p.recebidoCentavos > p.valorCentavos && <div className="muted peq num">recebido {formatarCentavos(p.recebidoCentavos)}</div>}
              </div>
              <span className="preco num">{formatarCentavos(p.valorCentavos)}</span>
              <button type="button" className="icone-btn" aria-label="Remover pagamento" onClick={() => setPagamentos((l) => l.filter((_, j) => j !== i))}><Icone nome="lixo" /></button>
            </div>
          ))}
        </div>
      )}

      {restante === 0 && (
        <>
          {troco > 0 && <div className="troco"><div className="peq">Troco para o cliente</div><div className="valor num">{formatarCentavos(troco)}</div></div>}
          <button type="button" className="btn primario grande" disabled={finalizando} onClick={finalizar}>{finalizando ? 'Gravando...' : 'Finalizar venda'}</button>
        </>
      )}

      {escolherCliente && (
        <SelecionarCliente
          aoFechar={() => setEscolherCliente(false)}
          aoEscolher={(c) => { setCarrinho((x) => ({ ...x, cliente: c })); setEscolherCliente(false); }}
        />
      )}
    </Modal>
  );
}
