import { useEffect, useState } from 'react';

const MOTIVO_MSG_BLOQUEIO = {
  congelada: 'O acesso a este sistema foi suspenso por pendência de pagamento.',
  bloqueio_imediato: 'O acesso a este sistema foi bloqueado.',
  sem_internet: 'Não foi possível confirmar a licença deste sistema — sem conexão com o servidor há vários dias.',
};

const MOTIVO_MSG_AVISO = {
  congelada: 'Pendência identificada nesta licença.',
  sem_internet: 'Não estamos conseguindo confirmar a licença deste sistema (sem conexão).',
};

/**
 * Envolve o app inteiro. Consulta o estado de licença LOCAL (já salvo
 * pelo processo principal, que fala com o servidor em segundo plano) —
 * nunca trava a tela esperando rede. Três estados possíveis:
 * - ok: mostra o app normalmente.
 * - aviso: mostra o app normalmente, com uma faixa de aviso no topo.
 * - bloqueado: substitui o app inteiro por uma tela de bloqueio.
 */
export function LicenseGate({ children }) {
  const [status, setStatus] = useState(null);

  async function verificar() {
    const result = await window.pdv.license.getStatus();
    setStatus(result);
  }

  useEffect(() => {
    verificar();
    // Checagem local (não faz chamada de rede), então pode ser
    // frequente sem custo nenhum — só recalcula os dias de carência.
    const id = setInterval(verificar, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (status?.status === 'bloqueado') {
    return (
      <div className="license-block-screen">
        <div className="license-block-card">
          <h1>Sistema bloqueado</h1>
          <p>{MOTIVO_MSG_BLOQUEIO[status.motivo] || 'Não foi possível confirmar a licença deste sistema.'}</p>
          <p>Entre em contato com o suporte pra regularizar o acesso. Seus dados continuam salvos e
            intactos — assim que a situação for resolvida, o sistema volta a funcionar normalmente.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {status?.status === 'aviso' && (
        <div className="license-warning-banner">
          ⚠ {MOTIVO_MSG_AVISO[status.motivo]} O acesso será bloqueado em{' '}
          <strong>{Math.max(1, Math.ceil(status.diasRestantes))} dia(s)</strong> caso não seja
          regularizado. Entre em contato com o suporte.
        </div>
      )}
      {children}
    </>
  );
}
