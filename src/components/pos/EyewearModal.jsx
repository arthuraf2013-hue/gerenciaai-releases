import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

const RECEITA_VAZIA = {
  dataReceita: '', odEsferico: '', odCilindrico: '', odEixo: '', odAdicao: '',
  oeEsferico: '', oeCilindrico: '', oeEixo: '', oeAdicao: '', distanciaPupilar: '', tipoLente: '', observacoes: '',
};

function paraNumeroOuNulo(v) {
  return v === '' ? null : Number(v);
}

export function EyewearModal({ customer, onFechar }) {
  const [receitas, setReceitas] = useState(null);
  const [editando, setEditando] = useState(null);
  useEscToClose(() => (editando ? setEditando(null) : onFechar()));

  function carregar() {
    window.pdv.eyewear.listByCustomer({ customerId: customer.id }).then((list) => setReceitas(Array.isArray(list) ? list : []));
  }
  useEffect(carregar, [customer.id]);

  function startNew() {
    setEditando({ ...RECEITA_VAZIA });
  }
  function startEdit(r) {
    setEditando({
      id: r.id, dataReceita: r.data_receita || '',
      odEsferico: r.od_esferico ?? '', odCilindrico: r.od_cilindrico ?? '', odEixo: r.od_eixo ?? '', odAdicao: r.od_adicao ?? '',
      oeEsferico: r.oe_esferico ?? '', oeCilindrico: r.oe_cilindrico ?? '', oeEixo: r.oe_eixo ?? '', oeAdicao: r.oe_adicao ?? '',
      distanciaPupilar: r.distancia_pupilar ?? '', tipoLente: r.tipo_lente || '', observacoes: r.observacoes || '',
    });
  }

  async function handleSave(e) {
    e.preventDefault();
    await window.pdv.eyewear.upsert({
      ...editando, customerId: customer.id,
      odEsferico: paraNumeroOuNulo(editando.odEsferico), odCilindrico: paraNumeroOuNulo(editando.odCilindrico),
      odEixo: paraNumeroOuNulo(editando.odEixo), odAdicao: paraNumeroOuNulo(editando.odAdicao),
      oeEsferico: paraNumeroOuNulo(editando.oeEsferico), oeCilindrico: paraNumeroOuNulo(editando.oeCilindrico),
      oeEixo: paraNumeroOuNulo(editando.oeEixo), oeAdicao: paraNumeroOuNulo(editando.oeAdicao),
      distanciaPupilar: paraNumeroOuNulo(editando.distanciaPupilar),
    });
    setEditando(null);
    carregar();
  }

  async function handleExcluir(id) {
    if (!confirm('Remover essa receita do histórico?')) return;
    await window.pdv.eyewear.deactivate({ id });
    carregar();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ width: 620 }}>
        <h2>👓 Receita óptica — {customer.nome}</h2>

        {!editando && (
          <>
            {receitas === null && <p className="empty-state">Carregando...</p>}
            {receitas !== null && receitas.length === 0 && <p className="empty-state">Nenhuma receita cadastrada ainda.</p>}
            {receitas && receitas.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
                {receitas.map((r) => (
                  <li key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{r.data_receita ? new Date(r.data_receita + 'T00:00:00').toLocaleDateString('pt-BR') : 'Sem data'} — {r.tipo_lente || 'Tipo não informado'}</strong>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button className="btn-link" onClick={() => startEdit(r)}>✏️ Editar</button>
                        <button className="btn-link-danger" onClick={() => handleExcluir(r.id)}>🗑️ Remover</button>
                      </div>
                    </div>
                    <p className="screen-hint" style={{ margin: '4px 0 0' }}>
                      OD: {r.od_esferico ?? '—'} / {r.od_cilindrico ?? '—'} × {r.od_eixo ?? '—'}°
                      {r.od_adicao != null && ` (adição ${r.od_adicao})`}
                      {' · '}
                      OE: {r.oe_esferico ?? '—'} / {r.oe_cilindrico ?? '—'} × {r.oe_eixo ?? '—'}°
                      {r.oe_adicao != null && ` (adição ${r.oe_adicao})`}
                      {r.distancia_pupilar != null && ` · DP: ${r.distancia_pupilar}mm`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onFechar}>✖️ Fechar</button>
              <button className="btn-primary" onClick={startNew}>+ Nova receita</button>
            </div>
          </>
        )}

        {editando && (
          <form onSubmit={handleSave}>
            <div className="form-grid">
              <label>Data da receita<input type="date" value={editando.dataReceita} onChange={(e) => setEditando({ ...editando, dataReceita: e.target.value })} /></label>
              <label>Tipo de lente<input value={editando.tipoLente} onChange={(e) => setEditando({ ...editando, tipoLente: e.target.value })} placeholder="Monofocal, multifocal..." /></label>
              <label>Distância pupilar (mm)<input type="number" step="0.1" value={editando.distanciaPupilar} onChange={(e) => setEditando({ ...editando, distanciaPupilar: e.target.value })} /></label>
            </div>

            <p style={{ fontWeight: 'bold', margin: '12px 0 6px' }}>Olho direito (OD)</p>
            <div className="form-grid">
              <label>Esférico<input type="number" step="0.25" value={editando.odEsferico} onChange={(e) => setEditando({ ...editando, odEsferico: e.target.value })} /></label>
              <label>Cilíndrico<input type="number" step="0.25" value={editando.odCilindrico} onChange={(e) => setEditando({ ...editando, odCilindrico: e.target.value })} /></label>
              <label>Eixo<input type="number" value={editando.odEixo} onChange={(e) => setEditando({ ...editando, odEixo: e.target.value })} /></label>
              <label>Adição<input type="number" step="0.25" value={editando.odAdicao} onChange={(e) => setEditando({ ...editando, odAdicao: e.target.value })} /></label>
            </div>

            <p style={{ fontWeight: 'bold', margin: '12px 0 6px' }}>Olho esquerdo (OE)</p>
            <div className="form-grid">
              <label>Esférico<input type="number" step="0.25" value={editando.oeEsferico} onChange={(e) => setEditando({ ...editando, oeEsferico: e.target.value })} /></label>
              <label>Cilíndrico<input type="number" step="0.25" value={editando.oeCilindrico} onChange={(e) => setEditando({ ...editando, oeCilindrico: e.target.value })} /></label>
              <label>Eixo<input type="number" value={editando.oeEixo} onChange={(e) => setEditando({ ...editando, oeEixo: e.target.value })} /></label>
              <label>Adição<input type="number" step="0.25" value={editando.oeAdicao} onChange={(e) => setEditando({ ...editando, oeAdicao: e.target.value })} /></label>
            </div>

            <label>Observações<input value={editando.observacoes} onChange={(e) => setEditando({ ...editando, observacoes: e.target.value })} /></label>

            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditando(null)}>✖️ Cancelar</button>
              <button type="submit" className="btn-primary">💾 Salvar</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
