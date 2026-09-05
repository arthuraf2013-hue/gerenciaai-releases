import { useEffect, useMemo, useState } from 'react';
import Icon from '../common/Icon';

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Consulta rápida de preço de serviço — pra checar na hora (ex: cliente
 * perguntando quanto custa tal serviço) sem precisar abrir o cadastro
 * de produto. Mesma fonte de dados da Tabela de Preços (ver
 * ServicePriceTableScreen), só que em app, com busca, pra quem está no
 * balcão/salão e precisa da resposta rápida. */
export function ServiceQuickLookupScreen() {
  const [itens, setItens] = useState(null);
  const [busca, setBusca] = useState('');

  async function reload() {
    const list = await window.pdv.products.listServicePriceTable();
    setItens(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reload(); }, []);

  const grupos = useMemo(() => {
    const termo = normalizarTexto(busca);
    const filtrados = (itens || []).filter((s) => !termo || normalizarTexto(s.nome).includes(termo) || normalizarTexto(s.tipo).includes(termo));
    const acc = {};
    for (const item of filtrados) {
      const chave = item.tipo || 'Serviços';
      if (!acc[chave]) acc[chave] = [];
      acc[chave].push(item);
    }
    return acc;
  }, [itens, busca]);

  const totalFiltrado = Object.values(grupos).reduce((soma, lista) => soma + lista.length, 0);

  return (
    <div className="screen">
      <h1><Icon name="search" size={18} /> Consulta Rápida</h1>
      <p className="screen-hint">
        Preço de cada serviço cadastrado (mão de obra) — busque por nome ou tipo. "a partir de"
        indica que o serviço tem material associado que pode somar ao valor final, dependendo do
        que for usado no atendimento.
      </p>

      <input
        type="text" placeholder="Buscar serviço ou tipo..." value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{ maxWidth: 360, marginBottom: 16 }}
        autoFocus
      />

      {itens === null && <p className="empty-state">Carregando...</p>}
      {itens !== null && itens.length === 0 && (
        <p className="empty-state">Nenhum serviço com "Tipo de serviço" cadastrado ainda — preencha esse campo no cadastro do produto pra ele aparecer aqui.</p>
      )}
      {itens !== null && itens.length > 0 && totalFiltrado === 0 && <p className="empty-state">Nenhum serviço encontrado pra "{busca}".</p>}

      {Object.entries(grupos).map(([tipo, servicos]) => (
        <div key={tipo} style={{ marginTop: 20 }}>
          <h2 style={{ marginBottom: 8 }}>{tipo}</h2>
          <table className="data-table">
            <tbody>
              {servicos.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontSize: 16 }}>{s.nome}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 18, whiteSpace: 'nowrap' }}>
                    {s.precoVariavel && <span className="screen-hint" style={{ fontWeight: 400, marginRight: 4 }}>a partir de</span>}
                    R$ {s.preco.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
