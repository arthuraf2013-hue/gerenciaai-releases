import { useEffect, useState } from 'react';

/**
 * Envolve o app inteiro, por fora do LicenseGate — se uma atualização
 * obrigatória foi publicada no painel e essa instalação ainda está
 * numa versão mais antiga, substitui a tela inteira por uma tela de
 * atualização com barra de progresso, até o download terminar e o
 * app reiniciar sozinho na versão nova.
 */
export function UpdateGate({ children }) {
  const [forcedStatus, setForcedStatus] = useState(null);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [verificando, setVerificando] = useState(false);

  async function verificar() {
    const result = await window.pdv.update.getForcedStatus();
    setForcedStatus(result);
  }

  useEffect(() => {
    verificar();
    const id = setInterval(verificar, 60 * 1000); // checagem local, sem custo de rede
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!forcedStatus?.bloqueado) return;
    // Assim que detecta que precisa atualizar, já dispara a checagem
    // real (que vai achar a versão disponível) — o download em si
    // começa sozinho assim que ela aparece (autoDownload, ver
    // updateService.js), sem precisar de clique nenhum.
    setVerificando(true);
    window.pdv.update.check();
    const id = setInterval(async () => {
      const s = await window.pdv.update.getStatus();
      setUpdateStatus(s);
      // Assim que a checagem resolve pra QUALQUER lado (achou
      // atualização, não achou, ou deu erro) — sai do estado
      // "verificando". Sem isso, clicar em "Atualizar agora" deixava
      // o botão preso em "Verificando..." pra sempre, mesmo depois da
      // checagem de verdade já ter terminado (com sucesso ou erro).
      if (!s.checking) setVerificando(false);
    }, 1000);
    return () => clearInterval(id);
  }, [forcedStatus?.bloqueado]);

  // Aqui, diferente do resto do app, instalar sozinho assim que a
  // atualização termina de baixar é seguro — a tela já está bloqueando
  // 100% do uso, então não tem venda nem trabalho em andamento pra
  // interromper (a pessoa já não consegue fazer mais nada até
  // atualizar de qualquer jeito). O botão manual abaixo continua como
  // reforço, caso esse efeito não dispare por algum motivo.
  useEffect(() => {
    if (forcedStatus?.bloqueado && updateStatus?.baixado) {
      window.pdv.update.install();
    }
  }, [forcedStatus?.bloqueado, updateStatus?.baixado]);

  if (!forcedStatus?.bloqueado) {
    return children;
  }

  async function handleAtualizarAgora() {
    setVerificando(true);
    await window.pdv.update.check();
    // não desliga "verificando" aqui direto — o polling acima faz isso
    // assim que o resultado da checagem chegar (s.checking vira false);
    // o download em si começa sozinho (autoDownload), sem passo extra.
  }

  function handleInstalar() {
    window.pdv.update.install();
  }

  // Depois de uma checagem que terminou sem achar nenhuma atualização
  // disponível — isso é estranho quando a tela está bloqueada dizendo
  // que uma versão nova é obrigatória: normalmente significa que o
  // release dessa versão no GitHub não está publicado corretamente
  // (rascunho, sem os arquivos que o auto-updater precisa, etc). Vale
  // deixar isso claro em vez de só voltar pro botão como se nada
  // tivesse acontecido.
  const checouENaoAchouNada = updateStatus && !updateStatus.checking && !updateStatus.disponivel &&
    !updateStatus.baixando && !updateStatus.baixado && !updateStatus.erro;

  return (
    <div className="license-block-screen">
      <div className="license-block-card update-block-card">
        <h1>⬆️ Atualização obrigatória</h1>
        <p>
          Uma nova versão do sistema é obrigatória pra continuar usando — versão atual:{' '}
          <strong>{forcedStatus.versaoAtual}</strong>, versão mínima exigida:{' '}
          <strong>{forcedStatus.versaoMinimaExigida}</strong>.
        </p>

        {updateStatus?.erro && (
          <p className="modal-error">
            Não foi possível verificar a atualização: {updateStatus.erro}. Confira sua conexão com a
            internet e tente de novo.
          </p>
        )}

        {checouENaoAchouNada && (
          <p className="modal-error">
            A checagem terminou, mas não achou nenhuma atualização disponível pra baixar — o mais
            comum é a versão {forcedStatus.versaoMinimaExigida} não estar publicada corretamente no
            GitHub Releases ainda (confira se o release está marcado como "Latest", não como rascunho
            ou pré-lançamento). Fale com quem administra o sistema se isso continuar.
          </p>
        )}

        {updateStatus?.baixando && (
          <div className="update-progress-wrap">
            <div className="update-progress-bar">
              <div className="update-progress-fill" style={{ width: `${updateStatus.progresso}%` }} />
            </div>
            <p className="screen-hint" style={{ margin: '6px 0 0' }}>Baixando... {updateStatus.progresso}%</p>
          </div>
        )}

        {updateStatus?.baixado && (
          <>
            <p>Atualização baixada — instalando automaticamente, o sistema fecha e abre de novo sozinho...</p>
            <button className="btn-primary" onClick={handleInstalar}>⬆️ Instalar agora</button>
          </>
        )}

        {!updateStatus?.baixando && !updateStatus?.baixado && (
          <button className="btn-primary" onClick={handleAtualizarAgora} disabled={verificando}>
            {verificando ? 'Verificando...' : (checouENaoAchouNada || updateStatus?.erro) ? 'Tentar de novo' : '🔄 Atualizar agora'}
          </button>
        )}

        <p className="screen-hint" style={{ marginTop: 16 }}>
          Seus dados continuam salvos e intactos — isso só atualiza o programa em si.
        </p>
      </div>
    </div>
  );
}
