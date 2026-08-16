import { useEffect, useState } from 'react';

export function DigitalMenuScreen() {
  const [form, setForm] = useState({ titulo: '', subtitulo: '', corTema: '#0f6e63', mostrarPrecos: true, rodapeTexto: '' });
  const [previewHtml, setPreviewHtml] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  async function carregarConfig() {
    const c = await window.pdv.digitalMenu.getConfig();
    setForm({
      titulo: c.titulo || '', subtitulo: c.subtitulo || '', corTema: c.cor_tema || '#0f6e63',
      mostrarPrecos: !!c.mostrar_precos, rodapeTexto: c.rodape_texto || '',
    });
  }

  async function atualizarPreview() {
    const html = await window.pdv.digitalMenu.generateHtml();
    setPreviewHtml(html);
  }

  useEffect(() => { carregarConfig(); atualizarPreview(); }, []);

  async function handleSalvar(e) {
    e.preventDefault();
    setSaving(true);
    await window.pdv.digitalMenu.updateConfig(form);
    await atualizarPreview();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleAbrirNoNavegador() {
    await window.pdv.digitalMenu.updateConfig(form);
    await window.pdv.digitalMenu.openInBrowser();
  }

  async function handleExportar() {
    setExportMsg('');
    await window.pdv.digitalMenu.updateConfig(form);
    const result = await window.pdv.digitalMenu.exportHtml();
    if (result.canceled) return;
    setExportMsg(result.ok ? `Salvo em: ${result.filePath}` : `Erro: ${result.error}`);
  }

  return (
    <div className="screen">
      <h1>🍽️ Cardápio Digital</h1>
      <p className="screen-hint">
        Personalize a aparência do cardápio digital (página própria pra exibir num tablet/TV, ou
        mandar o arquivo/link pro cliente) — mostra todos os pratos que tiverem o campo "Tipo"
        preenchido no cadastro do produto, agrupados por tipo. É diferente do "Cardápio do dia": este
        aqui é o cardápio permanente, não muda conforme a disponibilidade diária.
      </p>

      <div className="digital-menu-layout">
        <form className="modal-card" style={{ maxWidth: 420 }} onSubmit={handleSalvar}>
          <h2>🎨 Aparência</h2>
          <label>Título
            <input value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Ex: Nosso Cardápio" required />
          </label>
          <label>Subtítulo (opcional)
            <input value={form.subtitulo} onChange={(e) => setForm({ ...form, subtitulo: e.target.value })} placeholder="Ex: Sabores de casa, todos os dias" />
          </label>
          <label>Cor do tema
            <input type="color" value={form.corTema} onChange={(e) => setForm({ ...form, corTema: e.target.value })} style={{ height: 40, padding: 4 }} />
          </label>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox" style={{ width: 'auto' }}
              checked={form.mostrarPrecos}
              onChange={(e) => setForm({ ...form, mostrarPrecos: e.target.checked })}
            />
            Mostrar preços
          </label>
          <label>Rodapé (opcional — endereço, telefone, redes sociais...)
            <input value={form.rodapeTexto} onChange={(e) => setForm({ ...form, rodapeTexto: e.target.value })} />
          </label>
          <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : '💾 Salvar e atualizar preview'}</button>
            <button type="button" className="btn-secondary" onClick={handleAbrirNoNavegador}>🌐 Abrir no navegador</button>
            <button type="button" className="btn-secondary" onClick={handleExportar}>📤 Exportar arquivo HTML</button>
          </div>
          {saved && <p className="io-message">Salvo.</p>}
          {exportMsg && <p className={exportMsg.startsWith('Erro') ? 'modal-error' : 'io-message'}>{exportMsg}</p>}
        </form>

        <div className="digital-menu-preview">
          <p className="screen-hint" style={{ margin: '0 0 8px' }}>Preview:</p>
          <iframe title="Preview do cardápio digital" srcDoc={previewHtml} className="digital-menu-iframe" />
        </div>
      </div>
    </div>
  );
}
