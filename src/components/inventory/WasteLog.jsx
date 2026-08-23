import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { toISODate } from '../../utils/date';
import Icon from '../common/Icon';

const MOTIVOS_SUGERIDOS = ['Sobrou do prato do dia', 'Venceu / estragou', 'Erro de preparo', 'Cliente devolveu', 'Outro'];

export function WasteLog() {
  const { currentUser } = useSession();
  const [registros, setRegistros] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [periodo, setPeriodo] = useState('hoje');
  const [loadError, setLoadError] = useState('');
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  async function handleExport() {
    setExportando(true);
    setExportMsg('');
    const { dataInicio, dataFim } = datasDoPeriodo();
    const result = await window.pdv.report.exportWaste({ locationId: window.APP_LOCATION_ID, dataInicio, dataFim });
    setExportando(false);
    if (result.canceled) return;
    setExportMsg(result.ok ? `${result.total} registro(s) exportado(s) com sucesso.` : `Erro: ${result.error}`);
  }

  const [tipo, setTipo] = useState('prato');
  const [produtos, setProdutos] = useState([]);
  const [insumos, setInsumos] = useState([]);
  const [productId, setProductId] = useState('');
  const [ingredientId, setIngredientId] = useState('');
  const [quantidade, setQuantidade] = useState('1');
  const [custoEstimado, setCustoEstimado] = useState('');
  const [motivo, setMotivo] = useState(MOTIVOS_SUGERIDOS[0]);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  function datasDoPeriodo() {
    const hoje = new Date();
    const dataFim = toISODate(hoje);
    const inicio = new Date(hoje);
    if (periodo === 'semana') inicio.setDate(inicio.getDate() - 7);
    if (periodo === 'mes') inicio.setDate(inicio.getDate() - 30);
    const dataInicio = periodo === 'hoje' ? dataFim : toISODate(inicio);
    return { dataInicio, dataFim };
  }

  async function reload() {
    const { dataInicio, dataFim } = datasDoPeriodo();
    const locationId = window.APP_LOCATION_ID;
    const [list, sum] = await Promise.all([
      window.pdv.waste.list({ locationId, dataInicio, dataFim }),
      window.pdv.waste.getSummary({ locationId, dataInicio, dataFim }),
    ]);
    if (!Array.isArray(list)) {
      setLoadError('Não foi possível carregar os registros de desperdício.');
      return;
    }
    setLoadError('');
    setRegistros(list);
    setResumo(sum);
  }

  useEffect(() => { reload(); }, [periodo]);

  useEffect(() => {
    window.pdv.products.list({ limit: 300 }).then((list) => setProdutos(Array.isArray(list) ? list : []));
    window.pdv.ingredient.list({}).then((list) => setInsumos(Array.isArray(list) ? list : []));
  }, []);

  // Sugere um valor gasto automaticamente quando dá pra calcular (ficha
  // técnica do prato, ou custo do insumo) — sempre editável antes de
  // registrar.
  useEffect(() => {
    if (tipo === 'prato' && !productId) return;
    if (tipo === 'insumo' && !ingredientId) return;
    if (!quantidade || Number(quantidade) <= 0) return;
    window.pdv.waste.suggestCost({ tipo, productId, ingredientId, quantidade }).then((sugestao) => {
      setCustoEstimado(sugestao > 0 ? sugestao.toFixed(2) : '');
    });
  }, [tipo, productId, ingredientId, quantidade]);

  async function handleRegistrar(e) {
    e.preventDefault();
    setSaveError('');
    setSaving(true);
    const result = await window.pdv.waste.register({
      locationId: window.APP_LOCATION_ID,
      tipo,
      productId: tipo === 'prato' ? productId : undefined,
      ingredientId: tipo === 'insumo' ? ingredientId : undefined,
      quantidade,
      custoEstimado,
      motivo,
      operadorId: currentUser.id,
    });
    setSaving(false);
    if (!result.ok) return setSaveError(result.error);
    setProductId(''); setIngredientId(''); setQuantidade('1'); setCustoEstimado('');
    reload();
  }

  return (
    <div className="screen">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="trash" size={20} /> Desperdício</h1>
      <p className="screen-hint">
        Registre pratos que não foram vendidos (sobrou do prato do dia, por exemplo) ou insumos que
        estragaram — ajuda a enxergar quanto está sendo perdido, não só o que foi vendido.
      </p>

      <form className="modal-card" style={{ maxWidth: 600, marginBottom: 24 }} onSubmit={handleRegistrar}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={16} /> Registrar desperdício</h2>
        <label>O que foi perdido?
          <select value={tipo} onChange={(e) => { setTipo(e.target.value); setProductId(''); setIngredientId(''); }}>
            <option value="prato">Prato pronto</option>
            <option value="insumo">Insumo (matéria-prima)</option>
          </select>
        </label>

        {tipo === 'prato' ? (
          <label>Prato
            <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
              <option value="">Selecione...</option>
              {produtos.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </label>
        ) : (
          <label>Insumo
            <select value={ingredientId} onChange={(e) => setIngredientId(e.target.value)} required>
              <option value="">Selecione...</option>
              {insumos.map((i) => <option key={i.id} value={i.id}>{i.nome} ({i.unidade})</option>)}
            </select>
          </label>
        )}

        <label>Quantidade
          <input type="number" step="0.01" min="0.01" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} required />
        </label>

        <label>Valor gasto (R$) — sugerido automaticamente quando possível, mas edite à vontade
          <input type="number" step="0.01" min="0" value={custoEstimado} onChange={(e) => setCustoEstimado(e.target.value)} required />
        </label>

        <label>Motivo
          <select value={motivo} onChange={(e) => setMotivo(e.target.value)}>
            {MOTIVOS_SUGERIDOS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        {saveError && <p className="modal-error">{saveError}</p>}
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Registrando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={15} /> Registrar</span>}
        </button>
      </form>

      <div className="period-selector">
        {['hoje', 'semana', 'mes'].map((p) => (
          <button key={p} className={periodo === p ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setPeriodo(p)}>
            {p === 'hoje' ? 'Hoje' : p === 'semana' ? 'Últimos 7 dias' : 'Últimos 30 dias'}
          </button>
        ))}
        <button className="btn-secondary" onClick={handleExport} disabled={exportando || registros.length === 0}>
          {exportando ? 'Exportando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="export" size={15} /> Exportar planilha</span>}
        </button>
      </div>
      {exportMsg && <p className={exportMsg.startsWith('Erro') ? 'modal-error' : 'io-message'}>{exportMsg}</p>}

      {resumo && (
        <p className="screen-hint" style={{ fontSize: 15 }}>
          <strong>{resumo.eventos}</strong> registro(s) no período — <strong className="text-danger">R$ {resumo.total.toFixed(2)}</strong> perdidos.
        </p>
      )}

      {loadError && <p className="modal-error">{loadError}</p>}

      <table className="data-table">
        <thead><tr><th>Data</th><th>O que</th><th>Quantidade</th><th>Valor perdido</th><th>Motivo</th><th>Operador</th></tr></thead>
        <tbody>
          {registros.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.criado_em + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}</td>
              <td>{r.tipo === 'prato' ? r.prato_nome : r.insumo_nome}</td>
              <td>{r.quantidade}</td>
              <td className="text-danger">R$ {r.custo_estimado.toFixed(2)}</td>
              <td>{r.motivo || '—'}</td>
              <td>{r.operador_nome || '—'}</td>
            </tr>
          ))}
          {registros.length === 0 && (
            <tr><td colSpan={6}><p className="empty-state">Nenhum registro de desperdício nesse período.</p></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
