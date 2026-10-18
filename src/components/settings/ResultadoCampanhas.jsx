import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Quanto a reconquista e o cupom de aniversário trouxeram de volta
// (whatsappAutomationService.resultadoCampanhas).

const real = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const NOMES = { reconquista: 'Reconquista de cliente que sumiu', aniversario: 'Cupom de aniversário' };

export function ResultadoCampanhas() {
  const [dados, setDados] = useState(null);
  useEffect(() => {
    window.pdv.whatsappAutomation.resultadoCampanhas?.({ dias: 30, janelaDias: 15 })
      .then((r) => { if (r?.porTipo) setDados(r); }).catch(() => {});
  }, []);
  if (!dados) return null;
  const tipos = Object.entries(dados.porTipo).filter(([, t]) => t.enviados > 0);
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 6px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="chart" size={15} /> Resultado nos últimos {dados.dias} dias</h3>
      {tipos.length === 0 ? (
        <p className="screen-hint" style={{ margin: 0 }}>Nenhuma mensagem automática enviada no período.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Campanha</th><th style={{ textAlign: 'right' }}>Clientes avisados</th><th style={{ textAlign: 'right' }}>Voltaram em até {dados.janelaDias} dias</th><th style={{ textAlign: 'right' }}>Vendas desses clientes</th></tr></thead>
          <tbody>
            {tipos.map(([tipo, t]) => (
              <tr key={tipo}>
                <td>{NOMES[tipo] || tipo}</td>
                <td style={{ textAlign: 'right' }}>{t.enviados}</td>
                <td style={{ textAlign: 'right' }}>{t.voltaram} ({t.enviados ? Math.round((t.voltaram / t.enviados) * 100) : 0}%)</td>
                <td style={{ textAlign: 'right' }}><strong>{real(t.receita)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="screen-hint" style={{ marginTop: 6 }}>Conta quem comprou depois da mensagem — não prova que voltou por causa dela.</p>
    </div>
  );
}
