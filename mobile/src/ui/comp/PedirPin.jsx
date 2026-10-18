import { useState } from 'react';
import Modal from './Modal.jsx';
import TecladoPin from './TecladoPin.jsx';

/** Modal que pede o PIN de um gerente/admin. `aoConfirmar(pin)` devolve true se deu certo (senão limpa e deixa tentar de novo). */
export default function PedirPin({ titulo = 'Autorização do gerente', texto, aoConfirmar, aoFechar }) {
  const [ocupado, setOcupado] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  return (
    <Modal titulo={titulo} aoFechar={aoFechar}>
      {texto && <p className="muted">{texto}</p>}
      <TecladoPin
        rotuloOk="Autorizar"
        ocupado={ocupado}
        limparQuando={tentativa}
        aoConfirmar={async (pin) => {
          setOcupado(true);
          const ok = await aoConfirmar(pin);
          setOcupado(false);
          if (!ok) setTentativa((t) => t + 1);
        }}
      />
    </Modal>
  );
}
