import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';

/**
 * Aba "Personalizados" — depois que um prato/produto personalizado foi
 * vendido (ex: pizza meio-a-meio, porção montada na hora), quase nunca
 * a quantidade de insumo usada foi uma medida exata, só uma estimativa.
 * Aqui dá pra corrigir a quantidade FINAL de cada linha — só a
 * diferença é aplicada no estoque, não o valor inteiro de novo.
 */
export function PersonalizedItemsAdjustment() {
  const { currentUser } = useSession();
  const [dias, setDias] = useState(7);
  const [itens, setItens] = useState(null);
  const [edicoes, setEdicoes] = useState({}); // linhaId -> texto digitado
  const [salvandoItemId, setSalvandoItemId] = useState(null);
  const [mensagens, setMensagens] = useState({}); // saleItemId -> texto de status

  async function reload() {
    const locationId = window.APP_LOCATION_ID;
    const list = await window.pdv.customItem.listarParaAjuste({ locationId, dias });
    setItens(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reload(); }, [dias]);

  function valorAtualDaLinha(linha) {
    if (linha.quantidadeAjustada !== null && linha.quantidadeAjustada !== undefined) return linha.quantidadeAjustada;
    return linha.modo === 'percentual' ? (Number(linha.percentual) || 0) / 100 : (Number(linha.quantidade) || 0);
  }

  function labelQuantidadeOriginal(linha) {
    if (linha.modo === 'percentual') return `${linha.percentual}% de 1 unidade`;
    return `${linha.quantidade} ${linha.unidade}`;
  }

  async function handleSalvarItem(item) {
    const ajustes = item.linhas
      .filter((l) => edicoes[l.id] !== undefined && edicoes[l.id] !== '')
      .map((l) => ({ linhaId: l.id, quantidadeFinal: Number(edicoes[l.id]) }))
      .filter((a) => a.quantidadeFinal >= 0);

    if (ajustes.length === 0) return;

    setSalvandoItemId(item.saleItemId);
    const result = await window.pdv.customItem.ajustar({
      ajustes, operadorId: currentUser.id, locationId: window.APP_LOCATION_ID, deviceId: window.APP_DEVICE_ID,
    });
    setSalvandoItemId(null);
    setMensagens((prev) => ({ ...prev, [item.saleItemId]: result.ok ? 'Ajuste salvo.' : (result.error || 'Erro ao salvar.') }));
    if (result.ok) reload();
  }

  return (
    <div className="screen">
      <h1>🎨 Personalizados</h1>
      <p className="screen-hint">
        Itens personalizados (montados na hora) recentes — informe aqui a quantidade FINAL de cada insumo/produto
        usado, quando ela ficou diferente do estimado no momento da venda. Só a diferença é ajustada no estoque.
      </p>

      <div className="period-selector">
        {[7, 15, 30].map((d) => (
          <button key={d} className={dias === d ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setDias(d)}>
            Últimos {d} dias
          </button>
        ))}
      </div>

      {itens === null && <p className="empty-state">Carregando...</p>}
      {itens !== null && itens.length === 0 && <p className="empty-state">Nenhum item personalizado nesse período.</p>}

      {itens && itens.map((item) => (
        <div key={item.saleItemId} className="modal-card" style={{ maxWidth: 720, marginBottom: 20 }}>
          <h2>{item.nome}</h2>
          <p className="screen-hint" style={{ margin: '0 0 8px' }}>
            {new Date(item.criadoEm + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}
          </p>

          <table className="data-table">
            <thead>
              <tr><th>Componente</th><th>Estimado na venda</th><th>Quantidade final</th></tr>
            </thead>
            <tbody>
              {item.linhas.map((linha) => (
                <tr key={linha.id}>
                  <td>{linha.tipo === 'insumo' ? '🥫' : '📦'} {linha.nome}</td>
                  <td>{labelQuantidadeOriginal(linha)}{linha.quantidadeAjustada !== null && linha.quantidadeAjustada !== undefined ? ' (já ajustado)' : ''}</td>
                  <td>
                    <input
                      type="text" inputMode="decimal" style={{ width: 90 }}
                      placeholder={String(valorAtualDaLinha(linha))}
                      value={edicoes[linha.id] ?? ''}
                      onChange={(e) => setEdicoes((prev) => ({ ...prev, [linha.id]: e.target.value.replace(',', '.') }))}
                    />
                    {' '}{linha.modo === 'percentual' ? '(fração de 1 un.)' : linha.unidade}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {mensagens[item.saleItemId] && <p className="io-message" style={{ margin: '8px 0 0' }}>{mensagens[item.saleItemId]}</p>}

          <div className="modal-actions">
            <button
              type="button" className="btn-primary"
              onClick={() => handleSalvarItem(item)}
              disabled={salvandoItemId === item.saleItemId}
            >
              {salvandoItemId === item.saleItemId ? 'Salvando...' : '💾 Salvar quantidade final'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
