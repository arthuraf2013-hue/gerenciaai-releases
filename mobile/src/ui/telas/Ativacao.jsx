import { useState } from 'react';
import { useApp, useTentar } from '../contexto.jsx';
import Icone from '../comp/Icone.jsx';
import { ErroDeNegocio } from '../../services/base.js';

export default function Ativacao() {
  const { servicos, aoAtivar } = useApp();
  const tentar = useTentar();
  const [f, setF] = useState({ codigo: '', nomeNegocio: '', adminNome: '', adminPin: '', adminPin2: '' });
  const [ocupado, setOcupado] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const ativar = async (e) => {
    e.preventDefault();
    if (f.adminPin !== f.adminPin2) { await tentar(() => { throw new ErroDeNegocio('Os dois PINs não são iguais.'); }); return; }
    setOcupado(true);
    const ok = await tentar(async () => {
      await servicos.licenca.ativar({ codigo: f.codigo, nomeNegocio: f.nomeNegocio, adminNome: f.adminNome, adminPin: f.adminPin });
      return true;
    });
    setOcupado(false);
    if (ok) aoAtivar();
  };

  return (
    <form className="tela-cheia" onSubmit={ativar}>
      <div className="marca">
        <div className="logo">G</div>
        <div>
          <h1>GerenciaAI PDV</h1>
          <p className="muted peq">PDV mobile autônomo — vende sem computador</p>
        </div>
      </div>
      <div className="aviso info"><Icone nome="celular" /><span>Para começar, use o <b>código de ativação</b> que você recebeu. A ativação precisa de internet só desta vez; depois o app vende mesmo sem conexão.</span></div>
      {servicos.demo && <div className="aviso"><Icone nome="alerta" /><span>Modo demonstração (navegador): nada vai para a nuvem. Código de teste: <b>DEMO2026</b>.</span></div>}
      <label className="campo">Código de ativação
        <input value={f.codigo} onChange={mudar('codigo')} autoCapitalize="characters" autoComplete="off" placeholder="Ex.: K7Q2-M9XA" required />
      </label>
      <label className="campo">Nome do negócio
        <input value={f.nomeNegocio} onChange={mudar('nomeNegocio')} placeholder="Ex.: Mercadinho Boa Vista" required />
      </label>
      <label className="campo">Seu nome (administrador)
        <input value={f.adminNome} onChange={mudar('adminNome')} autoComplete="name" required />
      </label>
      <div className="grade-2">
        <label className="campo">PIN (4 a 8 números)
          <input value={f.adminPin} onChange={mudar('adminPin')} type="password" inputMode="numeric" pattern="\d{4,8}" autoComplete="new-password" required />
        </label>
        <label className="campo">Repita o PIN
          <input value={f.adminPin2} onChange={mudar('adminPin2')} type="password" inputMode="numeric" pattern="\d{4,8}" autoComplete="new-password" required />
        </label>
      </div>
      <button className="btn primario grande" disabled={ocupado}>{ocupado ? 'Ativando...' : 'Ativar este celular'}</button>
    </form>
  );
}
