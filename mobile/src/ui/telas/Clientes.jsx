import { useState } from 'react';
import { useApp, useTentar, useCarregar, useDebounce } from '../contexto.jsx';
import { buscarClientes, salvarCliente, obterCliente, receberFiado, extratoFiado } from '../../services/clientes.js';
import { formatarCentavos, lerCentavos, ErroDeNegocio } from '../../services/base.js';
import { METODOS } from '../../services/vendas.js';
import { abrirWhatsApp } from '../../app/plataforma.js';
import Modal from '../comp/Modal.jsx';
import Icone from '../comp/Icone.jsx';

const TIPO = { compra: 'Compra no fiado', pagamento: 'Pagamento', estorno: 'Estorno (venda cancelada)' };

function FormCliente({ cliente, aoFechar, aoSalvar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const [f, setF] = useState({
    nome: cliente?.nome || '', telefone: cliente?.telefone || '', documento: cliente?.documento || '',
    limite: cliente?.limite_fiado_centavos != null ? (cliente.limite_fiado_centavos / 100).toFixed(2).replace('.', ',') : '',
  });
  const m = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo={cliente ? 'Editar cliente' : 'Novo cliente'} aoFechar={aoFechar} rodape={(
      <button type="button" className="btn primario grande" onClick={() => tentar(async () => {
        const limite = f.limite.trim() ? lerCentavos(f.limite) : null;
        if (f.limite.trim() && (limite == null || limite < 0)) throw new ErroDeNegocio('Limite inválido.');
        await salvarCliente(servicos.db, { id: cliente?.id, nome: f.nome, telefone: f.telefone, documento: f.documento, limiteFiadoCentavos: limite }, usuario.id);
        aoSalvar();
      }, { sucesso: 'Cliente salvo.' })}>Salvar</button>
    )}>
      <label className="campo">Nome<input autoFocus={!cliente} value={f.nome} onChange={m('nome')} /></label>
      <label className="campo">Telefone (WhatsApp)<input value={f.telefone} onChange={m('telefone')} inputMode="tel" /></label>
      <label className="campo">CPF ou CNPJ<input value={f.documento} onChange={m('documento')} inputMode="numeric" placeholder="opcional" /></label>
      <label className="campo">Limite de fiado (R$)<input value={f.limite} onChange={m('limite')} inputMode="decimal" placeholder="sem limite" /></label>
    </Modal>
  );
}

function DetalheCliente({ id, aoFechar, aoMudar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const c = useCarregar(() => obterCliente(servicos.db, id), [id]);
  const ext = useCarregar(() => extratoFiado(servicos.db, id, 50), [id]);
  const [receber, setReceber] = useState(null);
  const [editar, setEditar] = useState(false);
  if (!c.dados) return null;
  const cli = c.dados;
  const recarregar = () => { c.recarregar(); ext.recarregar(); aoMudar(); };

  return (
    <Modal titulo={cli.nome} aoFechar={aoFechar}>
      <div className="cartao centro pilha-p">
        <span className="muted">Saldo devedor</span>
        <span className="total-grande num" style={{ color: cli.saldo_fiado_centavos > 0 ? 'var(--danger)' : undefined }}>{formatarCentavos(cli.saldo_fiado_centavos)}</span>
        {cli.limite_fiado_centavos != null && <span className="muted peq">Limite: {formatarCentavos(cli.limite_fiado_centavos)}</span>}
      </div>
      <div className="grade-2">
        <button type="button" className="btn primario" disabled={cli.saldo_fiado_centavos <= 0} onClick={() => setReceber({ valor: (cli.saldo_fiado_centavos / 100).toFixed(2).replace('.', ','), metodo: 'dinheiro' })}>Receber</button>
        <button type="button" className="btn" onClick={() => setEditar(true)}><Icone nome="editar" />Editar</button>
      </div>
      {cli.telefone && cli.saldo_fiado_centavos > 0 && (
        <button type="button" className="btn" onClick={() => abrirWhatsApp(cli.telefone, `Olá, ${cli.nome.split(' ')[0]}! Passando para lembrar do saldo de ${formatarCentavos(cli.saldo_fiado_centavos)} em ${servicos.licenca.estado?.nomeNegocio || 'nossa loja'}. Obrigado!`)}>Lembrar pelo WhatsApp</button>
      )}
      <div className="secao-titulo">Extrato</div>
      <div className="cartao plano">
        {(ext.dados || []).map((l) => (
          <div className="item" key={l.id}>
            <div className="cresce"><div>{TIPO[l.tipo]}{l.venda_numero ? ` · ${l.venda_numero}` : ''}</div><div className="muted peq">{new Date(l.criado_em).toLocaleString('pt-BR')}{l.metodo ? ` · ${METODOS[l.metodo]}` : ''}</div></div>
            <span className={`num forte ${l.valor_centavos > 0 ? 'estoque-baixo' : ''}`}>{l.valor_centavos > 0 ? '+' : '−'} {formatarCentavos(Math.abs(l.valor_centavos))}</span>
          </div>
        ))}
        {ext.dados?.length === 0 && <div className="vazio">Sem movimentação no fiado.</div>}
      </div>
      {receber && (
        <Modal titulo="Receber pagamento" aoFechar={() => setReceber(null)}>
          <label className="campo">Valor (R$)<input autoFocus value={receber.valor} onChange={(e) => setReceber({ ...receber, valor: e.target.value })} inputMode="decimal" /></label>
          <div className="segmentado">
            {['dinheiro', 'pix', 'debito', 'credito'].map((m) => <button type="button" key={m} className={receber.metodo === m ? 'ativo' : ''} onClick={() => setReceber({ ...receber, metodo: m })}>{m === 'debito' ? 'Débito' : m === 'credito' ? 'Crédito' : METODOS[m]}</button>)}
          </div>
          <button type="button" className="btn primario grande" onClick={() => tentar(async () => {
            const v = lerCentavos(receber.valor);
            if (v == null) throw new ErroDeNegocio('Valor inválido.');
            await receberFiado(servicos.db, { clienteId: id, valorCentavos: v, metodo: receber.metodo }, usuario.id);
            setReceber(null);
            recarregar();
          }, { sucesso: 'Pagamento recebido.' })}>Confirmar</button>
        </Modal>
      )}
      {editar && <FormCliente cliente={cli} aoFechar={() => setEditar(false)} aoSalvar={() => { setEditar(false); recarregar(); }} />}
    </Modal>
  );
}

export default function Clientes() {
  const { servicos } = useApp();
  const [termo, setTermo] = useState('');
  const [soFiado, setSoFiado] = useState(false);
  const t = useDebounce(termo, 150);
  const lista = useCarregar(() => buscarClientes(servicos.db, t, { limite: 200, soComFiado: soFiado }), [t, soFiado]);
  const [aberto, setAberto] = useState(null);
  const [novo, setNovo] = useState(false);
  const totalFiado = (lista.dados || []).reduce((s, c) => s + Math.max(0, c.saldo_fiado_centavos), 0);

  return (
    <>
      <header className="topo">
        <h1>Clientes</h1>
        <button type="button" className="btn primario peq" onClick={() => setNovo(true)}><Icone nome="mais1" />Novo</button>
      </header>
      <main className="conteudo">
        <div className="busca"><input value={termo} onChange={(e) => setTermo(e.target.value)} placeholder="Nome, telefone ou CPF" /></div>
        <div className="segmentado">
          <button type="button" className={!soFiado ? 'ativo' : ''} onClick={() => setSoFiado(false)}>Todos</button>
          <button type="button" className={soFiado ? 'ativo' : ''} onClick={() => setSoFiado(true)}>Devendo no fiado</button>
        </div>
        {soFiado && <div className="kpi"><div className="rotulo">Total a receber (lista)</div><div className="valor num">{formatarCentavos(totalFiado)}</div></div>}
        <div className="cartao plano">
          {(lista.dados || []).map((c) => (
            <button type="button" className="item" key={c.id} onClick={() => setAberto(c.id)}>
              <div className="cresce"><div className="forte corta">{c.nome}</div><div className="muted peq">{c.telefone || 'sem telefone'}</div></div>
              {c.saldo_fiado_centavos > 0 && <span className="selo alerta num">{formatarCentavos(c.saldo_fiado_centavos)}</span>}
            </button>
          ))}
          {lista.dados?.length === 0 && <div className="vazio">Nenhum cliente.</div>}
        </div>
      </main>
      {aberto && <DetalheCliente id={aberto} aoFechar={() => setAberto(null)} aoMudar={() => lista.recarregar()} />}
      {novo && <FormCliente aoFechar={() => setNovo(false)} aoSalvar={() => { setNovo(false); lista.recarregar(); }} />}
    </>
  );
}
