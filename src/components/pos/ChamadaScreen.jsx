import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

// Senhas do balcão e do site (ver electron/services/chamadaService.js).
// Chamar = aparece no painel (TV / Vértice), toca o aviso e fala o número;
// Entregue = sai do painel. Pedido da Separação acompanha (e vice-versa).

const ORIGEM = { balcao: 'Balcão', pedido: 'Site / Separação', manual: 'Manual' };

function minutosDesde(utc) {
  if (!utc) return null;
  const t = Date.parse(`${String(utc).replace(' ', 'T')}${String(utc).endsWith('Z') ? '' : 'Z'}`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function NovaSenhaModal({ onClose, onCriada }) {
  useEscToClose(onClose);
  const [nome, setNome] = useState('');
  const [erro, setErro] = useState('');
  async function criar(e) {
    e.preventDefault();
    const r = await window.pdv.chamada.criarManual({ nome });
    if (!r?.ok) { setErro(r?.error || 'Não consegui gerar a senha.'); return; }
    onCriada(r.chamada);
    onClose();
  }
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal-card" style={{ width: 'min(380px, 94vw)' }} onSubmit={criar}>
        <h2>Nova senha</h2>
        <p className="screen-hint" style={{ margin: 0 }}>Para um pedido feito no balcão sem passar pelo caixa (ex.: comanda de papel).</p>
        <label>Nome do cliente (opcional)<input value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} autoFocus /></label>
        {erro && <p className="modal-error">{erro}</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primary"><Icon name="add" size={15} /> Gerar senha</button>
        </div>
      </form>
    </div>
  );
}

export function ChamadaScreen() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [novaAberta, setNovaAberta] = useState(false);
  const [ocupado, setOcupado] = useState(null);
  const [aviso, setAviso] = useState('');

  async function carregar() {
    const r = await window.pdv.chamada.listar();
    if (r && r.ok === false) { setErro(r.error); return; }
    setDados(r);
  }

  useEffect(() => {
    carregar();
    const id = setInterval(carregar, 5000);
    const parar = window.pdv.chamada.onMudou?.(() => carregar()) || (() => {});
    return () => { clearInterval(id); parar(); };
  }, []);

  async function acao(fn, id, texto) {
    setErro('');
    setOcupado(id);
    const r = await fn({ id });
    setOcupado(null);
    if (!r?.ok) { setErro(r?.error || 'Não consegui atualizar a senha.'); return; }
    if (texto) { setAviso(texto); setTimeout(() => setAviso(''), 3000); }
    carregar();
  }

  const linha = (c, botoes) => {
    const min = minutosDesde(c.status === 'pronto' ? c.chamadoEm : c.criadoEm);
    return (
      <li key={c.id} className="senha-linha">
        <span className="senha-numero">{c.numero}</span>
        <span className="senha-info">
          <strong>{c.nome || 'Sem nome'}</strong>
          <span className="screen-hint">
            {ORIGEM[c.origem] || c.origem}
            {min != null && ` · ${c.status === 'pronto' ? 'chamada' : 'há'} ${min === 0 ? 'agora' : `${c.status === 'pronto' ? 'há ' : ''}${min} min`}`}
            {c.status === 'pronto' && c.vezesChamada > 1 && ` · ${c.vezesChamada}x`}
          </span>
        </span>
        <span className="senha-botoes">{botoes}</span>
      </li>
    );
  };

  return (
    <div className="screen">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1>Senhas</h1>
          <p className="screen-hint" style={{ margin: '-6px 0 14px' }}>
            Chamar = aparece no painel da TV e toca o aviso. Entregue = sai do painel. O link do painel fica em Configurações → Senhas.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setNovaAberta(true)}><Icon name="add" size={15} /> Nova senha</button>
      </div>

      {erro && <p className="modal-error">{erro}</p>}
      {aviso && <p className="io-message">{aviso}</p>}
      {!dados && !erro && <p className="empty-state">Carregando...</p>}
      {dados && (
        <div className="senhas-colunas">
          <section className="senhas-card">
            <h2>Preparando ({dados.preparando.length})</h2>
            {dados.preparando.length === 0
              ? <p className="empty-state">Nenhuma senha em preparo.</p>
              : <ul>{dados.preparando.map((c) => linha(c, (
                <>
                  <button className="btn-primary" disabled={ocupado === c.id} onClick={() => acao(window.pdv.chamada.chamar, c.id, `Senha ${c.numero} chamada no painel.`)}>Chamar</button>
                  <button className="btn-link-danger" title="Cancelar senha" onClick={() => { if (confirm(`Cancelar a senha ${c.numero}?`)) acao(window.pdv.chamada.cancelar, c.id); }}><Icon name="close" size={14} /></button>
                </>
              )))}</ul>}
          </section>
          <section className="senhas-card">
            <h2>Chamadas ({dados.prontas.length})</h2>
            {dados.prontas.length === 0
              ? <p className="empty-state">Nenhuma senha chamada agora.</p>
              : <ul>{dados.prontas.map((c) => linha(c, (
                <>
                  <button className="btn-secondary" disabled={ocupado === c.id} onClick={() => acao(window.pdv.chamada.chamar, c.id, `Senha ${c.numero} chamada de novo.`)}>De novo</button>
                  <button className="btn-primary" disabled={ocupado === c.id} onClick={() => acao(window.pdv.chamada.entregar, c.id)}>Entregue</button>
                  <button className="btn-link" title="Chamou por engano: volta para o preparo" onClick={() => acao(window.pdv.chamada.voltarParaPreparo, c.id)}><Icon name="undo" size={14} /></button>
                </>
              )))}</ul>}
          </section>
        </div>
      )}
      {dados && dados.entregues.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="screen-hint">Entregues hoje ({dados.entregues.length})</summary>
          <p className="screen-hint">{dados.entregues.map((c) => `${c.numero}${c.nome ? ` ${c.nome}` : ''}`).join(' · ')}</p>
        </details>
      )}
      {novaAberta && <NovaSenhaModal onClose={() => setNovaAberta(false)} onCriada={(c) => { setAviso(`Senha ${c.numero} gerada.`); carregar(); }} />}
    </div>
  );
}
