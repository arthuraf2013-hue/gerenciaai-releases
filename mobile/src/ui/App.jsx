import { useCallback, useEffect, useRef, useState } from 'react';
import { ProvedorApp, Toasts, useToasts, useResumoTerminal } from './contexto.jsx';
import { textoDoBloqueio } from '../services/licenca.js';
import { aoApertarVoltar } from '../app/plataforma.js';
import { fecharDoTopo } from './comp/pilhaVoltar.js';
import { CARRINHO_VAZIO } from './carrinhoUtil.js';
import Icone from './comp/Icone.jsx';
import Ativacao from './telas/Ativacao.jsx';
import Login from './telas/Login.jsx';
import Vender from './telas/Vender.jsx';
import Vendas from './telas/Vendas.jsx';
import Produtos from './telas/Produtos.jsx';
import Clientes from './telas/Clientes.jsx';
import Mais from './telas/Mais.jsx';

const ABAS = [
  ['vender', 'vender', 'Vender'],
  ['vendas', 'recibo', 'Vendas'],
  ['produtos', 'produto', 'Produtos'],
  ['clientes', 'cliente', 'Clientes'],
  ['mais', 'mais', 'Mais'],
];

function FaixaLicenca({ status }) {
  if (!status) return null;
  const msgs = [];
  if (status.status === 'aviso' || status.status === 'somente_leitura') msgs.push({ perigo: status.status === 'somente_leitura', texto: textoDoBloqueio(status) });
  if (status.alertaSemInternetHoras) msgs.push({ perigo: status.alertaSemInternetHoras <= 12, texto: `Sem falar com a Central há quase 3 dias. Conecte à internet em até ${status.alertaSemInternetHoras} h para não bloquear.` });
  if (status.mensagemDoPainel) msgs.push({ perigo: false, texto: status.mensagemDoPainel });
  return msgs.map((m, i) => (
    <div key={i} className={`faixa-licenca ${m.perigo ? 'perigo' : ''}`} role="alert"><Icone nome={m.perigo ? 'cadeado' : 'alerta'} /><span>{m.texto}</span></div>
  ));
}

// Terminal: o computador recusou algo -- não pode passar despercebido
// (a venda existe aqui mas não lá).
function FaixaTerminal({ resumo, irPara }) {
  if (!resumo?.erros?.length) return null;
  return (
    <button type="button" className="faixa-licenca perigo" role="alert" onClick={() => irPara('mais', { sub: 'ajustes' })}>
      <Icone nome="computador" /><span>O {resumo.servidorNome || 'computador'} recusou {resumo.erros.length} registro(s). Toque para ver.</span>
    </button>
  );
}

function TelaBloqueio({ status, servicos }) {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const tentar = async () => {
    setOcupado(true); setErro(null);
    try { await servicos.licenca.ping(); await servicos.licenca.verificar(); } catch { setErro('Ainda sem conexão com a Central. Confira a internet.'); }
    setOcupado(false);
  };
  const icone = status.motivo === 'sem_internet' ? 'wifiOff' : status.motivo === 'relogio_atrasado' ? 'alerta' : 'cadeado';
  return (
    <div className="bloqueio">
      <div className="tela-cheia" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div className="icone-grande"><Icone nome={icone} /></div>
        <h1>{status.motivo === 'sem_internet' ? 'Conecte à internet' : status.motivo === 'relogio_atrasado' ? 'Confira a data e hora' : 'Aparelho bloqueado'}</h1>
        <p className="muted">{textoDoBloqueio(status)}</p>
        {erro && <div className="aviso perigo"><span>{erro}</span></div>}
        <button type="button" className="btn primario grande" disabled={ocupado} onClick={tentar}>{ocupado ? 'Verificando...' : 'Verificar agora'}</button>
        <p className="muted peq">Seus dados continuam guardados neste celular e na nuvem.</p>
      </div>
    </div>
  );
}

export default function App({ servicos }) {
  const { lista: toasts, mostrar: toast } = useToasts();
  const [ativado, setAtivado] = useState(!!servicos.licenca.estado?.ativado);
  const [usuario, setUsuario] = useState(null);
  const [aba, setAba] = useState('vender');
  const [parametros, setParametros] = useState(null);
  const [carrinho, setCarrinho] = useState(CARRINHO_VAZIO);
  const [licencaStatus, setLicencaStatus] = useState(() => servicos.licenca.status());
  const terminal = useResumoTerminal(servicos);

  useEffect(() => {
    const atualizar = () => setLicencaStatus(servicos.licenca.status());
    const tirar = servicos.licenca.aoMudar(atualizar);
    const t = setInterval(atualizar, 30000);
    return () => { tirar(); clearInterval(t); };
  }, [servicos.licenca]);

  const irPara = useCallback((destino, params = null) => { setParametros(params); setAba(destino); }, []);

  // Registra o "voltar" do Android UMA vez; a aba atual vem por ref
  // (registrar de novo a cada troca de aba empilharia ouvintes).
  const abaRef = useRef(aba);
  abaRef.current = aba;
  useEffect(() => {
    aoApertarVoltar(() => {
      if (fecharDoTopo()) return true;
      if (abaRef.current !== 'vender') { setAba('vender'); return true; }
      return false;
    });
  }, []);

  const ctx = {
    servicos, usuario, toast, carrinho, setCarrinho, licencaStatus, irPara, terminal,
    entrar: (u) => { setUsuario(u); setAba('vender'); },
    sair: () => { setUsuario(null); setCarrinho(CARRINHO_VAZIO); },
    aoAtivar: () => { servicos.ligarSincronizacao(); setAtivado(true); setLicencaStatus(servicos.licenca.status()); },
  };

  let corpo;
  if (!ativado) corpo = <Ativacao />;
  else if (!usuario) corpo = <Login />;
  else {
    const Tela = { vender: Vender, vendas: Vendas, produtos: Produtos, clientes: Clientes, mais: Mais }[aba];
    corpo = (
      <>
        <FaixaLicenca status={licencaStatus} />
        <FaixaTerminal resumo={terminal} irPara={irPara} />
        <Tela key={`${aba}-${JSON.stringify(parametros)}`} parametros={parametros} />
        <nav className="abas" aria-label="Navegação">
          {ABAS.map(([id, ic, rot]) => (
            <button type="button" key={id} className={`aba ${aba === id ? 'ativa' : ''}`} aria-current={aba === id ? 'page' : undefined} onClick={() => irPara(id)}>
              <Icone nome={ic} />{rot}
            </button>
          ))}
        </nav>
      </>
    );
  }

  return (
    <ProvedorApp value={ctx}>
      {corpo}
      {ativado && licencaStatus?.status === 'bloqueado' && <TelaBloqueio status={licencaStatus} servicos={servicos} />}
      <Toasts lista={toasts} />
    </ProvedorApp>
  );
}
