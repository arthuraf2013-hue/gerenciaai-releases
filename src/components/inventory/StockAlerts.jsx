import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

export function StockAlerts() {
  const [alertas, setAlertas] = useState([]);
  const [previsao, setPrevisao] = useState(null);
  const [margem, setMargem] = useState(null);
  const [descontos, setDescontos] = useState(null);
  const [loadError, setLoadError] = useState('');

  function carregarDescontos() {
    window.pdv.stock.sugestoesDescontoValidade({ locationId: window.APP_LOCATION_ID }).then((list) => {
      setDescontos(Array.isArray(list) ? list : []);
    });
  }

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
    carregarDescontos();
  }, []);

  async function handleAplicarDesconto(p) {
    await window.pdv.products.aplicarDescontoValidade({ productId: p.id, precoPromocional: p.precoSugerido, validoAte: p.validade });
    carregarDescontos();
  }

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

  // Cada tipo de alerta numa lista: o topo mostra a contagem de todos, só os
  // que têm algo aparecem abertos e os vazios viram uma linha "tudo certo"
  // -- antes eram cinco seções grandes mesmo sem nada para mostrar.
  const secoes = [
    {
      id: 'critico', titulo: 'Crítico', icone: 'warning', classe: 'resumo-alerta-critico', lista: criticos,
      corpo: () => renderTabela(criticos, ''),
    },
    {
      id: 'aviso', titulo: 'Aviso', icone: 'warning', classe: 'resumo-alerta-aviso', lista: avisos,
      corpo: () => renderTabela(avisos, ''),
    },
    {
      id: 'faltar', titulo: 'Vai faltar em breve', icone: 'hourglass', classe: 'resumo-alerta-aviso', lista: previsao,
      explicacao: 'Usa o ritmo de venda real dos últimos 30 dias: pega o produto que ainda não bateu o mínimo, mas vai bater nos próximos 7 dias.',
      corpo: () => (
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
      ),
    },
    {
      id: 'margem', titulo: 'Margem fora do padrão', icone: 'chart', classe: 'resumo-alerta-aviso', lista: margem,
      explicacao: 'Compara a margem de cada produto com a média da categoria: pega custo que subiu num abastecimento e preço que não acompanhou.',
      corpo: () => (
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
      ),
    },
    {
      id: 'validade', titulo: 'Descontar por validade', icone: 'tag', classe: 'resumo-alerta-aviso', lista: descontos,
      explicacao: 'Produto vencendo logo: um clique aplica o desconto sugerido, e o preço volta sozinho depois da data.',
      corpo: () => (
        <table className="data-table">
          <thead><tr><th>Produto</th><th>Vence em</th><th>Preço normal</th><th>Preço sugerido ({descontos[0].percentualSugerido}% off)</th><th></th></tr></thead>
          <tbody>
            {descontos.map((p) => (
              <tr key={p.id} className="row-warning">
                <td>{p.nome}</td>
                <td>{new Date(p.validade + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                <td>R$ {p.preco.toFixed(2)}</td>
                <td>R$ {p.precoSugerido.toFixed(2)}</td>
                <td><button className="btn-link" onClick={() => handleAplicarDesconto(p)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="checkCircle" size={14} /> Aplicar desconto</span>
                </button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    },
  ];
  const comItens = secoes.filter((sec) => Array.isArray(sec.lista) && sec.lista.length > 0);
  const vazias = secoes.filter((sec) => Array.isArray(sec.lista) && sec.lista.length === 0);
  const calculando = secoes.some((sec) => sec.lista === null);

  return (
    <div className="screen">
      <h1><Icon name="warning" size={20} /> Alertas de estoque</h1>
      <p className="screen-hint">
        Os limites de crítico e aviso são os de Configurações → Perfis de negócio (os mesmos da cor do alerta no carrinho do PDV).
      </p>

      {loadError && <p className="modal-error">{loadError}</p>}

      <div className="resumo-alertas">
        {secoes.map((sec) => {
          const n = Array.isArray(sec.lista) ? sec.lista.length : null;
          return (
            <a key={sec.id} href={n ? `#alerta-${sec.id}` : undefined}
              className={n ? `resumo-alerta ${sec.classe}` : 'resumo-alerta resumo-alerta-ok'}>
              <Icon name={sec.icone} size={16} />
              <span>{sec.titulo}</span>
              <strong>{n === null ? '…' : n}</strong>
            </a>
          );
        })}
      </div>

      {comItens.map((sec) => (
        <section className="alert-section" key={sec.id} id={`alerta-${sec.id}`}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name={sec.icone} size={16} /> {sec.titulo} ({sec.lista.length})</h2>
          {sec.explicacao && <p className="screen-hint" style={{ margin: '0 0 10px' }}>{sec.explicacao}</p>}
          {sec.corpo()}
        </section>
      ))}

      {calculando && <p className="empty-state">Calculando os alertas…</p>}
      {!calculando && comItens.length === 0 && (
        <div className="vazio-guia"><Icon name="checkCircle" size={22} /><span><strong>Nada para resolver agora.</strong> Estoque, margens e validades dentro do esperado.</span></div>
      )}
      {vazias.length > 0 && comItens.length > 0 && (
        <p className="screen-hint" style={{ marginTop: 4 }}>
          <Icon name="checkCircle" size={14} /> Tudo certo em: {vazias.map((sec) => sec.titulo).join(', ')}.
        </p>
      )}
    </div>
  );
}
