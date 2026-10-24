import { useEffect, useState } from 'react';

/**
 * Faixa fixa de "suporte remoto" -- VISIBILIDADE é um dos três pilares
 * do módulo (ver suporteRemotoService.js): enquanto existe uma sessão, o
 * cliente SEMPRE vê que está sendo acessado e pode encerrar na hora.
 * Também é aqui que o cliente autoriza (ou recusa) uma conexão nova no
 * modo supervisionado -- nada começa a capturar a tela antes disso.
 */
export function SuporteRemotoBanner() {
  const [status, setStatus] = useState({ estado: 'ocioso' });

  useEffect(() => {
    let vivo = true;
    window.pdv.suporteRemoto?.getStatus().then((s) => { if (vivo && s) setStatus(s); });
    const desinscrever = window.pdv.suporteRemoto?.onMudou?.((s) => setStatus(s || { estado: 'ocioso' }));
    return () => { vivo = false; if (typeof desinscrever === 'function') desinscrever(); };
  }, []);

  const { estado, aguardandoPermissao, sessaoNaoSupervisionada } = status;
  if (!estado || estado === 'ocioso' || estado === 'encerrada') return null;

  const encerrar = () => window.pdv.suporteRemoto.encerrar({});
  const permitir = () => window.pdv.suporteRemoto.permitir({});

  // Pedido de conexão aguardando o OK do cliente (modo supervisionado).
  if (aguardandoPermissao) {
    return (
      <div style={estiloBase('#7a5310', '#fef3c7', '#b58a2a')}>
        <IconeSuporte cor="#7a5310" />
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: 14 }}>Pedido de suporte remoto</strong>
          <span style={{ display: 'block', fontSize: 12.5, marginTop: 2 }}>
            O suporte da Vetta quer acessar este computador. Só autorize se você pediu ajuda agora.
          </span>
        </div>
        <button style={btn('#0f6e63', true)} onClick={permitir}>Permitir acesso</button>
        <button style={btn('#b3402f', false)} onClick={encerrar}>Recusar</button>
      </div>
    );
  }

  // Sessão em andamento (negociando ou ativa).
  const texto = estado === 'ativa' ? 'Suporte remoto ativo' : 'Conectando o suporte remoto...';
  return (
    <div style={estiloBase('#0b3f38', '#163e37', '#37ab99')}>
      <IconeSuporte cor="#37ab99" />
      <div style={{ flex: 1 }}>
        <strong style={{ fontSize: 14, color: '#eef5f2' }}>{texto} — Vetta Sistemas</strong>
        <span style={{ display: 'block', fontSize: 12.5, marginTop: 2, color: '#aec2ba' }}>
          Um técnico está acessando este computador agora{sessaoNaoSupervisionada ? ' (acesso não supervisionado)' : ''}.
        </span>
      </div>
      <button style={btn('#e0705d', false)} onClick={encerrar}>Encerrar</button>
    </div>
  );
}

function estiloBase(_corTexto, fundo, borda) {
  return {
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9000,
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 18px', background: fundo, color: '#eef5f2',
    borderBottom: `3px solid ${borda}`, boxShadow: '0 2px 10px rgba(0,0,0,.25)',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  };
}
function btn(cor, preenchido) {
  return {
    background: preenchido ? cor : 'transparent',
    color: preenchido ? '#fff' : cor,
    border: `1px solid ${cor}`, borderRadius: 8, padding: '7px 13px',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  };
}
function IconeSuporte({ cor }) {
  return (
    <svg width="22" height="22" viewBox="0 0 26 26" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polygon points="13,2 24,23 2,23" fill="none" stroke={cor} strokeWidth="2" />
      <polygon points="13,8 18.5,19 7.5,19" fill={cor} />
    </svg>
  );
}
