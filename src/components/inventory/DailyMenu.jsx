import { useEffect, useMemo, useState } from 'react';
import Icon from '../common/Icon';
import { formatarReais } from '../../utils/cozinha';

/**
 * Cardápio do dia: todos os pratos numa tela só, liga/desliga com um toque
 * ("acabou o feijão"), e imprime só o que está ligado. Os pratos são os que
 * têm seção do cardápio (tipo de prato) ou são feitos na hora.
 */
export function DailyMenu() {
  const [pratos, setPratos] = useState([]);
  const [carregado, setCarregado] = useState(false);
  const [previsaoPorcoes, setPrevisaoPorcoes] = useState({});
  const [busca, setBusca] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [printando, setPrintando] = useState(false);

  async function reload() {
    const [list, previsao] = await Promise.all([
      window.pdv.products.listPratosParaCardapio(),
      window.pdv.ingredient.preverPorcoesPossiveisTodos(),
    ]);
    setPratos(Array.isArray(list) ? list : []);
    setPrevisaoPorcoes(previsao || {});
    setCarregado(true);
  }
  useEffect(() => { reload(); }, []);

  async function alternar(ids, disponivel) {
    const alvo = new Set(ids);
    const antes = pratos;
    setPratos((prev) => prev.map((p) => (alvo.has(p.id) ? { ...p, disponivelHoje: disponivel } : p)));
    const r = await window.pdv.products.setDisponivelHoje({ productIds: ids, disponivel });
    if (!r?.ok) { setPratos(antes); setMensagem(`Erro: ${r?.error || 'não consegui salvar.'}`); }
  }

  const ligados = pratos.filter((p) => p.disponivelHoje);
  const termo = busca.trim().toLowerCase();
  const grupos = useMemo(() => {
    const acc = {};
    for (const p of pratos) {
      if (termo && !p.nome.toLowerCase().includes(termo)) continue;
      const chave = p.tipo || 'Sem seção';
      (acc[chave] ||= []).push(p);
    }
    return Object.entries(acc);
  }, [pratos, termo]);

  async function imprimir() {
    setPrintando(true);
    setMensagem('');
    const itens = ligados.map(({ id, nome, preco, tipo }) => ({ id, nome, preco, tipo }));
    const result = await window.pdv.print.dailyMenu({ itens });
    setPrintando(false);
    setMensagem(result.ok ? 'Enviado para impressão.' : `Erro: ${result.error}`);
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1><Icon name="plate" size={18} /> Cardápio do dia</h1>
        <div className="screen-actions">
          <button className="btn-secondary" onClick={() => alternar(ligados.map((p) => p.id), false)} disabled={ligados.length === 0}>
            Tirar todos
          </button>
          <button className="btn-primary" onClick={imprimir} disabled={printando || ligados.length === 0}>
            {printando ? 'Imprimindo...' : <><Icon name="printer" size={16} /> Imprimir ({ligados.length})</>}
          </button>
        </div>
      </div>
      <p className="screen-hint">
        Toque no prato para colocar ou tirar do cardápio de hoje. Acabou alguma coisa no meio do turno? Desligue aqui,
        sem abrir o cadastro. Com ficha técnica, aparece quantas porções o estoque dos insumos ainda rende (conta
        direta: o insumo que acaba primeiro manda).
      </p>
      {mensagem && <p className={mensagem.startsWith('Erro') ? 'modal-error' : 'io-message'}>{mensagem}</p>}

      {carregado && pratos.length === 0 ? (
        <p className="empty-state">
          Nenhum prato cadastrado ainda. Em Produtos → "Novo item do cardápio", escolha "Prato feito na hora" ou preencha a seção do cardápio.
        </p>
      ) : (
        <>
          <input className="search-input" placeholder="Buscar prato…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {grupos.length === 0 && carregado && <p className="empty-state">Nenhum prato com esse nome.</p>}
          {grupos.map(([tipo, lista]) => {
            const todosLigados = lista.every((p) => p.disponivelHoje);
            return (
              <div key={tipo} style={{ marginTop: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <h2 style={{ margin: 0 }}>{tipo}</h2>
                  <span className="ficha-sub">{lista.filter((p) => p.disponivelHoje).length} de {lista.length} hoje</span>
                  <button className="btn-link" style={{ marginLeft: 'auto' }} onClick={() => alternar(lista.map((p) => p.id), !todosLigados)}>
                    {todosLigados ? 'Tirar a seção' : 'Ligar a seção'}
                  </button>
                </div>
                <div className="cardapio-montar">
                  {lista.map((p) => {
                    const porcoes = previsaoPorcoes[p.id];
                    return (
                      <button
                        type="button" key={p.id} role="switch" aria-checked={p.disponivelHoje}
                        className={p.disponivelHoje ? 'cardapio-item ligado' : 'cardapio-item'}
                        onClick={() => alternar([p.id], !p.disponivelHoje)}
                      >
                        <span className="cardapio-item-nome">
                          <strong>{p.nome}</strong>
                          <small>
                            {formatarReais(p.preco)}
                            {porcoes !== undefined && porcoes !== null && (
                              <span className={porcoes <= 3 ? 'pilula pilula-acabando' : 'pilula pilula-neutra'} style={{ marginLeft: 6 }}
                                title="Quantas porções o estoque atual dos insumos rende">
                                ≈{porcoes} porç{porcoes === 1 ? 'ão' : 'ões'}
                              </span>
                            )}
                          </small>
                        </span>
                        <span className="chave" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
