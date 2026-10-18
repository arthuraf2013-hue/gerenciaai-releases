import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// "Por que o resultado mudou" -- período escolhido x o anterior de mesmo
// tamanho (dashboardService.explicarVariacao). Sem IA: as parcelas são
// calculadas e somam exatamente a variação.

const real = (v) => `${v < 0 ? '−' : '+'}R$ ${Math.abs(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ROTULO = { movimento: 'Quantidade de vendas', ticket: 'Ticket médio', descontos: 'Descontos' };
const fmtData = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

export function ExplicacaoResultado({ dataInicio, dataFim, onExplicacao }) {
  const [r, setR] = useState(null);
  useEffect(() => {
    if (!dataInicio || !dataFim) return;
    let ignorar = false;
    window.pdv.dashboard.explicarVariacao?.({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim })
      .then((res) => { if (!ignorar && res?.frases) { setR(res); onExplicacao?.(res); } })
      .catch(() => {});
    return () => { ignorar = true; };
  }, [dataInicio, dataFim, onExplicacao]);

  if (!r || (r.atual.vendas === 0 && r.anteriorNumeros.vendas === 0)) return null;
  const maior = Math.max(1, ...Object.values(r.efeitos).map((v) => Math.abs(v)));

  return (
    <section className="settings-section explicacao-resultado">
      <h2><Icon name="chart" size={16} /> Por que o resultado mudou</h2>
      <p className="screen-hint" style={{ marginTop: 0 }}>
        {fmtData(r.periodo.dataInicio)}–{fmtData(r.periodo.dataFim)} comparado com {fmtData(r.anterior.dataInicio)}–{fmtData(r.anterior.dataFim)}.
      </p>
      <p className="explicacao-manchete">{r.frases[0]}</p>
      <div className="explicacao-efeitos">
        {Object.entries(r.efeitos).map(([k, v]) => (
          <div key={k} className="explicacao-efeito">
            <span>{ROTULO[k]}</span>
            <div className="explicacao-trilho"><span className={v < 0 ? 'neg' : 'pos'} style={{ width: `${(Math.abs(v) / maior) * 100}%` }} /></div>
            <strong className={v < 0 ? 'text-danger' : ''}>{real(v)}</strong>
          </div>
        ))}
      </div>
      {r.frases.length > 1 && (
        <ul className="explicacao-frases">
          {r.frases.slice(1).map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
    </section>
  );
}
