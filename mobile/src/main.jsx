import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './ui/App.jsx';
import { iniciarServicos } from './app/iniciar.js';

const raiz = createRoot(document.getElementById('app'));
raiz.render(<div className="carregando"><div className="spinner" />Abrindo...</div>);

iniciarServicos().then(
  (servicos) => raiz.render(<App servicos={servicos} />),
  (err) => {
    console.error(err);
    raiz.render(
      <div className="tela-cheia">
        <h1>Não foi possível abrir o app</h1>
        <p className="muted">{String(err?.message || err)}</p>
        <p className="muted peq">Seus dados não foram apagados. Feche e abra o app de novo; se continuar, fale com o suporte e mostre esta mensagem.</p>
        <button type="button" className="btn primario grande" onClick={() => location.reload()}>Tentar de novo</button>
      </div>,
    );
  },
);
