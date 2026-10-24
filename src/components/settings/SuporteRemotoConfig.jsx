import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';

/**
 * Configurações → Suporte: o cliente gera o código de acesso remoto (que
 * aparece aqui e na Central) e, se quiser, liga o acesso não
 * supervisionado. CONSENTIMENTO é o pilar: nada acontece sem o cliente
 * gerar o código ou ligar o não supervisionado de propósito.
 */
export function SuporteRemotoConfig() {
  const [config, setConfig] = useState({ naoSupervisionado: false, temSegredo: false });
  const [status, setStatus] = useState({ estado: 'ocioso' });
  const [codigo, setCodigo] = useState(null);
  const [expiraEmMs, setExpiraEmMs] = useState(null);
  const [restante, setRestante] = useState('');
  const [segredoRevelado, setSegredoRevelado] = useState(null);
  const [erro, setErro] = useState('');
  const tick = useRef(null);

  useEffect(() => {
    window.pdv.suporteRemoto.getConfig().then((c) => c && setConfig(c));
    window.pdv.suporteRemoto.getStatus().then((s) => s && setStatus(s));
    const desinscrever = window.pdv.suporteRemoto.onMudou?.((s) => setStatus(s || { estado: 'ocioso' }));
    return () => { if (typeof desinscrever === 'function') desinscrever(); if (tick.current) clearInterval(tick.current); };
  }, []);

  // Contagem regressiva do código (10 min).
  useEffect(() => {
    if (!expiraEmMs) return;
    const atualizar = () => {
      const ms = expiraEmMs - Date.now();
      if (ms <= 0) { setCodigo(null); setExpiraEmMs(null); setRestante(''); return; }
      const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000);
      setRestante(`${m}:${String(s).padStart(2, '0')}`);
    };
    atualizar();
    tick.current = setInterval(atualizar, 1000);
    return () => clearInterval(tick.current);
  }, [expiraEmMs]);

  async function gerar() {
    setErro(''); setSegredoRevelado(null);
    const r = await window.pdv.suporteRemoto.gerarCodigo({});
    if (!r?.ok) { setErro(r?.error || 'Não foi possível gerar o código.'); return; }
    setCodigo(r.codigo); setExpiraEmMs(r.expiraEmMs);
  }

  async function alternarNaoSupervisionado(e) {
    setErro('');
    const ligar = e.target.checked;
    const r = await window.pdv.suporteRemoto.salvarConfig({ naoSupervisionado: ligar });
    if (!r?.ok) { setErro(r?.error || 'Não foi possível salvar.'); return; }
    setConfig({ naoSupervisionado: r.naoSupervisionado, temSegredo: r.naoSupervisionado });
    setSegredoRevelado(ligar ? r.segredo : null);
  }

  const emSessao = status.estado && !['ocioso', 'encerrada', 'aguardando'].includes(status.estado);

  return (
    <div>
      <h2><Icon name="globe" size={16} /> Suporte remoto</h2>
      <p className="screen-hint">
        Gere um código e passe para o suporte da Vetta. Enquanto alguém estiver acessando, uma faixa de aviso
        aparece no topo da tela e você pode encerrar quando quiser. Tudo fica registrado na Auditoria.
      </p>

      {erro && <p className="modal-error">{erro}</p>}

      {emSessao ? (
        <div style={cartao('#163e37', '#2f6b5f')}>
          <strong style={{ color: '#bff0e4' }}>Suporte remoto {status.estado === 'ativa' ? 'ativo' : 'conectando'} agora.</strong>
          <p className="screen-hint" style={{ margin: '6px 0 10px' }}>Use a faixa no topo da tela para encerrar a qualquer momento.</p>
          <button className="btn-danger" onClick={() => window.pdv.suporteRemoto.encerrar({})}>Encerrar sessão</button>
        </div>
      ) : codigo ? (
        <div style={cartao('#1f312d', '#3f5b53')}>
          <p className="screen-hint" style={{ marginTop: 0 }}>Informe este código ao suporte:</p>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '0.14em', color: '#f6c453', fontFamily: 'monospace', textAlign: 'center' }}>
            {codigo.slice(0, 3)} {codigo.slice(3)}
          </div>
          <p className="screen-hint" style={{ textAlign: 'center', marginBottom: 0 }}>
            {restante ? `Expira em ${restante}` : 'Gerando...'} · O técnico só acessa com este código.
          </p>
        </div>
      ) : (
        <div className="settings-actions">
          <button className="btn-primary" onClick={gerar}><Icon name="globe" size={15} /> Gerar código de suporte</button>
        </div>
      )}

      <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={config.naoSupervisionado} onChange={alternarNaoSupervisionado} />
          <span><strong>Permitir acesso não supervisionado</strong> <span style={{ fontSize: 11, opacity: 0.7 }}>(opcional)</span></span>
        </label>
        <p className="screen-hint" style={{ marginTop: 8 }}>
          Com isso ligado, o suporte da Vetta pode acessar para manutenção sem precisar do código a cada vez.
          A faixa de aviso continua aparecendo e todo acesso fica na Auditoria. Você desliga quando quiser.
        </p>
        {segredoRevelado && (
          <div style={cartao('#453a1f', '#8a6d2a')}>
            <strong style={{ color: '#f2ce7a' }}>Guarde este segredo e passe ao suporte — ele só aparece agora:</strong>
            <div style={{ fontFamily: 'monospace', fontSize: 16, letterSpacing: '0.06em', margin: '8px 0', wordBreak: 'break-all' }}>{segredoRevelado}</div>
            <button className="btn-secondary btn-small" onClick={() => { navigator.clipboard?.writeText(segredoRevelado); }}>Copiar</button>
          </div>
        )}
      </div>
    </div>
  );
}

function cartao(fundo, borda) {
  return { background: fundo, border: `1px solid ${borda}`, borderRadius: 10, padding: 16, marginTop: 12 };
}
