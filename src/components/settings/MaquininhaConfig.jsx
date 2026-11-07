import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Maquininha integrada (Mercado Pago Point) -- ver
// electron/services/maquininhaService.js. O caixa manda a cobrança para a
// maquininha e o pagamento entra sozinho na venda, com bandeira e
// autorização (vão para a NFC-e). O token nunca volta para esta tela.

const dataHora = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${String(s).endsWith('Z') ? '' : 'Z'}`).toLocaleString('pt-BR') : '');

export function MaquininhaConfig() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [token, setToken] = useState('');
  const [terminais, setTerminais] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const [ocupado, setOcupado] = useState('');
  const [semVenda, setSemVenda] = useState([]);

  async function carregar() {
    const c = await window.pdv.maquininha.getConfig();
    if (c?.ok === false) return;
    setConfig(c);
    setForm((f) => f || { ativa: c.ativa, usarTokenPix: c.usarTokenPix, terminalId: c.terminalId, imprimirNoTerminal: c.imprimirNoTerminal });
    const l = await window.pdv.maquininha.listarSemVenda().catch(() => []);
    setSemVenda(Array.isArray(l) ? l : []);
  }
  useEffect(() => { carregar(); }, []);

  async function buscar() {
    setOcupado('buscar'); setMensagem(null);
    const r = await window.pdv.maquininha.listarTerminais({ token: form.usarTokenPix ? undefined : (token || undefined) });
    setOcupado('');
    if (!r?.ok) { setMensagem({ tipo: 'erro', texto: r?.error }); return; }
    setTerminais(r.terminais);
    setMensagem({ tipo: 'ok', texto: `Conta ${r.conta}: ${r.terminais.length} maquininha(s).` });
    if (r.terminais.length === 1 && !form.terminalId) setForm((f) => ({ ...f, terminalId: r.terminais[0].id }));
  }

  async function modoPdv(id) {
    setOcupado('pdv');
    const r = await window.pdv.maquininha.ativarModoPdv({ terminalId: id });
    setOcupado('');
    setMensagem(r?.ok ? { tipo: 'ok', texto: `Modo integrado pedido. ${r.aviso}` } : { tipo: 'erro', texto: r?.error });
    if (r?.ok) buscar();
  }

  async function salvar(e) {
    e.preventDefault();
    setOcupado('salvar'); setMensagem(null);
    const r = await window.pdv.maquininha.saveConfig({ ...form, token: form.usarTokenPix ? undefined : (token || undefined) });
    setOcupado('');
    if (!r?.ok) { setMensagem({ tipo: 'erro', texto: r?.error }); return; }
    setToken('');
    setConfig(r.config);
    setMensagem({ tipo: 'ok', texto: r.config.ativa ? 'Maquininha integrada ligada. No caixa aparece "Cobrar na maquininha".' : 'Salvo (desligada).' });
  }

  if (!form) return null;
  return (
    <section className="settings-section">
      <h2><Icon name="card" size={16} /> Maquininha integrada (Mercado Pago Point)</h2>
      <p className="screen-hint">
        Em vez de digitar o valor na maquininha, o caixa manda a cobrança para ela. O cliente passa o cartão (ou paga o Pix na tela dela) e o
        pagamento entra sozinho na venda, com bandeira e autorização para a NFC-e. Sem isso, a maquininha continua funcionando como sempre.
      </p>
      <form className="product-form" onSubmit={salvar}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.ativa} onChange={(e) => setForm({ ...form, ativa: e.target.checked })} />
          Usar a maquininha integrada no caixa
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.usarTokenPix} onChange={(e) => setForm({ ...form, usarTokenPix: e.target.checked })} />
          Usar o mesmo token do Pix automático (mesma conta Mercado Pago)
        </label>
        {!form.usarTokenPix && (
          <label style={{ maxWidth: 480 }}>Access Token do Mercado Pago
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={config?.temToken && !config.usarTokenPix ? `Guardado (final ${config.tokenFinal}) — em branco mantém` : 'APP_USR-...'} />
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn-secondary" onClick={buscar} disabled={!!ocupado}><Icon name="search" size={15} /> {ocupado === 'buscar' ? 'Buscando...' : 'Buscar maquininhas da conta'}</button>
          {form.terminalId && <span className="screen-hint">Escolhida: {form.terminalId}</span>}
        </div>
        {terminais && (terminais.length === 0
          ? <p className="empty-state">Nenhuma maquininha Point nesta conta. Vincule a maquininha à conta pelo app do Mercado Pago.</p>
          : (
            <table className="data-table">
              <thead><tr><th></th><th>Maquininha</th><th>Modo</th><th></th></tr></thead>
              <tbody>
                {terminais.map((t) => (
                  <tr key={t.id}>
                    <td><input type="radio" name="terminal" style={{ width: 'auto' }} checked={form.terminalId === t.id} onChange={() => setForm({ ...form, terminalId: t.id })} /></td>
                    <td>{t.nome || t.id}<br /><span className="screen-hint">{t.id}</span></td>
                    <td>{t.modo === 'PDV' ? 'Integrado' : (t.modo || '—')}</td>
                    <td>{t.modo !== 'PDV' && <button type="button" className="btn-link" onClick={() => modoPdv(t.id)} disabled={!!ocupado}>Colocar no modo integrado</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.imprimirNoTerminal} onChange={(e) => setForm({ ...form, imprimirNoTerminal: e.target.checked })} />
          Imprimir a via da loja na maquininha
        </label>
        <p className="screen-hint" style={{ margin: 0 }}>
          A maquininha precisa estar no modo integrado (PDV) e ser da mesma conta do token. Depois de mudar o modo, reinicie a maquininha.
          Comece com uma venda de R$ 1,00 para conferir.
        </p>
        <button className="btn-primary" type="submit" disabled={!!ocupado}><Icon name="save" size={15} /> {ocupado === 'salvar' ? 'Salvando...' : 'Salvar maquininha'}</button>
        {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
      </form>
      {semVenda.length > 0 && (
        <div className="io-message-aviso" style={{ marginTop: 14, flexDirection: 'column', alignItems: 'flex-start' }}>
          <strong><Icon name="warning" size={15} /> Aprovado na maquininha sem venda ({semVenda.length})</strong>
          <span>O cliente pagou depois que a venda foi cancelada ou já estava quitada. Estorne pelo Mercado Pago ou lance como recebimento.</span>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {semVenda.map((c) => <li key={c.id}>R$ {Number(c.valor).toFixed(2).replace('.', ',')} · {c.tipo} · {dataHora(c.atualizado_em)} · pedido {c.provedor_id || c.id.slice(0, 8)}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
