import { useEffect, useState } from 'react';

export function StockAlerts() {
  const [alertas, setAlertas] = useState([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    window.pdv.stock.listAlerts({ locationId: window.APP_LOCATION_ID }).then((list) => {
      if (!Array.isArray(list)) {
        setAlertas([]);
        setLoadError(list?.error || 'Não foi possível carregar os alertas.');
        return;
      }
      setLoadError('');
      setAlertas(list);
    });
  }, []);

  const criticos = alertas.filter((p) => p.alerta.nivel === 'critico');
  const avisos = alertas.filter((p) => p.alerta.nivel === 'aviso');

  function renderTabela(lista, vazio) {
    if (lista.length === 0) return <p className="empty-state">{vazio}</p>;
    return (
      <table className="data-table">
        <thead><tr><th>Produto</th><th>Motivo</th></tr></thead>
        <tbody>
          {lista.map((p) => (
            <tr key={p.id} className={p.alerta.nivel === 'critico' ? 'row-critical' : 'row-warning'}>
              <td>{p.nome}</td>
              <td>{p.alerta.motivos.join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="screen">
      <h1>Alertas de estoque</h1>
      <p className="screen-hint">
        Mesmos limiares configurados em Configurações → Perfis de negócio, que também definem a cor
        do ícone de alerta no carrinho do PDV.
      </p>

      {loadError && <p className="modal-error">{loadError}</p>}

      <section className="alert-section">
        <h2>Crítico</h2>
        {renderTabela(criticos, 'Nenhum produto em estado crítico.')}
      </section>

      <section className="alert-section">
        <h2>Aviso</h2>
        {renderTabela(avisos, 'Nenhum produto em aviso.')}
      </section>
    </div>
  );
}
