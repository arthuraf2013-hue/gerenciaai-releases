import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

export function LapsedCustomersModal({ onFechar }) {
  const [clientes, setClientes] = useState(null);
  useEscToClose(onFechar);

  useEffect(() => {
    window.pdv.customers.listQueSumiram().then((list) => setClientes(Array.isArray(list) ? list : []));
  }, []);

  async function handleEnviar(customerId) {
    const result = await window.pdv.customers.montarLinkReconquista({ customerId });
    if (!result.ok) return alert(result.error);
    window.open(result.url, '_blank');
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-fullscreen">
        <div>
          <h2>Clientes que sumiram{clientes && clientes.length > 0 ? ` — ${clientes.length}` : ''}</h2>
          <p className="screen-hint" style={{ margin: '4px 0 12px' }}>
            Compara o tempo desde a última compra com o ritmo normal de cada cliente — não é um número
            fixo pra todo mundo. Quem compra a cada semana e some por um mês aparece aqui; quem compra
            a cada 3 meses só aparece se também passar bem do próprio ritmo.
          </p>
        </div>

        <div className="modal-card-fullscreen-scroll">
          {clientes === null && <p className="empty-state">Carregando...</p>}
          {clientes !== null && clientes.length === 0 && <p className="empty-state">Nenhum cliente parece ter sumido — todo mundo dentro do próprio ritmo.</p>}
          {clientes && clientes.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Cliente</th><th>Costuma comprar a cada</th><th>Sumiu há</th><th></th></tr></thead>
              <tbody>
                {clientes.map((c) => (
                  <tr key={c.id}>
                    <td>{c.nome}</td>
                    <td>{c.ritmoMedioDias} dia(s)</td>
                    <td>{c.diasDesdeUltimaCompra} dia(s)</td>
                    <td>
                      {c.telefone ? (
                        <button className="btn-link" onClick={() => handleEnviar(c.id)}>Enviar mensagem de reconquista</button>
                      ) : (
                        <span className="screen-hint">sem telefone cadastrado</span>
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
