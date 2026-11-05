import { useEffect, useRef, useState } from 'react';
import { icon } from '../../icons.js';

/** Ícone do conjunto do app (icons.js -- SVG fixo do próprio app, nunca dado de fora). */
export function Icone({ nome, tamanho = 18 }) {
  return <span className="pm-icone" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(nome, tamanho) }} />;
}

/** Folha que sobe de baixo (mesmo visual dos modais do resto do app). */
export function Folha({ titulo, aoFechar, children, fecharTocandoFora = true }) {
  useEffect(() => {
    const tecla = (e) => { if (e.key === 'Escape') aoFechar?.(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [aoFechar]);
  return (
    <div className="modal-fundo" onClick={(e) => { if (fecharTocandoFora && e.target === e.currentTarget) aoFechar?.(); }}>
      <div className="modal-caixa pm-folha" role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="pm-folha-topo">
          <h2>{titulo}</h2>
          {aoFechar && (
            <button type="button" className="btn-icone" aria-label="Fechar" onClick={aoFechar}><Icone nome="fechar" /></button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Pede um texto (nome da pessoa, observação, motivo). */
export function PedirTexto({ titulo, rotulo, inicial = '', max = 40, placeholder = '', textoBotao = 'Salvar', multilinha = false, permitirVazio = true, aoConfirmar, aoFechar }) {
  const [valor, setValor] = useState(inicial || '');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const enviar = (e) => {
    e.preventDefault();
    const limpo = valor.replace(/\s+/g, ' ').trim();
    if (!permitirVazio && !limpo) return;
    aoConfirmar(limpo);
  };
  return (
    <Folha titulo={titulo} aoFechar={aoFechar}>
      <form onSubmit={enviar} className="pm-form">
        <label className="pm-rotulo" htmlFor="pm-texto">{rotulo}</label>
        {multilinha ? (
          <textarea id="pm-texto" ref={ref} className="campo" rows={3} maxLength={max} placeholder={placeholder}
            value={valor} onChange={(e) => setValor(e.target.value)} />
        ) : (
          <input id="pm-texto" ref={ref} className="campo" maxLength={max} placeholder={placeholder} autoComplete="off"
            value={valor} onChange={(e) => setValor(e.target.value)} />
        )}
        <button type="submit" className="btn-primario" disabled={!permitirVazio && !valor.trim()}>{textoBotao}</button>
      </form>
    </Folha>
  );
}

/** Escolher gerente e digitar o PIN dele (o PIN vai cifrado para o computador). */
export function PedirAutorizacao({ autorizadores, motivoTexto, aoConfirmar, aoFechar }) {
  const [quem, setQuem] = useState(autorizadores?.[0]?.id || '');
  const [pin, setPin] = useState('');
  const [motivo, setMotivo] = useState('');
  const valido = quem && /^\d{4,8}$/.test(pin);
  return (
    <Folha titulo="Autorização do gerente" aoFechar={aoFechar}>
      <form className="pm-form" onSubmit={(e) => { e.preventDefault(); if (valido) aoConfirmar({ autorizadorId: quem, pin, motivo: motivo.trim() }); }}>
        <p className="subtexto">{motivoTexto}</p>
        {(!autorizadores || autorizadores.length === 0) ? (
          <p className="msg-erro">Nenhum gerente cadastrado para autorizar. Faça pelo computador.</p>
        ) : (
          <>
            <label className="pm-rotulo" htmlFor="pm-quem">Quem autoriza</label>
            <select id="pm-quem" className="campo" value={quem} onChange={(e) => setQuem(e.target.value)}>
              {autorizadores.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
            </select>
            <label className="pm-rotulo" htmlFor="pm-pin">PIN</label>
            <input id="pm-pin" className="campo campo-grande" type="password" inputMode="numeric" autoComplete="off" maxLength={8}
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            <label className="pm-rotulo" htmlFor="pm-motivo">Motivo (opcional)</label>
            <input id="pm-motivo" className="campo" maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <button type="submit" className="btn-primario" disabled={!valido}>Autorizar</button>
          </>
        )}
      </form>
    </Folha>
  );
}

/** Lista de opções numa folha (menu "⋯", escolher pessoa, mesa...). */
export function Opcoes({ titulo, opcoes, aoFechar }) {
  return (
    <Folha titulo={titulo} aoFechar={aoFechar}>
      <div className="pm-opcoes">
        {opcoes.filter(Boolean).map((o) => (
          <button key={o.chave || o.rotulo} type="button" className={`pm-opcao${o.perigo ? ' pm-opcao-perigo' : ''}${o.ativa ? ' pm-opcao-ativa' : ''}`}
            disabled={o.desabilitada} onClick={o.aoEscolher}>
            <span>{o.rotulo}</span>
            {o.detalhe && <span className="pm-opcao-detalhe">{o.detalhe}</span>}
          </button>
        ))}
      </div>
    </Folha>
  );
}

/** Contador +/- (pessoas da mesa, quantidade). */
export function Contador({ valor, min = 1, max = 99, aoMudar, rotulo }) {
  return (
    <div className="pm-contador" role="group" aria-label={rotulo}>
      <button type="button" className="btn-icone pm-contador-btn" aria-label="Menos" disabled={valor <= min} onClick={() => aoMudar(Math.max(min, valor - 1))}>−</button>
      <span className="pm-contador-valor" aria-live="polite">{valor}</span>
      <button type="button" className="btn-icone pm-contador-btn" aria-label="Mais" disabled={valor >= max} onClick={() => aoMudar(Math.min(max, valor + 1))}>+</button>
    </div>
  );
}

export function Selo({ tom = 'neutro', children }) {
  return <span className={`pm-selo pm-selo-${tom}`}>{children}</span>;
}
