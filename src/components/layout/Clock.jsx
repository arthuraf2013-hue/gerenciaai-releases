import { useEffect, useState } from 'react';

// Formatadores criados UMA vez (o relógio redesenha a cada segundo --
// criar dois Intl.DateTimeFormat novos por segundo era alocação à toa).
const FORMATOS = {
  completo: {
    hora: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    data: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }),
  },
  compacto: {
    hora: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
    data: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }),
  },
};

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
    // Sem segundos na tela (modo compacto), basta redesenhar na virada de
    // cada minuto -- 60x menos renderizações o dia inteiro.
    if (compact) {
      let id;
      const agendar = () => {
        const agora = Date.now() + offsetMs;
        setNow(new Date(agora));
        id = setTimeout(agendar, 60000 - (agora % 60000) + 50);
      };
      agendar();
      return () => clearTimeout(id);
    }
    const id = setInterval(() => setNow(new Date(Date.now() + offsetMs)), 1000);
    return () => clearInterval(id);
  }, [offsetMs, compact]);

  const fmt = compact ? FORMATOS.compacto : FORMATOS.completo;
  const hora = fmt.hora.format(now);
  const data = fmt.data.format(now);

  return (
    <div className={`clock ${compact ? 'clock-compact' : ''}`} title={sincronizado ? 'Sincronizado com a internet' : 'Sem sincronização — usando o relógio deste computador'}>
      <span className={`clock-dot ${sincronizado ? 'clock-dot-ok' : 'clock-dot-warn'}`} />
      <span className="clock-time">{hora}</span>
      {!compact && <span className="clock-date">{data}</span>}
    </div>
  );
}
