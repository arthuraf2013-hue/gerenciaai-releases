import { useCallback, useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Celulares PDV mobile que foram migrados para este computador e, na
// Central, viraram TERMINAIS daqui: vendem offline e mandam as vendas pra
// cá. Ver electron/services/pdvMobileTerminalService.js.

const TIPO = { venda: 'Venda', venda_cancelada: 'Cancelamento', fiado_pagamento: 'Fiado recebido', cliente: 'Cliente', estoque: 'Estoque' };
const dataHora = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`).toLocaleString('pt-BR') : '—');
const dinheiro = (v) => (v == null ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

function situacao(t) {
  if (t.ativo && t.modo === 'terminal') return { texto: 'Terminal ativo', cor: 'var(--color-primary)' };
  if (t.ativo) return { texto: 'Voltou a autônomo (recebendo o que ficou)', cor: 'var(--color-text-muted)' };
  return { texto: 'Não é terminal', cor: 'var(--color-text-muted)' };
}

export function TerminaisPdvMobile({ podeConfigurar }) {
  const [terminais, setTerminais] = useState(null);
  const [problemas, setProblemas] = useState([]);
  const [config, setConfig] = useState(null);
  const [janela, setJanela] = useState('10');
  const [mensagem, setMensagem] = useState(null);
  const [ocupado, setOcupado] = useState(null);

  const carregar = useCallback(async () => {
    const [l, e, c] = await Promise.all([
      window.pdv.pdvTerminal.listar(),
      window.pdv.pdvTerminal.eventos({ soProblemas: true, limit: 30 }),
      window.pdv.pdvTerminal.getConfig(),
    ]);
    if (l?.ok) setTerminais(l.terminais);
    if (e?.ok) setProblemas(e.eventos);
    if (c?.ok) { setConfig(c.config); setJanela(String(c.config.janelaNfceMin)); }
  }, []);

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 15000);
    return () => clearInterval(t);
  }, [carregar]);

  const tentarDeNovo = async (ev) => {
    setOcupado(ev.evento_id); setMensagem(null);
    const r = await window.pdv.pdvTerminal.reprocessar({ eventoId: ev.evento_id });
    setOcupado(null);
    setMensagem(r?.ok ? { ok: true, texto: 'Aplicado.' } : { ok: false, texto: r?.error || 'Não deu certo.' });
    carregar();
  };

  const salvar = async (novo) => {
    setMensagem(null);
    const r = await window.pdv.pdvTerminal.salvarConfig(novo);
    if (r?.ok) { setConfig(r.config); setMensagem({ ok: true, texto: 'Configuração salva.' }); } else setMensagem({ ok: false, texto: r?.error || 'Não consegui salvar.' });
  };

  // Só aparece pra quem tem celular migrado pra cá -- senão não há o que mostrar.
  if (!terminais || terminais.length === 0) return null;

  return (
    <section className="settings-section">
      <h2><Icon name="mobile" size={16} /> Celulares terminais deste computador</h2>
      <p className="screen-hint">
        Um celular migrado para cá pode virar <strong>terminal</strong> deste computador (na Central, "Usar como terminal").
        Ele continua vendendo, mesmo sem internet, no caixa dele; as vendas, cancelamentos, fiado recebido e clientes chegam
        aqui quando houver conexão — com o GerenciaAI aberto. Produtos, preços e estoque passam a ser cuidados aqui e vão
        para o celular sozinhos. As vendas do celular entram nos relatórios, mas <strong>não</strong> no fechamento do caixa
        deste computador (o dinheiro está no caixa do celular).
      </p>

      <table className="data-table">
        <thead><tr><th>Celular</th><th>Situação</th><th style={{ textAlign: 'right' }}>Recebidos</th><th>Pendências</th><th>Última venda recebida</th></tr></thead>
        <tbody>
          {terminais.map((t) => {
            const s = situacao(t);
            return (
              <tr key={t.installId}>
                <td><strong>{t.nomeAtual || 'PDV mobile'}</strong><div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t.installId.slice(0, 8)}</div></td>
                <td style={{ color: s.cor }}>{s.texto}{t.ativo && t.pendentesNoCelular > 0 ? ` · ${t.pendentesNoCelular} ainda no celular` : ''}</td>
                <td style={{ textAlign: 'right' }}>{t.aplicados}</td>
                <td>
                  {t.erros === 0 && t.aguardando === 0 ? <span style={{ color: 'var(--color-primary)' }}><Icon name="check" size={14} /> nenhuma</span> : (
                    <span style={{ color: 'var(--color-danger)' }}>
                      {t.erros > 0 && `${t.erros} recusado(s)`}{t.erros > 0 && t.aguardando > 0 && ' · '}{t.aguardando > 0 && `${t.aguardando} aguardando`}
                    </span>
                  )}
                  {t.ultimoErroRede && <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>Rede: {t.ultimoErroRede}</div>}
                </td>
                <td>{dataHora(t.ultimoAplicadoEm)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {problemas.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, margin: '16px 0 6px' }}>O que não entrou</h3>
          <table className="data-table">
            <thead><tr><th>Quando</th><th>Tipo</th><th>Motivo</th><th /></tr></thead>
            <tbody>
              {problemas.map((p) => (
                <tr key={p.evento_id}>
                  <td>{new Date(p.criado_em_ms).toLocaleString('pt-BR')}</td>
                  <td>{TIPO[p.tipo] || p.tipo}{p.numero_celular ? ` ${p.numero_celular}` : ''}{p.total_venda != null ? ` · ${dinheiro(p.total_venda)}` : ''}</td>
                  <td>
                    {p.status === 'aguardando' ? 'Aguardando outro registro chegar: ' : ''}{p.erro}
                    {p.nfce_status && ['erro', 'rejeitada'].includes(p.nfce_status) && <div style={{ color: 'var(--color-danger)' }}>NFC-e: {p.nfce_mensagem || p.nfce_status}</div>}
                  </td>
                  <td>{p.status === 'erro' && <button className="btn-secondary" style={{ whiteSpace: 'nowrap' }} onClick={() => tentarDeNovo(p)} disabled={ocupado === p.evento_id}><Icon name="refresh" size={14} /> {ocupado === p.evento_id ? 'Aplicando...' : 'Tentar de novo'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {config && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>NFC-e das vendas do celular</h3>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={config.emitirNfce} disabled={!podeConfigurar} onChange={(e) => salvar({ emitirNfce: e.target.checked, janelaNfceMin: Number(janela) })} />
            Emitir NFC-e automaticamente quando a venda chegar do celular
          </label>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            Só se chegar em até
            <input type="number" min="1" max="1440" value={janela} disabled={!podeConfigurar} onChange={(e) => setJanela(e.target.value)} style={{ width: 80 }} />
            minutos depois da venda
            <button className="btn-secondary" style={{ marginLeft: 4 }} disabled={!podeConfigurar || Number(janela) === config.janelaNfceMin} onClick={() => salvar({ emitirNfce: config.emitirNfce, janelaNfceMin: Number(janela) })}>Salvar</button>
          </label>
          <p className="io-message-aviso" style={{ marginTop: 8, alignItems: 'flex-start' }}>
            <Icon name="warning" size={15} />
            <span>
              A nota é emitida <strong>quando a venda chega aqui</strong>, com a data e hora desse momento
              (a SEFAZ não aceita nota com horário atrasado). Venda feita offline e que chega depois da janela fica sem nota automática —
              dá pra emitir em Vendas. Confirme com seu contador se esse procedimento atende o seu caso. Usa a configuração fiscal deste computador.
            </span>
          </p>
        </div>
      )}
      {mensagem && <p className={mensagem.ok ? 'io-message' : 'io-message-aviso'} style={{ marginTop: 8 }}>{mensagem.texto}</p>}
    </section>
  );
}
