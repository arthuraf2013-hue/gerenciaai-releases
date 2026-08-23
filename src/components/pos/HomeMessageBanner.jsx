import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

const CHAVE_LOCALSTORAGE = 'gerenciaai:mensagens-fechadas';

function assinaturaDe(mensagens) {
  // Uma "impressão digital" do conteúdo — se o admin trocar o texto ou
  // a imagem, essa assinatura muda, e a mensagem nova volta a aparecer
  // mesmo que a anterior já tivesse sido fechada.
  return JSON.stringify({ g: mensagens.global, p: mensagens.personalizada });
}

function jaFoiFechada(assinatura) {
  try {
    return localStorage.getItem(CHAVE_LOCALSTORAGE) === assinatura;
  } catch (err) {
    return false;
  }
}

function marcarComoFechada(assinatura) {
  try {
    localStorage.setItem(CHAVE_LOCALSTORAGE, assinatura);
  } catch (err) {
    // localStorage indisponível (raro) — só não persiste, sem quebrar nada
  }
}

export function HomeMessageBanner() {
  const [mensagens, setMensagens] = useState(null);
  const [fechada, setFechada] = useState(false);

  useEffect(() => {
    function atualizar() {
      window.pdv.message.getForDisplay().then((m) => {
        setMensagens(m);
        setFechada(jaFoiFechada(assinaturaDe(m)));
      });
    }
    atualizar();
    const id = setInterval(atualizar, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (fechada || !mensagens || (!mensagens.global && !mensagens.personalizada)) return null;

  function handleFechar() {
    marcarComoFechada(assinaturaDe(mensagens));
    setFechada(true);
  }

  return (
    <div className="home-message-banner">
      <button className="home-message-close" onClick={handleFechar} title="Fechar"><Icon name="close" size={14} /></button>
      {mensagens.personalizada && (
        <div className="home-message-item home-message-personalizada"><Icon name="warning" size={15} /> {mensagens.personalizada}</div>
      )}
      {mensagens.global && (
        <div className="home-message-item">
          {mensagens.global.imagemUrl && <img src={mensagens.global.imagemUrl} alt="" className="home-message-imagem" />}
          {mensagens.global.texto && <span>{mensagens.global.texto}</span>}
        </div>
      )}
    </div>
  );
}
