import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

/**
 * @param {{ onFechar: () => void, onExcluido: () => void }} props
 */
export function DuplicateProductsModal({ onFechar, onExcluido }) {
  const [grupos, setGrupos] = useState(null);
  const [selecionados, setSelecionados] = useState(new Set());
  const [excluindo, setExcluindo] = useState(false);
  const [erro, setErro] = useState('');
  useEscToClose(onFechar);

  function carregar() {
    window.pdv.products.findDuplicates().then(setGrupos);
    setSelecionados(new Set());
  }

  useEffect(carregar, []);

  function toggleSelecionado(productId) {
    setSelecionados((prev) => {
      const novo = new Set(prev);
      if (novo.has(productId)) novo.delete(productId); else novo.add(productId);
      return novo;
    });
  }

  function selecionarTodosMenosOMaior(grupo) {
    // Marca todos do grupo pra excluir, exceto o de maior estoque —
    // um jeito rápido de "limpar" um grupo inteiro de uma vez, sem
    // precisar clicar item por item.
    const maiorEstoque = [...grupo].sort((a, b) => b.estoque_atual - a.estoque_atual)[0];
    setSelecionados((prev) => {
      const novo = new Set(prev);
      grupo.forEach((p) => { if (p.id !== maiorEstoque.id) novo.add(p.id); });
      return novo;
    });
  }

  function selecionarTodosOsDuplicados() {
    // Aplica a mesma lógica (mantém o de maior estoque) em TODOS os
    // grupos de uma vez.
    const novo = new Set();
    grupos.forEach((grupo) => {
      const maiorEstoque = [...grupo].sort((a, b) => b.estoque_atual - a.estoque_atual)[0];
      grupo.forEach((p) => { if (p.id !== maiorEstoque.id) novo.add(p.id); });
    });
    setSelecionados(novo);
  }

  async function handleExcluirSelecionados() {
    if (selecionados.size === 0) return;
    if (!confirm(`Excluir ${selecionados.size} produto(s) selecionado(s)? O estoque deles NÃO é somado em outro produto — some sozinho antes, se precisar manter a quantidade. Não pode ser desfeito.`)) return;

    setExcluindo(true);
    setErro('');
    for (const productId of selecionados) {
      const result = await window.pdv.products.deactivate({ productId });
      if (!result.ok) { setErro(result.error); setExcluindo(false); return; }
    }
    setExcluindo(false);
    carregar();
    onExcluido?.();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ maxWidth: 700 }}>
        <h2>Produtos duplicados</h2>
        <p className="screen-hint" style={{ margin: '0 0 12px' }}>
          Produtos com o mesmo nome — comum quando duas máquinas sincronizadas cadastram
          "o mesmo" produto de forma independente. Marque os que quer excluir e confirme —
          <strong> o estoque deles não é somado em nenhum outro produto</strong>, é só removido.
        </p>
        {erro && <p className="modal-error">{erro}</p>}
        {grupos === null && <p className="empty-state">Carregando...</p>}
        {grupos !== null && grupos.length === 0 && <p className="empty-state">Nenhum produto duplicado encontrado.</p>}

        {grupos && grupos.length > 0 && (
          <button className="btn-link" style={{ marginBottom: 12 }} onClick={selecionarTodosOsDuplicados}>
            Selecionar todos os duplicados (mantém o de maior estoque em cada grupo)
          </button>
        )}

        {grupos && grupos.map((grupo, indice) => (
          <div key={indice} className="screen-section-box" style={{ margin: '0 0 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{grupo[0].nome}</strong>
              <button className="btn-link" onClick={() => selecionarTodosMenosOMaior(grupo)}>Selecionar este grupo</button>
            </div>
            <table className="data-table" style={{ marginTop: 8 }}>
              <thead><tr><th></th><th>Preço</th><th>Estoque</th><th>Mín.</th></tr></thead>
              <tbody>
                {grupo.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox" style={{ width: 'auto' }}
                          checked={selecionados.has(p.id)}
                          onChange={() => toggleSelecionado(p.id)}
                        />
                        excluir
                      </label>
                    </td>
                    <td>R$ {p.preco.toFixed(2)}</td>
                    <td>{p.estoque_atual}</td>
                    <td>{p.estoque_minimo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onFechar}>Fechar</button>
          {grupos && grupos.length > 0 && (
            <button type="button" className="btn-primary" disabled={excluindo || selecionados.size === 0} onClick={handleExcluirSelecionados}>
              {excluindo ? 'Excluindo...' : `Excluir ${selecionados.size} selecionado(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
