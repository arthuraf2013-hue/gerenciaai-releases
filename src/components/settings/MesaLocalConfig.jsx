import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Configurações -> Vitrine -> "Pedido pela mesa na rede da loja" (mesaLocalService):
// o QR da mesa abre o cardápio direto do computador servidor, pelo Wi-Fi da
// loja, sem Firebase e sem internet. Vários celulares entram na mesma mesa,
// cada um com o nome (vira integrante/pessoa da comanda).

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Túnel da Cloudflare montado sozinho: a loja só cola o token e o domínio. */
function TunelCloudflare({ onConfigurado }) {
  const [st, setSt] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [f, setF] = useState({ apiToken: '', dominio: '', nome: 'mesa' });
  const [ocupado, setOcupado] = useState('');
  const [res, setRes] = useState(null);
  const [teste, setTeste] = useState(null);

  async function carregar() {
    const s = await window.pdv.tunel.status().catch(() => null);
    if (s && s.ok !== false) setSt(s);
  }
  useEffect(() => { carregar(); const t = setInterval(carregar, 5000); return () => clearInterval(t); }, []);

  async function testarAteFuncionar() {
    for (let i = 1; i <= 8; i++) {
      setTeste({ erro: false, texto: `Testando o endereço (tentativa ${i} de 8)... o primeiro acesso pode levar até 1 minuto.` });
      await esperar(i === 1 ? 4000 : 8000);
      const r = await window.pdv.mesaLocal.testarEndereco({}).catch((err) => ({ ok: false, error: err.message }));
      if (r?.ok) { setTeste({ erro: false, texto: r.mensagem || 'Funcionando.' }); return; }
      if (i === 8) setTeste({ erro: true, texto: r?.error || 'Não respondeu.' });
    }
  }

  async function configurar(e) {
    e.preventDefault();
    setOcupado('configurar'); setRes(null); setTeste(null);
    const r = await window.pdv.tunel.configurar(f).catch((err) => ({ ok: false, error: err.message }));
    setOcupado('');
    setRes(r);
    if (r?.ok) {
      setF((x) => ({ ...x, apiToken: '' })); // o token da API não fica na tela nem no sistema
      setAberto(false);
      onConfigurado?.();
      carregar();
      testarAteFuncionar();
    }
  }

  async function acao(tipo) {
    setOcupado(tipo); setTeste(null);
    const r = await (tipo === 'desligar' ? window.pdv.tunel.desligar() : window.pdv.tunel.religar()).catch((err) => ({ ok: false, error: err.message }));
    setOcupado('');
    if (r && r.ok === false) setRes({ ok: false, error: r.error });
    onConfigurado?.();
    carregar();
    if (tipo === 'religar' && r?.ok !== false) testarAteFuncionar();
  }

  if (!st) return null;
  const situacao = !st.configurado ? null
    : !st.ativo ? { cls: 'io-message-aviso', txt: `Túnel desligado (https://${st.host}).` }
      : st.conectado ? { cls: 'io-message', txt: `Túnel conectado: https://${st.host}` }
        : { cls: 'io-message-aviso', txt: st.ultimoErro || (st.rodando ? 'Túnel ligando...' : 'Túnel parado, tentando ligar...') };
  return (
    <div className="tunel-cloudflare" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 10, margin: '8px 0' }}>
      <strong style={{ fontSize: 13 }}>Túnel da Cloudflare automático</strong>
      {situacao && <p className={situacao.cls} style={{ margin: '4px 0' }}>{situacao.txt}</p>}
      {teste && <p className={teste.erro ? 'modal-error' : 'io-message'} style={{ margin: '4px 0' }}>{teste.texto}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" className="btn-secondary" onClick={() => setAberto((a) => !a)}>{st.configurado ? 'Configurar de novo' : 'Configurar automaticamente'}</button>
        {st.configurado && st.ativo && <button type="button" className="btn-secondary" disabled={!!ocupado} onClick={() => acao('religar')}>{ocupado === 'religar' ? 'Religando...' : 'Religar túnel'}</button>}
        {st.configurado && !st.ativo && <button type="button" className="btn-secondary" disabled={!!ocupado} onClick={() => acao('religar')}>{ocupado === 'religar' ? 'Ligando...' : 'Ligar túnel'}</button>}
        {st.configurado && st.ativo && <button type="button" className="btn-secondary" disabled={!!ocupado} onClick={() => acao('desligar')}>{ocupado === 'desligar' ? 'Desligando...' : 'Desligar túnel'}</button>}
      </div>
      {aberto && (
        <form onSubmit={configurar} style={{ marginTop: 8 }}>
          <p className="screen-hint" style={{ fontSize: 12, margin: '0 0 6px' }}>
            Na Cloudflare: <b>Meu perfil → Tokens de API → Criar token → Token personalizado</b>, com as permissões
            {' '}<b>Conta · Cloudflare Tunnel · Editar</b>, <b>Zona · DNS · Editar</b> e <b>Zona · Zona · Ler</b> (zona: o seu domínio).
            Cole o token aqui. Ele só é usado agora para montar o túnel e não fica guardado.
          </p>
          <div className="form-grid">
            <label>Token da API da Cloudflare<input type="password" autoComplete="off" value={f.apiToken} onChange={(e) => setF({ ...f, apiToken: e.target.value })} /></label>
            <label>Domínio<input value={f.dominio} onChange={(e) => setF({ ...f, dominio: e.target.value })} placeholder="barcharque.com.br" /></label>
            <label>Nome do endereço<input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="mesa" /></label>
          </div>
          <p className="screen-hint" style={{ fontSize: 12, margin: '4px 0' }}>O QR das mesas vai ficar: https://{(f.nome || 'mesa').trim()}.{f.dominio.trim() || 'seudominio.com.br'}</p>
          <button className="btn-primary" type="submit" disabled={ocupado === 'configurar'}>{ocupado === 'configurar' ? 'Configurando na Cloudflare...' : 'Configurar automaticamente'}</button>
        </form>
      )}
      {res && (
        <ul className="suporte-passos" style={{ marginTop: 6 }}>
          {(res.passos || []).map((p) => <li key={p.passo} className="suporte-ok">OK — {p.passo}</li>)}
          {!res.ok && <li className="suporte-alerta">Parou: {res.error}</li>}
        </ul>
      )}
    </div>
  );
}

export function MesaLocalConfig({ onMudou }) {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);
  const [teste, setTeste] = useState(null);

  async function carregar() {
    const c = await window.pdv.mesaLocal.getConfig().catch(() => null);
    if (!c || c.ok === false) { setCfg({ semPermissao: true }); return; }
    setCfg(c);
    setForm((f) => f || {
      ativo: c.ativo, enderecoFixo: c.enderecoFixo || '', enderecoPublico: c.enderecoPublico || '', porta: String(c.porta || 47830),
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
          : c.rodando ? `Ligado em ${c.endereco}. Imprima os QRs de novo (o endereço do QR mudou).${c.pelaInternet ? ' Use "Testar endereço" para conferir o túnel.' : ''}` : `Não liguei: ${c.erro || 'erro desconhecido'}`,
    });
    onMudou?.();
  }

  async function testar() {
    setTestando(true); setTeste(null);
    const r = await window.pdv.mesaLocal.testarEndereco({ endereco: form.enderecoPublico }).catch((err) => ({ ok: false, error: err.message }));
    setTestando(false);
    setTeste(r?.ok ? { erro: false, texto: r.mensagem || 'Funcionando.' } : { erro: true, texto: r?.error || 'Não funcionou.' });
  }

  if (!cfg || cfg.semPermissao || !form) return null;
  return (
    <div className="mesa-local" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="globe" size={15} /> Pedido pela mesa direto no sistema (rede da loja ou túnel da Cloudflare)</h3>
      <p className="screen-hint" style={{ margin: 0 }}>
        O QR da mesa abre o cardápio direto deste computador, pelo Wi-Fi da loja: não usa Firebase nem internet. Vários celulares entram na
        mesma mesa, cada um com o nome, e viram pessoas da comanda (cada um vê a própria conta, chama o garçom e pede a conta).
        Sem o endereço pela internet, o celular do cliente precisa estar no Wi-Fi da loja (imprima o QR do Wi-Fi junto).
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
        <label>
          Endereço pela internet (Cloudflare Tunnel, opcional)
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ flex: 1 }} value={form.enderecoPublico} onChange={(e) => { setForm({ ...form, enderecoPublico: e.target.value }); setTeste(null); }} placeholder="https://mesa.seudominio.com.br" />
            <button type="button" className="btn-secondary" disabled={testando || !form.enderecoPublico.trim()} onClick={testar}>{testando ? 'Testando...' : 'Testar endereço'}</button>
          </div>
          <span className="screen-hint" style={{ fontSize: 12 }}>
            Com o túnel da Cloudflare rodando neste computador, o QR da mesa usa este endereço e abre no Wi-Fi da loja e no 4G do cliente, sem Firebase.
            Deixe em branco para usar só a rede da loja. Este computador precisa estar ligado para o QR abrir.
          </span>
        </label>
        {teste && <p className={teste.erro ? 'modal-error' : 'io-message'} style={{ margin: '4px 0' }}>{teste.texto}</p>}
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
      {/* Fora do <form> de cima: formulário dentro de formulário recarregava a tela ao configurar. */}
      <TunelCloudflare onConfigurado={async () => { const c = await window.pdv.mesaLocal.getConfig().catch(() => null); if (c && c.ok !== false) { setCfg(c); setForm((x) => ({ ...x, ativo: c.ativo, enderecoPublico: c.enderecoPublico || '' })); } onMudou?.(); }} />
    </div>
  );
}
