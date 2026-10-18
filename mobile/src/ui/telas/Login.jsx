import { useState } from 'react';
import { useApp, useTentar, useCarregar } from '../contexto.jsx';
import { listarUsuarios, autenticar } from '../../services/usuarios.js';
import TecladoPin from '../comp/TecladoPin.jsx';

const PAPEL = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };

export default function Login() {
  const { servicos, entrar } = useApp();
  const tentar = useTentar();
  const { dados: usuarios } = useCarregar(() => listarUsuarios(servicos.db), []);
  const [escolhido, setEscolhido] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const nomeNegocio = servicos.licenca.estado?.nomeNegocio;

  return (
    <div className="tela-cheia">
      <div className="marca">
        <div className="logo">G</div>
        <div>
          <h1>{nomeNegocio || 'GerenciaAI PDV'}</h1>
          <p className="muted peq">Quem vai usar o caixa?</p>
        </div>
      </div>
      <div className="operadores">
        {(usuarios || []).map((u) => (
          <button type="button" key={u.id} className={`operador ${escolhido?.id === u.id ? 'ativo' : ''}`} onClick={() => setEscolhido(u)}>
            <span className="avatar">{u.nome.slice(0, 1).toUpperCase()}</span>
            <span className="corta" style={{ maxWidth: '100%' }}>{u.nome}</span>
            <span className="selo">{PAPEL[u.papel]}</span>
          </button>
        ))}
      </div>
      {escolhido && (
        <div className="cartao pilha">
          <p className="centro">PIN de <b>{escolhido.nome}</b></p>
          <TecladoPin
            ocupado={ocupado}
            limparQuando={`${escolhido.id}-${tentativa}`}
            aoConfirmar={async (pin) => {
              setOcupado(true);
              const u = await tentar(() => autenticar(servicos.db, escolhido.id, pin));
              setOcupado(false);
              if (u) entrar(u); else setTentativa((t) => t + 1);
            }}
          />
        </div>
      )}
    </div>
  );
}
