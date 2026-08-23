import { useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

const CONFIANCA_LABEL = { alta: 'alta confiança', media: 'confiança média', baixa: 'baixa confiança — confira antes de salvar' };

/**
 * Cadastro rápido de produto a partir de uma foto — aberto quando o
 * código de barras bipado no PDV não bate com nada no catálogo (ver
 * POSScreen.jsx). A IA (Gemini) só SUGERE nome/categoria/unidade a
 * partir da foto da embalagem; preço nunca vem de foto nenhuma (não dá
 * pra saber o preço de venda só olhando o produto), então continua
 * sempre digitado por quem está cadastrando. Se a IA não estiver
 * configurada ou a chamada falhar, o formulário continua disponível
 * pra preencher tudo na mão — a foto é um atalho, nunca um bloqueio.
 */
export function NovoProdutoPorFotoModal({ codigoBarras, onClose, onCriado }) {
  useEscToClose(onClose);
  const [analisando, setAnalisando] = useState(false);
  const [sugestao, setSugestao] = useState(null); // { marca, confianca } | null -- só o que não vira campo do form
  const [avisoFoto, setAvisoFoto] = useState('');
  const [form, setForm] = useState({ nome: '', categoria: '', unidade: 'un', preco: '', estoqueInicial: '1' });
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function handleSelecionarFoto() {
    setAvisoFoto('');
    setAnalisando(true);
    const resultado = await window.pdv.ai.pickAndIdentifyProduct();
    setAnalisando(false);
    if (resultado?.canceled) return; // usuário fechou o seletor de arquivo, sem erro nenhum pra mostrar
    if (!resultado?.ok) {
      setAvisoFoto(resultado?.error || 'Não consegui analisar a foto — preencha os campos manualmente.');
      return;
    }
    const dados = resultado.data || {};
    setForm((f) => ({
      ...f,
      nome: dados.nome || f.nome,
      categoria: dados.categoria || f.categoria,
      unidade: dados.unidade || f.unidade,
    }));
    setSugestao({ marca: dados.marca || '', confianca: dados.confianca || '' });
  }

  async function handleSalvar(e) {
    e.preventDefault();
    setErro('');
    if (!form.nome.trim()) return setErro('Informe o nome do produto.');
    if (form.preco === '' || Number(form.preco) < 0 || Number.isNaN(Number(form.preco))) {
      return setErro('Informe um preço de venda válido.');
    }

    setSalvando(true);
    const resultado = await window.pdv.products.upsert({
      nome: form.nome.trim(),
      categoria: form.categoria.trim() || null,
      unidade: form.unidade || 'un',
      preco: Number(form.preco),
      codigoBarras: codigoBarras || null,
    });
    if (!resultado?.ok) {
      setSalvando(false);
      setErro(resultado?.error || 'Não consegui salvar o produto.');
      return;
    }

    const estoqueInicial = Number(form.estoqueInicial) || 0;
    if (estoqueInicial > 0) {
      await window.pdv.stock.adjust({
        productId: resultado.id,
        locationId: window.APP_LOCATION_ID,
        quantidade: estoqueInicial,
        tipo: 'entrada',
        motivo: 'Cadastro inicial via foto (IA)',
        deviceId: window.APP_DEVICE_ID,
      });
    }

    setSalvando(false);
    onCriado({
      id: resultado.id, nome: form.nome.trim(), preco: Number(form.preco),
      categoria: form.categoria.trim() || null, codigo_barras: codigoBarras || null,
      temEstoque: estoqueInicial > 0,
    });
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal-card" onSubmit={handleSalvar} style={{ width: 'min(440px, 94vw)' }}>
        <h2><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="camera" size={18} /> Cadastrar produto por foto</span></h2>
        <p className="screen-hint" style={{ margin: '0 0 10px' }}>
          Código bipado: <strong>{codigoBarras}</strong> — não encontrado no catálogo.
        </p>

        <button type="button" className="btn-secondary" onClick={handleSelecionarFoto} disabled={analisando} style={{ marginBottom: 10 }}>
          {analisando ? 'Analisando foto...' : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="camera" size={15} /> Selecionar foto do produto</span>
          )}
        </button>
        {avisoFoto && <p className="screen-hint" style={{ color: 'var(--color-danger, #c0392b)' }}>{avisoFoto}</p>}
        {sugestao && (
          <p className="screen-hint" style={{ margin: '0 0 10px' }}>
            Sugerido pela IA{sugestao.marca ? ` — marca: ${sugestao.marca}` : ''}
            {sugestao.confianca ? ` (${CONFIANCA_LABEL[sugestao.confianca] || sugestao.confianca})` : ''}. Confira os campos abaixo antes de salvar.
          </p>
        )}

        <div className="form-grid">
          <label>Nome
            <input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required autoFocus />
          </label>
          <label>Categoria
            <input value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })} />
          </label>
          <label>Unidade
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
              {['un', 'kg', 'g', 'l', 'ml'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <label>Preço de venda (R$)
            <input type="number" step="0.01" min="0" value={form.preco} onChange={(e) => setForm({ ...form, preco: e.target.value })} required />
          </label>
          <label>Estoque inicial
            <input type="number" min="0" value={form.estoqueInicial} onChange={(e) => setForm({ ...form, estoqueInicial: e.target.value })} />
          </label>
        </div>
        <p className="screen-hint" style={{ margin: '0 0 8px' }}>
          Com estoque inicial 0, o produto fica cadastrado mas não pode ser vendido até dar entrada no estoque (tela Abastecimento).
        </p>

        {erro && <p className="modal-error">{erro}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span>
          </button>
          <button type="submit" className="btn-primary" disabled={salvando}>
            {salvando ? 'Salvando...' : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="save" size={15} /> Cadastrar produto</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
