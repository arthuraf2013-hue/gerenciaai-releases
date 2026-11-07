import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import { obterVertice, verticeDisponivel } from '../../integrations/vertice/verticeClient';

// Configurações → Vértice: liga este caixa ao Vértice (digital signage da
// Vetta). As senhas (preparando / pronto / entregue) aparecem no "Painel de
// pedidos" das TVs do Vértice. Lógica em src/integrations/vertice (módulo
// do próprio Vértice + ponteSenhas.js).

export function VerticeConfig() {
  const [vx, setVx] = useState(null);
  const [s, setS] = useState({ status: 'starting' });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [senhasAtivas, setSenhasAtivas] = useState(true);

  useEffect(() => {
    window.pdv.chamada.getConfig().then((c) => setSenhasAtivas(!!c?.ativa)).catch(() => {});
    if (!verticeDisponivel()) return undefined;
    let parar = () => {};
    let vivo = true;
    obterVertice().then((v) => {
      if (!vivo || !v) { if (vivo && !v) setS({ status: 'error', error: 'Não consegui iniciar a conexão com o Vértice.' }); return; }
      setVx(v);
      parar = v.onState(setS);
    });
    return () => { vivo = false; parar(); };
  }, []);

  async function gerar() {
    setOcupado(true); setErro('');
    try { await vx.startPairing(); } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  }

  async function desconectar() {
    if (!confirm('Desconectar este caixa do Vértice? As TVs param de receber as senhas daqui. Remova também em Empresa › Integrações no painel do Vértice.')) return;
    await vx.unpair();
  }

  return (
    <section className="settings-section">
      <h2><Icon name="mobile" size={16} /> Vértice · Painel de pedidos nas TVs</h2>
      <p className="screen-hint">
        Liga este caixa ao Vértice, o digital signage da Vetta. Cada senha aparece no "Painel de pedidos" das TVs: em preparo, pronta
        (com o aviso em tela cheia) e some quando é entregue. Vai só o número e o primeiro nome com a inicial (ex.: "Maria S.").
      </p>
      {!senhasAtivas && (
        <p className="io-message-aviso"><Icon name="warning" size={15} /> Ligue as senhas em Configurações → Senhas: é delas que saem os pedidos para o Vértice.</p>
      )}

      {!verticeDisponivel() ? (
        <p className="io-message-aviso"><Icon name="warning" size={15} /> A conexão com o Vértice ainda não foi ativada nesta versão do GerenciaAI. Enquanto isso, use o link do painel (Configurações → Senhas) como página web numa tela do Vértice.</p>
      ) : (
        <div className="product-form" style={{ maxWidth: 560 }}>
          {s.status === 'starting' && <p className="screen-hint">Conectando ao Vértice...</p>}
          {s.status === 'paired' && (
            <>
              <p className="selo selo-ok" style={{ alignSelf: 'flex-start', fontSize: 13 }}>● Conectado{s.companyName ? ` a ${s.companyName}` : ''}</p>
              <p className="screen-hint" style={{ margin: 0 }}>Para escolher em quais TVs os pedidos aparecem, use o painel do Vértice: Telas › configurar tela › Painel de pedidos.</p>
              <button type="button" className="btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={desconectar}>Desconectar este caixa</button>
            </>
          )}
          {s.status === 'pairing' && (
            <>
              <p className="screen-hint" style={{ margin: 0 }}>No painel do Vértice, abra <strong>Empresa › Integrações › Conectar caixa</strong> e digite:</p>
              <div style={{ fontSize: 52, fontWeight: 800, letterSpacing: '.06em' }}>
                {s.code.slice(0, 3)}<span style={{ color: '#d9a441', margin: '0 .2em' }}>·</span>{s.code.slice(3)}
              </div>
              <p className="screen-hint" style={{ margin: 0 }}>O código vale por 30 minutos. Esta tela muda sozinha quando conectar.</p>
              <button type="button" className="btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => vx.cancelPairing()}>Cancelar</button>
            </>
          )}
          {(s.status === 'unpaired' || s.status === 'error') && (
            <>
              {s.error && <p className="modal-error">{s.error}</p>}
              <button type="button" className="btn-primary" style={{ alignSelf: 'flex-start' }} onClick={gerar} disabled={ocupado || !vx}>
                <Icon name="link" size={15} /> {ocupado ? 'Gerando...' : 'Gerar código de conexão'}
              </button>
            </>
          )}
          {erro && <p className="modal-error">{erro}</p>}
        </div>
      )}
    </section>
  );
}
