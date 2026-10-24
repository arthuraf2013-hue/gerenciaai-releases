import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';

// Vitrine online: página pública com os produtos e preços da loja, pedido
// pelo WhatsApp. O endereço e o WhatsApp que recebe os pedidos são criados
// na Central; aqui a loja liga, desliga e escolhe o que mostrar. Ver
// electron/services/vitrineService.js.

const dataHora = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`).toLocaleString('pt-BR') : null);

export function VitrineOnline() {
  const { currentUser } = useSession();
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    const c = await window.pdv.vitrine.getConfig();
    if (c && c.ok === false) { setMensagem({ tipo: 'erro', texto: c.error }); return; }
    setConfig(c);
    setForm((f) => f || {
      ativa: c.ativa, ocultarSemEstoque: c.ocultarSemEstoque, avisoPoucasUnidades: String(c.avisoPoucasUnidades),
      mensagem: c.mensagem, modos: c.modos, pedidoMinimo: c.pedidoMinimo ? String(c.pedidoMinimo).replace('.', ',') : '',
    });
  }

  useEffect(() => { carregar(); }, []);

  function alternarModo(modo, ligado) {
    setForm((f) => ({ ...f, modos: ligado ? [...new Set([...f.modos, modo])] : f.modos.filter((m) => m !== modo) }));
  }

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    setMensagem(null);
    const r = await window.pdv.vitrine.saveConfig({
      ...form,
      avisoPoucasUnidades: Number(form.avisoPoucasUnidades) || 0,
      pedidoMinimo: Number(String(form.pedidoMinimo || '0').replace(',', '.')) || 0,
      requestingUserId: currentUser.id,
    });
    setSalvando(false);
    if (!r.ok) { setMensagem({ tipo: 'erro', texto: r.error }); return; }
    setMensagem({ tipo: 'ok', texto: r.config.slug ? 'Salvo. A página atualiza em alguns segundos.' : 'Salvo. Falta criar o endereço da vitrine na Central.' });
    carregar();
  }

  async function copiarLink() {
    try { await navigator.clipboard.writeText(config.link); setMensagem({ tipo: 'ok', texto: 'Link copiado — cole na bio do Instagram, no Google e no status do WhatsApp.' }); } catch { setMensagem({ tipo: 'erro', texto: 'Não consegui copiar.' }); }
  }

  return (
    <section className="settings-section">
      <h2><Icon name="store" size={16} /> Vitrine online</h2>
      <p className="screen-hint">
        Uma página com os seus produtos e preços para colocar no Instagram, no Google e no WhatsApp. O cliente escolhe,
        monta o carrinho e o pedido chega no WhatsApp da loja, já escrito. Custo e quantidade exata em estoque nunca aparecem.
      </p>
      {!form && <p className="screen-hint">Carregando...</p>}
      {form && (
        <>
          {config?.link ? (
            <div className="vitrine-link">
              {config.qrDataUrl && <img src={config.qrDataUrl} alt="QR Code da vitrine" width="132" height="132" />}
              <div>
                <div className="vitrine-link-url">{config.link}</div>
                <p className="screen-hint" style={{ margin: '4px 0 8px' }}>
                  {config.ativa
                    ? (config.ultimaPublicacao ? `Publicada ${dataHora(config.ultimaPublicacao)} · ${config.itensPublicados ?? 0} produto(s)` : 'Publicando...')
                    : 'Desligada: quem abrir o link vê "vitrine fechada".'}
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn-secondary" onClick={copiarLink}><Icon name="link" size={15} /> Copiar link</button>
                  <a className="btn-secondary" href={config.link} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Icon name="globe" size={15} /> Abrir a página</a>
                </div>
              </div>
            </div>
          ) : (
            <p className="io-message-aviso"><Icon name="warning" size={15} /> O endereço da vitrine ainda não foi criado. Peça ao suporte (é criado na Central, junto com o WhatsApp que recebe os pedidos).</p>
          )}

          <form className="product-form" onSubmit={salvar} style={{ marginTop: 12 }}>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.ativa} onChange={(e) => setForm({ ...form, ativa: e.target.checked })} />
              Vitrine ligada
            </label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.ocultarSemEstoque} onChange={(e) => setForm({ ...form, ocultarSemEstoque: e.target.checked })} />
              Esconder produto sem estoque (desmarcado: aparece como "esgotado")
            </label>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Como o cliente recebe:</span>
              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.modos.includes('retirada')} onChange={(e) => alternarModo('retirada', e.target.checked)} /> Retirada na loja
              </label>
              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.modos.includes('entrega')} onChange={(e) => alternarModo('entrega', e.target.checked)} /> Entrega
              </label>
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <label>
                Mostrar "poucas unidades" com estoque até
                <input type="number" min="0" max="1000" step="1" value={form.avisoPoucasUnidades} onChange={(e) => setForm({ ...form, avisoPoucasUnidades: e.target.value })} />
              </label>
              <label>
                Pedido mínimo (R$, opcional)
                <input inputMode="decimal" value={form.pedidoMinimo} onChange={(e) => setForm({ ...form, pedidoMinimo: e.target.value })} placeholder="0,00" />
              </label>
            </div>
            <label style={{ maxWidth: 640 }}>
              Recado no topo da página (opcional)
              <input maxLength={280} value={form.mensagem} onChange={(e) => setForm({ ...form, mensagem: e.target.value })} placeholder="Ex: Entregamos no bairro de seg. a sáb., das 8h às 19h." />
            </label>
            <button className="btn-primary" type="submit" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar vitrine'}</button>
            {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
          </form>
        </>
      )}
    </section>
  );
}
