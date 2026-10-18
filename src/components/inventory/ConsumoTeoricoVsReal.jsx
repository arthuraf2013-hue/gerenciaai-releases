import { useCallback, useEffect, useState } from 'react';
import { toISODate } from '../../utils/date';
import Icon from '../common/Icon';

// Consumo de insumo pela ficha técnica (o que as vendas deveriam ter
// tirado) contra o que a contagem de inventário mostrou. Ver
// ingredientService.relatorioConsumoTeoricoVsReal.

const PERIODOS = [{ dias: 7, rotulo: '7 dias' }, { dias: 30, rotulo: '30 dias' }, { dias: 90, rotulo: '90 dias' }];
const real = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

export function ConsumoTeoricoVsReal() {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState(null);

  const carregar = useCallback(async () => {
    const fim = new Date();
    const inicio = new Date(fim.getTime() - (dias - 1) * 86400000);
    const r = await window.pdv.ingredient.relatorioConsumo({ dataInicio: toISODate(inicio), dataFim: toISODate(fim) });
    setDados(r && Array.isArray(r.itens) ? r : { itens: [], totais: { custoTeorico: 0, custoPerdas: 0, custoDesvio: 0 } });
  }, [dias]);

  useEffect(() => { carregar(); }, [carregar]);

  return (
    <section className="settings-section" style={{ marginTop: 28 }}>
      <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="chart" size={18} /> Consumo pela ficha × inventário</h2>
      <p className="screen-hint">
        Quanto as vendas deveriam ter gasto de cada insumo pela ficha técnica, as perdas registradas e as
        correções de contagem. Correção <strong>negativa</strong> = saiu mais do que a ficha explica (porção maior,
        desperdício não anotado, desvio). Para funcionar, conte o estoque e lance a diferença em "Ajustar estoque → Ajuste".
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {PERIODOS.map((p) => (
          <button key={p.dias} className={p.dias === dias ? 'btn-primary' : 'btn-secondary'} onClick={() => setDias(p.dias)}>{p.rotulo}</button>
        ))}
      </div>
      {!dados ? <p className="screen-hint">Calculando...</p> : dados.itens.length === 0 ? (
        <p className="empty-state">Nenhum consumo de insumo no período (vendas de pratos com ficha técnica aparecem aqui).</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12, fontSize: 14 }}>
            <span>Custo pela ficha: <strong>{real(dados.totais.custoTeorico)}</strong></span>
            <span>Perdas registradas: <strong>{real(dados.totais.custoPerdas)}</strong></span>
            <span>Correções de contagem: <strong style={{ color: dados.totais.custoDesvio < 0 ? 'var(--color-danger)' : undefined }}>{real(dados.totais.custoDesvio)}</strong></span>
          </div>
          <table className="data-table">
            <thead><tr><th>Insumo</th><th style={{ textAlign: 'right' }}>Pela ficha</th><th style={{ textAlign: 'right' }}>Perdas</th><th style={{ textAlign: 'right' }}>Correção de contagem</th><th style={{ textAlign: 'right' }}>Desvio</th><th style={{ textAlign: 'right' }}>Em R$</th></tr></thead>
            <tbody>
              {dados.itens.map((l) => (
                <tr key={l.id}>
                  <td>{l.nome}</td>
                  <td style={{ textAlign: 'right' }}>{num(l.consumoTeorico)} {l.unidade}</td>
                  <td style={{ textAlign: 'right' }}>{num(l.perdas)} {l.unidade}</td>
                  <td style={{ textAlign: 'right', color: l.ajusteInventario < 0 ? 'var(--color-danger)' : undefined }}>{num(l.ajusteInventario)} {l.unidade}</td>
                  <td style={{ textAlign: 'right' }}>{l.desvioPercentual == null ? '—' : `${l.desvioPercentual.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</td>
                  <td style={{ textAlign: 'right', color: l.custoDesvio < 0 ? 'var(--color-danger)' : undefined }}>{real(l.custoDesvio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
