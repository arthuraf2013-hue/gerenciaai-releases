import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Servidor do grupo (electron/services/servidorDoGrupoService.js): lista os
// computadores do grupo e deixa admin/suporte escolher qual é o servidor --
// onde ficam as mesas e o estoque e de onde os outros leem e gravam. A troca
// pede a conta da Central (regra do Firebase); ela não fica salva aqui.

const quando = (iso) => {
  if (!iso) return 'sem contato';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'agora';
  if (min < 60) return `há ${min} min`;
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export function ServidorDoGrupo({ hubIdLigado }) {
  const [lista, setLista] = useState(null);
  const [escolhido, setEscolhido] = useState(null);
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [mensagem, setMensagem] = useState(null);

  async function carregar() {
    setLista(await window.pdv.redeLocal.maquinasDoGrupo().catch((e) => ({ ok: false, error: e?.message })));
  }
  useEffect(() => { carregar(); }, []);

  async function confirmar(e) {
    e.preventDefault();
    setOcupado(true); setMensagem(null);
    const r = await window.pdv.redeLocal.escolherServidor({ instalacaoId: escolhido.id, email, senha }).catch((err) => ({ ok: false, error: err?.message }));
    setOcupado(false);
    setSenha('');
    if (!r?.ok) return setMensagem({ tipo: 'erro', texto: r?.error || 'Não deu certo.' });
    setEscolhido(null);
    setMensagem({ tipo: 'ok', texto: `${r.servidor} agora é o servidor do grupo. Em cada caixa, ligue de novo na rede local com o código que aparece no novo servidor.` });
    setTimeout(carregar, 3000);
  }

  if (!lista) return null;
  if (!lista.ok) return <p className="screen-hint">{lista.error}</p>;
  const servidor = lista.maquinas.find((m) => m.servidor);
  const eu = lista.maquinas.find((m) => m.estaMaquina);
  const ligadoAoAntigo = eu && !eu.servidor && hubIdLigado && servidor && hubIdLigado !== servidor.id;

  return (
    <div className="servidor-grupo">
      <h3><Icon name="link" size={15} /> Servidor do grupo</h3>
      <p className="screen-hint">O servidor guarda as mesas e o estoque. Os outros computadores leem e gravam nele pela rede local.</p>
      {!servidor && <p className="modal-error">Nenhum computador está marcado como servidor do grupo. Escolha um abaixo.</p>}
      {ligadoAoAntigo && (
        <p className="modal-error">Este caixa está ligado ao servidor antigo. Desligue da rede local abaixo e ligue de novo com o código que aparece no {servidor.nome}.</p>
      )}
      <table className="servidor-grupo-tabela">
        <thead><tr><th>Computador</th><th>Versão</th><th>Último contato</th><th /></tr></thead>
        <tbody>
          {lista.maquinas.map((m) => (
            <tr key={m.id}>
              <td>
                <strong>{m.nome}</strong>
                {m.servidor && <span className="servidor-grupo-selo">servidor</span>}
                {m.estaMaquina && <span className="servidor-grupo-eu"> (este computador)</span>}
              </td>
              <td>{m.versao || '-'}</td>
              <td>{quando(m.ultimoContato)}</td>
              <td className="servidor-grupo-acao">
                {!m.servidor && (
                  <button type="button" className="btn-secondary" disabled={ocupado} onClick={() => { setEscolhido(m); setMensagem(null); }}>Tornar servidor</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {escolhido && (
        <form className="servidor-grupo-confirmar" onSubmit={confirmar}>
          <p>
            Tornar <strong>{escolhido.nome}</strong> o servidor?{servidor ? ` O ${servidor.nome} deixa de ser.` : ''} Os caixas precisam ser ligados de novo ao novo servidor (código da rede local).
          </p>
          <div className="servidor-grupo-campos">
            <input type="email" placeholder="E-mail da Central" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
            <input type="password" placeholder="Senha da Central" value={senha} onChange={(e) => setSenha(e.target.value)} required autoComplete="off" />
            <button type="submit" className="btn-primary" disabled={ocupado}>{ocupado ? 'Trocando...' : 'Confirmar'}</button>
            <button type="button" className="btn-link" disabled={ocupado} onClick={() => setEscolhido(null)}>Cancelar</button>
          </div>
          <p className="screen-hint">A conta da Central é usada só nesta troca e não fica salva neste computador.</p>
        </form>
      )}
      {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
    </div>
  );
}
