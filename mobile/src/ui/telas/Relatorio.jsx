import { useState } from 'react';
import { useApp, useCarregar } from '../contexto.jsx';
import { resumoDoPeriodo } from '../../services/relatorios.js';
import { formatarCentavos, formatarQuantidade, limitesDoDiaLocal, agoraMs } from '../../services/base.js';
import Icone from '../comp/Icone.jsx';

const DIA = 86400000;

export default function Relatorio({ voltar }) {
  const { servicos } = useApp();
  const [dias, setDias] = useState(0);
  const r = useCarregar(() => {
    const hoje = limitesDoDiaLocal(agoraMs());
    return resumoDoPeriodo(servicos.db, dias === 0 ? hoje : { inicio: limitesDoDiaLocal(agoraMs() - dias * DIA).inicio, fim: hoje.fim });
  }, [dias]);
  const d = r.dados;
  const maxMetodo = d ? Math.max(1, ...d.porMetodo.map((m) => m.totalCentavos)) : 1;
  const lucro = d ? d.totalCentavos - d.custoEstimadoCentavos : 0;

  return (
    <>
      <header className="topo">
        <button type="button" className="icone-btn" onClick={voltar} aria-label="Voltar"><Icone nome="voltar" /></button>
        <h1>Relatório</h1>
      </header>
      <main className="conteudo">
        <div className="segmentado">
          {[[0, 'Hoje'], [6, '7 dias'], [29, '30 dias']].map(([n, rot]) => <button type="button" key={n} className={dias === n ? 'ativo' : ''} onClick={() => setDias(n)}>{rot}</button>)}
        </div>
        {d && (
          <>
            <div className="kpis">
              <div className="kpi"><div className="rotulo">Faturamento</div><div className="valor num">{formatarCentavos(d.totalCentavos)}</div></div>
              <div className="kpi"><div className="rotulo">Vendas</div><div className="valor num">{d.vendas}</div></div>
              <div className="kpi"><div className="rotulo">Ticket médio</div><div className="valor num">{formatarCentavos(d.ticketMedioCentavos)}</div></div>
              <div className="kpi"><div className="rotulo">Lucro bruto estimado</div><div className="valor num">{d.custoEstimadoCentavos ? formatarCentavos(lucro) : '—'}</div></div>
            </div>
            {d.custoEstimadoCentavos === 0 && d.vendas > 0 && <p className="muted peq">O lucro aparece quando os produtos têm custo cadastrado.</p>}
            <div className="secao-titulo">Por forma de pagamento</div>
            <div className="cartao pilha">
              {d.porMetodo.map((m) => (
                <div key={m.metodo} className="pilha-p">
                  <div className="entre"><span>{m.nome}</span><span className="num forte">{formatarCentavos(m.totalCentavos)}</span></div>
                  <div className="barra-fundo"><div className="barra-cheia" style={{ width: `${(m.totalCentavos / maxMetodo) * 100}%` }} /></div>
                </div>
              ))}
              {d.porMetodo.length === 0 && <p className="muted">Sem vendas no período.</p>}
            </div>
            <div className="secao-titulo">Mais vendidos</div>
            <div className="cartao plano">
              {d.maisVendidos.map((p, i) => (
                <div className="item" key={p.produto_id}>
                  <span className="muted num" style={{ width: 20 }}>{i + 1}</span>
                  <div className="cresce"><div className="corta">{p.nome}</div><div className="muted peq">{formatarQuantidade(p.qtd_mil, p.unidade)}{p.unidade === 'un' ? ' un' : ''}</div></div>
                  <span className="preco num">{formatarCentavos(p.total)}</span>
                </div>
              ))}
              {d.maisVendidos.length === 0 && <div className="vazio">Sem vendas no período.</div>}
            </div>
            {d.canceladas.quantidade > 0 && <p className="muted peq">{d.canceladas.quantidade} venda(s) cancelada(s): {formatarCentavos(d.canceladas.totalCentavos)} (fora dos totais).</p>}
          </>
        )}
      </main>
    </>
  );
}
