import { useApp, useTentar } from '../contexto.jsx';
import { formatarCentavos } from '../../services/base.js';
import { reciboEmTexto } from '../../services/relatorios.js';
import { compartilharTexto, abrirWhatsApp } from '../../app/plataforma.js';
import Icone from '../comp/Icone.jsx';
import SeloEnvio from '../comp/SeloEnvio.jsx';

export default function VendaConcluida({ venda, aoNovaVenda }) {
  const { servicos, terminal } = useApp();
  const tentar = useTentar();
  const texto = reciboEmTexto(venda, { nomeNegocio: servicos.licenca.estado?.nomeNegocio });
  return (
    <main className="conteudo" style={{ paddingTop: 'calc(20px + var(--safe-top))' }}>
      <div className="sucesso">
        <div className="circulo"><Icone nome="ok" /></div>
        <h1>Venda concluída</h1>
        <p className="muted">{venda.numero}</p>
        <div className="total-grande num">{formatarCentavos(venda.total_centavos)}</div>
      </div>
      {venda.troco_centavos > 0 && <div className="troco"><div className="peq">Troco</div><div className="valor num">{formatarCentavos(venda.troco_centavos)}</div></div>}
      <div className="grade-2">
        <button type="button" className="btn" onClick={() => tentar(async () => {
          const r = await compartilharTexto(texto, `Recibo ${venda.numero}`);
          if (r === 'copiado') return 'copiado';
        }, {})}><Icone nome="compartilhar" />Enviar recibo</button>
        {venda.cliente_telefone
          ? <button type="button" className="btn" onClick={() => abrirWhatsApp(venda.cliente_telefone, texto)}>WhatsApp do cliente</button>
          : <button type="button" className="btn" disabled title="Cliente sem telefone">WhatsApp do cliente</button>}
      </div>
      <SeloEnvio vendaId={venda.id} />
      <button type="button" className="btn primario grande" autoFocus onClick={aoNovaVenda}>Nova venda</button>
      <p className="muted peq centro">
        {terminal?.ativo
          ? `Recibo sem valor fiscal. A NFC-e, se estiver ligada no ${terminal.servidorNome || 'computador'}, sai por lá quando a venda chegar.`
          : 'Recibo sem valor fiscal. NFC-e não é emitida pelo celular autônomo.'}
      </p>
    </main>
  );
}
