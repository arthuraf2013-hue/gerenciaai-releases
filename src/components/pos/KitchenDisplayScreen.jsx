import { useEffect, useState } from 'react';

// Painel de Cozinha (KDS) — mostra os itens que ainda faltam preparar,
// agrupados por mesa/comanda, com botões grandes pra avançar o status
// (pensado pra tela de tablet/monitor na cozinha, não pro mouse+teclado
// do caixa). Atualiza sozinho a cada poucos segundos: mais de uma
// pessoa pode estar lançando pedido ao mesmo tempo, e quem está na
// cozinha não deve precisar apertar F5.
const INTERVALO_ATUALIZACAO_MS = 6000;

function agruparPorMesa(itens) {
  const grupos = new Map();
  for (const item of itens) {
    const chave = item.sale_id;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        saleId: item.sale_id,
        label: item.mesa_numero ? `Mesa ${item.mesa_numero}${item.mesa_nome ? ` — ${item.mesa_nome}` : ''}` : 'Balcão',
        itens: [],
      });
    }
    grupos.get(chave).itens.push(item);
  }
  // Comandas com item pendente há mais tempo aparecem primeiro.
  return [...grupos.values()].sort((a, b) => {
    const maisAntigoA = Math.min(...a.itens.map((i) => new Date(i.criado_em).getTime()));
    const maisAntigoB = Math.min(...b.itens.map((i) => new Date(i.criado_em).getTime()));
    return maisAntigoA - maisAntigoB;
  });
}

function minutosDesde(criadoEm) {
  const diffMs = Date.now() - new Date(criadoEm).getTime();
  return Math.max(0, Math.floor(diffMs / 60000));
}

export function KitchenDisplayScreen() {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [atualizandoId, setAtualizandoId] = useState(null);

  async function carregar() {
    const lista = await window.pdv.kitchen.listActiveItems({ locationId: window.APP_LOCATION_ID });
    setItens(Array.isArray(lista) ? lista : []);
    setCarregando(false);
  }

  useEffect(() => {
    carregar();
    const id = setInterval(carregar, INTERVALO_ATUALIZACAO_MS);
    return () => clearInterval(id);
  }, []);

  async function avancarStatus(item) {
    const proximo = item.status_preparo === 'pendente' ? 'preparando' : 'pronto';
    setAtualizandoId(item.id);
    await window.pdv.kitchen.updateItemStatus({ itemId: item.id, status: proximo });
    await carregar();
    setAtualizandoId(null);
  }

  const grupos = agruparPorMesa(itens);

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>👨‍🍳 Painel de Cozinha</h1>
        <p className="screen-hint" style={{ margin: 0 }}>
          {itens.length} item(ns) em preparo · atualiza sozinho a cada {INTERVALO_ATUALIZACAO_MS / 1000}s
        </p>
      </div>

      {carregando ? (
        <p className="empty-state">Carregando...</p>
      ) : grupos.length === 0 ? (
        <p className="empty-state">🎉 Nenhum item pendente — cozinha em dia!</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {grupos.map((grupo) => (
            <div
              key={grupo.saleId}
              style={{
                background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
                padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18 }}>{grupo.label}</h2>
              {grupo.itens.map((item) => {
                const minutos = minutosDesde(item.criado_em);
                const atrasado = minutos >= 15;
                return (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8,
                      background: item.status_preparo === 'preparando' ? 'var(--color-warning-bg, #fff7e6)' : 'var(--color-bg)',
                      border: atrasado ? '1px solid var(--color-danger, #c0392b)' : '1px solid var(--color-border)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <strong style={{ fontSize: 16 }}>{item.quantidade}× {item.nome}</strong>
                      <span style={{ fontSize: 12, color: atrasado ? 'var(--color-danger, #c0392b)' : 'var(--color-text-muted)', fontWeight: atrasado ? 700 : 400 }}>
                        {minutos} min{atrasado ? ' ⚠' : ''}
                      </span>
                    </div>
                    {item.pessoa_numero && (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Pessoa {item.pessoa_numero}</span>
                    )}
                    {item.observacao && (
                      <span style={{ fontSize: 13, color: 'var(--color-danger, #c0392b)' }}>⚠ {item.observacao}</span>
                    )}
                    <button
                      className="btn-primary"
                      disabled={atualizandoId === item.id}
                      onClick={() => avancarStatus(item)}
                      style={{ marginTop: 4 }}
                    >
                      {atualizandoId === item.id
                        ? 'Salvando...'
                        : item.status_preparo === 'pendente' ? '▶️ Começar a preparar' : '✅ Marcar como pronto'}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
