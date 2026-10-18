import { useEffect } from 'react';
import Icone from './Icone.jsx';
import { registrarFechavel } from './pilhaVoltar.js';

/** Folha que sobe de baixo. Fecha no X, tocando fora, no Esc e no "voltar" do Android. */
export default function Modal({ titulo, aoFechar, children, rodape }) {
  useEffect(() => {
    const tecla = (e) => { if (e.key === 'Escape') aoFechar?.(); };
    window.addEventListener('keydown', tecla);
    const tirar = registrarFechavel(() => aoFechar?.());
    return () => { window.removeEventListener('keydown', tecla); tirar(); };
  }, [aoFechar]);

  return (
    <div className="fundo-modal" onClick={(e) => { if (e.target === e.currentTarget) aoFechar?.(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="modal-topo">
          <h2>{titulo}</h2>
          {aoFechar && <button type="button" className="icone-btn" onClick={aoFechar} aria-label="Fechar"><Icone nome="fechar" /></button>}
        </div>
        <div className="modal-corpo">{children}</div>
        {rodape && <div style={{ padding: '0 18px 16px' }}>{rodape}</div>}
      </div>
    </div>
  );
}
