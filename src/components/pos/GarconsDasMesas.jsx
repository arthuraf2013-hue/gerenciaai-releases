import { useEffect, useMemo, useState } from 'react';
import Icon from '../common/Icon';

// Garçons das mesas (gerente): escolhe o garçom/operador e marca as mesas dele.
// O vínculo é da mesa e fica até tirar; vira etiqueta no quadrado da mesa e
// sai na nota e na pré-nota. Backend: electron/services/mesaAtendentesService.js
// (no grupo de caixas, pelo servidor -- `api` vem de apiDasMesas).

export function GarconsDasMesas({ api, onFechar, onSalvou }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [selecionado, setSelecionado] = useState(null);
  const [marcadas, setMarcadas] = useState(new Set());
  const [salvando, setSalvando] = useState(false);
  const [confirmarLimpar, setConfirmarLimpar] = useState(false);

  async function carregar(manterSelecionado) {
    const r = await api.table.atendentes({ locationId: window.APP_LOCATION_ID });
    if (!r?.ok) { setErro(r?.error || 'Não consegui carregar os garçons.'); return; }
    setErro('');
    setDados(r);
    const alvo = r.atendentes.find((a) => a.id === manterSelecionado) || r.atendentes[0] || null;
    setSelecionado(alvo?.id || null);
    setMarcadas(new Set(r.vinculos.filter((v) => v.userId === alvo?.id).map((v) => v.tableId)));
  }
  useEffect(() => { carregar(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const mesasPorAtendente = useMemo(() => {
    const m = new Map();
    for (const v of dados?.vinculos || []) m.set(v.userId, (m.get(v.userId) || 0) + 1);
    return m;
  }, [dados]);
  const outrosPorMesa = useMemo(() => {
    const nomes = new Map((dados?.atendentes || []).map((a) => [a.id, a.nome]));
    const m = new Map();
    for (const v of dados?.vinculos || []) {
      if (v.userId === selecionado) continue;
      if (!m.has(v.tableId)) m.set(v.tableId, []);
      m.get(v.tableId).push(nomes.get(v.userId));
    }
    return m;
  }, [dados, selecionado]);

  const salvas = new Set((dados?.vinculos || []).filter((v) => v.userId === selecionado).map((v) => v.tableId));
  const mudou = salvas.size !== marcadas.size || [...marcadas].some((id) => !salvas.has(id));

  function escolher(id) {
    if (id === selecionado) return;
    if (mudou) { setAviso('Salve as mesas marcadas antes de trocar de garçom (ou desmarque o que mudou).'); return; }
    setAviso('');
    setSelecionado(id);
    setMarcadas(new Set((dados?.vinculos || []).filter((v) => v.userId === id).map((v) => v.tableId)));
  }
  function alternar(id) {
    const n = new Set(marcadas);
    if (n.has(id)) n.delete(id); else n.add(id);
    setMarcadas(n);
    setAviso('');
  }

  async function salvar() {
    setSalvando(true);
    const r = await api.table.vincularAtendente({ userId: selecionado, tableIds: [...marcadas], locationId: window.APP_LOCATION_ID });
    setSalvando(false);
    if (!r?.ok) { setErro(r?.error || 'Não consegui salvar.'); return; }
    const nome = dados.atendentes.find((a) => a.id === selecionado)?.nome || '';
    setAviso(r.quantidade ? `${nome}: ${r.quantidade} mesa(s).` : `${nome} ficou sem mesa.`);
    await carregar(selecionado);
    onSalvou?.();
  }

  async function limparTodos() {
    if (!confirmarLimpar) { setConfirmarLimpar(true); return; }
    setConfirmarLimpar(false);
    const r = await api.table.limparAtendentes({ locationId: window.APP_LOCATION_ID });
    if (!r?.ok) { setErro(r?.error || 'Não consegui tirar os vínculos.'); return; }
    setAviso('Todas as mesas ficaram sem garçom.');
    await carregar(selecionado);
    onSalvou?.();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card garcons-mesas">
        <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="users" size={18} /> Garçons das mesas</h2>
        <p className="screen-hint">
          Escolha o garçom e marque as mesas dele. O nome aparece no quadrado da mesa e sai na nota e na pré-nota.
          O que outra pessoa lançar na mesa continua saindo com o nome de quem lançou e a hora.
        </p>
        {!dados && !erro && <p className="screen-hint">Carregando...</p>}
        {dados && !dados.atendentes.length && (
          <p className="io-message-aviso">Nenhum garçom ou operador ativo. Cadastre em Usuários e volte aqui.</p>
        )}
        {dados && dados.atendentes.length > 0 && (
          <div className="garcons-mesas-corpo">
            <div className="garcons-mesas-lista" role="listbox" aria-label="Garçom">
              {dados.atendentes.map((a) => (
                <button
                  type="button" key={a.id} role="option" aria-selected={a.id === selecionado}
                  className={`garcons-mesas-pessoa${a.id === selecionado ? ' ativo' : ''}`} onClick={() => escolher(a.id)}
                >
                  <span className="garcons-mesas-nome">{a.nome}</span>
                  <span className="garcons-mesas-papel">{a.papel} · {mesasPorAtendente.get(a.id) || 0} mesa(s)</span>
                </button>
              ))}
            </div>
            <div className="garcons-mesas-grade">
              {dados.mesas.length === 0 && <p className="screen-hint">Cadastre as mesas primeiro.</p>}
              {dados.mesas.map((m) => {
                const outros = outrosPorMesa.get(m.id) || [];
                return (
                  <button
                    type="button" key={m.id} aria-pressed={marcadas.has(m.id)}
                    className={`garcons-mesas-mesa${marcadas.has(m.id) ? ' ativo' : ''}`} onClick={() => alternar(m.id)}
                    title={outros.length ? `Também: ${outros.join(', ')}` : undefined}
                  >
                    {marcadas.has(m.id) && <Icon name="check" size={13} />} {m.rotulo}
                    {outros.length > 0 && <span className="garcons-mesas-outros">{outros.join(', ')}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {erro && <p className="modal-error" role="alert">{erro}</p>}
        {aviso && <p className="io-message" role="status">{aviso}</p>}
        <div className="modal-actions">
          {dados?.vinculos?.length > 0 && (
            <button type="button" className={confirmarLimpar ? 'btn-danger' : 'btn-link'} onClick={limparTodos} onBlur={() => setConfirmarLimpar(false)}>
              {confirmarLimpar ? 'Confirmar: tirar todos' : 'Tirar todos os garçons das mesas'}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onFechar}>Fechar</button>
          {selecionado && (
            <button type="button" className="btn-primary" onClick={salvar} disabled={salvando || !mudou}>
              <Icon name="save" size={15} /> {salvando ? 'Salvando...' : 'Salvar mesas'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
