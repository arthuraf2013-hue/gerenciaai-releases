import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';

// Pix automático (Mercado Pago): o QR do caixa vem do provedor e a venda
// recebe o pagamento sozinha quando o cliente paga. O token fica cifrado no
// computador e nunca volta pra esta tela. Ver
// electron/services/pixAutomaticoService.js.

const dataHora = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${String(s).endsWith('Z') ? '' : 'Z'}`).toLocaleString('pt-BR') : '');

export function PixAutomaticoConfig() {
  const { currentUser } = useSession();
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [token, setToken] = useState('');
  const [mensagem, setMensagem] = useState(null);
  const [ocupado, setOcupado] = useState('');
  const [semVenda, setSemVenda] = useState([]);

  async function carregar() {
    const c = await window.pdv.pixAuto.getConfig();
    if (c?.ok === false) return;
    setConfig(c);
    setForm((f) => f || { ativo: c.ativo, emailPagador: c.emailPagador, validadeMin: String(c.validadeMin) });
    const l = await window.pdv.pixAuto.listarSemVenda().catch(() => []);
    setSemVenda(Array.isArray(l) ? l : []);
  }
  useEffect(() => { carregar(); }, []);

  async function testar() {
    setOcupado('testar'); setMensagem(null);
    const r = await window.pdv.pixAuto.testar({ token: token || undefined, requestingUserId: currentUser.id });
    setOcupado('');
    setMensagem(r.ok ? { tipo: 'ok', texto: `Conectado à conta ${r.conta}.` } : { tipo: 'erro', texto: r.error });
  }

  async function salvar(e) {
    e.preventDefault();
    setOcupado('salvar'); setMensagem(null);
    const r = await window.pdv.pixAuto.saveConfig({
      ativo: form.ativo, token: token || undefined, emailPagador: form.emailPagador,
      validadeMin: Number(form.validadeMin) || 30, requestingUserId: currentUser.id,
    });
    setOcupado('');
    if (!r.ok) { setMensagem({ tipo: 'erro', texto: r.error }); return; }
    setToken('');
    setConfig(r.config);
    setMensagem({ tipo: 'ok', texto: r.config.ativo ? 'Pix automático ligado. No caixa, "Gerar QR Code" já usa o Mercado Pago.' : 'Salvo (desligado).' });
  }

  if (!form) return null;
  return (
    <section className="settings-section">
      <h2><Icon name="card" size={16} /> Pix automático (Mercado Pago)</h2>
      <p className="screen-hint">
        O QR do caixa passa a ser gerado pelo Mercado Pago e a venda recebe o pagamento sozinha quando o cliente paga —
        sem conferir no celular e sem golpe de comprovante falso. O Mercado Pago cobra uma tarifa por Pix recebido
        (0,49% na página deles em out/2026; confira na sua conta). O Pix pela chave, acima, continua funcionando sem tarifa.
      </p>
      <form className="product-form" onSubmit={salvar}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
          Usar Pix automático no caixa
        </label>
        <div className="form-grid">
          <label>
            Access Token do Mercado Pago
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={config?.temToken ? `Guardado (final ${config.tokenFinal}${config.tokenDeTeste ? ', de TESTE' : ''}) — em branco mantém` : 'APP_USR-...'} />
          </label>
          <label>
            E-mail do pagador (exigido pelo Mercado Pago)
            <input type="email" value={form.emailPagador} onChange={(e) => setForm({ ...form, emailPagador: e.target.value })} placeholder="ex: vendas@sualoja.com.br" />
          </label>
          <label>
            Validade do QR (minutos)
            <input type="number" min="30" max="240" step="5" value={form.validadeMin} onChange={(e) => setForm({ ...form, validadeMin: e.target.value })} />
          </label>
        </div>
        <p className="screen-hint" style={{ margin: 0 }}>
          Token: no painel de desenvolvedor do Mercado Pago (Suas integrações → sua aplicação → Credenciais de produção). Use um e-mail diferente do da conta
          do Mercado Pago. Comece com uma venda de R$ 1,00 para conferir.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={testar} disabled={!!ocupado}>{ocupado === 'testar' ? 'Testando...' : 'Testar conexão'}</button>
          <button className="btn-primary" type="submit" disabled={!!ocupado}>{ocupado === 'salvar' ? 'Salvando...' : 'Salvar Pix automático'}</button>
        </div>
        {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
      </form>

      {semVenda.length > 0 && (
        <div className="io-message-aviso" style={{ marginTop: 14, flexDirection: 'column', alignItems: 'flex-start' }}>
          <strong><Icon name="warning" size={15} /> Pix recebido sem venda ({semVenda.length})</strong>
          <span>O cliente pagou depois que a venda foi cancelada ou já estava quitada. Devolva pelo Mercado Pago ou lance como recebimento.</span>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {semVenda.map((c) => (
              <li key={c.id}>R$ {Number(c.valor).toFixed(2).replace('.', ',')} · {dataHora(c.atualizado_em)} · cobrança {c.provedor_id || c.id.slice(0, 8)} · venda {c.venda_status || 'removida'}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
