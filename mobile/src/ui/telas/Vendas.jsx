import { useState } from 'react';
import { useApp, useTentar, useCarregar } from '../contexto.jsx';
import { listarVendas, obterVenda, cancelarVenda, METODOS } from '../../services/vendas.js';
import { reciboEmTexto } from '../../services/relatorios.js';
import { formatarCentavos, formatarQuantidade, limitesDoDiaLocal, agoraMs } from '../../services/base.js';
import { compartilharTexto } from '../../app/plataforma.js';
import Modal from '../comp/Modal.jsx';
import PedirPin from '../comp/PedirPin.jsx';
import Icone from '../comp/Icone.jsx';
import SeloEnvio from '../comp/SeloEnvio.jsx';

const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const DIA = 86400000;

function DetalheVenda({ id, aoFechar, aoMudar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const v = useCarregar(() => obterVenda(servicos.db, id), [id]);
  const [cancelar, setCancelar] = useState(null);
  if (!v.dados) return null;
  const venda = v.dados;
  return (
    <Modal titulo={`Venda ${venda.numero}`} aoFechar={aoFechar}>
      <div className="entre">
        <span className="muted">{new Date(venda.criado_em).toLocaleString('pt-BR')}</span>
        {venda.status === 'cancelada' ? <span className="selo perigo">Cancelada</span> : <span className="selo ok">Finalizada</span>}
      </div>
      <div className="cartao plano">
        {venda.itens.map((i) => (
          <div className="item" key={i.id}>
            <div className="cresce"><div className="corta">{i.nome}</div><div className="muted peq num">{formatarQuantidade(i.qtd_mil, i.unidade)} × {formatarCentavos(i.preco_unit_centavos)}</div></div>
            <span className="preco num">{formatarCentavos(i.total_centavos)}</span>
          </div>
        ))}
      </div>
      <div className="pilha-p">
        {venda.desconto_centavos > 0 && <div className="entre"><span className="muted">Desconto</span><span className="num">− {formatarCentavos(venda.desconto_centavos)}</span></div>}
        <div className="entre"><span className="forte">Total</span><span className="forte num">{formatarCentavos(venda.total_centavos)}</span></div>
        {venda.pagamentos.map((p) => <div className="entre peq" key={p.id}><span className="muted">{METODOS[p.metodo]}</span><span className="num">{formatarCentavos(p.valor_centavos)}</span></div>)}
        {venda.troco_centavos > 0 && <div className="entre peq"><span className="muted">Troco</span><span className="num">{formatarCentavos(venda.troco_centavos)}</span></div>}
        {venda.cliente_nome && <div className="entre peq"><span className="muted">Cliente</span><span>{venda.cliente_nome}</span></div>}
        <div className="entre peq"><span className="muted">Operador</span><span>{venda.operador_nome}</span></div>
        {venda.motivo_cancelamento && <div className="aviso perigo"><span>Motivo do cancelamento: {venda.motivo_cancelamento}</span></div>}
      </div>
      <SeloEnvio vendaId={venda.id} />
      <button type="button" className="btn" onClick={() => tentar(() => compartilharTexto(reciboEmTexto(venda, { nomeNegocio: servicos.licenca.estado?.nomeNegocio })))}><Icone nome="compartilhar" />Enviar recibo</button>
      {venda.status === 'finalizada' && (
        <button type="button" className="btn contorno-perigo" onClick={() => {
          const motivo = prompt('Motivo do cancelamento:');
          if (motivo && motivo.trim()) setCancelar(motivo.trim());
        }}>Cancelar venda</button>
      )}
      {cancelar && (
        <PedirPin
          texto="Cancelar devolve os produtos ao estoque e estorna o fiado. Um gerente (não o próprio operador) precisa autorizar."
          aoFechar={() => setCancelar(null)}
          aoConfirmar={async (pin) => {
            const r = await tentar(() => cancelarVenda(servicos.db, { vendaId: id, motivo: cancelar, pinGerente: pin }, usuario.id), { sucesso: 'Venda cancelada.' });
            if (!r) return false;
            setCancelar(null);
            v.recarregar();
            aoMudar();
            return true;
          }}
        />
      )}
    </Modal>
  );
}

export default function Vendas() {
  const { servicos, terminal } = useApp();
  const [dias, setDias] = useState(0);
  const limites = (() => {
    const hoje = limitesDoDiaLocal(agoraMs());
    if (dias === 0) return hoje;
    return { inicio: limitesDoDiaLocal(agoraMs() - dias * DIA).inicio, fim: hoje.fim };
  })();
  const lista = useCarregar(() => listarVendas(servicos.db, limites), [dias]);
  const [aberta, setAberta] = useState(null);
  const finalizadas = (lista.dados || []).filter((v) => v.status === 'finalizada');
  const total = finalizadas.reduce((s, v) => s + v.total_centavos, 0);

  return (
    <>
      <header className="topo"><h1>Vendas</h1></header>
      <main className="conteudo">
        <div className="segmentado">
          {[[0, 'Hoje'], [6, '7 dias'], [29, '30 dias']].map(([d, r]) => <button type="button" key={d} className={dias === d ? 'ativo' : ''} onClick={() => setDias(d)}>{r}</button>)}
        </div>
        {terminal?.ativo && terminal.naoEnviados > 0 && (
          <div className="aviso"><Icone nome="wifiOff" /><span>{terminal.naoEnviados} registro(s) ainda não foram para o {terminal.servidorNome || 'computador'}. Vão sozinhos quando houver internet.</span></div>
        )}
        <div className="kpis">
          <div className="kpi"><div className="rotulo">Vendido</div><div className="valor num">{formatarCentavos(total)}</div></div>
          <div className="kpi"><div className="rotulo">Vendas</div><div className="valor num">{finalizadas.length}</div></div>
        </div>
        <div className="cartao plano">
          {(lista.dados || []).map((v) => (
            <button type="button" className="item" key={v.id} onClick={() => setAberta(v.id)}>
              <div className="cresce">
                <div className="linha"><span className="forte">{v.numero}</span>{v.status === 'cancelada' && <span className="selo perigo">Cancelada</span>}</div>
                <div className="muted peq corta">{dias ? new Date(v.criado_em).toLocaleDateString('pt-BR') + ' ' : ''}{hora(v.criado_em)} · {(v.metodos || '').split(',').map((m) => METODOS[m] || m).join(' + ')}{v.cliente_nome ? ` · ${v.cliente_nome}` : ''}</div>
              </div>
              <span className="preco num" style={v.status === 'cancelada' ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{formatarCentavos(v.total_centavos)}</span>
            </button>
          ))}
          {lista.dados?.length === 0 && <div className="vazio">Nenhuma venda no período.</div>}
        </div>
      </main>
      {aberta && <DetalheVenda id={aberta} aoFechar={() => setAberta(null)} aoMudar={() => lista.recarregar()} />}
    </>
  );
}
