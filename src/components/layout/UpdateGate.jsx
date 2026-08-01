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
  const [iniciando, setIniciando] = useState(false);

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
    // real (que vai achar a versão disponível pra baixar) — poupa um
    // clique de quem está usando o app.
    window.pdv.update.check();
    const id = setInterval(async () => {
      const s = await window.pdv.update.getStatus();
      setUpdateStatus(s);
    }, 1000);
    return () => clearInterval(id);
  }, [forcedStatus?.bloqueado]);

  if (!forcedStatus?.bloqueado) {
    return children;
  }

  async function handleAtualizarAgora() {
    setIniciando(true);
    if (updateStatus?.disponivel && !updateStatus?.baixando && !updateStatus?.baixado) {
      await window.pdv.update.download();
    } else if (!updateStatus?.disponivel) {
      await window.pdv.update.check();
    }
  }

  function handleInstalar() {
    window.pdv.update.install();
  }

  return (
    <div className="license-block-screen">
      <div className="license-block-card update-block-card">
        <h1>Atualização obrigatória</h1>
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
            <p>Atualização baixada — clique abaixo pra instalar. O sistema fecha e abre de novo sozinho.</p>
            <button className="btn-primary" onClick={handleInstalar}>Instalar e reiniciar agora</button>
          </>
        )}

        {!updateStatus?.baixando && !updateStatus?.baixado && (
          <button className="btn-primary" onClick={handleAtualizarAgora} disabled={iniciando}>
            {iniciando ? 'Verificando...' : 'Atualizar agora'}
          </button>
        )}

        <p className="screen-hint" style={{ marginTop: 16 }}>
          Seus dados continuam salvos e intactos — isso só atualiza o programa em si.
        </p>
      </div>
    </div>
  );
}
