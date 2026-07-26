import { useEffect, useState } from 'react';

/**
 * @param {{ compact?: boolean }} props
 */
export function Clock({ compact = false }) {
  const [offsetMs, setOffsetMs] = useState(0);
  const [sincronizado, setSincronizado] = useState(null); // null = ainda carregando
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    let mounted = true;
    window.pdv.time.getStatus().then((status) => {
      if (!mounted) return;
      setOffsetMs(status.offsetMs || 0);
      setSincronizado(status.sincronizado);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date(Date.now() + offsetMs)), 1000);
    return () => clearInterval(id);
  }, [offsetMs]);

  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: compact ? undefined : '2-digit',
  }).format(now);
  const data = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: compact ? undefined : 'numeric',
  }).format(now);

  return (
    <div className={`clock ${compact ? 'clock-compact' : ''}`} title={sincronizado ? 'Sincronizado com a internet' : 'Sem sincronização — usando o relógio deste computador'}>
      <span className={`clock-dot ${sincronizado ? 'clock-dot-ok' : 'clock-dot-warn'}`} />
      <span className="clock-time">{hora}</span>
      {!compact && <span className="clock-date">{data}</span>}
    </div>
  );
}
