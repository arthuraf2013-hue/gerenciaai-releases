import { useState } from 'react';
import Modal from './Modal.jsx';
import { useApp, useTentar, useCarregar, useDebounce } from '../contexto.jsx';
import { buscarClientes, salvarCliente, obterCliente } from '../../services/clientes.js';
import { formatarCentavos } from '../../services/base.js';

export default function SelecionarCliente({ aoEscolher, aoFechar }) {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const [termo, setTermo] = useState('');
  const t = useDebounce(termo, 150);
  const lista = useCarregar(() => buscarClientes(servicos.db, t, { limite: 30 }), [t]);
  const [novo, setNovo] = useState(null);

  if (novo) {
    return (
      <Modal titulo="Novo cliente" aoFechar={() => setNovo(null)}>
        <label className="campo">Nome<input autoFocus value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} /></label>
        <label className="campo">Telefone (WhatsApp)<input value={novo.telefone} onChange={(e) => setNovo({ ...novo, telefone: e.target.value })} inputMode="tel" /></label>
        <button type="button" className="btn primario grande" onClick={() => tentar(async () => {
          const id = await salvarCliente(servicos.db, novo, usuario.id);
          aoEscolher(await obterCliente(servicos.db, id));
        })}>Salvar e escolher</button>
      </Modal>
    );
  }

  return (
    <Modal titulo="Cliente" aoFechar={aoFechar}>
      <div className="busca">
        <input autoFocus value={termo} onChange={(e) => setTermo(e.target.value)} placeholder="Nome, telefone ou CPF" />
        <button type="button" className="btn" onClick={() => setNovo({ nome: termo, telefone: '' })}>Novo</button>
      </div>
      <div className="cartao plano">
        {(lista.dados || []).map((c) => (
          <button type="button" key={c.id} className="item" onClick={() => aoEscolher(c)}>
            <div className="cresce">
              <div className="forte corta">{c.nome}</div>
              <div className="muted peq">{c.telefone || 'sem telefone'}</div>
            </div>
            {c.saldo_fiado_centavos > 0 && <span className="selo alerta">deve {formatarCentavos(c.saldo_fiado_centavos)}</span>}
          </button>
        ))}
        {lista.dados?.length === 0 && <div className="vazio">Nenhum cliente encontrado.</div>}
      </div>
    </Modal>
  );
}
