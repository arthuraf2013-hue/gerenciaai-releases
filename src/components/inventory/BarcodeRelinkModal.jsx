import { useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

export function BarcodeRelinkModal({ onFechar, onAplicado }) {
  const [relatorio, setRelatorio] = useState(null); // null = ainda não escolheu arquivo
  const [selecionados, setSelecionados] = useState(new Set());
  const [carregando, setCarregando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [erro, setErro] = useState('');
  const [resultadoAplicado, setResultadoAplicado] = useState(null);
  useEscToClose(onFechar);

  async function handleEscolherPlanilha() {
    setCarregando(true);
    setErro('');
    const result = await window.pdv.io.prepararRevinculacaoCodigosBarras();
    setCarregando(false);
    if (result.canceled) return;
    if (!result.ok) return setErro(result.error);
    setRelatorio(result);
    setSelecionados(new Set(result.casados.map((c) => c.productId)));
  }

  async function handleBuscarViaGrupo() {
    setCarregando(true);
    setErro('');
    const result = await window.pdv.productSync.prepararRevinculacaoViaGrupo();
    setCarregando(false);
    if (!result.ok) return setErro(result.error);
    setRelatorio(result);
    setSelecionados(new Set(result.casados.map((c) => c.productId)));
  }

  function toggleSelecionado(productId) {
    setSelecionados((prev) => {
      const novo = new Set(prev);
      if (novo.has(productId)) novo.delete(productId); else novo.add(productId);
      return novo;
    });
  }

  async function handleAplicar() {
    const aceitos = relatorio.casados.filter((c) => selecionados.has(c.productId));
    if (aceitos.length === 0) return;
    setAplicando(true);
    const result = await window.pdv.io.aplicarRevinculacaoCodigosBarras(aceitos);
    setAplicando(false);
    setResultadoAplicado(result);
    onAplicado?.();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-fullscreen">
        <div>
          <h2><Icon name="link" size={18} /> Re-vincular códigos de barras de uma planilha antiga</h2>
          <p className="screen-hint" style={{ margin: '4px 0 12px' }}>
            Casa cada linha da planilha com o produto existente <strong>pelo nome</strong> —
            nunca cria produto novo, só preenche o código de barras de quem já existe aqui.
            Aceita as colunas em qualquer nome parecido com "nome"/"produto" e
            "codigo_barras"/"codigo"/"ean".
          </p>
          {erro && <p className="modal-error">{erro}</p>}
        </div>

        {relatorio === null && (
          <div className="modal-card-fullscreen-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <button className="btn-primary" onClick={handleBuscarViaGrupo} disabled={carregando}>
              {carregando ? 'Consultando...' : <><Icon name="search" size={16} /> Buscar automaticamente no grupo sincronizado</>}
            </button>
            <p className="screen-hint">Se essa máquina já sincronizou com outra que ainda tem os códigos certos — mais rápido, sem precisar de arquivo nenhum.</p>
            <div style={{ margin: '8px 0', color: 'var(--color-text-muted)' }}>ou</div>
            <button className="btn-secondary" onClick={handleEscolherPlanilha} disabled={carregando}>
              {carregando ? 'Lendo planilha...' : <><Icon name="attachment" size={16} /> Escolher planilha antiga</>}
            </button>
          </div>
        )}

        {relatorio !== null && resultadoAplicado === null && (
          <>
            <div className="modal-card-fullscreen-scroll">
              <p className="screen-hint">
                {relatorio.totalLinhas} linha(s) na planilha — {relatorio.casados.length} produto(s)
                encontrado(s) pra re-vincular, {relatorio.naoEncontrados.length} não encontrado(s),
                {relatorio.ambiguos.length > 0 && ` ${relatorio.ambiguos.length} ambíguo(s) (mais de um produto local com esse nome),`}
                {relatorio.conflitos.length > 0 && ` ${relatorio.conflitos.length} pulado(s) por conflito (código já usado por outro produto).`}
              </p>

              {relatorio.casados.length > 0 && (
                <table className="data-table">
                  <thead><tr><th></th><th>Produto</th><th>Código antigo (aqui)</th><th>Código novo (da planilha)</th></tr></thead>
                  <tbody>
                    {relatorio.casados.map((c) => (
                      <tr key={c.productId}>
                        <td><input type="checkbox" style={{ width: 'auto' }} checked={selecionados.has(c.productId)} onChange={() => toggleSelecionado(c.productId)} /></td>
                        <td>{c.nomeAtual}</td>
                        <td>{c.codigoBarrasAntigo || <span className="screen-hint">(vazio)</span>}</td>
                        <td>{c.codigoBarrasNovo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {relatorio.naoEncontrados.length > 0 && (
                <details style={{ marginTop: 16 }}>
                  <summary>Não encontrados na base local ({relatorio.naoEncontrados.length})</summary>
                  <ul>
                    {relatorio.naoEncontrados.map((n, i) => <li key={i}>{n.nomePlanilha} — {n.codigoPlanilha}</li>)}
                  </ul>
                </details>
              )}
              {relatorio.conflitos.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary>Pulados por conflito ({relatorio.conflitos.length})</summary>
                  <ul>
                    {relatorio.conflitos.map((c, i) => <li key={i}>{c.nomePlanilha} — código {c.codigoPlanilha} já pertence a "{c.jaPertenceA}"</li>)}
                  </ul>
                </details>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onFechar}><Icon name="close" size={16} /> Fechar</button>
              {relatorio.casados.length > 0 && (
                <button type="button" className="btn-primary" disabled={aplicando || selecionados.size === 0} onClick={handleAplicar}>
                  {aplicando ? 'Aplicando...' : <><Icon name="link" size={16} /> Re-vincular {selecionados.size} produto(s)</>}
                </button>
              )}
            </div>
          </>
        )}

        {resultadoAplicado !== null && (
          <>
            <div className="modal-card-fullscreen-scroll">
              <p>{resultadoAplicado.aplicados} produto(s) re-vinculado(s) com sucesso.</p>
              {resultadoAplicado.ignoradosPorConflito.length > 0 && (
                <p className="modal-warning">
                  {resultadoAplicado.ignoradosPorConflito.length} pulado(s) na hora de aplicar — o código já tinha sido usado por outro produto nesse meio tempo.
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-primary" onClick={onFechar}><Icon name="close" size={16} /> Fechar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
