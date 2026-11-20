import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Ferramentas do suporte (aba "Suporte" de Configurações, só o papel suporte):
// diagnóstico do grupo, forçar filas, conferir cadastros com o servidor,
// clonar do servidor e zerar a instalação. Ver electron/services/suporteService.js.

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

function Comparacao({ titulo, c }) {
  if (!c) return null;
  const igual = !c.faltandoAqui && !c.soAqui;
  return (
    <div className="suporte-conferencia-item">
      <span className="suporte-rotulo">{titulo}</span>
      <span>{c.aqui} aqui · {c.noGrupo} no grupo</span>
      {igual && <span className="suporte-ok">Iguais</span>}
      {c.faltandoAqui > 0 && (
        <span className="suporte-alerta">Faltam {c.faltandoAqui} aqui: {c.nomesFaltandoAqui.join(', ')}{c.faltandoAqui > c.nomesFaltandoAqui.length ? '...' : ''}</span>
      )}
      {c.soAqui > 0 && (
        <span className="suporte-alerta">Só aqui ({c.soAqui}): {c.nomesSoAqui.join(', ')}{c.soAqui > c.nomesSoAqui.length ? '...' : ''}</span>
      )}
    </div>
  );
}

function ResultadoPassos({ r }) {
  if (!r) return null;
  if (r.error && !r.passos) return <p className="modal-error">{r.error}</p>;
  return (
    <ul className="suporte-passos">
      {(r.passos || []).map((p) => (
        <li key={p.passo} className={p.ok ? 'suporte-ok' : 'suporte-alerta'}>
          {p.ok ? 'OK' : 'Falhou'} — {p.passo}{p.detalhe ? `: ${p.detalhe}` : ''}
        </li>
      ))}
      {r.pendencias && (
        <li>{r.pendencias.length ? `Ainda pendente: ${r.pendencias.map((p) => `${p.n} ${p.texto}`).join('; ')}` : 'Nada pendente.'}</li>
      )}
    </ul>
  );
}

export function FerramentasSuporte() {
  const [ocupado, setOcupado] = useState('');
  const [diag, setDiag] = useState(null);
  const [aviso, setAviso] = useState('');
  const [filas, setFilas] = useState(null);
  const [conf, setConf] = useState(null);
  const [pend, setPend] = useState([]);
  const [descartar, setDescartar] = useState(false);
  const [palavra, setPalavra] = useState('');
  const [erroRisco, setErroRisco] = useState('');

  async function rodar(nome, fn) {
    setOcupado(nome);
    try { return await fn(); } finally { setOcupado(''); }
  }

  async function carregarPendencias() {
    const r = await window.pdv.suporte.pendencias().catch(() => null);
    setPend(r?.pendencias || []);
  }

  async function rodarDiagnostico() {
    setAviso('');
    const r = await rodar('diag', () => window.pdv.suporte.diagnostico());
    if (r?.ok) setDiag(r); else setAviso(r?.error || 'Não deu para rodar o diagnóstico.');
    carregarPendencias();
  }

  useEffect(() => { rodarDiagnostico(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const papel = diag?.diagnostico?.grupo?.papel;
  const ehCaixa = papel === 'caixa';
  const servidorNome = diag?.diagnostico?.grupo?.redeLocal?.servidor || 'o servidor';

  async function copiar() {
    try { await navigator.clipboard.writeText(diag?.texto || ''); setAviso('Relatório copiado.'); } catch { setAviso('Não deu para copiar.'); }
  }
  async function salvar() {
    const r = await window.pdv.suporte.salvarRelatorio({ texto: diag?.texto || '' });
    if (r?.ok) setAviso(`Relatório salvo em ${r.caminho}.`);
  }

  async function forcar(tipo) {
    const r = await rodar(tipo, () => (tipo === 'envio' ? window.pdv.suporte.forcarEnvio() : window.pdv.suporte.forcarRecebimento()));
    setFilas(r);
    carregarPendencias();
  }

  async function conferir() {
    setConf(await rodar('conferir', () => window.pdv.suporte.conferir()));
  }

  async function executarRisco(tipo) {
    setErroRisco('');
    const esperado = tipo === 'clonar' ? 'CLONAR' : 'ZERAR';
    if (semAcento(palavra) !== esperado) return setErroRisco(`Digite ${esperado} para confirmar.`);
    const texto = tipo === 'clonar'
      ? `Clonar do servidor (${servidorNome})?\n\nOs dados deste caixa são apagados e ele fica com a configuração da loja e os cadastros do servidor. Grupo, rede local, impressoras e NFC-e deste PC continuam. O app reinicia.`
      : 'Zerar esta instalação?\n\nTodos os dados deste computador são apagados (vendas, caixa, cadastros, configurações). Ficam a licença, a identidade na Central e a numeração da NFC-e. O app reinicia com o usuário admin e PIN 0000.';
    if (!window.confirm(texto)) return;
    const r = await rodar(tipo, () => (tipo === 'clonar'
      ? window.pdv.suporte.clonar({ descartarPendencias: descartar })
      : window.pdv.suporte.zerar({ descartarPendencias: descartar })));
    if (!r?.ok) {
      if (r?.pendencias) setPend(r.pendencias);
      return setErroRisco(r?.error || 'Não foi possível.');
    }
    setErroRisco('');
    setAviso(`Feito. Cópia de segurança: ${r.backup}. O GerenciaAI vai reiniciar.`);
  }

  return (
    <>
      <section className="settings-section">
        <h2><Icon name="wrench" size={16} /> Diagnóstico do grupo</h2>
        <div className="suporte-botoes">
          <button type="button" className="btn-secondary" disabled={!!ocupado} onClick={rodarDiagnostico}>{ocupado === 'diag' ? 'Rodando...' : 'Rodar diagnóstico'}</button>
          <button type="button" className="btn-secondary" disabled={!diag} onClick={copiar}>Copiar relatório</button>
          <button type="button" className="btn-secondary" disabled={!diag} onClick={salvar}>Salvar relatório</button>
        </div>
        {aviso && <p className="io-message">{aviso}</p>}
        {diag?.texto && <pre className="suporte-relatorio">{diag.texto}</pre>}
      </section>

      <section className="settings-section">
        <h2><Icon name="refresh" size={16} /> Filas e cadastros</h2>
        <p className="screen-hint">Forçar envio manda agora o que está na fila (vendas, estoque, cadastros, fotos, contas de mesa). Puxar do grupo relê todos os cadastros. Conferir compara este computador com o grupo{ehCaixa ? ` (no ${servidorNome})` : ''}.</p>
        <div className="suporte-botoes">
          <button type="button" className="btn-secondary" disabled={!!ocupado || !papel || papel === 'fora de grupo'} onClick={() => forcar('envio')}>{ocupado === 'envio' ? 'Enviando...' : 'Forçar envio agora'}</button>
          <button type="button" className="btn-secondary" disabled={!!ocupado || !papel || papel === 'fora de grupo'} onClick={() => forcar('recebimento')}>{ocupado === 'recebimento' ? 'Puxando...' : 'Puxar tudo do grupo de novo'}</button>
          <button type="button" className="btn-secondary" disabled={!!ocupado || !papel || papel === 'fora de grupo'} onClick={conferir}>{ocupado === 'conferir' ? 'Conferindo...' : 'Conferir com o servidor'}</button>
        </div>
        <ResultadoPassos r={filas} />
        {conf && !conf.ok && <p className="modal-error">{conf.error}</p>}
        {conf?.ok && (
          <div className="suporte-conferencia">
            <Comparacao titulo="Produtos" c={conf.produtos} />
            <Comparacao titulo="Clientes" c={conf.clientes} />
            <Comparacao titulo="Usuários" c={conf.usuarios} />
          </div>
        )}
      </section>

      <section className="settings-section suporte-risco">
        <h2><Icon name="warning" size={16} /> Zona de risco</h2>
        {ehCaixa && (
          <p><strong>Clonar do servidor</strong> — zera este caixa e fica com a configuração da loja e os cadastros do {servidorNome}. Mantém grupo, rede local, impressoras e NFC-e deste PC.</p>
        )}
        <p><strong>Zerar instalação</strong> — apaga tudo e reabre como no primeiro uso. Mantém a licença, a identidade na Central e a numeração da NFC-e.{papel && papel !== 'fora de grupo' ? ' Se a Central mantiver esta máquina no grupo, ela volta ao grupo e recebe os cadastros dele.' : ''}</p>
        {pend.length > 0 && (
          <div className="modal-error" role="status">
            Pendências: {pend.map((p) => `${p.n} ${p.texto}`).join('; ')}. Use "Forçar envio" antes.
          </div>
        )}
        {pend.length > 0 && (
          <label className="suporte-descartar">
            <input type="checkbox" checked={descartar} onChange={(e) => setDescartar(e.target.checked)} />
            Descartar as pendências (ficam só na cópia de segurança)
          </label>
        )}
        <div className="suporte-botoes">
          <input type="text" value={palavra} onChange={(e) => setPalavra(e.target.value)} placeholder={ehCaixa ? 'Digite CLONAR ou ZERAR' : 'Digite ZERAR'} />
          {ehCaixa && (
            <button type="button" className="btn-secondary" disabled={!!ocupado} onClick={() => executarRisco('clonar')}>{ocupado === 'clonar' ? 'Clonando...' : 'Clonar do servidor'}</button>
          )}
          <button type="button" className="btn-danger" disabled={!!ocupado} onClick={() => executarRisco('zerar')}>{ocupado === 'zerar' ? 'Zerando...' : 'Zerar instalação'}</button>
        </div>
        {erroRisco && <p className="modal-error">{erroRisco}</p>}
        <p className="screen-hint">Antes de apagar, uma cópia do banco e das fotos vai para a pasta de backups (antes-de-zerar-...). O app reinicia sozinho.</p>
      </section>
    </>
  );
}
