import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { useProfile } from '../../context/ProfileContext';
import { useSession } from '../../context/SessionContext';

const emptyProduct = {
  id: null, sku: '', codigoBarras: '', nome: '', categoria: '',
  preco: '', custo: '', unidade: 'un', codigoBalanca: '', estoqueMinimo: '', customFields: {},
  ncm: '', cest: '', cfop: '', cstCsosn: '', origemMercadoria: '0',
};

/**
 * @param {{ product?: object, onSaved: () => void, onCancel: () => void }} props
 */
export function ProductForm({ product, onSaved, onCancel }) {
  const { profile } = useProfile();
  const { currentUser } = useSession();
  const [form, setForm] = useState(emptyProduct);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [fotoDataUrl, setFotoDataUrl] = useState(null);
  const [fotoBusy, setFotoBusy] = useState(false);
  const [historicoPreco, setHistoricoPreco] = useState([]);
  const [mostrarHistorico, setMostrarHistorico] = useState(false);
  const [insumosDisponiveis, setInsumosDisponiveis] = useState([]);
  const [receita, setReceita] = useState([]); // [{ ingredientId, quantidade }]
  const [mostrarFicha, setMostrarFicha] = useState(false);
  const [custoCalculado, setCustoCalculado] = useState(0);
  const [margemPercentual, setMargemPercentual] = useState('');
  const [fichaSalva, setFichaSalva] = useState('');
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const barcodeCanvasRef = useRef(null);

  async function handleGerarCodigoInterno() {
    setBarcodeBusy(true);
    const result = await window.pdv.products.generateInternalBarcode({ productId: form.id });
    setBarcodeBusy(false);
    if (!result.ok) return setError(result.error);
    setField('codigoBarras', result.codigoBarras);
  }

  function handleImprimirEtiqueta() {
    if (!barcodeCanvasRef.current || !form.codigoBarras) return;
    JsBarcode(barcodeCanvasRef.current, form.codigoBarras, { format: 'CODE128', displayValue: false, margin: 0, height: 60 });
    const dataUrl = barcodeCanvasRef.current.toDataURL('image/png');
    window.pdv.print.label({
      nome: form.nome, preco: Number(form.preco) || 0, codigoBarras: form.codigoBarras, barcodeDataUrl: dataUrl,
    });
  }

  useEffect(() => {
    if (product) {
      setForm({
        id: product.id,
        sku: product.sku || '',
        codigoBarras: product.codigo_barras || '',
        nome: product.nome || '',
        categoria: product.categoria || '',
        preco: product.preco ?? '',
        custo: product.custo || '',
        unidade: product.unidade || 'un',
        codigoBalanca: product.codigo_balanca || '',
        estoqueMinimo: product.estoque_minimo ?? '',
        customFields: JSON.parse(product.custom_fields || '{}'),
        ncm: product.ncm || '', cest: product.cest || '', cfop: product.cfop || '',
        cstCsosn: product.cst_csosn || '', origemMercadoria: product.origem_mercadoria || '0',
      });
      if (product.custo > 0 && product.preco > 0) {
        setMargemPercentual((((product.preco - product.custo) / product.custo) * 100).toFixed(1));
      } else {
        setMargemPercentual('');
      }
      if (product.foto_path) {
        window.pdv.products.getFotoDataUrl({ productId: product.id }).then(setFotoDataUrl);
      } else {
        setFotoDataUrl(null);
      }
      window.pdv.products.listPriceHistory({ productId: product.id }).then((list) => {
        setHistoricoPreco(Array.isArray(list) ? list : []);
      });
      window.pdv.ingredient.list({}).then((list) => setInsumosDisponiveis(Array.isArray(list) ? list : []));
      window.pdv.ingredient.getRecipe({ productId: product.id }).then((list) => {
        setReceita(Array.isArray(list) ? list.map((r) => ({ ingredientId: r.ingredient_id, quantidade: r.quantidade })) : []);
      });
      window.pdv.ingredient.computeDishCost({ productId: product.id }).then(setCustoCalculado);
    } else {
      setForm(emptyProduct);
      setFotoDataUrl(null);
      setHistoricoPreco([]);
      setReceita([]);
    }
  }, [product]);

  async function handleFotoSelect() {
    setFotoBusy(true);
    const result = await window.pdv.products.setFoto({ productId: form.id });
    setFotoBusy(false);
    if (result.canceled || !result.ok) return;
    const url = await window.pdv.products.getFotoDataUrl({ productId: form.id });
    setFotoDataUrl(url);
  }

  async function handleFotoRemove() {
    setFotoBusy(true);
    await window.pdv.products.removeFoto({ productId: form.id });
    setFotoBusy(false);
    setFotoDataUrl(null);
  }

  function setField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  const [identificandoFoto, setIdentificandoFoto] = useState(false);
  const [avisoIdentificacao, setAvisoIdentificacao] = useState('');

  // Só faz sentido pra produto NOVO (o de editar já tem esses campos
  // preenchidos) -- diferente da foto do cadastro em si (fotoDataUrl
  // acima, que exige o produto já salvo), essa foto é só um atalho
  // pra preencher o formulário, nunca fica guardada em lugar nenhum.
  async function handleIdentificarPorFoto() {
    setAvisoIdentificacao('');
    setIdentificandoFoto(true);
    const resultado = await window.pdv.ai.pickAndIdentifyProduct();
    setIdentificandoFoto(false);
    if (resultado?.canceled) return;
    if (!resultado?.ok) return setAvisoIdentificacao(resultado?.error || 'Não consegui analisar a foto.');
    const dados = resultado.data || {};
    setForm((prev) => ({
      ...prev,
      nome: dados.nome || prev.nome,
      categoria: dados.categoria || prev.categoria,
      unidade: dados.unidade || prev.unidade,
    }));
    setAvisoIdentificacao(
      dados.confianca === 'baixa' ? 'Sugestão de baixa confiança — confira os campos antes de salvar.' : ''
    );
  }

  // Editar a margem recalcula o preço de venda a partir do custo atual.
  function handleMargemChange(novaMargem) {
    setMargemPercentual(novaMargem);
    const custo = Number(form.custo);
    const margem = Number(novaMargem);
    if (custo > 0 && !isNaN(margem)) {
      setField('preco', (custo * (1 + margem / 100)).toFixed(2));
    }
  }

  // Editar o custo, com uma margem já definida, mantém a margem —
  // recalcula o preço de venda pra continuar com o mesmo aumento
  // percentual (útil quando a leitura da nota atualiza o custo sozinha).
  function handleCustoChange(novoCusto) {
    setField('custo', novoCusto);
    const custo = Number(novoCusto);
    const margem = Number(margemPercentual);
    if (custo > 0 && margemPercentual !== '' && !isNaN(margem)) {
      setField('preco', (custo * (1 + margem / 100)).toFixed(2));
    }
  }

  // Editar o preço direto (sem mexer na margem) atualiza a margem
  // exibida, só como referência — não força nada.
  function handlePrecoChange(novoPreco) {
    setField('preco', novoPreco);
    const custo = Number(form.custo);
    const preco = Number(novoPreco);
    if (custo > 0 && !isNaN(preco)) {
      setMargemPercentual((((preco - custo) / custo) * 100).toFixed(1));
    }
  }

  function setCustomField(campo, value) {
    setForm((prev) => ({ ...prev, customFields: { ...prev.customFields, [campo]: value } }));
  }

  function adicionarLinhaReceita() {
    setReceita((prev) => [...prev, { ingredientId: '', quantidade: '' }]);
  }

  function atualizarLinhaReceita(index, campo, valor) {
    setReceita((prev) => prev.map((r, i) => (i === index ? { ...r, [campo]: valor } : r)));
  }

  function removerLinhaReceita(index) {
    setReceita((prev) => prev.filter((_, i) => i !== index));
  }

  async function salvarFichaTecnica() {
    setFichaSalva('');
    const itens = receita.filter((r) => r.ingredientId && Number(r.quantidade) > 0);
    await window.pdv.ingredient.setRecipe({ productId: form.id, itens });
    const custo = await window.pdv.ingredient.computeDishCost({ productId: form.id });
    setCustoCalculado(custo);
    setFichaSalva('Ficha técnica salva.');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!form.nome.trim()) return setError('Informe o nome do produto.');
    if (form.preco === '' || isNaN(Number(form.preco))) return setError('Informe um preço válido.');

    for (const campo of profile?.camposExtras || []) {
      if (campo.obrigatorio && !form.customFields[campo.campo]) {
        return setError(`O campo "${campo.label}" é obrigatório para o perfil ${profile.nome}.`);
      }
    }

    setSaving(true);
    const result = await window.pdv.products.upsert({
      id: form.id,
      sku: form.sku || null,
      codigoBarras: form.codigoBarras || null,
      nome: form.nome.trim(),
      categoria: form.categoria || null,
      preco: Number(form.preco),
      custo: form.custo ? Number(form.custo) : 0,
      unidade: form.unidade || 'un',
      codigoBalanca: form.unidade === 'kg' ? (form.codigoBalanca || undefined) : undefined,
      estoqueMinimo: form.estoqueMinimo ? Number(form.estoqueMinimo) : 0,
      customFields: form.customFields,
      ncm: form.ncm || null,
      cest: form.cest || null,
      cfop: form.cfop || null,
      cstCsosn: form.cstCsosn || null,
      origemMercadoria: form.origemMercadoria || '0',
      operadorId: currentUser.id,
    });
    setSaving(false);
    if (!result.ok) return setError(result.error);
    onSaved(result);
  }

  return (
    <form
      className="product-form"
      onSubmit={handleSubmit}
    >
      <h2>{form.id ? 'Editar produto' : 'Novo produto'}</h2>

      {!form.id && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" className="btn-secondary" onClick={handleIdentificarPorFoto} disabled={identificandoFoto}>
            {identificandoFoto ? 'Analisando foto...' : '🤖 Identificar por foto (IA)'}
          </button>
          {avisoIdentificacao && <p className="screen-hint" style={{ margin: '4px 0 0' }}>{avisoIdentificacao}</p>}
        </div>
      )}

      <div className="product-photo-section">
        {fotoDataUrl ? (
          <img src={fotoDataUrl} alt={form.nome} className="product-photo-preview" />
        ) : (
          <div className="product-photo-preview product-photo-placeholder">Sem foto</div>
        )}
        <div className="product-photo-actions">
          {form.id ? (
            <>
              <button type="button" className="btn-secondary" onClick={handleFotoSelect} disabled={fotoBusy}>
                {fotoBusy ? 'Aguarde...' : fotoDataUrl ? 'Trocar foto' : 'Adicionar foto'}
              </button>
              {fotoDataUrl && (
                <button type="button" className="btn-link-danger" onClick={handleFotoRemove} disabled={fotoBusy}>🗑️ Remover</button>
              )}
            </>
          ) : (
            <p className="screen-hint" style={{ margin: 0 }}>Salve o produto primeiro para adicionar uma foto.</p>
          )}
        </div>
      </div>

      <div className="form-grid">
        <label>Nome
          <input value={form.nome} onChange={(e) => setField('nome', e.target.value)} required autoFocus />
        </label>
        <label>Categoria
          <input value={form.categoria} onChange={(e) => setField('categoria', e.target.value)} />
        </label>
        <label>SKU
          <input value={form.sku} onChange={(e) => setField('sku', e.target.value)} />
        </label>
        <label>Código de barras
          <input
            value={form.codigoBarras}
            onChange={(e) => setField('codigoBarras', e.target.value)}
            // Só ESTE campo bloqueia Enter — o leitor de código de
            // barras manda um Enter depois dos dígitos, e sem isso o
            // formulário salvava e fechava sozinho antes da pessoa
            // terminar de preencher o resto do cadastro. Os outros
            // campos usam o Enter normal do navegador pra salvar.
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
          />
        </label>
        {form.id && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', gridColumn: '1 / -1' }}>
            {!form.codigoBarras && (
              <button type="button" className="btn-secondary" onClick={handleGerarCodigoInterno} disabled={barcodeBusy}>
                {barcodeBusy ? 'Gerando...' : '🏷️ Gerar código de barras interno'}
              </button>
            )}
            {form.codigoBarras && (
              <button type="button" className="btn-secondary" onClick={handleImprimirEtiqueta}>🖨️ Imprimir etiqueta</button>
            )}
            <canvas ref={barcodeCanvasRef} style={{ display: 'none' }} />
          </div>
        )}
        <label>Preço de venda
          <input type="number" step="0.01" value={form.preco} onChange={(e) => handlePrecoChange(e.target.value)} required />
        </label>
        {form.id && historicoPreco.length > 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="btn-link" onClick={() => setMostrarHistorico((v) => !v)}>
              {mostrarHistorico ? 'Esconder' : 'Ver'} histórico de preço ({historicoPreco.length})
            </button>
            {mostrarHistorico && (
              <ul className="payment-list" style={{ marginTop: 6 }}>
                {historicoPreco.map((h) => (
                  <li key={h.id}>
                    R$ {h.preco_antigo.toFixed(2)} → R$ {h.preco_novo.toFixed(2)}
                    {' — '}{new Date(h.criado_em + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })}
                    {h.operador_nome && ` (${h.operador_nome})`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <label>Custo
          <input type="number" step="0.01" value={form.custo} onChange={(e) => handleCustoChange(e.target.value)} />
        </label>
        <label>Margem sobre o custo (%)
          <input
            type="number" step="0.1" value={margemPercentual}
            onChange={(e) => handleMargemChange(e.target.value)}
            placeholder="Ex: 40 (calcula o preço de venda sozinho)"
            disabled={!form.custo || Number(form.custo) <= 0}
          />
        </label>
        <label>Unidade
          <select value={form.unidade} onChange={(e) => setField('unidade', e.target.value)}>
            <option value="un">Unidade</option>
            <option value="kg">Kg (vendido por peso)</option>
            <option value="g">Grama</option>
            <option value="l">Litro</option>
            <option value="ml">Mililitro</option>
            <option value="cx">Caixa</option>
            <option value="pct">Pacote</option>
          </select>
        </label>
        {form.unidade === 'kg' && (
          <label>Código do produto na balança
            <input
              value={form.codigoBalanca || ''}
              onChange={(e) => setField('codigoBalanca', e.target.value)}
              placeholder="Ex: 001234 (cadastrado na própria balança)"
            />
          </label>
        )}
        <label>Estoque mínimo (alerta)
          <input type="number" step="0.01" value={form.estoqueMinimo} onChange={(e) => setField('estoqueMinimo', e.target.value)} />
        </label>
      </div>

      <h3>🧾 Dados fiscais (opcional — necessário só quando a emissão de NFC-e estiver ativa)</h3>
      <div className="form-grid">
        <label>NCM
          <input value={form.ncm} onChange={(e) => setField('ncm', e.target.value)} placeholder="8 dígitos" maxLength={8} />
        </label>
        <label>CEST
          <input value={form.cest} onChange={(e) => setField('cest', e.target.value)} placeholder="quando aplicável" />
        </label>
        <label>CFOP
          <input value={form.cfop} onChange={(e) => setField('cfop', e.target.value)} placeholder="ex: 5102" />
        </label>
        <label>CST/CSOSN
          <input value={form.cstCsosn} onChange={(e) => setField('cstCsosn', e.target.value)} placeholder="conforme regime tributário" />
        </label>
        <label>Origem da mercadoria
          <select value={form.origemMercadoria} onChange={(e) => setField('origemMercadoria', e.target.value)}>
            <option value="0">0 - Nacional</option>
            <option value="1">1 - Estrangeira (importação direta)</option>
            <option value="2">2 - Estrangeira (adquirida no mercado interno)</option>
          </select>
        </label>
      </div>

      {profile?.camposExtras?.length > 0 && (
        <>
          <h3>📋 Campos do perfil "{profile.nome}"</h3>
          <div className="form-grid">
            {profile.camposExtras.map((campo) => (
              <label key={campo.campo}>
                {campo.label}{campo.obrigatorio ? ' *' : ''}
                {campo.tipo === 'boolean' ? (
                  <select
                    value={form.customFields[campo.campo] ? 'sim' : 'não'}
                    onChange={(e) => setCustomField(campo.campo, e.target.value === 'sim')}
                  >
                    <option value="não">Não</option>
                    <option value="sim">Sim</option>
                  </select>
                ) : (
                  <input
                    type={campo.tipo === 'data' ? 'date' : campo.tipo === 'numero' ? 'number' : 'text'}
                    value={form.customFields[campo.campo] || ''}
                    onChange={(e) => setCustomField(campo.campo, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
        </>
      )}

      {error && <p className="modal-error">{error}</p>}

      {form.id && (
        <div style={{ gridColumn: '1 / -1', marginTop: 12 }}>
          <button type="button" className="btn-link" onClick={() => setMostrarFicha((v) => !v)}>
            {mostrarFicha ? 'Esconder' : 'Ver'} ficha técnica (insumos)
            {custoCalculado > 0 && ` — custo calculado: R$ ${custoCalculado.toFixed(2)}`}
          </button>
          {mostrarFicha && (
            <div style={{ marginTop: 8, border: '1px solid var(--color-border)', borderRadius: 8, padding: 12 }}>
              <p className="screen-hint" style={{ margin: '0 0 10px' }}>
                Insumos e quantidades que entram numa porção deste prato — usado pra calcular o custo
                automaticamente (inclusive nos registros de desperdício). Cadastre os insumos em
                Insumos, no menu, antes de montar a ficha aqui.
              </p>
              {receita.map((linha, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <select
                    value={linha.ingredientId}
                    onChange={(e) => atualizarLinhaReceita(i, 'ingredientId', e.target.value)}
                    style={{ flex: 2 }}
                  >
                    <option value="">Selecione o insumo...</option>
                    {insumosDisponiveis.map((ins) => (
                      <option key={ins.id} value={ins.id}>{ins.nome} ({ins.unidade})</option>
                    ))}
                  </select>
                  <input
                    type="number" step="0.01" min="0" placeholder="Quantidade"
                    value={linha.quantidade}
                    onChange={(e) => atualizarLinhaReceita(i, 'quantidade', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn-link-danger" onClick={() => removerLinhaReceita(i)}>🗑️ Remover</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="button" className="btn-secondary" onClick={adicionarLinhaReceita}>➕ Adicionar insumo</button>
                <button type="button" className="btn-secondary" onClick={salvarFichaTecnica}>💾 Salvar ficha técnica</button>
              </div>
              {fichaSalva && <p className="io-message" style={{ marginTop: 8 }}>{fichaSalva}</p>}
            </div>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>✖️ Cancelar</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Salvando...' : '💾 Salvar produto'}
        </button>
      </div>
    </form>
  );
}
