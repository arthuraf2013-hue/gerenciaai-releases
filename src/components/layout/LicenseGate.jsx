import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

const MOTIVO_MSG_BLOQUEIO = {
  congelada: 'O acesso a este sistema foi suspenso por pendência de pagamento.',
  bloqueio_imediato: 'O acesso a este sistema foi bloqueado.',
  sem_internet: 'Não foi possível confirmar a licença deste sistema — sem conexão com o servidor há vários dias.',
  teste_expirado: 'O período de teste grátis do GerenciaAI terminou.',
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
  const [motivoCustomizado, setMotivoCustomizado] = useState(null);

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

  useEffect(() => {
    if (status?.status !== 'bloqueado') return;
    window.pdv.message.getMotivoBloqueio().then(setMotivoCustomizado);
  }, [status?.status]);

  if (status?.status === 'bloqueado' && status.motivo === 'teste_expirado') {
    const contato = status.contato;
    return (
      <div className="license-block-screen">
        <div className="license-block-card">
          <h1 className="teste-fim-titulo"><Icon name="clock" size={22} /> Seu teste grátis terminou</h1>
          <p>{contato?.mensagem || 'Gostou do GerenciaAI? Para continuar usando, fale com a gente e escolha o seu plano.'}</p>
          <p><strong>Tudo o que você cadastrou e vendeu continua salvo neste computador</strong> — assim que o plano for ativado,
            o sistema volta exatamente de onde parou.</p>
          {contato?.link
            ? <a className="btn-primary teste-fim-botao" href={contato.link} target="_blank" rel="noreferrer"><Icon name="chat" size={16} /> Falar no WhatsApp{contato.empresa ? ` com ${contato.empresa}` : ''}</a>
            : <p>Entre em contato com quem instalou o sistema.</p>}
        </div>
      </div>
    );
  }

  if (status?.status === 'bloqueado') {
    return (
      <div className="license-block-screen">
        <div className="license-block-card">
          <h1><Icon name="lock" size={22} /> Sistema bloqueado</h1>
          <p>{motivoCustomizado || MOTIVO_MSG_BLOQUEIO[status.motivo] || 'Não foi possível confirmar a licença deste sistema.'}</p>
          <p>Entre em contato com o suporte pra regularizar o acesso. Seus dados continuam salvos e
            intactos — assim que a situação for resolvida, o sistema volta a funcionar normalmente.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {status?.teste && !status.teste.expirado && (
        <div className={`license-trial-banner ${status.teste.diasRestantes <= 3 ? 'license-trial-banner-final' : ''}`}>
          <Icon name="clock" size={15} /> Teste grátis do GerenciaAI: {status.teste.diasRestantes === 1 ? 'último dia' : `faltam ${status.teste.diasRestantes} dias`}.
          {status.contato?.link && (
            <a href={status.contato.link} target="_blank" rel="noreferrer">Quero continuar usando</a>
          )}
        </div>
      )}
      {status?.status === 'aviso' && (
        <div className="license-warning-banner">
          <Icon name="warning" size={15} /> {MOTIVO_MSG_AVISO[status.motivo]} O acesso será bloqueado em{' '}
          <strong>{Math.max(1, Math.ceil(status.diasRestantes))} dia(s)</strong> caso não seja
          regularizado. Entre em contato com o suporte.
        </div>
      )}
      {children}
    </>
  );
}
