import { useEffect, useMemo, useState } from 'react';
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
    setGrupos(null);
    window.pdv.products.findDuplicates().then(setGrupos);
    setSelecionados(new Set());
  }

  useEffect(carregar, []);

  // Uma lista única, "achatada", em vez de uma tabela por grupo —
  // com muitos grupos (centenas) isso fica bem mais rápido de
  // renderizar e mais fácil de rolar/escanear que várias tabelas
  // pequenas empilhadas.
  const totalProdutos = useMemo(() => grupos ? grupos.reduce((acc, g) => acc + g.length, 0) : 0, [grupos]);

  // Sugestão padrão de seleção: em cada grupo, marca todos MENOS o
  // candidato mais razoável a manter. Prioriza manter quem TEM
  // código de barras (perder isso é pior que perder um pouco de
  // estoque, já que o código não é somado em lugar nenhum ao
  // excluir) — só usa estoque como desempate entre produtos que
  // estão empatados nisso (ambos com código, ou ambos sem).
  const sugestaoDeSelecao = useMemo(() => {
    if (!grupos) return new Set();
    const novo = new Set();
    grupos.forEach((grupo) => {
      const melhorCandidato = [...grupo].sort((a, b) => {
        const temCodigoA = a.codigo_barras ? 1 : 0;
        const temCodigoB = b.codigo_barras ? 1 : 0;
        if (temCodigoA !== temCodigoB) return temCodigoB - temCodigoA;
        return b.estoque_atual - a.estoque_atual;
      })[0];
      grupo.forEach((p) => { if (p.id !== melhorCandidato.id) novo.add(p.id); });
    });
    return novo;
  }, [grupos]);

  function toggleSelecionado(productId) {
    setSelecionados((prev) => {
      const novo = new Set(prev);
      if (novo.has(productId)) novo.delete(productId); else novo.add(productId);
      return novo;
    });
  }

  function selecionarTodosOsDuplicados() {
    setSelecionados(new Set(sugestaoDeSelecao));
  }

  function limparSelecao() {
    setSelecionados(new Set());
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
      <div className="modal-card modal-card-fullscreen">
        <div>
          <h2>Produtos duplicados{grupos && grupos.length > 0 ? ` — ${grupos.length} grupos, ${totalProdutos} produtos` : ''}</h2>
          <p className="screen-hint" style={{ margin: '4px 0 12px' }}>
            Produtos com o mesmo nome — comum quando duas máquinas sincronizadas cadastram
            "o mesmo" produto de forma independente. Marque os que quer excluir e confirme —
            <strong> o estoque deles não é somado em nenhum outro produto</strong>, é só removido.
          </p>
          {erro && <p className="modal-error">{erro}</p>}
          {grupos && grupos.length > 0 && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8 }}>
              <button className="btn-primary" onClick={selecionarTodosOsDuplicados}>
                Selecionar todos ({sugestaoDeSelecao.size}) — mantém quem tem código de barras (desempate por estoque)
              </button>
              <button className="btn-link" onClick={limparSelecao}>Limpar seleção</button>
              <span className="screen-hint">{selecionados.size} selecionado(s)</span>
            </div>
          )}
        </div>

        <div className="modal-card-fullscreen-scroll">
          {grupos === null && <p className="empty-state">Carregando...</p>}
          {grupos !== null && grupos.length === 0 && <p className="empty-state">Nenhum produto duplicado encontrado.</p>}
          {grupos && grupos.length > 0 && (
            <table className="data-table">
              <thead>
                <tr><th></th><th>Nome</th><th>Código de barras</th><th>Preço</th><th>Estoque</th><th>Mín.</th></tr>
              </thead>
              <tbody>
                {grupos.map((grupo, indiceGrupo) => (
                  grupo.map((p, indiceNoGrupo) => (
                    <tr key={p.id} style={indiceNoGrupo === 0 && indiceGrupo > 0 ? { borderTop: '2px solid var(--color-border)' } : undefined}>
                      <td>
                        <input
                          type="checkbox" style={{ width: 'auto' }}
                          checked={selecionados.has(p.id)}
                          onChange={() => toggleSelecionado(p.id)}
                        />
                      </td>
                      <td>{p.nome}</td>
                      <td>{p.codigo_barras || <span className="screen-hint">(sem código)</span>}</td>
                      <td>R$ {p.preco.toFixed(2)}</td>
                      <td>{p.estoque_atual}</td>
                      <td>{p.estoque_minimo}</td>
                    </tr>
                  ))
                ))}
              </tbody>
            </table>
          )}
        </div>

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
