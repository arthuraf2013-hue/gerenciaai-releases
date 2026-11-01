import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';
import { brl, dataBR, useModulosErp, ModuloInativo } from './erpUtils';

/** Equipe (ERP, gestão de pessoas): cadastro, documentos e férias. Sem cálculo de folha. */

const SITUACAO = { gozadas: ['chip-novo', 'gozadas'], a_gozar: ['chip-neutro', 'a gozar'], vencendo: ['chip-atualizar', 'vencendo'], vencidas: ['chip-erro', 'vencidas'], em_aquisicao: ['chip-neutro', 'em aquisição'] };
const VAZIO = { nome: '', cpf: '', cargo: '', departamento: '', admissao: '', demissao: '', salario: '', telefone: '', email: '', userId: '', documentos: {}, observacoes: '' };

export function EquipeScreen() {
  const { currentUser } = useSession();
  const modulos = useModulosErp();
  const [d, setD] = useState(null);
  const [inativos, setInativos] = useState(false);
  const [form, setForm] = useState(null);
  const [ferias, setFerias] = useState(null); // { colaborador, inicio, fim }
  const [erro, setErro] = useState('');
  useEscToClose(() => { setForm(null); setFerias(null); }, !!form || !!ferias);
  const carregar = () => window.pdv.rh.listar({ incluirInativos: inativos }).then(setD);
  useEffect(() => { if (modulos?.rh) carregar(); }, [inativos, modulos?.rh]);

  async function salvar(e) {
    e.preventDefault();
    const r = await window.pdv.rh.salvar({ ...form, operadorId: currentUser.id });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setForm(null); carregar();
  }
  async function salvarFerias(e) {
    e.preventDefault();
    const r = await window.pdv.rh.registrarFerias({ employeeId: ferias.colaborador.id, inicio: ferias.inicio, fim: ferias.fim, operadorId: currentUser.id });
    if (!r?.ok) return setErro(r?.error);
    setErro(''); setFerias(null); carregar();
  }
  if (modulos === null) return <div className="screen"><p className="empty-state">Carregando...</p></div>;
  if (!modulos.rh) return <ModuloInativo modulo="financeiro" semPermissao={modulos.financeiroLicenciado && modulos.semPermissao.rh} />;
  if (!d) return <div className="screen"><p className="empty-state">Carregando...</p></div>;
  if (d.ok === false) return <div className="screen"><p className="modal-error">{d.error}</p></div>;
  const set = (k, v) => setForm({ ...form, [k]: v });
  return (
    <div className="screen">
      <div className="screen-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="users" size={20} /> Equipe</h1>
        <button className="btn-primary" onClick={() => { setErro(''); setForm({ ...VAZIO }); }}><Icon name="add" size={15} /> Novo colaborador</button>
      </div>
      <p className="screen-hint">Cadastro, documentos e férias da equipe. Folha, INSS, FGTS e rescisão ficam com o contador (eSocial). Férias pela CLT, sem considerar faltas.</p>
      {d.alertas.map((a) => <p key={a.texto} className={a.nivel === 'critico' ? 'modal-error erp-aviso' : a.nivel === 'aviso' ? 'io-message-aviso' : 'io-message'} style={{ marginBottom: 6 }}>{a.texto}</p>)}
      <div className="dashboard-stats">
        <div className="stat-card"><span>Ativos</span><strong>{d.resumo.ativos}</strong></div>
        <div className="stat-card"><span>Salários (base mensal)</span><strong>{brl(d.resumo.folhaBaseMensal)}</strong></div>
        <div className="stat-card"><span>De férias hoje</span><strong>{d.resumo.emFerias}</strong></div>
        <div className="stat-card"><span>Por departamento</span><strong style={{ fontSize: 14 }}>{d.resumo.porDepartamento.map((x) => `${x.departamento}: ${x.qtd}`).join(' · ') || '—'}</strong></div>
      </div>
      <label className="nfe-opcao" style={{ marginBottom: 10 }}><input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} /> Mostrar desligados</label>
      {d.colaboradores.length === 0 ? <p className="empty-state">Nenhum colaborador cadastrado.</p> : (
        <table className="data-table">
          <thead><tr><th>Colaborador</th><th>Admissão</th><th>Férias</th><th>Documentos</th><th></th></tr></thead>
          <tbody>{d.colaboradores.map((c) => {
            const atual = c.periodos.filter((p) => p.direito > 0 && p.saldo > 0)[0];
            return (
              <tr key={c.id} style={c.ativo ? undefined : { opacity: 0.55 }}>
                <td><strong>{c.nome}</strong>{c.emFerias && <span className="chip-situacao chip-novo" style={{ marginLeft: 6 }}>de férias</span>}
                  <div className="nfe-item-codigos">{[c.cargo, c.departamento, c.usuario_nome && `login: ${c.usuario_nome}`].filter(Boolean).join(' · ')}</div></td>
                <td>{dataBR(c.admissao)}{c.demissao && <div className="nfe-item-codigos">saiu {dataBR(c.demissao)}</div>}</td>
                <td>{atual ? <><span className={`chip-situacao ${SITUACAO[atual.situacao][0]}`}>{atual.saldo} dia(s) {SITUACAO[atual.situacao][1]}</span><div className="nfe-item-codigos">conceder até {dataBR(atual.limite)}</div></> : <span className="nfe-item-codigos">{c.admissao ? 'em dia' : 'sem admissão'}</span>}</td>
                <td>{c.documentosFaltando.length === 0 ? <span className="chip-situacao chip-novo">completo</span> : <span className="nfe-item-codigos">faltam {c.documentosFaltando.length}</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-link" onClick={() => { setErro(''); setForm({ ...VAZIO, ...Object.fromEntries(Object.entries(c).filter(([k]) => k in VAZIO)), userId: c.user_id || '', salario: c.salario ?? '', id: c.id }); }}>Editar</button>
                  {c.ativo === 1 && c.admissao && <button className="btn-link" onClick={() => { setErro(''); setFerias({ colaborador: c, inicio: '', fim: '' }); }}>Férias</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}

      {form && (
        <div className="modal-overlay"><form className="modal-card" onSubmit={salvar} style={{ width: 'min(760px, 100%)' }}>
          <h2><Icon name="users" size={18} /> {form.id ? 'Editar colaborador' : 'Novo colaborador'}</h2>
          <div className="form-grid">
            <label>Nome<input value={form.nome} onChange={(e) => set('nome', e.target.value)} required maxLength={120} /></label>
            <label>CPF<input value={form.cpf || ''} onChange={(e) => set('cpf', e.target.value)} inputMode="numeric" /></label>
            <label>Cargo<input value={form.cargo || ''} onChange={(e) => set('cargo', e.target.value)} maxLength={60} /></label>
            <label>Departamento<input value={form.departamento || ''} onChange={(e) => set('departamento', e.target.value)} maxLength={60} /></label>
            <label>Admissão<input type="date" value={form.admissao || ''} onChange={(e) => set('admissao', e.target.value)} /></label>
            <label>Desligamento<input type="date" value={form.demissao || ''} onChange={(e) => set('demissao', e.target.value)} /></label>
            <label>Salário (R$)<input type="number" min="0" step="0.01" value={form.salario} onChange={(e) => set('salario', e.target.value)} /></label>
            <label>Login no PDV<select value={form.userId} onChange={(e) => set('userId', e.target.value)}><option value="">(nenhum)</option>{d.usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label>
            <label>Telefone<input value={form.telefone || ''} onChange={(e) => set('telefone', e.target.value)} /></label>
            <label>E-mail<input value={form.email || ''} onChange={(e) => set('email', e.target.value)} /></label>
          </div>
          <h3 style={{ margin: '6px 0 0' }}>Documentos entregues</h3>
          <div className="form-grid">
            {Object.entries(d.documentosCatalogo).map(([k, rot]) => (
              <label key={k} className="nfe-opcao"><input type="checkbox" checked={!!form.documentos?.[k]} onChange={(e) => set('documentos', { ...form.documentos, [k]: e.target.checked })} /> {rot}</label>
            ))}
          </div>
          <label>Observações<textarea rows={2} value={form.observacoes || ''} onChange={(e) => set('observacoes', e.target.value)} maxLength={1000} /></label>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}><Icon name="close" size={15} /> Cancelar</button>
            <button type="submit" className="btn-primary"><Icon name="save" size={15} /> Salvar</button>
          </div>
        </form></div>
      )}

      {ferias && (
        <div className="modal-overlay"><form className="modal-card" onSubmit={salvarFerias}>
          <h2><Icon name="calendar" size={18} /> Férias — {ferias.colaborador.nome}</h2>
          <table className="data-table">
            <thead><tr><th>Período aquisitivo</th><th>Saldo</th><th>Conceder até</th></tr></thead>
            <tbody>{ferias.colaborador.periodos.filter((p) => p.direito > 0).map((p) => (
              <tr key={p.inicio}><td>{dataBR(p.inicio)} a {dataBR(p.fim)}</td><td><span className={`chip-situacao ${SITUACAO[p.situacao][0]}`}>{p.saldo} dia(s)</span></td><td>{dataBR(p.limite)}</td></tr>
            ))}</tbody>
          </table>
          {ferias.colaborador.ferias.length > 0 && <p className="screen-hint">Já registradas: {ferias.colaborador.ferias.map((f) => `${dataBR(f.inicio)}–${dataBR(f.fim)}`).join(', ')}</p>}
          <div className="form-grid">
            <label>Início<input type="date" value={ferias.inicio} onChange={(e) => setFerias({ ...ferias, inicio: e.target.value })} required /></label>
            <label>Fim<input type="date" value={ferias.fim} onChange={(e) => setFerias({ ...ferias, fim: e.target.value })} required /></label>
          </div>
          <p className="screen-hint">Mínimo de 5 dias por período; até 30 dias.</p>
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setFerias(null)}><Icon name="close" size={15} /> Cancelar</button>
            <button type="submit" className="btn-primary"><Icon name="save" size={15} /> Registrar férias</button>
          </div>
        </form></div>
      )}
    </div>
  );
}
