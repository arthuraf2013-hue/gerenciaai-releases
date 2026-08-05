import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

export function CategoryManager() {
  const [categorias, setCategorias] = useState(null);
  const [showNovo, setShowNovo] = useState(false);
  const [novoNome, setNovoNome] = useState('');
  const [editando, setEditando] = useState(null); // { nome, novoNome } | null
  const [excluindo, setExcluindo] = useState(null); // { nome, totalProdutos, moverPara } | null
  const [erro, setErro] = useState('');
  const [sugestoesIA, setSugestoesIA] = useState(null); // null = fechado, [] = revisão aberta
  const [selecionadosIA, setSelecionadosIA] = useState(new Set());
  const [carregandoIA, setCarregandoIA] = useState(false);
  const [aplicandoIA, setAplicandoIA] = useState(false);
  const [erroIA, setErroIA] = useState('');
  useEscToClose(() => { setShowNovo(false); setEditando(null); setExcluindo(null); setSugestoesIA(null); });

  function carregar() {
    window.pdv.categories.list().then(setCategorias);
  }
  useEffect(carregar, []);

  async function handleCriar(e) {
    e.preventDefault();
    setErro('');
    const result = await window.pdv.categories.create({ nome: novoNome });
    if (!result.ok) return setErro(result.error);
    setNovoNome('');
    setShowNovo(false);
    carregar();
  }

  async function handleRenomear(e) {
    e.preventDefault();
    setErro('');
    const result = await window.pdv.categories.rename({ nomeAntigo: editando.nome, nomeNovo: editando.novoNome });
    if (!result.ok) return setErro(result.error);
    setEditando(null);
    carregar();
  }

  async function handleExcluir(e) {
    e.preventDefault();
    await window.pdv.categories.remove({ nome: excluindo.nome, moverParaCategoria: excluindo.moverPara || null });
    setExcluindo(null);
    carregar();
  }

  async function handleSugerirComIA() {
    setCarregandoIA(true);
    setErroIA('');
    const result = await window.pdv.categories.sugerirComIA({});
    setCarregandoIA(false);
    if (!result.ok) return setErroIA(result.error);
    if (result.sugestoes.length === 0) {
      setErroIA(result.totalSemCategoria === 0 ? 'Todos os produtos já têm categoria.' : 'A IA não teve confiança suficiente pra sugerir nenhuma categoria dessa vez.');
      return;
    }
    setSugestoesIA(result.sugestoes);
    setSelecionadosIA(new Set(result.sugestoes.map((s) => s.produtoId)));
  }

  function toggleSugestao(produtoId) {
    setSelecionadosIA((prev) => {
      const novo = new Set(prev);
      if (novo.has(produtoId)) novo.delete(produtoId); else novo.add(produtoId);
      return novo;
    });
  }

  function editarCategoriaSugerida(produtoId, novaCategoria) {
    setSugestoesIA((prev) => prev.map((s) => s.produtoId === produtoId ? { ...s, categoriaSugerida: novaCategoria } : s));
  }

  async function handleAplicarSugestoes() {
    const aceitas = sugestoesIA.filter((s) => selecionadosIA.has(s.produtoId));
    if (aceitas.length === 0) return;
    setAplicandoIA(true);
    await window.pdv.categories.aplicarSugestoes(aceitas);
    setAplicandoIA(false);
    setSugestoesIA(null);
    carregar();
  }

  return (
    <div>
      <div className="screen-header">
        <h1>Categorias</h1>
        <div className="screen-actions">
          <button className="btn-secondary" onClick={handleSugerirComIA} disabled={carregandoIA}>
            {carregandoIA ? 'Consultando produtos...' : '✨ Categorizar produtos sem categoria com IA'}
          </button>
          <button className="btn-primary" onClick={() => setShowNovo(true)}>+ Nova categoria</button>
        </div>
      </div>
      {erroIA && <p className="modal-error">{erroIA}</p>}
      <p className="screen-hint">
        Categorias organizam os produtos no PDV (os botões de navegação por categoria) e nos relatórios.
      </p>

      {categorias === null && <p className="empty-state">Carregando...</p>}
      {categorias !== null && categorias.length === 0 && <p className="empty-state">Nenhuma categoria ainda.</p>}
      {categorias && categorias.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Nome</th><th>Produtos</th><th></th></tr></thead>
          <tbody>
            {categorias.map((c) => (
              <tr key={c.nome}>
                <td>{c.nome}</td>
                <td>{c.totalProdutos}</td>
                <td>
                  <button className="btn-link" onClick={() => setEditando({ nome: c.nome, novoNome: c.nome })}>Editar</button>
                  <button className="btn-link-danger" style={{ marginLeft: 12 }} onClick={() => setExcluindo({ nome: c.nome, totalProdutos: c.totalProdutos, moverPara: '' })}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNovo && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleCriar}>
              <h2>Nova categoria</h2>
              <label>
                Nome
                <input autoFocus value={novoNome} onChange={(e) => setNovoNome(e.target.value)} required />
              </label>
              {erro && <p className="modal-error">{erro}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => { setShowNovo(false); setErro(''); }}>Cancelar</button>
                <button type="submit" className="btn-primary">Criar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editando && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleRenomear}>
              <h2>Renomear categoria</h2>
              <p className="screen-hint" style={{ margin: '0 0 8px' }}>
                Atualiza automaticamente em todos os produtos que usam "{editando.nome}".
              </p>
              <label>
                Novo nome
                <input autoFocus value={editando.novoNome} onChange={(e) => setEditando({ ...editando, novoNome: e.target.value })} required />
              </label>
              {erro && <p className="modal-error">{erro}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => { setEditando(null); setErro(''); }}>Cancelar</button>
                <button type="submit" className="btn-primary">Salvar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {excluindo && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleExcluir}>
              <h2>Excluir categoria "{excluindo.nome}"</h2>
              {excluindo.totalProdutos > 0 ? (
                <>
                  <p className="modal-warning">
                    {excluindo.totalProdutos} produto(s) usam essa categoria. Escolha pra onde eles vão:
                  </p>
                  <label>
                    Mover produtos pra outra categoria (opcional — deixe vazio pra ficarem sem categoria)
                    <select value={excluindo.moverPara} onChange={(e) => setExcluindo({ ...excluindo, moverPara: e.target.value })}>
                      <option value="">(sem categoria)</option>
                      {categorias.filter((c) => c.nome !== excluindo.nome).map((c) => (
                        <option key={c.nome} value={c.nome}>{c.nome}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <p className="screen-hint">Nenhum produto usa essa categoria — pode excluir direto.</p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setExcluindo(null)}>Cancelar</button>
                <button type="submit" className="btn-primary">Excluir</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {sugestoesIA && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-fullscreen">
            <div>
              <h2>Revisar sugestões da IA — {sugestoesIA.length} produto(s)</h2>
              <p className="screen-hint" style={{ margin: '4px 0 12px' }}>
                Confira antes de aplicar — desmarque o que não fizer sentido, ou edite a categoria sugerida.
                Só o que estiver marcado é salvo.
              </p>
            </div>
            <div className="modal-card-fullscreen-scroll">
              <table className="data-table">
                <thead><tr><th></th><th>Produto</th><th>Categoria sugerida</th></tr></thead>
                <tbody>
                  {sugestoesIA.map((s) => (
                    <tr key={s.produtoId}>
                      <td>
                        <input type="checkbox" style={{ width: 'auto' }} checked={selecionadosIA.has(s.produtoId)} onChange={() => toggleSugestao(s.produtoId)} />
                      </td>
                      <td>{s.produtoNome}</td>
                      <td>
                        <input value={s.categoriaSugerida} onChange={(e) => editarCategoriaSugerida(s.produtoId, e.target.value)} style={{ maxWidth: 220 }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setSugestoesIA(null)}>Cancelar</button>
              <button type="button" className="btn-primary" disabled={aplicandoIA || selecionadosIA.size === 0} onClick={handleAplicarSugestoes}>
                {aplicandoIA ? 'Aplicando...' : `Aplicar ${selecionadosIA.size} selecionado(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
