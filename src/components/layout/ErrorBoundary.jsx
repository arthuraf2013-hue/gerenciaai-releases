import { Component } from 'react';

/**
 * Pega erros de renderização do React (que window.onerror sozinho não
 * pega sempre) e reporta pro painel, em vez de deixar a tela em
 * branco sem explicação nenhuma. Mostra uma tela de recuperação com
 * botão pra recarregar, sem perder dados (nada é gravado aqui, só a
 * interface trava).
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { comErro: false };
  }

  static getDerivedStateFromError() {
    return { comErro: true };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
    try {
      window.pdv?.error?.report({
        mensagem: error?.message, stack: error?.stack, contexto: 'react-render',
      });
    } catch (err) {
      // se nem isso der certo, não tem mais nada a fazer aqui
    }
  }

  render() {
    if (this.state.comErro) {
      return (
        <div className="license-block-screen">
          <div className="license-block-card update-block-card">
            <h1>⚠️ Algo deu errado</h1>
            <p>A tela travou por causa de um erro inesperado. Seus dados continuam salvos e intactos —
              isso é só um problema na exibição.</p>
            <button className="btn-primary" onClick={() => window.location.reload()}>🔄 Recarregar</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
