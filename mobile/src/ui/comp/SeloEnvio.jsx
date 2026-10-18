import { useEffect, useState } from 'react';
import { useApp } from '../contexto.jsx';
import Icone from './Icone.jsx';

// Situação de uma venda no modo terminal: já chegou no computador? saiu
// NFC-e? (venda de quando o celular era autônomo não tem nada pra mostrar).
export default function SeloEnvio({ vendaId }) {
  const { servicos, terminal } = useApp();
  const [linhas, setLinhas] = useState(null);
  useEffect(() => {
    if (!servicos.terminal) return undefined;
    let vivo = true;
    const ler = () => servicos.terminal.situacaoDaVenda(vendaId).then((l) => { if (vivo) setLinhas(l); }).catch(() => {});
    ler();
    const tirar = servicos.terminal.aoMudar(ler);
    return () => { vivo = false; tirar(); };
  }, [servicos.terminal, vendaId]);
  if (!linhas || linhas.length === 0) return null;
  const nome = terminal?.servidorNome || 'computador';
  const erro = linhas.find((l) => l.status === 'erro');
  const pendente = linhas.some((l) => l.status === 'pendente');
  const enviado = linhas.some((l) => l.status === 'enviado');
  const nfce = linhas.find((l) => l.tipo === 'venda')?.resultado?.nfce;
  let selo;
  if (erro) selo = <div className="aviso perigo"><Icone nome="alerta" /><span>O {nome} recusou: {erro.erro}</span></div>;
  else if (pendente) selo = <div className="aviso"><Icone nome="wifiOff" /><span>Ainda não foi para o {nome} — vai sozinha quando houver internet.</span></div>;
  else if (enviado) selo = <div className="aviso"><Icone nome="sincronizar" /><span>Enviada, esperando o {nome} confirmar.</span></div>;
  else selo = <div className="aviso ok"><Icone nome="computador" /><span>Registrada no {nome}.</span></div>;
  return (
    <div className="pilha-p">
      {selo}
      {nfce && <SeloNfce nfce={nfce} />}
    </div>
  );
}

function SeloNfce({ nfce }) {
  if (nfce.status === 'autorizada') {
    return (
      <div className="aviso ok"><Icone nome="recibo" /><span>NFC-e nº {nfce.numero} autorizada.{nfce.url ? <> <a href={nfce.url} target="_blank" rel="noreferrer">Consultar</a></> : null}</span></div>
    );
  }
  if (nfce.status === 'contingencia' || nfce.status === 'pendente') return <div className="aviso"><Icone nome="recibo" /><span>NFC-e nº {nfce.numero} emitida em contingência — o computador transmite assim que a SEFAZ responder.</span></div>;
  if (nfce.status === 'nao_emitida') return <div className="aviso"><Icone nome="recibo" /><span>{nfce.mensagem}</span></div>;
  return <div className="aviso perigo"><Icone nome="recibo" /><span>NFC-e não saiu: {nfce.mensagem || nfce.status}</span></div>;
}
