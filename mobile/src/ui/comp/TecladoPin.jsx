import { useEffect, useState } from 'react';

/** Teclado numérico grande pra PIN (sem abrir o teclado do sistema). Aceita teclado físico também. */
export default function TecladoPin({ aoConfirmar, min = 4, max = 8, ocupado = false, rotuloOk = 'Entrar', limparQuando }) {
  const [pin, setPin] = useState('');
  useEffect(() => { setPin(''); }, [limparQuando]);

  const digitar = (d) => setPin((p) => (p.length < max ? p + d : p));
  const apagar = () => setPin((p) => p.slice(0, -1));
  const confirmar = () => { if (pin.length >= min && !ocupado) aoConfirmar(pin); };

  useEffect(() => {
    const t = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return; // digitando num campo de verdade
      if (/^\d$/.test(e.key)) digitar(e.key);
      else if (e.key === 'Backspace') apagar();
      else if (e.key === 'Enter') confirmar();
    };
    window.addEventListener('keydown', t);
    return () => window.removeEventListener('keydown', t);
  });

  return (
    <div className="pilha">
      <div className="pin-pontos" aria-label={`${pin.length} dígitos digitados`}>
        {Array.from({ length: Math.max(min, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'cheio' : ''} />)}
      </div>
      <div className="teclado">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button type="button" key={d} onClick={() => digitar(d)}>{d}</button>)}
        <button type="button" className="acao" onClick={apagar} aria-label="Apagar">Apagar</button>
        <button type="button" onClick={() => digitar('0')}>0</button>
        <button type="button" className="ok" onClick={confirmar} disabled={pin.length < min || ocupado}>{ocupado ? '...' : rotuloOk}</button>
      </div>
    </div>
  );
}
