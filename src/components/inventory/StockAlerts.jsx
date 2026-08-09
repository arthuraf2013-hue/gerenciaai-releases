import { useEffect, useState } from 'react';

export function StockAlerts() {
  const [alertas, setAlertas] = useState([]);
  const [previsao, setPrevisao] = useState(null);
  const [margem, setMargem] = useState(null);
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
    window.pdv.stock.previsaoDeRuptura({ locationId: window.APP_LOCATION_ID }).then((list) => {
      setPrevisao(Array.isArray(list) ? list : []);
    });
    window.pdv.products.alertasDeMargem().then((list) => {
      setMargem(Array.isArray(list) ? list : []);
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

      <section className="alert-section">
        <h2>Vai faltar em breve</h2>
        <p className="screen-hint" style={{ margin: '0 0 10px' }}>
          Diferente dos alertas acima (que só disparam depois que o estoque já bateu o mínimo
          configurado), isso olha o ritmo de venda real dos últimos 30 dias — pega produto de venda
          rápida que ainda não bateu o mínimo, mas vai bater em breve no ritmo atual.
        </p>
        {previsao === null && <p className="empty-state">Calculando...</p>}
        {previsao !== null && previsao.length === 0 && <p className="empty-state">Nenhum produto com ruptura prevista pros próximos 7 dias.</p>}
        {previsao !== null && previsao.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Produto</th><th>Estoque atual</th><th>Vendendo por dia</th><th>Acaba em</th></tr></thead>
            <tbody>
              {previsao.map((p) => (
                <tr key={p.id} className={p.diasRestantes <= 2 ? 'row-critical' : 'row-warning'}>
                  <td>{p.nome}</td>
                  <td>{p.estoqueAtual}</td>
                  <td>{p.velocidadeDiaria}</td>
                  <td>{p.diasRestantes === 0 ? 'hoje' : `${p.diasRestantes} dia(s)`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="alert-section">
        <h2>Margem fora do padrão</h2>
        <p className="screen-hint" style={{ margin: '0 0 10px' }}>
          Compara a margem de cada produto com a média da própria categoria dele — pega erro de
          precificação (ex: custo subiu num abastecimento e o preço de venda nunca foi reajustado)
          antes que vire prejuízo acumulado sem ninguém perceber.
        </p>
        {margem === null && <p className="empty-state">Calculando...</p>}
        {margem !== null && margem.length === 0 && <p className="empty-state">Nenhum produto com margem fora do padrão da categoria.</p>}
        {margem !== null && margem.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Produto</th><th>Categoria</th><th>Margem</th><th>Média da categoria</th></tr></thead>
            <tbody>
              {margem.map((p) => (
                <tr key={p.id} className={p.margemNegativa ? 'row-critical' : 'row-warning'}>
                  <td>{p.nome}</td>
                  <td>{p.categoria || '(sem categoria)'}</td>
                  <td>{p.margem}%{p.margemNegativa && ' — prejuízo'}</td>
                  <td>{p.mediaCategoria !== null ? `${p.mediaCategoria}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
