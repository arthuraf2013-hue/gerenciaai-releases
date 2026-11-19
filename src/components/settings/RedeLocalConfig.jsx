import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Rede local da loja (electron/services/grupoTransporteService.js): os
// caixas do grupo sincronizam direto com o computador servidor, sem gastar
// internet nem cota da nuvem, e continuam juntos com a internet fora.
// Servidor: gera o código e vê os caixas ligados. Caixa: digita o código.

const dataHora = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${String(s).endsWith('Z') ? '' : 'Z'}`)
  .toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ainda não');

function minutosRestantes(iso) {
  const m = Math.ceil((new Date(iso).getTime() - Date.now()) / 60000);
  return m > 0 ? m : 0;
}

export function RedeLocalConfig({ podeMexer }) {
  const [st, setSt] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const [ocupado, setOcupado] = useState('');
  const [codigo, setCodigo] = useState('');
  const [endereco, setEndereco] = useState('');

  async function carregar() {
    const r = await window.pdv.redeLocal.status();
    if (r && r.ok !== false) setSt(r);
  }
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 5000);
    return () => clearInterval(t);
  }, []);

  async function executar(nome, fn, sucesso) {
    setOcupado(nome); setMensagem(null);
    const r = await fn();
    setOcupado('');
    if (r?.ok === false) setMensagem({ tipo: 'erro', texto: r.error || 'Não deu certo.' });
    else if (sucesso) setMensagem({ tipo: 'ok', texto: typeof sucesso === 'function' ? sucesso(r) : sucesso });
    await carregar();
    return r;
  }

  if (!st || !st.grupo) return null;

  if (st.servidor) {
    const hub = st.hub || { caixas: [], enderecos: [] };
    const caixas = hub.caixas || [];
    const ligado = st.modo === 'hub';
    return (
      <div className="rede-local">
        <h3><Icon name="plug" size={15} /> Rede local da loja</h3>
        <div className={`rede-local-estado ${ligado ? 'ok' : ''}`}>
          <span className="rede-local-ponto" />
          <span>{ligado
            ? <>Ligada: <strong>{caixas.length} {caixas.length === 1 ? 'caixa conectado' : 'caixas conectados'}</strong> a este computador.</>
            : caixas.length
              ? <>Preparando a cópia do grupo neste computador (precisa de internet uma vez)…</>
              : <>Nenhum caixa ligado. Os caixas usam a internet para sincronizar.</>}</span>
        </div>
        <p className="screen-hint">
          Com a rede local, os caixas da loja sincronizam direto com este computador: não gastam internet,
          continuam juntos se a internet cair, e a nuvem recebe tudo daqui.
          {st.espelho?.faltaSubir ? ` Falta subir para a nuvem: ${st.espelho.faltaSubir}.` : ''}
        </p>
        {hub.enderecos?.length > 0 && (
          <p className="rede-local-endereco">Endereço na rede: <code>{hub.enderecos.join('  ·  ')}</code></p>
        )}

        {hub.codigo ? (
          <div className="rede-local-codigo">
            <div className="rede-local-codigo-valor">{hub.codigo.codigo}</div>
            <div>
              <strong>Digite este código no caixa</strong> (Configurações → Sincronização → Rede local da loja).
              Vale por {minutosRestantes(hub.codigo.expiraEm)} min e liga um caixa só.
            </div>
            {podeMexer && (
              <button type="button" className="btn-link" disabled={!!ocupado}
                onClick={() => executar('cancelar', () => window.pdv.redeLocal.cancelarCodigo())}>Cancelar</button>
            )}
          </div>
        ) : podeMexer && (
          <button type="button" className="btn-primary" disabled={!!ocupado}
            onClick={() => executar('codigo', () => window.pdv.redeLocal.gerarCodigo())}>
            <Icon name="link" size={15} /> {ocupado === 'codigo' ? 'Abrindo a rede local…' : 'Ligar um caixa'}
          </button>
        )}

        {caixas.length > 0 && (
          <table className="data-table rede-local-tabela">
            <thead><tr><th>Caixa</th><th>Último contato</th>{podeMexer && <th />}</tr></thead>
            <tbody>
              {caixas.map((c) => (
                <tr key={c.install_id}>
                  <td>{c.nome || c.install_id.slice(0, 8)}</td>
                  <td>{dataHora(c.ultimo_contato)}</td>
                  {podeMexer && (
                    <td className="rede-local-acoes">
                      <button type="button" className="btn-link" disabled={!!ocupado}
                        onClick={() => window.confirm(`Desligar ${c.nome || 'este caixa'} da rede local? Ele volta a sincronizar pela internet.`)
                          && executar('remover', () => window.pdv.redeLocal.removerCaixa({ installId: c.install_id }), 'Caixa desligado da rede local.')}>
                        Desligar
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {st.ultimoErro && <p className="modal-error">{st.ultimoErro}</p>}
        <p className="screen-hint rede-local-dica">
          Se o caixa não achar este computador: na primeira vez o Windows pergunta se o GerenciaAI pode usar a rede —
          responda <strong>Permitir</strong> (rede privada).
        </p>
        {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
      </div>
    );
  }

  // Caixa
  const cli = st.cliente;
  const conectado = st.modo === 'lan';
  return (
    <div className="rede-local">
      <h3><Icon name="plug" size={15} /> Rede local da loja</h3>
      <div className={`rede-local-estado ${conectado ? 'ok' : ''}`}>
        <span className="rede-local-ponto" />
        <span>{conectado
          ? <>Conectado ao servidor <strong>{cli?.servidor}</strong> pela rede da loja.</>
          : cli
            ? <>Servidor <strong>{cli.servidor}</strong> não encontrado na rede agora — sincronizando pela internet.</>
            : <>Não ligado ao servidor da loja — sincronizando pela internet.</>}</span>
      </div>
      {!cli && podeMexer && (
        <form className="rede-local-form" onSubmit={(e) => {
          e.preventDefault();
          executar('parear', () => window.pdv.redeLocal.parear({ codigo, endereco }), (r) => `Ligado ao servidor ${r.servidor}.`)
            .then((r) => { if (r?.ok) { setCodigo(''); setEndereco(''); } });
        }}>
          <label>
            Código que aparece no servidor
            <input value={codigo} onChange={(e) => setCodigo(e.target.value.toUpperCase())} placeholder="ABCD-EF23" maxLength={9}
              autoComplete="off" spellCheck={false} required />
          </label>
          <label>
            Endereço do servidor <span className="rede-local-opcional">(só se não achar sozinho)</span>
            <input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="192.168.0.10:47820" autoComplete="off" />
          </label>
          <button type="submit" className="btn-primary" disabled={!!ocupado || codigo.replace(/[^A-Za-z0-9]/g, '').length !== 8}>
            <Icon name="link" size={15} /> {ocupado === 'parear' ? 'Procurando o servidor…' : 'Ligar a este servidor'}
          </button>
        </form>
      )}
      {cli && podeMexer && (
        <button type="button" className="btn-secondary" disabled={!!ocupado}
          onClick={() => window.confirm('Desligar este caixa da rede local? Ele volta a sincronizar só pela internet.')
            && executar('desligar', () => window.pdv.redeLocal.desligar(), 'Desligado da rede local.')}>
          Desligar da rede local
        </button>
      )}
      {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
    </div>
  );
}
