import { useEffect, useRef, useState } from 'react';

function RobotIcon() {
  return (
    <svg viewBox="0 0 100 100" width="30" height="30">
      {/* antena */}
      <line x1="50" y1="8" x2="50" y2="20" stroke="#3C7A87" strokeWidth="3" strokeLinecap="round" />
      <circle cx="50" cy="7" r="5.5" fill="#F2A6BC" />

      {/* orelhas */}
      <circle cx="21" cy="38" r="8" fill="#F4C752" />
      <circle cx="79" cy="38" r="8" fill="#F4C752" />

      {/* cabeça */}
      <rect x="24" y="18" width="52" height="42" rx="14" fill="#5C93A3" />
      {/* tela do rosto */}
      <rect x="32" y="27" width="36" height="26" rx="8" fill="#F4C752" />
      {/* olhos */}
      <circle cx="43" cy="39" r="4.4" fill="#2E4C55" />
      <circle cx="57" cy="39" r="4.4" fill="#2E4C55" />
      <circle cx="41.6" cy="37.3" r="1.3" fill="#FFFFFF" />
      <circle cx="55.6" cy="37.3" r="1.3" fill="#FFFFFF" />
      {/* bochechas */}
      <circle cx="36.5" cy="45.5" r="2.6" fill="#F2A6BC" />
      <circle cx="63.5" cy="45.5" r="2.6" fill="#F2A6BC" />
      {/* sorriso */}
      <path d="M46 45.5 Q50 49 54 45.5" stroke="#2E4C55" strokeWidth="2" strokeLinecap="round" fill="none" />

      {/* corpo */}
      <rect x="28" y="62" width="44" height="30" rx="12" fill="#8DBAC6" />
      {/* coração no peito */}
      <rect x="41" y="70" width="18" height="18" rx="5" fill="#F4C752" />
      <path
        d="M50 82.5c-3.6-2.6-6-4.7-6-7.3 0-1.8 1.4-3.2 3.1-3.2 1.2 0 2.2.7 2.9 1.7.7-1 1.7-1.7 2.9-1.7 1.7 0 3.1 1.4 3.1 3.2 0 2.6-2.4 4.7-6 7.3z"
        fill="#FBEFD9"
      />

      {/* braços */}
      <rect x="16" y="66" width="10" height="20" rx="5" fill="#5C93A3" />
      <rect x="74" y="66" width="10" height="20" rx="5" fill="#5C93A3" />
      <circle cx="21" cy="88" r="6.5" fill="#2E4C55" />
      <circle cx="79" cy="88" r="6.5" fill="#2E4C55" />

      {/* pernas */}
      <rect x="36" y="90" width="9" height="8" rx="3" fill="#5C93A3" />
      <rect x="55" y="90" width="9" height="8" rx="3" fill="#5C93A3" />
    </svg>
  );
}

export function FloatingTutor() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // { role: 'user'|'assistant', texto }
  const [input, setInput] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  async function enviar(e) {
    e.preventDefault();
    const pergunta = input.trim();
    if (!pergunta || enviando) return;

    setError('');
    setInput('');
    const novoHistorico = [...messages, { role: 'user', texto: pergunta }];
    setMessages(novoHistorico);
    setEnviando(true);

    const result = await window.pdv.ai.askTutor({ pergunta, historico: messages });
    setEnviando(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessages([...novoHistorico, { role: 'assistant', texto: result.resposta }]);
  }

  return (
    <>
      <button className="tutor-fab" onClick={() => setOpen((v) => !v)} title="Tirar dúvidas sobre o sistema">
        <RobotIcon />
      </button>

      {open && (
        <div className="tutor-panel">
          <div className="tutor-panel-header">
            <span>IA tutora — dúvidas do sistema</span>
            <button className="btn-link" style={{ color: 'white' }} onClick={() => setOpen(false)}>Fechar</button>
          </div>

          <div className="tutor-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <p className="tutor-empty-hint">
                Pergunte como usar qualquer parte do sistema, ou cole uma mensagem de erro que apareceu
                na tela — eu ajudo a entender o que ela significa.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`tutor-bubble tutor-bubble-${m.role}`}>{m.texto}</div>
            ))}
            {enviando && <div className="tutor-bubble tutor-bubble-assistant tutor-typing">Digitando...</div>}
          </div>

          {error && <p className="modal-error tutor-error">{error}</p>}

          <form className="tutor-input-row" onSubmit={enviar}>
            <input
              placeholder="Digite sua dúvida..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={enviando}
            />
            <button className="btn-primary" type="submit" disabled={enviando || !input.trim()}>Enviar</button>
          </form>
        </div>
      )}
    </>
  );
}
