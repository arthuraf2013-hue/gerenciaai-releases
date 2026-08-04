import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

/**
 * @param {{ onFechar: () => void, onMesclado: () => void, currentUserId: string }} props
 */
export function DuplicateProductsModal({ onFechar, onMesclado, currentUserId }) {
  const [grupos, setGrupos] = useState(null);
  const [selecionados, setSelecionados] = useState({}); // índice do grupo -> productId a manter
  const [mesclando, setMesclando] = useState(null);
  const [erro, setErro] = useState('');
  useEscToClose(onFechar);

  function carregar() {
    window.pdv.products.findDuplicates().then((lista) => {
      setGrupos(lista);
      // pré-seleciona o que tem mais estoque como sugestão de qual manter
      const padrao = {};
      lista.forEach((grupo, i) => {
        const maiorEstoque = [...grupo].sort((a, b) => b.estoque_atual - a.estoque_atual)[0];
        padrao[i] = maiorEstoque.id;
      });
      setSelecionados(padrao);
    });
  }

  useEffect(carregar, []);

  async function handleMesclar(grupo, indice) {
    const manterId = selecionados[indice];
    const outros = grupo.filter((p) => p.id !== manterId);
    setMesclando(indice);
    setErro('');
    for (const produto of outros) {
      const result = await window.pdv.products.merge({ manterId, removerId: produto.id, currentOperatorId: currentUserId });
      if (!result.ok) { setErro(result.error); setMesclando(null); return; }
    }
    setMesclando(null);
    carregar();
    onMesclado?.();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ maxWidth: 700 }}>
        <h2>Produtos duplicados</h2>
        <p className="screen-hint" style={{ margin: '0 0 12px' }}>
          Produtos com o mesmo nome — comum quando duas máquinas sincronizadas cadastram
          "o mesmo" produto de forma independente antes de nunca terem sincronizado.
          Escolha qual manter — o estoque e o histórico de vendas do outro são somados
          automaticamente nele, nada se perde.
        </p>
        {erro && <p className="modal-error">{erro}</p>}
        {grupos === null && <p className="empty-state">Carregando...</p>}
        {grupos !== null && grupos.length === 0 && <p className="empty-state">Nenhum produto duplicado encontrado.</p>}
        {grupos && grupos.map((grupo, indice) => (
          <div key={indice} className="screen-section-box" style={{ margin: '0 0 16px' }}>
            <strong>{grupo[0].nome}</strong>
            <table className="data-table" style={{ marginTop: 8 }}>
              <thead><tr><th></th><th>Preço</th><th>Estoque</th><th>Mín.</th></tr></thead>
              <tbody>
                {grupo.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <input
                          type="radio" style={{ width: 'auto' }}
                          checked={selecionados[indice] === p.id}
                          onChange={() => setSelecionados({ ...selecionados, [indice]: p.id })}
                        />
                        manter este
                      </label>
                    </td>
                    <td>R$ {p.preco.toFixed(2)}</td>
                    <td>{p.estoque_atual}</td>
                    <td>{p.estoque_minimo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn-primary" style={{ marginTop: 8 }} disabled={mesclando === indice} onClick={() => handleMesclar(grupo, indice)}>
              {mesclando === indice ? 'Mesclando...' : `Mesclar em 1 produto (soma o estoque de ${grupo.length})`}
            </button>
          </div>
        ))}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
