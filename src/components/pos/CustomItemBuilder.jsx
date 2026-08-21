import { useEffect, useRef, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';

let proximoIdLocal = 1;
function novoIdLocal() {
  return `linha-${proximoIdLocal++}`;
}

function linhaVazia() {
  return {
    idLocal: novoIdLocal(),
    busca: '',
    resultados: [],
    componente: null, // { tipo, id, nome, unidade, custoUnitario }
    modo: 'quantidade',
    quantidade: '',
    percentual: '',
  };
}

/**
 * Uma linha da composição do produto personalizado — busca combinada
 * (insumo OU produto do catálogo), depois escolhe quantidade OU
 * percentual (percentual só faz sentido escolhendo um produto: fração
 * de UMA unidade inteira dele, ex: pizza 50% sabor Calabresa).
 */
function LinhaCustomItem({ linha, onChange, onRemover, podeRemover }) {
  const debounceRef = useRef(null);

  function buscar(texto) {
    onChange({ ...linha, busca: texto, componente: texto ? linha.componente : null });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (texto.trim().length < 2) {
      onChange({ ...linha, busca: texto, resultados: [], componente: texto ? linha.componente : null });
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const resultados = await window.pdv.customItem.buscar({ query: texto.trim() });
      onChange((atual) => ({ ...atual, resultados: Array.isArray(resultados) ? resultados : [] }));
    }, 200);
  }

  function selecionar(opcao) {
    onChange({
      ...linha,
      componente: opcao,
      busca: opcao.nome,
      resultados: [],
      modo: opcao.tipo === 'insumo' ? 'quantidade' : linha.modo,
    });
  }

  return (
    <div className="custom-item-linha">
      <div className="custom-item-linha-busca">
        <input
          type="text"
          placeholder="Buscar insumo ou produto..."
          value={linha.busca}
          onChange={(e) => buscar(e.target.value)}
        />
        {linha.resultados.length > 0 && (
          <ul className="product-search-results">
            {linha.resultados.map((opcao) => (
              <li key={`${opcao.tipo}-${opcao.id}`}>
                <button type="button" onClick={() => selecionar(opcao)}>
                  <span>{opcao.tipo === 'insumo' ? '🥫' : '📦'} {opcao.nome}</span>
                  <span className="product-search-price">{opcao.unidade}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {linha.componente && (
        <>
          {linha.componente.tipo === 'produto' && (
            <div className="custom-item-modo-toggle">
              <button
                type="button"
                className={linha.modo === 'quantidade' ? 'btn-secondary btn-toggle-active' : 'btn-secondary'}
                onClick={() => onChange({ ...linha, modo: 'quantidade' })}
              >
                Quantidade
              </button>
              <button
                type="button"
                className={linha.modo === 'percentual' ? 'btn-secondary btn-toggle-active' : 'btn-secondary'}
                onClick={() => onChange({ ...linha, modo: 'percentual' })}
              >
                % de 1 unidade
              </button>
            </div>
          )}

          {linha.modo === 'percentual' ? (
            <label className="custom-item-qtd">%
              <input
                type="number" min="1" max="100" step="1"
                value={linha.percentual}
                onChange={(e) => onChange({ ...linha, percentual: e.target.value })}
                placeholder="Ex: 50"
              />
            </label>
          ) : (
            <label className="custom-item-qtd">Qtd. ({linha.componente.unidade})
              <input
                type="text" inputMode="decimal"
                value={linha.quantidade}
                onChange={(e) => onChange({ ...linha, quantidade: e.target.value.replace(',', '.') })}
                placeholder="Ex: 0.3"
              />
            </label>
          )}
        </>
      )}

      <button type="button" className="btn-link-danger" onClick={onRemover} disabled={!podeRemover} title="Remover linha">✖</button>
    </div>
  );
}

/**
 * @param {{ saleId: string, locationId: string, operadorId: string, deviceId: string, onAdded: (result: object) => void, onClose: () => void }} props
 */
export function CustomItemBuilder({ saleId, locationId, operadorId, deviceId, onAdded, onClose }) {
  useEscToClose(onClose);
  const [nome, setNome] = useState('');
  const [preco, setPreco] = useState('');
  const [precoEditadoManualmente, setPrecoEditadoManualmente] = useState(false);
  const [linhas, setLinhas] = useState([linhaVazia(), linhaVazia(), linhaVazia()]);
  const [custoEstimado, setCustoEstimado] = useState(null);
  const [erro, setErro] = useState(null);
  const [salvando, setSalvando] = useState(false);

  function linhasValidasParaEnvio() {
    return linhas
      .filter((l) => l.componente)
      .map((l) => ({
        tipo: l.componente.tipo,
        insumoId: l.componente.tipo === 'insumo' ? l.componente.id : undefined,
        produtoId: l.componente.tipo === 'produto' ? l.componente.id : undefined,
        modo: l.modo,
        quantidade: l.modo === 'quantidade' ? Number(l.quantidade) : undefined,
        percentual: l.modo === 'percentual' ? Number(l.percentual) : undefined,
      }))
      .filter((l) => (l.modo === 'percentual' ? l.percentual > 0 : l.quantidade > 0));
  }

  // Sugestão de custo — recalcula sempre que a composição muda (debounced
  // levemente pra não bater a cada tecla). Só um ponto de partida: nunca
  // sobrescreve o preço se o operador já digitou algo à mão.
  useEffect(() => {
    const validas = linhasValidasParaEnvio();
    if (validas.length === 0) { setCustoEstimado(null); return; }
    const id = setTimeout(() => {
      window.pdv.customItem.sugerirPreco({ linhas: validas }).then((r) => {
        setCustoEstimado(r.custoEstimado);
        if (!precoEditadoManualmente) setPreco(r.custoEstimado.toFixed(2));
      });
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(linhas.map((l) => ({ c: l.componente, m: l.modo, q: l.quantidade, p: l.percentual })))]);

  function atualizarLinha(idLocal, atualizacaoOuFn) {
    setLinhas((prev) => prev.map((l) => {
      if (l.idLocal !== idLocal) return l;
      return typeof atualizacaoOuFn === 'function' ? atualizacaoOuFn(l) : atualizacaoOuFn;
    }));
  }

  function removerLinha(idLocal) {
    setLinhas((prev) => prev.filter((l) => l.idLocal !== idLocal));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErro(null);

    const nomeLimpo = nome.trim();
    if (!nomeLimpo) { setErro('Informe um nome para o item.'); return; }
    const precoNumerico = Number(preco.replace(',', '.'));
    if (!(precoNumerico >= 0)) { setErro('Preço inválido.'); return; }
    const validas = linhasValidasParaEnvio();
    if (validas.length === 0) { setErro('Adicione ao menos um insumo ou produto com quantidade.'); return; }

    setSalvando(true);
    const result = await window.pdv.sale.addCustomItem({
      saleId, locationId, nome: nomeLimpo, preco: precoNumerico, linhas: validas, operadorId, deviceId,
    });
    setSalvando(false);

    if (!result.ok) { setErro(result.error); return; }
    onAdded({ itemId: result.itemId, precoUnitario: result.precoUnitario, nome: nomeLimpo });
  }

  return (
    <div className="modal-overlay">
      <form className="modal-card modal-card-wide" onSubmit={handleSubmit}>
        <h2>🎨 Produto personalizado</h2>
        <p className="screen-hint">
          Monte um prato/produto na hora combinando insumos e/ou produtos do catálogo — ex: pizza meio-a-meio,
          drink combinado. O preço é só sugerido pelo custo dos itens usados; ajuste como preferir.
        </p>

        <label>Nome (aparece no carrinho e no recibo)
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: Pizza meio Calabresa meio Marguerita" autoFocus required />
        </label>

        <label>Preço de venda
          <input
            type="text" inputMode="decimal"
            value={preco}
            onChange={(e) => { setPreco(e.target.value.replace(',', '.')); setPrecoEditadoManualmente(true); }}
            placeholder="0.00"
            required
          />
        </label>
        {custoEstimado !== null && (
          <p className="screen-hint" style={{ margin: '-8px 0 8px' }}>
            Custo estimado dos itens: R$ {custoEstimado.toFixed(2)}
          </p>
        )}

        <div className="custom-item-linhas">
          {linhas.map((linha) => (
            <LinhaCustomItem
              key={linha.idLocal}
              linha={linha}
              onChange={(atualizacao) => atualizarLinha(linha.idLocal, atualizacao)}
              onRemover={() => removerLinha(linha.idLocal)}
              podeRemover={linhas.length > 1}
            />
          ))}
        </div>
        <button type="button" className="btn-link" onClick={() => setLinhas((prev) => [...prev, linhaVazia()])}>
          ➕ Adicionar outra linha
        </button>

        {erro && <p className="scan-feedback scan-feedback-error">{erro}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>✖️ Cancelar</button>
          <button type="submit" className="btn-primary" disabled={salvando}>
            {salvando ? 'Adicionando...' : '➕ Adicionar à venda'}
          </button>
        </div>
      </form>
    </div>
  );
}
