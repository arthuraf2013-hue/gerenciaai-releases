import { useEffect, useState } from 'react';

export function HomeMessageBanner() {
  const [mensagens, setMensagens] = useState(null);
  const [fechada, setFechada] = useState(false);

  useEffect(() => {
    window.pdv.message.getForDisplay().then(setMensagens);
    const id = setInterval(() => window.pdv.message.getForDisplay().then(setMensagens), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (fechada || !mensagens || (!mensagens.global && !mensagens.personalizada)) return null;

  return (
    <div className="home-message-banner">
      <button className="home-message-close" onClick={() => setFechada(true)} title="Fechar">✕</button>
      {mensagens.personalizada && (
        <div className="home-message-item home-message-personalizada">⚠ {mensagens.personalizada}</div>
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
