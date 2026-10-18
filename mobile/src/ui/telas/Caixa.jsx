import { useState } from 'react';
import { useApp, useTentar, useCarregar } from '../contexto.jsx';
import { caixaAberto, resumoDoCaixa, movimentarCaixa, fecharCaixa, historicoDeCaixas } from '../../services/caixa.js';
import { formatarCentavos, lerCentavos, ErroDeNegocio } from '../../services/base.js';
import { METODOS } from '../../services/vendas.js';
import Modal from '../comp/Modal.jsx';
import Icone from '../comp/Icone.jsx';

function Linha({ rotulo, valor, forte }) {
  return <div className="entre"><span className={forte ? 'forte' : 'muted'}>{rotulo}</span><span className={`num ${forte ? 'forte' : ''}`}>{valor}</span></div>;
}

export default function Caixa({ voltar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const dados = useCarregar(async () => {
    const c = await caixaAberto(servicos.db);
    return { caixa: c, resumo: c ? await resumoDoCaixa(servicos.db, c.id) : null, historico: await historicoDeCaixas(servicos.db, 10) };
  }, []);
  const [mov, setMov] = useState(null);
  const [fechar, setFechar] = useState(null);
  const [resultado, setResultado] = useState(null);
  const r = dados.dados?.resumo;

  return (
    <>
      <header className="topo">
        <button type="button" className="icone-btn" onClick={voltar} aria-label="Voltar"><Icone nome="voltar" /></button>
        <h1>Caixa</h1>
      </header>
      <main className="conteudo">
        {resultado && (
          <div className={`aviso ${resultado.diferencaCentavos === 0 ? 'info' : resultado.diferencaCentavos < 0 ? 'perigo' : ''}`}>
            <Icone nome={resultado.diferencaCentavos === 0 ? 'ok' : 'alerta'} />
            <span>Caixa fechado. Esperado {formatarCentavos(resultado.dinheiroEsperadoCentavos)}, contado {formatarCentavos(resultado.valorContadoCentavos)} —{' '}
              {resultado.diferencaCentavos === 0 ? 'bateu certinho.' : resultado.diferencaCentavos > 0 ? `sobra de ${formatarCentavos(resultado.diferencaCentavos)}.` : `falta de ${formatarCentavos(-resultado.diferencaCentavos)}.`}</span>
          </div>
        )}
        {!dados.dados ? null : !r ? (
          <div className="cartao pilha"><p>Nenhum caixa aberto. Abra pela tela <b>Vender</b>.</p></div>
        ) : (
          <>
            <div className="cartao pilha-p">
              <p className="muted peq">Aberto em {new Date(r.caixa.aberto_em).toLocaleString('pt-BR')}</p>
              <Linha rotulo="Vendas" valor={`${r.vendas.quantidade} · ${formatarCentavos(r.vendas.totalCentavos)}`} forte />
              {Object.entries(r.porMetodo).filter(([, v]) => v).map(([m, v]) => <Linha key={m} rotulo={METODOS[m]} valor={formatarCentavos(v)} />)}
              {r.canceladas.quantidade > 0 && <Linha rotulo={`Canceladas (${r.canceladas.quantidade})`} valor={formatarCentavos(r.canceladas.totalCentavos)} />}
              {Object.entries(r.fiadoRecebido).filter(([, v]) => v).map(([m, v]) => <Linha key={`f${m}`} rotulo={`Fiado recebido (${METODOS[m].toLowerCase()})`} valor={formatarCentavos(v)} />)}
            </div>
            <div className="cartao pilha-p">
              <Linha rotulo="Abertura" valor={formatarCentavos(r.caixa.valor_abertura_centavos)} />
              {r.suprimentosCentavos > 0 && <Linha rotulo="Suprimentos" valor={`+ ${formatarCentavos(r.suprimentosCentavos)}`} />}
              {r.sangriasCentavos > 0 && <Linha rotulo="Sangrias" valor={`− ${formatarCentavos(r.sangriasCentavos)}`} />}
              <Linha rotulo="Dinheiro que deve ter na gaveta" valor={formatarCentavos(r.dinheiroEsperadoCentavos)} forte />
            </div>
            <div className="grade-2">
              <button type="button" className="btn" onClick={() => setMov({ tipo: 'sangria', valor: '', motivo: '' })}>Sangria</button>
              <button type="button" className="btn" onClick={() => setMov({ tipo: 'suprimento', valor: '', motivo: '' })}>Suprimento</button>
            </div>
            <button type="button" className="btn perigo grande" onClick={() => setFechar({ valor: '', obs: '' })}>Fechar caixa</button>
          </>
        )}
        {dados.dados?.historico?.filter((h) => h.status === 'fechado').length > 0 && (
          <>
            <div className="secao-titulo">Últimos fechamentos</div>
            <div className="cartao plano">
              {dados.dados.historico.filter((h) => h.status === 'fechado').map((h) => {
                const dif = h.valor_contado_centavos - h.valor_esperado_centavos;
                return (
                  <div className="item" key={h.id}>
                    <div className="cresce"><div>{new Date(h.fechado_em).toLocaleString('pt-BR')}</div><div className="muted peq">{h.fechado_por_nome}</div></div>
                    <span className={`selo ${dif === 0 ? 'ok' : dif < 0 ? 'perigo' : 'alerta'}`}>{dif === 0 ? 'bateu' : `${dif > 0 ? '+' : '−'}${formatarCentavos(Math.abs(dif))}`}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
      {mov && (
        <Modal titulo={mov.tipo === 'sangria' ? 'Sangria (tirar dinheiro)' : 'Suprimento (colocar dinheiro)'} aoFechar={() => setMov(null)}>
          <label className="campo">Valor (R$)<input autoFocus value={mov.valor} onChange={(e) => setMov({ ...mov, valor: e.target.value })} inputMode="decimal" /></label>
          <label className="campo">Motivo<input value={mov.motivo} onChange={(e) => setMov({ ...mov, motivo: e.target.value })} placeholder="ex.: pagamento de fornecedor" /></label>
          <button type="button" className="btn primario grande" onClick={() => tentar(async () => {
            const v = lerCentavos(mov.valor);
            if (v == null) throw new ErroDeNegocio('Valor inválido.');
            await movimentarCaixa(servicos.db, { tipo: mov.tipo, valorCentavos: v, motivo: mov.motivo }, usuario.id);
            setMov(null);
            dados.recarregar();
          }, { sucesso: 'Registrado.' })}>Confirmar</button>
        </Modal>
      )}
      {fechar && (
        <Modal titulo="Fechar caixa" aoFechar={() => setFechar(null)}>
          <p className="muted">Conte o dinheiro da gaveta e digite o total. O app compara com o que deveria ter.</p>
          <label className="campo">Dinheiro contado (R$)<input autoFocus value={fechar.valor} onChange={(e) => setFechar({ ...fechar, valor: e.target.value })} inputMode="decimal" /></label>
          <label className="campo">Observação<input value={fechar.obs} onChange={(e) => setFechar({ ...fechar, obs: e.target.value })} placeholder="opcional" /></label>
          <button type="button" className="btn perigo grande" onClick={() => tentar(async () => {
            const v = lerCentavos(fechar.valor);
            if (v == null) throw new ErroDeNegocio('Informe o valor contado.');
            const res = await fecharCaixa(servicos.db, { valorContadoCentavos: v, observacao: fechar.obs }, usuario.id);
            setFechar(null);
            setResultado(res);
            dados.recarregar();
            // Fim de expediente é um bom momento pra garantir a cópia na nuvem.
            servicos.backup.fazerBackup({ motivo: 'fechamento_caixa' }).catch(() => {});
          })}>Fechar caixa</button>
        </Modal>
      )}
    </>
  );
}
