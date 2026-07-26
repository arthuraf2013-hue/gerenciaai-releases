import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ProductForm } from './ProductForm';

/** Campo de busca de produto por linha — pré-preenchido com o melhor
 * palpite (busca pela descrição extraída), editável pra corrigir. */
function ProductPicker({ value, onChange }) {
  const [query, setQuery] = useState(value?.nome || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  // Sincroniza o texto mostrado quando o produto da linha é definido de
  // fora (ex: acabou de ser cadastrado por "Cadastrar novo produto") —
  // sem isso, o campo continuaria mostrando o texto antigo digitado.
  useEffect(() => {
    setQuery(value?.nome || '');
  }, [value?.id]);

  async function handleChange(v) {
    setQuery(v);
    onChange(null); // desfaz o match enquanto o usuário digita de novo
    if (v.trim().length < 2) { setResults([]); setOpen(false); return; }
    const list = await window.pdv.products.list({ query: v });
    setResults(Array.isArray(list) ? list.slice(0, 6) : []);
    setOpen(true);
  }

  function selecionar(produto) {
    onChange(produto);
    setQuery(produto.nome);
    setResults([]);
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Buscar produto..."
        style={{ width: 180, borderColor: value ? undefined : 'var(--color-danger)' }}
      />
      {open && results.length > 0 && (
        <ul className="customer-suggestions" style={{ width: 240 }}>
          {results.map((p) => (
            <li key={p.id}><button className="btn-link" onClick={() => selecionar(p)}>{p.nome}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SupplyScreen() {
  const { currentUser } = useSession();
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [arquivoNome, setArquivoNome] = useState('');
  const [linhas, setLinhas] = useState([]); // { produto, lote, validade, quantidade, descricaoOriginal }
  const [fornecedores, setFornecedores] = useState([]);
  const [fornecedorId, setFornecedorId] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState(null);

  const [upcoming, setUpcoming] = useState([]);
  const [loadingUpcoming, setLoadingUpcoming] = useState(false);
  const [cadastrandoLinha, setCadastrandoLinha] = useState(null);

  useEffect(() => {
    window.pdv.suppliers.list({}).then((list) => setFornecedores(Array.isArray(list) ? list : []));
    carregarRecomendacao();
  }, []);

  async function carregarRecomendacao() {
    setLoadingUpcoming(true);
    const list = await window.pdv.supply.listUpcomingExpiry({ locationId: window.APP_LOCATION_ID });
    setLoadingUpcoming(false);
    setUpcoming(Array.isArray(list) ? list : []);
  }

  async function handleAnexar() {
    setExtracting(true);
    setExtractError('');
    setResultado(null);
    const result = await window.pdv.supply.pickAndExtract();
    setExtracting(false);
    if (result.canceled) return;
    if (!result.ok) return setExtractError(result.error);

    setArquivoNome(result.arquivo);

    // Pré-busca um palpite de produto pra cada linha extraída, em paralelo.
    const itensComPalpite = await Promise.all((result.data.itens || []).map(async (item) => {
      const nomeBusca = item.descricao?.trim();
      let produto = null;
      if (nomeBusca) {
        const matches = await window.pdv.products.list({ query: nomeBusca });
        if (Array.isArray(matches) && matches.length > 0) produto = matches[0];
      }
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        descricaoOriginal: item.descricao,
        codigoOriginal: item.codigo,
        precoUnitarioOriginal: item.precoUnitario,
        produto,
        lote: '',
        validade: '',
        quantidade: item.quantidade || 1,
      };
    }));
    setLinhas(itensComPalpite);
  }

  function atualizarLinha(id, mudancas) {
    setLinhas((prev) => prev.map((l) => (l.id === id ? { ...l, ...mudancas } : l)));
  }

  function removerLinha(id) {
    setLinhas((prev) => prev.filter((l) => l.id !== id));
  }

  function handleProdutoCadastrado(result) {
    if (!result.ok) return; // ProductForm já mostra o próprio erro de validação
    atualizarLinha(cadastrandoLinha.id, {
      produto: { id: result.id, nome: cadastrandoLinha.descricaoOriginal },
    });
    setCadastrandoLinha(null);
  }

  async function handleConfirmar() {
    const linhasValidas = linhas.filter((l) => l.produto && l.quantidade > 0);
    if (linhasValidas.length === 0) {
      setExtractError('Nenhuma linha pronta pra confirmar — cada linha precisa de um produto casado e quantidade maior que zero.');
      return;
    }
    setConfirmando(true);
    const result = await window.pdv.supply.confirmEntries({
      linhas: linhasValidas.map((l) => ({
        productId: l.produto.id,
        lote: l.lote || null,
        validade: l.validade || null,
        quantidade: l.quantidade,
        fornecedorId: fornecedorId || null,
      })),
      locationId: window.APP_LOCATION_ID,
      operadorId: currentUser.id,
      deviceId: window.APP_DEVICE_ID,
      motivo: `Abastecimento — ${arquivoNome}`,
    });
    setConfirmando(false);
    setResultado(result);
    if (result.sucesso > 0) {
      setLinhas([]);
      carregarRecomendacao();
    }
  }

  return (
    <div className="screen">
      <h1>Abastecimento</h1>
      <p className="screen-hint">
        Anexe a nota de compra (foto do celular, PDF ou planilha) — a IA lê fotos e PDF, e a
        planilha (CSV/Excel) é lida direto, sem gastar IA. Depois é só casar cada linha com o
        produto do sistema e preencher lote/validade antes de confirmar a entrada.
      </p>

      <button className="btn-primary" onClick={handleAnexar} disabled={extracting}>
        {extracting ? 'Lendo documento...' : 'Anexar nota de compra'}
      </button>
      {extractError && <p className="modal-error">{extractError}</p>}

      {linhas.length > 0 && (
        <section className="settings-section" style={{ marginTop: 20 }}>
          <h2>Conferir e confirmar entrada — {arquivoNome}</h2>

          <label style={{ maxWidth: 320, marginBottom: 12 }}>
            Fornecedor desta nota (opcional)
            <select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
              <option value="">Não informar</option>
              {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
            </select>
          </label>

          <table className="data-table">
            <thead>
              <tr>
                <th>Descrição na nota</th><th>Produto no sistema</th><th>Qtd</th><th>Lote</th><th>Validade</th><th></th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.id} className={!l.produto ? 'row-critical' : ''}>
                  <td>{l.descricaoOriginal}</td>
                  <td>
                    <ProductPicker value={l.produto} onChange={(p) => atualizarLinha(l.id, { produto: p })} />
                    {!l.produto && (
                      <button type="button" className="btn-link" onClick={() => setCadastrandoLinha(l)}>
                        + Cadastrar novo produto
                      </button>
                    )}
                  </td>
                  <td>
                    <input
                      type="number" min="0" step="any" style={{ width: 70 }}
                      value={l.quantidade}
                      onChange={(e) => atualizarLinha(l.id, { quantidade: Number(e.target.value) })}
                    />
                  </td>
                  <td><input style={{ width: 90 }} value={l.lote} onChange={(e) => atualizarLinha(l.id, { lote: e.target.value })} /></td>
                  <td><input type="date" value={l.validade} onChange={(e) => atualizarLinha(l.id, { validade: e.target.value })} /></td>
                  <td><button className="btn-link-danger" onClick={() => removerLinha(l.id)}>Remover</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="screen-hint" style={{ marginTop: 8 }}>
            Linhas em vermelho ainda não têm produto casado — corrija a busca ou remova a linha
            antes de confirmar.
          </p>

          <button className="btn-primary" onClick={handleConfirmar} disabled={confirmando} style={{ marginTop: 8 }}>
            {confirmando ? 'Confirmando...' : `Confirmar entrada (${linhas.filter((l) => l.produto).length} linha(s))`}
          </button>
        </section>
      )}

      {resultado && (
        <p className={resultado.erros.length === 0 ? 'io-message' : 'modal-error'}>
          {resultado.sucesso} lote(s) registrado(s) com sucesso.
          {resultado.erros.length > 0 && ` ${resultado.erros.length} com erro (linha ${resultado.erros[0].linha}: ${resultado.erros[0].erro}).`}
        </p>
      )}

      <section className="settings-section" style={{ marginTop: 28 }}>
        <h2>Recomendação de venda por validade</h2>
        <p className="screen-hint">
          Lotes recebidos pelo abastecimento, ordenados pelo vencimento mais próximo primeiro —
          venda estes antes dos que chegaram depois com validade mais distante.
        </p>
        {loadingUpcoming ? (
          <p className="empty-state">Carregando...</p>
        ) : upcoming.length === 0 ? (
          <p className="empty-state">Nenhum lote com validade registrada ainda.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Produto</th><th>Lote</th><th>Validade</th><th>Qtd recebida</th><th>Fornecedor</th></tr></thead>
            <tbody>
              {upcoming.map((b) => (
                <tr key={b.id}>
                  <td>{b.produto_nome}</td>
                  <td>{b.lote || '—'}</td>
                  <td>{new Date(`${b.validade}T00:00:00`).toLocaleDateString('pt-BR')}</td>
                  <td>{b.quantidade} {b.unidade}</td>
                  <td>{b.fornecedor_nome || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {cadastrandoLinha && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-wide">
            <ProductForm
              product={{
                id: null,
                sku: cadastrandoLinha.codigoOriginal || '',
                codigo_barras: '',
                nome: cadastrandoLinha.descricaoOriginal || '',
                categoria: '',
                // Preço de custo vem direto da nota; preço de venda começa
                // igual ao custo só como ponto de partida — precisa ajustar
                // antes de vender, senão sai vendendo no preço de custo.
                preco: cadastrandoLinha.precoUnitarioOriginal || '',
                custo: cadastrandoLinha.precoUnitarioOriginal || '',
                unidade: 'un',
                estoque_minimo: '',
                custom_fields: '{}',
                ncm: '', cest: '', cfop: '', cst_csosn: '', origem_mercadoria: '0',
              }}
              onSaved={handleProdutoCadastrado}
              onCancel={() => setCadastrandoLinha(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
