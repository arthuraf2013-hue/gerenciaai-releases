import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

/** Config/preview/export da tabela de preços de serviços — mesmo padrão
 * do DigitalMenuScreen (cardápio digital), adaptado pra serviço: sem a
 * opção de "esconder preço" (aqui o preço é o conteúdo inteiro). */
export function ServicePriceTableScreen() {
  const [form, setForm] = useState({ titulo: '', subtitulo: '', corTema: '#0f6e63', rodapeTexto: '' });
  const [previewHtml, setPreviewHtml] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  async function carregarConfig() {
    const c = await window.pdv.servicePriceTable.getConfig();
    setForm({
      titulo: c.titulo || '', subtitulo: c.subtitulo || '', corTema: c.cor_tema || '#0f6e63',
      rodapeTexto: c.rodape_texto || '',
    });
  }

  async function atualizarPreview() {
    const html = await window.pdv.servicePriceTable.generateHtml();
    setPreviewHtml(html);
  }

  useEffect(() => { carregarConfig(); atualizarPreview(); }, []);

  async function handleSalvar(e) {
    e.preventDefault();
    setSaving(true);
    await window.pdv.servicePriceTable.updateConfig(form);
    await atualizarPreview();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleAbrirNoNavegador() {
    await window.pdv.servicePriceTable.updateConfig(form);
    await window.pdv.servicePriceTable.openInBrowser();
  }

  async function handleExportar() {
    setExportMsg('');
    await window.pdv.servicePriceTable.updateConfig(form);
    const result = await window.pdv.servicePriceTable.exportHtml();
    if (result.canceled) return;
    setExportMsg(result.ok ? `Salvo em: ${result.filePath}` : `Erro: ${result.error}`);
  }

  return (
    <div className="screen">
      <h1><Icon name="card" size={18} /> Tabela de Preços</h1>
      <p className="screen-hint">
        Personalize a aparência da tabela de preços (página própria pra exibir na recepção, ou
        mandar o arquivo/link pro cliente) — mostra todos os serviços que tiverem o campo "Tipo de
        serviço" preenchido no cadastro do produto, agrupados por tipo. Serviços com material
        associado que soma custo ao preço (ver aba "Materiais usados" no cadastro) aparecem como
        "a partir de", já que o valor final depende do material realmente usado.
      </p>

      <div className="digital-menu-layout">
        <form className="modal-card" style={{ maxWidth: 420 }} onSubmit={handleSalvar}>
          <h2><Icon name="palette" size={18} /> Aparência</h2>
          <label>Título
            <input value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Ex: Tabela de Preços" required />
          </label>
          <label>Subtítulo (opcional)
            <input value={form.subtitulo} onChange={(e) => setForm({ ...form, subtitulo: e.target.value })} placeholder="Ex: Cortes, coloração e tratamentos" />
          </label>
          <label>Cor do tema
            <input type="color" value={form.corTema} onChange={(e) => setForm({ ...form, corTema: e.target.value })} style={{ height: 40, padding: 4 }} />
          </label>
          <label>Rodapé (opcional — endereço, telefone, redes sociais...)
            <input value={form.rodapeTexto} onChange={(e) => setForm({ ...form, rodapeTexto: e.target.value })} />
          </label>
          <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : <><Icon name="save" size={16} /> Salvar e atualizar preview</>}</button>
            <button type="button" className="btn-secondary" onClick={handleAbrirNoNavegador}><Icon name="globe" size={16} /> Abrir no navegador</button>
            <button type="button" className="btn-secondary" onClick={handleExportar}><Icon name="export" size={16} /> Exportar arquivo HTML</button>
          </div>
          {saved && <p className="io-message">Salvo.</p>}
          {exportMsg && <p className={exportMsg.startsWith('Erro') ? 'modal-error' : 'io-message'}>{exportMsg}</p>}
        </form>

        <div className="digital-menu-preview">
          <p className="screen-hint" style={{ margin: '0 0 8px' }}>Preview:</p>
          <iframe title="Preview da tabela de preços" srcDoc={previewHtml} className="digital-menu-iframe" />
        </div>
      </div>
    </div>
  );
}
