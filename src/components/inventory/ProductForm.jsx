import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { useProfile } from '../../context/ProfileContext';

const emptyProduct = {
  id: null, sku: '', codigoBarras: '', nome: '', categoria: '',
  preco: '', custo: '', unidade: 'un', estoqueMinimo: '', customFields: {},
  ncm: '', cest: '', cfop: '', cstCsosn: '', origemMercadoria: '0',
};

/**
 * @param {{ product?: object, onSaved: () => void, onCancel: () => void }} props
 */
export function ProductForm({ product, onSaved, onCancel }) {
  const { profile } = useProfile();
  const [form, setForm] = useState(emptyProduct);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [fotoDataUrl, setFotoDataUrl] = useState(null);
  const [fotoBusy, setFotoBusy] = useState(false);
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
        custo: product.custo ?? '',
        unidade: product.unidade || 'un',
        estoqueMinimo: product.estoque_minimo ?? '',
        customFields: JSON.parse(product.custom_fields || '{}'),
        ncm: product.ncm || '', cest: product.cest || '', cfop: product.cfop || '',
        cstCsosn: product.cst_csosn || '', origemMercadoria: product.origem_mercadoria || '0',
      });
      if (product.foto_path) {
        window.pdv.products.getFotoDataUrl({ productId: product.id }).then(setFotoDataUrl);
      } else {
        setFotoDataUrl(null);
      }
    } else {
      setForm(emptyProduct);
      setFotoDataUrl(null);
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

  function setCustomField(campo, value) {
    setForm((prev) => ({ ...prev, customFields: { ...prev.customFields, [campo]: value } }));
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
      estoqueMinimo: form.estoqueMinimo ? Number(form.estoqueMinimo) : 0,
      customFields: form.customFields,
      ncm: form.ncm || null,
      cest: form.cest || null,
      cfop: form.cfop || null,
      cstCsosn: form.cstCsosn || null,
      origemMercadoria: form.origemMercadoria || '0',
    });
    setSaving(false);
    if (!result.ok) return setError(result.error);
    onSaved(result);
  }

  return (
    <form className="product-form" onSubmit={handleSubmit}>
      <h2>{form.id ? 'Editar produto' : 'Novo produto'}</h2>

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
                <button type="button" className="btn-link-danger" onClick={handleFotoRemove} disabled={fotoBusy}>Remover</button>
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
          <input value={form.codigoBarras} onChange={(e) => setField('codigoBarras', e.target.value)} />
        </label>
        {form.id && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', gridColumn: '1 / -1' }}>
            {!form.codigoBarras && (
              <button type="button" className="btn-secondary" onClick={handleGerarCodigoInterno} disabled={barcodeBusy}>
                {barcodeBusy ? 'Gerando...' : 'Gerar código de barras interno'}
              </button>
            )}
            {form.codigoBarras && (
              <button type="button" className="btn-secondary" onClick={handleImprimirEtiqueta}>Imprimir etiqueta</button>
            )}
            <canvas ref={barcodeCanvasRef} style={{ display: 'none' }} />
          </div>
        )}
        <label>Preço de venda
          <input type="number" step="0.01" value={form.preco} onChange={(e) => setField('preco', e.target.value)} required />
        </label>
        <label>Custo
          <input type="number" step="0.01" value={form.custo} onChange={(e) => setField('custo', e.target.value)} />
        </label>
        <label>Unidade
          <input value={form.unidade} onChange={(e) => setField('unidade', e.target.value)} />
        </label>
        <label>Estoque mínimo (alerta)
          <input type="number" step="0.01" value={form.estoqueMinimo} onChange={(e) => setField('estoqueMinimo', e.target.value)} />
        </label>
      </div>

      <h3>Dados fiscais (opcional — necessário só quando a emissão de NFC-e estiver ativa)</h3>
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
          <h3>Campos do perfil "{profile.nome}"</h3>
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

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Salvando...' : 'Salvar produto'}
        </button>
      </div>
    </form>
  );
}
