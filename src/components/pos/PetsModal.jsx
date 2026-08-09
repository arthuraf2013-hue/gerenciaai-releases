import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

const PET_VAZIO = { nome: '', especie: '', raca: '', ultimaVacinaEm: '', proximaVacinaEm: '', ultimoVermifugoEm: '', proximoVermifugoEm: '', observacoes: '' };

export function PetsModal({ customer, onFechar }) {
  const [pets, setPets] = useState(null);
  const [editando, setEditando] = useState(null); // null = fechado, PET_VAZIO = novo, {...} = editando
  useEscToClose(() => (editando ? setEditando(null) : onFechar()));

  function carregar() {
    window.pdv.pets.listByCustomer({ customerId: customer.id }).then((list) => setPets(Array.isArray(list) ? list : []));
  }
  useEffect(carregar, [customer.id]);

  function startNew() {
    setEditando({ ...PET_VAZIO });
  }
  function startEdit(p) {
    setEditando({
      id: p.id, nome: p.nome, especie: p.especie || '', raca: p.raca || '',
      ultimaVacinaEm: p.ultima_vacina_em || '', proximaVacinaEm: p.proxima_vacina_em || '',
      ultimoVermifugoEm: p.ultimo_vermifugo_em || '', proximoVermifugoEm: p.proximo_vermifugo_em || '',
      observacoes: p.observacoes || '',
    });
  }

  async function handleSave(e) {
    e.preventDefault();
    await window.pdv.pets.upsert({ ...editando, customerId: customer.id });
    setEditando(null);
    carregar();
  }

  async function handleExcluir(petId) {
    if (!confirm('Remover esse pet da ficha?')) return;
    await window.pdv.pets.deactivate({ petId });
    carregar();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ width: 560 }}>
        <h2>Pets — {customer.nome}</h2>

        {!editando && (
          <>
            {pets === null && <p className="empty-state">Carregando...</p>}
            {pets !== null && pets.length === 0 && <p className="empty-state">Nenhum pet cadastrado ainda.</p>}
            {pets && pets.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
                {pets.map((p) => (
                  <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <span>{p.nome} {p.especie && `— ${p.especie}`} {p.raca && `(${p.raca})`}</span>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button className="btn-link" onClick={() => startEdit(p)}>Editar</button>
                      <button className="btn-link-danger" onClick={() => handleExcluir(p.id)}>Remover</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onFechar}>Fechar</button>
              <button className="btn-primary" onClick={startNew}>+ Novo pet</button>
            </div>
          </>
        )}

        {editando && (
          <form onSubmit={handleSave}>
            <div className="form-grid">
              <label>Nome<input value={editando.nome} onChange={(e) => setEditando({ ...editando, nome: e.target.value })} required autoFocus /></label>
              <label>Espécie<input value={editando.especie} onChange={(e) => setEditando({ ...editando, especie: e.target.value })} placeholder="Cão, gato, ave..." /></label>
              <label>Raça<input value={editando.raca} onChange={(e) => setEditando({ ...editando, raca: e.target.value })} /></label>
              <label>Última vacina<input type="date" value={editando.ultimaVacinaEm} onChange={(e) => setEditando({ ...editando, ultimaVacinaEm: e.target.value })} /></label>
              <label>Próxima vacina<input type="date" value={editando.proximaVacinaEm} onChange={(e) => setEditando({ ...editando, proximaVacinaEm: e.target.value })} /></label>
              <label>Último vermífugo<input type="date" value={editando.ultimoVermifugoEm} onChange={(e) => setEditando({ ...editando, ultimoVermifugoEm: e.target.value })} /></label>
              <label>Próximo vermífugo<input type="date" value={editando.proximoVermifugoEm} onChange={(e) => setEditando({ ...editando, proximoVermifugoEm: e.target.value })} /></label>
            </div>
            <label>Observações<input value={editando.observacoes} onChange={(e) => setEditando({ ...editando, observacoes: e.target.value })} /></label>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditando(null)}>Cancelar</button>
              <button type="submit" className="btn-primary">Salvar</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
