import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

export function PetReminderModal({ onFechar }) {
  const [lembretes, setLembretes] = useState(null);
  useEscToClose(onFechar);

  useEffect(() => {
    window.pdv.pets.listLembretesPendentes().then((list) => setLembretes(Array.isArray(list) ? list : []));
  }, []);

  async function handleEnviar(petId) {
    const result = await window.pdv.pets.montarLinkLembrete({ petId });
    if (!result.ok) return alert(result.error);
    window.open(result.url, '_blank');
  }

  function motivo(l) {
    const partes = [];
    if (l.vacinaPendente) partes.push(l.vacinaVencida ? 'vacina vencida' : 'vacina próxima');
    if (l.vermifugoPendente) partes.push(l.vermifugoVencido ? 'vermífugo vencido' : 'vermífugo próximo');
    return partes.join(' · ');
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-fullscreen">
        <div>
          <h2>Lembretes de vacina/vermífugo{lembretes && lembretes.length > 0 ? ` — ${lembretes.length}` : ''}</h2>
          <p className="screen-hint" style={{ margin: '4px 0 12px' }}>
            Pets com vacina ou vermífugo vencido, ou vencendo nos próximos 7 dias.
          </p>
        </div>

        <div className="modal-card-fullscreen-scroll">
          {lembretes === null && <p className="empty-state">Carregando...</p>}
          {lembretes !== null && lembretes.length === 0 && <p className="empty-state">Nenhum lembrete pendente.</p>}
          {lembretes && lembretes.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Pet</th><th>Dono</th><th>Pendência</th><th></th></tr></thead>
              <tbody>
                {lembretes.map((l) => (
                  <tr key={l.id} className={l.vacinaVencida || l.vermifugoVencido ? 'row-critical' : 'row-warning'}>
                    <td>{l.nome} {l.especie && `(${l.especie})`}</td>
                    <td>{l.clienteNome}</td>
                    <td>{motivo(l)}</td>
                    <td>
                      {l.clienteTelefone ? (
                        <button className="btn-link" onClick={() => handleEnviar(l.id)}>Enviar lembrete</button>
                      ) : (
                        <span className="screen-hint">sem telefone</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
