import { useEffect, useState } from 'react';
import { useProfile } from '../../context/ProfileContext';
import Icon from '../common/Icon';

const TIPOS_CAMPO = [
  { value: 'texto', label: 'Texto' },
  { value: 'numero', label: 'Número' },
  { value: 'data', label: 'Data' },
  { value: 'boolean', label: 'Sim/Não' },
];

const emptyForm = {
  nome: '', camposExtras: [], alertaValidadeProxima: false,
  diasAlertaValidade: 60, diasAlertaValidadeCritico: 7, estoqueCriticoPercentual: 50,
};

export function ProfileManager() {
  const { profile, reload } = useProfile();
  const [profiles, setProfiles] = useState([]);
  const [editing, setEditing] = useState(null); // id do perfil sendo editado, ou 'new', ou null
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function reloadProfiles() {
    const list = await window.pdv.profile.listAvailable();
    setProfiles(Array.isArray(list) ? list : []);
  }

  useEffect(() => { reloadProfiles(); }, []);

  async function handleUseProfile(id) {
    await window.pdv.profile.setActive({ profileId: id });
    await reload();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function startNew() {
    setForm(emptyForm);
    setEditing('new');
    setError('');
  }

  function startEdit(p) {
    setForm({
      nome: p.nome,
      camposExtras: p.camposExtras || [],
      alertaValidadeProxima: p.regrasAlerta?.includes('validade_proxima') || false,
      diasAlertaValidade: p.diasAlertaValidade || 60,
      diasAlertaValidadeCritico: p.diasAlertaValidadeCritico || 7,
      estoqueCriticoPercentual: p.estoqueCriticoPercentual ?? 50,
    });
    setEditing(p.id);
    setError('');
  }

  async function handleDuplicate(p) {
    await window.pdv.profile.duplicate({ id: p.id, novoNome: `${p.nome} (cópia)` });
    reloadProfiles();
  }

  async function handleDelete(p) {
    if (!confirm(`Excluir o perfil "${p.nome}"? Produtos já cadastrados não são afetados.`)) return;
    const result = await window.pdv.profile.delete({ id: p.id });
    if (!result.ok) return setError(result.error);
    reloadProfiles();
  }

  function addCampo() {
    setForm({ ...form, camposExtras: [...form.camposExtras, { campo: '', label: '', tipo: 'texto', obrigatorio: false }] });
  }

  function updateCampo(index, changes) {
    const novos = form.camposExtras.map((c, i) => (i === index ? { ...c, ...changes } : c));
    setForm({ ...form, camposExtras: novos });
  }

  function removeCampo(index) {
    setForm({ ...form, camposExtras: form.camposExtras.filter((_, i) => i !== index) });
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');

    // gera a "chave" de cada campo extra a partir do rótulo, se ainda não tiver
    const camposComChave = form.camposExtras.map((c) => ({
      ...c,
      campo: c.campo || c.label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_'),
    }));

    const payload = { ...form, camposExtras: camposComChave };
    const result = editing === 'new'
      ? await window.pdv.profile.create(payload)
      : await window.pdv.profile.update({ id: editing, ...payload });

    if (!result.ok) return setError(result.error);
    setEditing(null);
    reloadProfiles();
    reload(); // caso o perfil ativo tenha sido editado, atualiza o resto do app na hora
  }

  return (
    <section className="settings-section">
      <h2><Icon name="folder" size={16} /> Perfis de negócio</h2>
      <p className="screen-hint">
        Cada perfil define quais campos extras aparecem no cadastro de produtos e se o alerta de
        validade próxima fica ativo — dá pra usar o GerenciaAI em qualquer tipo de comércio, não só
        farmácia. Trocar ou editar um perfil não apaga produtos já cadastrados.
      </p>

      <div className="profile-cards">
        {profiles.map((p) => (
          <div key={p.id} className={`profile-card ${profile?.id === p.id ? 'profile-card-active' : ''}`}>
            <strong>{p.nome}</strong>
            {p.camposExtras?.length > 0 ? (
              <span>{p.camposExtras.map((c) => c.label).join(', ')}</span>
            ) : (
              <span>Nenhum campo extra</span>
            )}
            <div className="profile-card-actions">
              {profile?.id !== p.id && (
                <button className="btn-link" onClick={() => handleUseProfile(p.id)}><Icon name="checkCircle" size={15} /> Usar</button>
              )}
              <button className="btn-link" onClick={() => startEdit(p)}><Icon name="edit" size={15} /> Editar</button>
              <button className="btn-link" onClick={() => handleDuplicate(p)}><Icon name="duplicate" size={15} /> Duplicar</button>
              <button className="btn-link-danger" onClick={() => handleDelete(p)}><Icon name="trash" size={15} /> Excluir</button>
            </div>
          </div>
        ))}
        <button className="profile-card profile-card-new" onClick={startNew}><Icon name="add" size={15} /> Novo perfil</button>
      </div>

      {saved && <p className="io-message">Perfil ativo atualizado.</p>}

      {editing && (
        <form className="product-form profile-editor" onSubmit={handleSave}>
          <h3>{editing === 'new' ? 'Novo perfil' : 'Editar perfil'}</h3>

          <label>Nome do perfil
            <input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Papelaria, Pet Shop, Mercearia..." required />
          </label>

          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox" style={{ width: 'auto' }}
              checked={form.alertaValidadeProxima}
              onChange={(e) => setForm({ ...form, alertaValidadeProxima: e.target.checked })}
            />
            Alertar quando produtos estiverem perto da validade
          </label>

          {form.alertaValidadeProxima && (
            <div className="form-grid" style={{ maxWidth: 460 }}>
              <label>Avisar (amarelo) com quantos dias de antecedência
                <input type="number" value={form.diasAlertaValidade} onChange={(e) => setForm({ ...form, diasAlertaValidade: Number(e.target.value) })} />
              </label>
              <label>Crítico (vermelho) com quantos dias de antecedência
                <input type="number" value={form.diasAlertaValidadeCritico} onChange={(e) => setForm({ ...form, diasAlertaValidadeCritico: Number(e.target.value) })} />
              </label>
            </div>
          )}

          <label style={{ maxWidth: 320 }}>
            Estoque crítico (vermelho) abaixo de quantos % do estoque mínimo
            <input
              type="number" min="0" max="100" value={form.estoqueCriticoPercentual}
              onChange={(e) => setForm({ ...form, estoqueCriticoPercentual: Number(e.target.value) })}
            />
          </label>
          <p className="screen-hint" style={{ marginTop: -8 }}>
            Ex: mínimo 10 e 50% → abaixo de 5 unidades fica vermelho; entre 5 e 10, amarelo.
          </p>

          <h4>Campos extras do produto</h4>
          <p className="screen-hint" style={{ marginTop: -4 }}>
            Aparecem no cadastro de produto quando este perfil estiver ativo. Ex: "Validade", "Cor", "Tamanho", "Voltagem"...
          </p>

          {form.camposExtras.map((campo, i) => (
            <div key={i} className="campo-extra-row">
              <input
                placeholder="Nome do campo (ex: Cor)"
                value={campo.label}
                onChange={(e) => updateCampo(i, { label: e.target.value })}
              />
              <select value={campo.tipo} onChange={(e) => updateCampo(i, { tipo: e.target.value })}>
                {TIPOS_CAMPO.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="campo-extra-obrigatorio">
                <input type="checkbox" checked={campo.obrigatorio} onChange={(e) => updateCampo(i, { obrigatorio: e.target.checked })} />
                Obrigatório
              </label>
              <button type="button" className="btn-link-danger" onClick={() => removeCampo(i)}><Icon name="trash" size={15} /> Remover</button>
            </div>
          ))}
          <button type="button" className="btn-secondary" onClick={addCampo}><Icon name="add" size={15} /> Adicionar campo</button>

          {error && <p className="modal-error">{error}</p>}

          <div className="settings-actions" style={{ marginTop: 16 }}>
            <button className="btn-primary" type="submit"><Icon name="save" size={15} /> Salvar perfil</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}><Icon name="close" size={15} /> Cancelar</button>
          </div>
        </form>
      )}
    </section>
  );
}
