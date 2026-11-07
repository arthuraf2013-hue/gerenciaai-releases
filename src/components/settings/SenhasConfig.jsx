import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Senhas e painel de chamada (TV / Vértice) -- ver
// electron/services/chamadaService.js e pwa-mobile/painel.html. O link do
// painel leva um segredo: quem tem o link vê número e primeiro nome (nunca
// valor nem item). "Gerar novo link" invalida o antigo.

export function SenhasConfig() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const [ocupado, setOcupado] = useState('');

  async function carregar() {
    const c = await window.pdv.chamada.getConfig();
    if (c?.ok === false) { setMensagem({ tipo: 'erro', texto: c.error }); return; }
    setConfig(c);
    setForm((f) => f || { ativa: c.ativa, senhaNoBalcao: c.senhaNoBalcao, minutosNoPainel: String(c.minutosNoPainel), modelo: { ...c.modelo } });
  }
  useEffect(() => { carregar(); }, []);

  const m = form?.modelo;
  const setM = (campo, valor) => setForm((f) => ({ ...f, modelo: { ...f.modelo, [campo]: valor } }));

  async function salvar(e) {
    e.preventDefault();
    setOcupado('salvar'); setMensagem(null);
    const r = await window.pdv.chamada.saveConfig({ ...form, minutosNoPainel: Number(form.minutosNoPainel) || 15 });
    setOcupado('');
    if (!r?.ok) { setMensagem({ tipo: 'erro', texto: r?.error }); return; }
    setMensagem({ tipo: 'ok', texto: r.config.ativa ? 'Salvo. A tela "Senhas" aparece no menu e o painel atualiza em segundos.' : 'Salvo (painel desligado).' });
    const c = await window.pdv.chamada.getConfig();
    setConfig(c);
  }

  async function novoLink() {
    if (!confirm('Gerar um link novo? A TV que usa o link atual para de atualizar até você colocar o novo.')) return;
    setOcupado('link');
    const r = await window.pdv.chamada.gerarNovoLink();
    setOcupado('');
    if (!r?.ok) { setMensagem({ tipo: 'erro', texto: r?.error }); return; }
    setConfig(r.config);
    setMensagem({ tipo: 'ok', texto: 'Link novo gerado. Atualize o endereço na TV / no Vértice.' });
  }

  async function copiar() {
    try { await navigator.clipboard.writeText(config.link); setMensagem({ tipo: 'ok', texto: 'Link copiado. Cole no Vértice (tela → conteúdo de página web) ou abra no navegador da TV em tela cheia.' }); } catch { setMensagem({ tipo: 'erro', texto: 'Não consegui copiar.' }); }
  }

  if (!form) return <section className="settings-section"><p className="screen-hint">Carregando...</p></section>;
  return (
    <section className="settings-section">
      <h2><Icon name="clock" size={16} /> Senhas e painel de chamada</h2>
      <p className="screen-hint">
        O pedido de retirada ou "comer aqui" ganha uma senha. Na TV (ou no Vértice) aparece quem está em preparo e quem pode retirar; ao chamar,
        a senha aparece grande, toca um aviso e a TV fala o número. O cliente que pediu pelo celular também é avisado na página dele.
      </p>

      {config?.link && (
        <div className="vitrine-link">
          {config.qrDataUrl && <img src={config.qrDataUrl} alt="QR Code do painel" width="120" height="120" />}
          <div>
            <div className="vitrine-link-url">{config.link}</div>
            <p className="screen-hint" style={{ margin: '4px 0 8px' }}>Abra este link na TV em tela cheia, ou use-o como página web numa tela do Vértice.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn-secondary" onClick={copiar}><Icon name="link" size={15} /> Copiar link</button>
              <a className="btn-secondary" href={config.link} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Icon name="globe" size={15} /> Abrir o painel</a>
              <button type="button" className="btn-link" onClick={novoLink} disabled={!!ocupado}><Icon name="refresh" size={14} /> Gerar novo link</button>
            </div>
          </div>
        </div>
      )}

      <form className="product-form" onSubmit={salvar} style={{ marginTop: 12 }}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.ativa} onChange={(e) => setForm({ ...form, ativa: e.target.checked })} />
          Usar senhas e painel de chamada
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.senhaNoBalcao} onChange={(e) => setForm({ ...form, senhaNoBalcao: e.target.checked })} />
          Senha também na venda do balcão (lanchonete: paga no caixa, leva a senha, espera chamar). A senha sai no topo do recibo e a comanda na cozinha.
        </label>
        <div className="form-grid">
          <label>Senha chamada fica no painel por (minutos)
            <input type="number" min="1" max="240" value={form.minutosNoPainel} onChange={(e) => setForm({ ...form, minutosNoPainel: e.target.value })} />
          </label>
          <label>Layout
            <select value={m.layout} onChange={(e) => setM('layout', e.target.value)}>
              <option value="duas_colunas">Preparando + prontos</option>
              <option value="so_prontos">Só os prontos</option>
            </select>
          </label>
          <label>Título (vazio = nome da loja)<input maxLength={40} value={m.titulo} onChange={(e) => setM('titulo', e.target.value)} /></label>
          <label>Coluna "preparando"<input maxLength={40} value={m.tituloPreparando} onChange={(e) => setM('tituloPreparando', e.target.value)} /></label>
          <label>Coluna "prontos"<input maxLength={40} value={m.tituloProntos} onChange={(e) => setM('tituloProntos', e.target.value)} /></label>
          <label>Aviso grande<input maxLength={40} value={m.tituloChamada} onChange={(e) => setM('tituloChamada', e.target.value)} /></label>
          <label>Instrução no aviso<input maxLength={40} value={m.mensagemChamada} onChange={(e) => setM('mensagemChamada', e.target.value)} /></label>
          <label>Rodapé<input maxLength={140} value={m.mensagem} onChange={(e) => setM('mensagem', e.target.value)} /></label>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {[['corFundo', 'Fundo'], ['corTexto', 'Texto'], ['corDestaque', 'Destaque'], ['corPreparando', 'Preparando']].map(([k, rot]) => (
            <label key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input type="color" value={m[k]} onChange={(e) => setM(k, e.target.value)} style={{ width: 36, height: 28, padding: 0 }} /> {rot}
            </label>
          ))}
          <button type="button" className="btn-link" onClick={() => setForm({ ...form, modelo: { ...config.modeloPadrao } })}>Voltar ao padrão do Vértice</button>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {[['mostrarNome', 'Mostrar o primeiro nome'], ['som', 'Tocar aviso'], ['falarSenha', 'Falar a senha']].map(([k, rot]) => (
            <label key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!m[k]} onChange={(e) => setM(k, e.target.checked)} /> {rot}
            </label>
          ))}
        </div>

        <div className="painel-previa" style={{ background: m.corFundo, color: m.corTexto, gridTemplateColumns: m.layout === 'so_prontos' ? '1fr' : undefined }} aria-label="Prévia do painel">
          {m.layout !== 'so_prontos' && (
            <div>
              <h4 style={{ color: m.corPreparando }}>{m.tituloPreparando}</h4>
              <span className="chip">43</span><span className="chip">44</span><span className="chip">45</span>
            </div>
          )}
          <div>
            <h4 style={{ color: m.corDestaque }}>{m.tituloProntos}</h4>
            <div className="pronto" style={{ border: `2px solid ${m.corDestaque}` }}>42 {m.mostrarNome && <small style={{ fontSize: 13, fontWeight: 600 }}>Ana</small>}</div>
          </div>
        </div>

        <button className="btn-primary" type="submit" disabled={!!ocupado}><Icon name="save" size={15} /> {ocupado === 'salvar' ? 'Salvando...' : 'Salvar senhas e painel'}</button>
        {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
      </form>
    </section>
  );
}
