import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

export function DailyMenu() {
  const [itens, setItens] = useState([]);
  const [printMsg, setPrintMsg] = useState('');
  const [printando, setPrintando] = useState(false);
  const [previsaoPorcoes, setPrevisaoPorcoes] = useState({});

  async function reload() {
    const [list, previsao] = await Promise.all([
      window.pdv.products.listDailyMenu(),
      window.pdv.ingredient.preverPorcoesPossiveisTodos(),
    ]);
    setItens(Array.isArray(list) ? list : []);
    setPrevisaoPorcoes(previsao || {});
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
        <h1><Icon name="plate" size={18} /> Cardápio do dia</h1>
        <button className="btn-primary" onClick={handleImprimir} disabled={printando || itens.length === 0}>
          {printando ? 'Imprimindo...' : <><Icon name="printer" size={16} /> Imprimir cardápio</>}
        </button>
      </div>
      <p className="screen-hint">
        Mostra só os pratos marcados como "Disponível hoje" no cadastro do produto (perfil
        Restaurante) — desmarque ali o que estiver em falta hoje pra tirar da lista sem precisar
        excluir o produto. Quando o prato tem ficha técnica (insumos) cadastrada, mostra também
        quantas porções dá pra fazer com o estoque atual dos insumos — cálculo direto (o insumo
        mais escasso da receita é quem limita), não é uma estimativa de IA.
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
                {pratos.map((p) => {
                  const porcoes = previsaoPorcoes[p.id];
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.nome}
                        {porcoes !== undefined && porcoes !== null && (
                          <span
                            className={porcoes <= 3 ? 'badge-warning' : 'badge-warning'}
                            style={{
                              marginLeft: 8, background: porcoes <= 3 ? undefined : 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
                              color: porcoes <= 3 ? undefined : 'var(--color-primary)',
                            }}
                            title="Previsão calculada a partir do estoque atual dos insumos da ficha técnica — não é uma estimativa de IA"
                          >
                            <Icon name="chart" size={13} /> ≈{porcoes} porç{porcoes === 1 ? 'ão' : 'ões'}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>R$ {p.preco.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
