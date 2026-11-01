import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';
import { brl, hojeLocal, somarDias } from './erpUtils';
import { Termo } from './Glossario';

/**
 * Caixa (ERP, terceira leva): abertura, sangria, suprimento e fechamento
 * com conferência por forma de pagamento. Usa o mesmo caixa do PDV (uma
 * sessão aberta por loja); nada aqui bloqueia a venda.
 */

const METODO = { dinheiro: 'Dinheiro', pix: 'Pix', cartao_debito: 'Cartão de débito', cartao_credito: 'Cartão de crédito', fiado: 'Fiado', outro: 'Outro' };
const CONFERIDOS = ['pix', 'cartao_debito', 'cartao_credito', 'outro'];
const num = (v) => Number(String(v ?? '').replace(',', '.'));
const horaBR = (utc) => (utc ? new Date(`${String(utc).replace(' ', 'T')}Z`).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export function CaixaScreen() {
  const { currentUser } = useSession();
  const loc = window.APP_LOCATION_ID;
  const [c, setC] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [abertura, setAbertura] = useState('');
  const [mov, setMov] = useState(null); // { tipo, valor, motivo }
  const [fechando, setFechando] = useState(null); // { dinheiro, pix, ... }
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');
  useEscToClose(() => { setMov(null); setFechando(null); }, !!mov || !!fechando);

  const carregar = () => {
    window.pdv.cash.caixaAtual({ locationId: loc }).then(setC);
    const hoje = hojeLocal();
    window.pdv.cash.listClosedSessions({ locationId: loc, dataInicio: somarDias(hoje, -30), dataFim: hoje }).then((l) => setHistorico(Array.isArray(l) ? l : []));
  };
  useEffect(() => { carregar(); }, []);

  async function abrir(e) {
    e.preventDefault();
    const r = await window.pdv.cash.open({ locationId: loc, operadorId: currentUser.id, valorAbertura: num(abertura) || 0 });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setAbertura(''); setResultado(null); carregar();
  }
  async function registrar(e) {
    e.preventDefault();
    const r = await window.pdv.cash.movimento({ sessionId: c.session.id, tipo: mov.tipo, valor: num(mov.valor), motivo: mov.motivo });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setMov(null); carregar();
  }
  async function fechar(e) {
    e.preventDefault();
    const conferencia = {};
    for (const m of CONFERIDOS) if (fechando[m] !== undefined && fechando[m] !== '') conferencia[m] = num(fechando[m]);
    const r = await window.pdv.cash.close({ sessionId: c.session.id, operadorId: currentUser.id, valorInformado: num(fechando.dinheiro), conferencia });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setFechando(null); setResultado(r); carregar();
  }

  if (!c) return <div className="screen"><p className="empty-state">Carregando...</p></div>;
  if (c.ok === false) return <div className="screen"><p className="modal-error">{c.error}</p></div>;
  const totalMetodo = (m) => c.porMetodo?.find((x) => x.metodo === m)?.total || 0;

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="cash" size={20} /> Caixa</h1>
        {c.aberto && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={() => { setErro(''); setMov({ tipo: 'suprimento', valor: '', motivo: '' }); }}><Icon name="add" size={15} /> Suprimento</button>
            <button className="btn-secondary" onClick={() => { setErro(''); setMov({ tipo: 'sangria', valor: '', motivo: '' }); }}><Icon name="export" size={15} /> Sangria</button>
            <button className="btn-primary" onClick={() => { setErro(''); setFechando({ dinheiro: '' }); }}><Icon name="lock" size={15} /> Fechar caixa</button>
          </div>
        )}
      </div>
      <p className="screen-hint">
        <Termo t="Sangria" /> é dinheiro tirado da gaveta (depósito, pagamento em espécie); <Termo t="Suprimento" /> é troco colocado.
        Os dois ficam registrados e entram na conta do que deveria ter na gaveta. No fechamento, conte o dinheiro e confira os comprovantes da maquininha e do Pix.
      </p>
      {erro && !mov && !fechando && <p className="modal-error" style={{ marginBottom: 10 }}>{erro}</p>}

      {resultado && (
        <section className="settings-section">
          <h2><Icon name="checkCircle" size={16} /> Caixa fechado</h2>
          <table className="data-table"><tbody>
            <tr><td>Dinheiro</td><td style={{ textAlign: 'right' }}>esperado {brl(resultado.valorEsperado)}</td><td style={{ textAlign: 'right' }}><Diferenca valor={resultado.diferenca} /></td></tr>
            {(resultado.diferencasPorMetodo || []).map((d) => (
              <tr key={d.metodo}><td>{METODO[d.metodo]}</td><td style={{ textAlign: 'right' }}>esperado {brl(d.esperado)}</td><td style={{ textAlign: 'right' }}>{d.informado === null ? 'não conferido' : <Diferenca valor={d.diferenca} />}</td></tr>
            ))}
          </tbody></table>
        </section>
      )}

      {!c.aberto ? (
        <form onSubmit={abrir} className="settings-section" style={{ maxWidth: 480 }}>
          <h2><Icon name="lock" size={16} /> Abrir caixa</h2>
          <p className="screen-hint">Informe o troco que está na gaveta agora.</p>
          <label>Valor de abertura (R$)<input type="number" step="0.01" min="0" value={abertura} onChange={(e) => setAbertura(e.target.value)} placeholder="0,00" autoFocus /></label>
          <div className="settings-actions"><button className="btn-primary" type="submit"><Icon name="lock" size={15} /> Abrir caixa</button></div>
        </form>
      ) : (
        <>
          <p className="screen-hint" style={{ marginTop: 0 }}>Aberto por {c.operadorAberturaNome || '—'} em {horaBR(c.session.aberta_em)}.</p>
          <div className="dashboard-stats">
            <div className="stat-card"><span>Abertura</span><strong>{brl(c.valorAbertura)}</strong></div>
            <div className="stat-card"><span>Vendas em dinheiro</span><strong>{brl(c.totalVendasDinheiro)}</strong></div>
            <div className="stat-card"><span>Suprimentos</span><strong>{brl(c.totalSuprimentos)}</strong></div>
            <div className="stat-card"><span>Sangrias</span><strong>{brl(c.totalSangrias)}</strong></div>
            {c.totalDevolvidoEmDinheiro > 0 && <div className="stat-card"><span>Devolvido em dinheiro</span><strong>{brl(c.totalDevolvidoEmDinheiro)}</strong></div>}
            <div className="stat-card"><span>Deve ter na gaveta</span><strong>{brl(c.valorEsperado)}</strong></div>
          </div>
          <div className="erp-duas-colunas">
            <section className="settings-section">
              <h2><Icon name="card" size={16} /> Vendas por forma de pagamento</h2>
              {c.porMetodo.length === 0 ? <p className="empty-state">Nenhuma venda desde a abertura.</p> : (
                <table className="data-table"><tbody>
                  {c.porMetodo.map((m) => <tr key={m.metodo}><td>{METODO[m.metodo] || m.metodo}</td><td style={{ textAlign: 'right' }}>{brl(m.total)}</td></tr>)}
                </tbody></table>
              )}
            </section>
            <section className="settings-section">
              <h2><Icon name="receipt" size={16} /> Sangrias e suprimentos</h2>
              {c.movimentos.length === 0 ? <p className="empty-state">Nenhum ainda.</p> : (
                <table className="data-table"><tbody>
                  {c.movimentos.map((m) => (
                    <tr key={m.id}>
                      <td>{horaBR(m.criado_em)}<div className="nfe-item-codigos">{m.operador_nome || ''}</div></td>
                      <td>{m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}{m.motivo ? <div className="nfe-item-codigos">{m.motivo}</div> : null}</td>
                      <td style={{ textAlign: 'right' }} className={m.tipo === 'sangria' ? 'caixa-mov-sangria' : 'caixa-mov-suprimento'}>{m.tipo === 'sangria' ? '−' : '+'} {brl(m.valor)}</td>
                    </tr>
                  ))}
                </tbody></table>
              )}
            </section>
          </div>
        </>
      )}

      <section className="settings-section">
        <h2><Icon name="calendar" size={16} /> Fechamentos dos últimos 30 dias</h2>
        {historico.length === 0 ? <p className="empty-state">Nenhum caixa fechado no período.</p> : (
          <table className="data-table">
            <thead><tr><th>Fechado em</th><th>Quem fechou</th><th style={{ textAlign: 'right' }}>Esperado</th><th style={{ textAlign: 'right' }}>Contado</th><th style={{ textAlign: 'right' }}>Diferença</th><th>Outras formas</th></tr></thead>
            <tbody>{historico.map((h) => {
              let conf = [];
              try { conf = h.conferencia_json ? JSON.parse(h.conferencia_json) : []; } catch { conf = []; }
              const comDiferenca = conf.filter((x) => x.diferenca);
              return (
                <tr key={h.id} className={h.diferenca < 0 ? 'row-warning' : ''}>
                  <td>{horaBR(h.fechada_em)}</td><td>{h.operador_fechamento_nome || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{brl(h.valor_fechamento_esperado)}</td><td style={{ textAlign: 'right' }}>{brl(h.valor_fechamento_informado)}</td>
                  <td style={{ textAlign: 'right' }}><Diferenca valor={h.diferenca} /></td>
                  <td>{conf.length === 0 ? '—' : comDiferenca.length === 0 ? 'conferidas, sem diferença' : comDiferenca.map((x) => `${METODO[x.metodo]} ${x.diferenca > 0 ? '+' : ''}${brl(x.diferenca)}`).join(' · ')}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>

      {mov && (
        <div className="modal-overlay"><div className="modal-card"><form onSubmit={registrar}>
          <h2><Icon name={mov.tipo === 'sangria' ? 'export' : 'add'} size={18} /> {mov.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}</h2>
          <p className="screen-hint">{mov.tipo === 'sangria' ? `Na gaveta agora (pelo sistema): ${brl(c.valorEsperado)}.` : 'Dinheiro que está entrando na gaveta para troco.'}</p>
          <label>Valor (R$)<input type="number" step="0.01" min="0.01" value={mov.valor} onChange={(e) => setMov({ ...mov, valor: e.target.value })} required autoFocus /></label>
          <label style={{ marginTop: 10 }}>{mov.tipo === 'sangria' ? 'Motivo (obrigatório)' : 'Observação'}
            <input value={mov.motivo} maxLength={200} onChange={(e) => setMov({ ...mov, motivo: e.target.value })} required={mov.tipo === 'sangria'} placeholder={mov.tipo === 'sangria' ? 'Ex.: depósito no banco' : 'Ex.: troco do cofre'} /></label>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={() => setMov(null)}>Voltar</button>
            <button type="submit" className="btn-primary">Registrar</button>
          </div>
        </form></div></div>
      )}

      {fechando && (
        <div className="modal-overlay"><div className="modal-card" style={{ width: 'min(560px, 100%)' }}><form onSubmit={fechar}>
          <h2><Icon name="lock" size={18} /> Fechar caixa</h2>
          <p className="screen-hint">Conte o dinheiro da gaveta e some os comprovantes. O sistema compara com o que foi registrado e guarda a diferença.</p>
          <label>Dinheiro contado na gaveta (R$)<input type="number" step="0.01" min="0" value={fechando.dinheiro} onChange={(e) => setFechando({ ...fechando, dinheiro: e.target.value })} required autoFocus /></label>
          <div className="form-grid" style={{ marginTop: 10 }}>
            {CONFERIDOS.filter((m) => totalMetodo(m) > 0).map((m) => (
              <label key={m}>{METODO[m]} pelos comprovantes (R$)
                <input type="number" step="0.01" min="0" value={fechando[m] ?? ''} placeholder="não conferir" onChange={(e) => setFechando({ ...fechando, [m]: e.target.value })} /></label>
            ))}
          </div>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={() => setFechando(null)}>Voltar</button>
            <button type="submit" className="btn-primary">Fechar caixa</button>
          </div>
        </form></div></div>
      )}
    </div>
  );
}

function Diferenca({ valor }) {
  const v = Number(valor) || 0;
  if (Math.abs(v) < 0.005) return <span>bateu</span>;
  return <strong className={v < 0 ? 'valor-erro' : undefined}>{v > 0 ? `sobrou ${brl(v)}` : `faltou ${brl(-v)}`}</strong>;
}

