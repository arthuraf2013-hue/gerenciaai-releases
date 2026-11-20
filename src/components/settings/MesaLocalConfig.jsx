import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Configurações -> Vitrine -> "Pedido pela mesa na rede da loja" (mesaLocalService):
// o QR da mesa abre o cardápio direto do computador servidor, pelo Wi-Fi da
// loja, sem Firebase e sem internet. Vários celulares entram na mesma mesa,
// cada um com o nome (vira integrante/pessoa da comanda).

export function MesaLocalConfig({ onMudou }) {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    const c = await window.pdv.mesaLocal.getConfig().catch(() => null);
    if (!c || c.ok === false) { setCfg({ semPermissao: true }); return; }
    setCfg(c);
    setForm((f) => f || {
      ativo: c.ativo, enderecoFixo: c.enderecoFixo || '', porta: String(c.porta || 47830),
      wifiNome: c.wifiNome || '', wifiSenha: c.wifiSenha || '', wifiTipo: c.wifiTipo || 'WPA', mostrarWifi: !!c.mostrarWifi,
    });
  }
  useEffect(() => { carregar(); }, []);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true); setMsg(null);
    const r = await window.pdv.mesaLocal.saveConfig({ ...form, porta: Number(form.porta) || 47830 }).catch((err) => ({ ok: false, error: err.message }));
    setSalvando(false);
    if (!r?.ok) { setMsg({ erro: true, texto: r?.error || 'Não consegui salvar.' }); return; }
    setCfg(r.config);
    const c = r.config;
    setMsg({
      erro: !!(c.ativo && c.deveRodar && !c.rodando),
      texto: !c.ativo ? 'Desligado.'
        : !c.deveRodar ? 'Salvo. Este computador não é o servidor do grupo: o pedido pela mesa liga só no servidor.'
          : c.rodando ? `Ligado em ${c.endereco}. Imprima os QRs de novo (o endereço mudou para a rede da loja).` : `Não liguei: ${c.erro || 'erro desconhecido'}`,
    });
    onMudou?.();
  }

  if (!cfg || cfg.semPermissao || !form) return null;
  return (
    <div className="mesa-local" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="globe" size={15} /> Pedido pela mesa na rede da loja (sem internet)</h3>
      <p className="screen-hint" style={{ margin: 0 }}>
        O QR da mesa abre o cardápio direto deste computador, pelo Wi-Fi da loja: não usa Firebase nem internet. Vários celulares entram na
        mesma mesa, cada um com o nome, e viram pessoas da comanda (cada um vê a própria conta, chama o garçom e pede a conta).
        O celular do cliente precisa estar no Wi-Fi da loja: imprima o QR do Wi-Fi junto.
      </p>
      <form className="product-form" onSubmit={salvar} style={{ marginTop: 8 }}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
          Ligar o pedido pela mesa na rede da loja
        </label>
        {cfg.ativo && (
          <p className={cfg.rodando ? 'io-message' : 'io-message-aviso'} style={{ margin: '4px 0' }}>
            {cfg.rodando ? <>Funcionando em <strong>{cfg.endereco}</strong></>
              : cfg.deveRodar ? `Parado: ${cfg.erro || 'tentando ligar...'}` : 'Este computador não é o servidor do grupo: liga só no servidor.'}
          </p>
        )}
        <div className="form-grid">
          <label>
            Endereço fixo do servidor (IP)
            <input value={form.enderecoFixo} onChange={(e) => setForm({ ...form, enderecoFixo: e.target.value })} placeholder={cfg.enderecosDetectados?.[0] || '192.168.1.74'} />
            <span className="screen-hint" style={{ fontSize: 12 }}>
              Deixe o IP fixo no roteador para o QR impresso não mudar. Detectado agora: {cfg.enderecosDetectados?.length ? cfg.enderecosDetectados.join(', ') : 'nenhum'}.
            </span>
          </label>
          <label>
            Porta
            <input inputMode="numeric" value={form.porta} onChange={(e) => setForm({ ...form, porta: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Wi-Fi da loja (nome)
            <input maxLength={32} value={form.wifiNome} onChange={(e) => setForm({ ...form, wifiNome: e.target.value })} placeholder="Ex.: Quiosque-Clientes" />
          </label>
          <label>
            Senha do Wi-Fi
            <input maxLength={63} value={form.wifiSenha} disabled={form.wifiTipo === 'nopass'} onChange={(e) => setForm({ ...form, wifiSenha: e.target.value })} />
          </label>
          <label>
            Tipo
            <select value={form.wifiTipo} onChange={(e) => setForm({ ...form, wifiTipo: e.target.value })}>
              <option value="WPA">WPA/WPA2 (o comum)</option>
              <option value="WEP">WEP</option>
              <option value="nopass">Aberta (sem senha)</option>
            </select>
          </label>
        </div>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.mostrarWifi} onChange={(e) => setForm({ ...form, mostrarWifi: e.target.checked })} />
          Imprimir o QR do Wi-Fi no cartão da mesa (o cliente lê o 1º para conectar e o 2º para pedir)
        </label>
        <button className="btn-primary" type="submit" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar pedido pela mesa'}</button>
        {msg && <p className={msg.erro ? 'modal-error' : 'io-message'}>{msg.texto}</p>}
      </form>
    </div>
  );
}
