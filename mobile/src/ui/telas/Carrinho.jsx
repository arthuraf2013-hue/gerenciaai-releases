import { useState } from 'react';
import { useApp, useTentar, useCarregar } from '../contexto.jsx';
import { formatarCentavos, formatarQuantidade, lerCentavos, lerQuantidadeMil, totalItemCentavos } from '../../services/base.js';
import { configDeVenda } from '../../services/vendas.js';
import { autorizarGerente } from '../../services/usuarios.js';
import Modal from '../comp/Modal.jsx';
import PedirPin from '../comp/PedirPin.jsx';
import SelecionarCliente from '../comp/SelecionarCliente.jsx';
import Icone from '../comp/Icone.jsx';
import { totalDoCarrinho, CARRINHO_VAZIO } from '../carrinhoUtil.js';

function Desconto({ subtotal, limitePercent, aoAplicar, aoFechar }) {
  const [modo, setModo] = useState('valor');
  const [v, setV] = useState('');
  const centavos = modo === 'valor' ? lerCentavos(v) : (() => {
    const p = Number(String(v).replace(',', '.'));
    return Number.isFinite(p) && p >= 0 && p <= 100 ? Math.round((subtotal * p) / 100) : null;
  })();
  const precisaGerente = centavos > Math.floor((subtotal * limitePercent) / 100);
  return (
    <Modal titulo="Desconto" aoFechar={aoFechar}>
      <div className="segmentado">
        <button type="button" className={modo === 'valor' ? 'ativo' : ''} onClick={() => setModo('valor')}>R$</button>
        <button type="button" className={modo === 'pct' ? 'ativo' : ''} onClick={() => setModo('pct')}>%</button>
      </div>
      <label className="campo">{modo === 'valor' ? 'Desconto (R$)' : 'Desconto (%)'}
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" />
      </label>
      <div className="entre"><span className="muted">Desconto</span><span className="forte num">{centavos != null ? formatarCentavos(centavos) : '—'}</span></div>
      {precisaGerente && centavos <= subtotal && <div className="aviso"><Icone nome="cadeado" /><span>Acima de {limitePercent}% precisa de autorização de um gerente.</span></div>}
      <button type="button" className="btn primario grande" disabled={centavos == null || centavos > subtotal} onClick={() => aoAplicar(centavos, precisaGerente)}>Aplicar</button>
    </Modal>
  );
}

export default function Carrinho({ aoFechar, aoCobrar }) {
  const { servicos, usuario, carrinho, setCarrinho } = useApp();
  const tentar = useTentar();
  const cfg = useCarregar(() => configDeVenda(servicos.db), []);
  const [modal, setModal] = useState(null);
  const [descontoPendente, setDescontoPendente] = useState(null);
  const [editarKg, setEditarKg] = useState(null);

  const subtotal = totalDoCarrinho(carrinho.itens);
  const desconto = Math.min(carrinho.descontoCentavos || 0, subtotal);
  const mudarQtd = (produtoId, delta) => setCarrinho((c) => ({
    ...c,
    itens: c.itens.map((i) => (i.produtoId === produtoId ? { ...i, qtdMil: i.qtdMil + delta } : i)).filter((i) => i.qtdMil > 0),
  }));
  const remover = (produtoId) => setCarrinho((c) => ({ ...c, itens: c.itens.filter((i) => i.produtoId !== produtoId) }));

  return (
    <Modal
      titulo="Carrinho"
      aoFechar={aoFechar}
      rodape={(
        <div className="pilha">
          <div className="entre"><span className="muted">Subtotal</span><span className="num">{formatarCentavos(subtotal)}</span></div>
          {desconto > 0 && <div className="entre"><span className="muted">Desconto</span><span className="num">− {formatarCentavos(desconto)}</span></div>}
          <div className="entre"><span className="forte">Total</span><span className="total-grande num">{formatarCentavos(subtotal - desconto)}</span></div>
          <button type="button" className="btn primario grande" disabled={!carrinho.itens.length} onClick={aoCobrar}>Cobrar</button>
        </div>
      )}
    >
      <div className="cartao plano">
        {carrinho.itens.map((i) => (
          <div key={i.produtoId} className="item">
            <div className="cresce">
              <div className="forte corta">{i.nome}</div>
              <div className="muted peq num">{formatarCentavos(i.precoCentavos)}{i.unidade === 'kg' ? '/kg' : ''} · {formatarCentavos(totalItemCentavos(i.precoCentavos, i.qtdMil))}</div>
            </div>
            {i.unidade === 'kg' ? (
              <button type="button" className="btn peq" onClick={() => setEditarKg(i)}>{formatarQuantidade(i.qtdMil, 'kg')}</button>
            ) : (
              <div className="passo-qtd">
                <button type="button" onClick={() => mudarQtd(i.produtoId, -1000)} aria-label="Menos um">−</button>
                <span className="num">{i.qtdMil / 1000}</span>
                <button type="button" onClick={() => mudarQtd(i.produtoId, 1000)} aria-label="Mais um">+</button>
              </div>
            )}
            <button type="button" className="icone-btn" onClick={() => remover(i.produtoId)} aria-label={`Remover ${i.nome}`}><Icone nome="lixo" /></button>
          </div>
        ))}
        {carrinho.itens.length === 0 && <div className="vazio">Carrinho vazio.</div>}
      </div>

      <div className="grade-2">
        <button type="button" className="btn" onClick={() => setModal('cliente')}>
          <Icone nome="cliente" />{carrinho.cliente ? <span className="corta">{carrinho.cliente.nome}</span> : 'Cliente'}
        </button>
        <button type="button" className="btn" onClick={() => setModal('desconto')} disabled={!subtotal}>
          {desconto ? `Desc. ${formatarCentavos(desconto)}` : 'Desconto'}
        </button>
      </div>
      {carrinho.cliente && <button type="button" className="btn peq" onClick={() => setCarrinho((c) => ({ ...c, cliente: null }))}>Tirar cliente</button>}
      {desconto > 0 && <button type="button" className="btn peq" onClick={() => setCarrinho((c) => ({ ...c, descontoCentavos: 0, pinGerenteDesconto: null }))}>Tirar desconto</button>}
      <button type="button" className="btn contorno-perigo peq" onClick={() => { if (confirm('Esvaziar o carrinho?')) { setCarrinho(CARRINHO_VAZIO); aoFechar(); } }}>Esvaziar carrinho</button>

      {modal === 'cliente' && <SelecionarCliente aoFechar={() => setModal(null)} aoEscolher={(c) => { setCarrinho((x) => ({ ...x, cliente: c })); setModal(null); }} />}
      {modal === 'desconto' && cfg.dados && (
        <Desconto
          subtotal={subtotal}
          limitePercent={cfg.dados.descontoMaxPercent}
          aoFechar={() => setModal(null)}
          aoAplicar={(c, precisaGerente) => {
            if (precisaGerente) { setDescontoPendente(c); setModal('pin'); return; }
            setCarrinho((x) => ({ ...x, descontoCentavos: c, pinGerenteDesconto: null }));
            setModal(null);
          }}
        />
      )}
      {modal === 'pin' && (
        <PedirPin
          texto={`Desconto de ${formatarCentavos(descontoPendente)} (acima do limite). Um gerente — não o próprio operador — precisa digitar o PIN.`}
          aoFechar={() => setModal(null)}
          aoConfirmar={async (pin) => {
            const g = await tentar(() => autorizarGerente(servicos.db, { pin, solicitanteId: usuario.id }));
            if (!g) return false;
            setCarrinho((x) => ({ ...x, descontoCentavos: descontoPendente, pinGerenteDesconto: pin }));
            setModal(null);
            return true;
          }}
        />
      )}
      {editarKg && (
        <Modal titulo={editarKg.nome} aoFechar={() => setEditarKg(null)}>
          <EditarKg item={editarKg} aoSalvar={(q) => {
            setCarrinho((c) => ({ ...c, itens: c.itens.map((i) => (i.produtoId === editarKg.produtoId ? { ...i, qtdMil: q } : i)) }));
            setEditarKg(null);
          }} />
        </Modal>
      )}
    </Modal>
  );
}

function EditarKg({ item, aoSalvar }) {
  const [v, setV] = useState((item.qtdMil / 1000).toFixed(3).replace('.', ','));
  const q = lerQuantidadeMil(v);
  return (
    <>
      <label className="campo">Peso (kg)<input autoFocus value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" /></label>
      <button type="button" className="btn primario grande" disabled={!q} onClick={() => aoSalvar(q)}>Salvar</button>
    </>
  );
}

