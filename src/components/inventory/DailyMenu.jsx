import { useEffect, useState } from 'react';

export function DailyMenu() {
  const [itens, setItens] = useState([]);
  const [printMsg, setPrintMsg] = useState('');
  const [printando, setPrintando] = useState(false);

  async function reload() {
    const list = await window.pdv.products.listDailyMenu();
    setItens(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reload(); }, []);

  async function handleImprimir() {
    setPrintando(true);
    setPrintMsg('');
    const result = await window.pdv.print.dailyMenu({ itens });
    setPrintando(false);
    setPrintMsg(result.ok ? 'Enviado pra impressão.' : `Erro: ${result.error}`);
  }

  const grupos = itens.reduce((acc, item) => {
    const chave = item.tipo || 'Cardápio';
    if (!acc[chave]) acc[chave] = [];
    acc[chave].push(item);
    return acc;
  }, {});

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>🍽️ Cardápio do dia</h1>
        <button className="btn-primary" onClick={handleImprimir} disabled={printando || itens.length === 0}>
          {printando ? 'Imprimindo...' : '🖨️ Imprimir cardápio'}
        </button>
      </div>
      <p className="screen-hint">
        Mostra só os pratos marcados como "Disponível hoje" no cadastro do produto (perfil
        Restaurante) — desmarque ali o que estiver em falta hoje pra tirar da lista sem precisar
        excluir o produto.
      </p>
      {printMsg && <p className={printMsg.startsWith('Erro') ? 'modal-error' : 'io-message'}>{printMsg}</p>}

      {itens.length === 0 ? (
        <p className="empty-state">Nenhum prato marcado como disponível hoje ainda.</p>
      ) : (
        Object.entries(grupos).map(([tipo, pratos]) => (
          <div key={tipo} style={{ marginTop: 20 }}>
            <h2 style={{ marginBottom: 8 }}>{tipo}</h2>
            <table className="data-table">
              <tbody>
                {pratos.map((p) => (
                  <tr key={p.id}>
                    <td>{p.nome}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>R$ {p.preco.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
