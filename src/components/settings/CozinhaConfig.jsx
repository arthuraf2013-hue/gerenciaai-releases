import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Impressora da COZINHA, separada da do caixa (ver
// electron/services/cozinhaService.js): comanda das mesas, dos pedidos
// aceitos na Separação e do balcão com senha. Só as categorias marcadas.

const dataHora = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${String(s).endsWith('Z') ? '' : 'Z'}`).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function CozinhaConfig() {
  const [form, setForm] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [impressoras, setImpressoras] = useState([]);
  const [ultimas, setUltimas] = useState([]);
  const [mensagem, setMensagem] = useState(null);
  const [ocupado, setOcupado] = useState('');

  async function carregar() {
    const [c, cats, ult] = await Promise.all([
      window.pdv.cozinha.getConfig(), window.pdv.cozinha.listarCategorias(), window.pdv.cozinha.listarUltimas({ limite: 15 }),
    ]);
    if (c?.ok === false) { setMensagem({ tipo: 'erro', texto: c.error }); return; }
    setForm((f) => f || { ...c, porta: String(c.porta) });
    setCategorias(Array.isArray(cats) ? cats : []);
    setUltimas(Array.isArray(ult) ? ult : []);
  }
  useEffect(() => { carregar(); }, []);

  async function buscarImpressoras() {
    setOcupado('buscar');
    const l = await window.pdv.print.listPrinters();
    setOcupado('');
    setImpressoras(Array.isArray(l) ? l : []);
  }

  function alternarCategoria(c) {
    setForm((f) => ({ ...f, categorias: f.categorias.includes(c) ? f.categorias.filter((x) => x !== c) : [...f.categorias, c] }));
  }

  async function salvar(e) {
    e?.preventDefault();
    setOcupado('salvar'); setMensagem(null);
    const r = await window.pdv.cozinha.saveConfig({ ...form, porta: Number(form.porta) || 9100, copias: Number(form.copias) || 1, larguraMm: Number(form.larguraMm) });
    setOcupado('');
    if (!r?.ok) { setMensagem({ tipo: 'erro', texto: r?.error || 'Não consegui salvar.' }); return false; }
    setForm({ ...r.config, porta: String(r.config.porta) });
    setMensagem({ tipo: 'ok', texto: r.config.ativa ? 'Impressora da cozinha salva.' : 'Salvo (desligada).' });
    return true;
  }

  async function testar() {
    if (!(await salvar())) return;
    setOcupado('testar');
    const r = await window.pdv.cozinha.imprimirTeste();
    setOcupado('');
    setMensagem(r?.ok ? { tipo: 'ok', texto: 'Página de teste enviada. Confira os acentos: se sair símbolo estranho, troque a tabela de acentos.' } : { tipo: 'erro', texto: r?.error });
  }

  async function reimprimir(id) {
    const r = await window.pdv.cozinha.reimprimir({ id });
    setMensagem(r?.ok ? { tipo: 'ok', texto: 'Reimpresso.' } : { tipo: 'erro', texto: r?.error });
    carregar();
  }

  if (!form) return <section className="settings-section"><p className="screen-hint">Carregando...</p></section>;
  return (
    <section className="settings-section">
      <h2><Icon name="cooking" size={16} /> Impressora da cozinha</h2>
      <p className="screen-hint">
        Separada da impressora do caixa. Sai a comanda das mesas (PC, garçom e QR), dos pedidos aceitos na Separação e da venda do balcão com senha.
        Cada item sai uma vez só; se a impressora falhar, ele fica para a próxima tentativa e aparece aqui embaixo.
      </p>
      <form className="product-form" onSubmit={salvar}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.ativa} onChange={(e) => setForm({ ...form, ativa: e.target.checked })} />
          Impressora da cozinha ligada
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.automatica} onChange={(e) => setForm({ ...form, automatica: e.target.checked })} />
          Imprimir sozinho o que for lançado nas mesas (junta o que for lançado em sequência numa folha só)
        </label>
        <div className="form-grid">
          <label>Tipo
            <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
              <option value="windows">Impressora instalada no Windows (USB)</option>
              <option value="rede">Térmica na rede (IP)</option>
            </select>
          </label>
          {form.tipo === 'rede' ? (
            <>
              <label>IP da impressora<input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="192.168.0.50" /></label>
              <label>Porta<input inputMode="numeric" value={form.porta} onChange={(e) => setForm({ ...form, porta: e.target.value })} placeholder="9100" /></label>
              <label>Tabela de acentos
                <select value={form.codepage} onChange={(e) => setForm({ ...form, codepage: e.target.value })}>
                  <option value="cp860">Português (CP860) — Epson, Elgin, Bematech</option>
                  <option value="cp850">Multilíngue (CP850)</option>
                  <option value="sem_acento">Sem acento (troca á por a)</option>
                </select>
              </label>
            </>
          ) : (
            <label>Impressora
              <span style={{ display: 'flex', gap: 6 }}>
                <select value={form.impressoraWindows} onChange={(e) => setForm({ ...form, impressoraWindows: e.target.value })} style={{ flex: 1 }}>
                  <option value="">{form.impressoraWindows || 'Escolha...'}</option>
                  {impressoras.filter((p) => p.nome !== form.impressoraWindows).map((p) => <option key={p.nome} value={p.nome}>{p.nome}</option>)}
                </select>
                <button type="button" className="btn-secondary" onClick={buscarImpressoras} disabled={ocupado === 'buscar'} title="Buscar impressoras instaladas"><Icon name="search" size={14} /></button>
              </span>
            </label>
          )}
          <label>Papel
            <select value={form.larguraMm} onChange={(e) => setForm({ ...form, larguraMm: Number(e.target.value) })}>
              <option value={80}>80 mm</option>
              <option value={58}>58 mm</option>
            </select>
          </label>
          <label>Cópias
            <select value={form.copias} onChange={(e) => setForm({ ...form, copias: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {form.tipo === 'rede' && (
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.cortarPapel} onChange={(e) => setForm({ ...form, cortarPapel: e.target.checked })} />
            Cortar o papel no fim de cada comanda
          </label>
        )}
        <div>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Vai para a cozinha (sem marcar nenhuma = tudo):</span>
          {categorias.length === 0
            ? <p className="screen-hint" style={{ margin: '4px 0 0' }}>Nenhuma categoria cadastrada nos produtos ainda.</p>
            : <div className="chips-categorias">{categorias.map((c) => <button type="button" key={c} className={form.categorias.includes(c) ? 'ativo' : ''} onClick={() => alternarCategoria(c)}>{c}</button>)}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={testar} disabled={!!ocupado}><Icon name="printer" size={15} /> {ocupado === 'testar' ? 'Imprimindo...' : 'Salvar e imprimir teste'}</button>
          <button className="btn-primary" type="submit" disabled={!!ocupado}><Icon name="save" size={15} /> {ocupado === 'salvar' ? 'Salvando...' : 'Salvar'}</button>
        </div>
        {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</p>}
      </form>

      <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>Últimas comandas da cozinha</h3>
      {ultimas.length === 0 ? <p className="empty-state">Nenhuma comanda impressa ainda.</p> : (
        <table className="data-table">
          <thead><tr><th>Quando</th><th>Comanda</th><th>Itens</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {ultimas.map((u) => (
              <tr key={u.id} className={u.status === 'falhou' ? 'row-critical' : ''}>
                <td>{dataHora(u.impresso_em || u.criado_em)}</td>
                <td>{u.titulo}</td>
                <td>{u.itens}</td>
                <td>{u.status === 'impresso' ? 'Impressa' : <span title={u.erro || ''}>Falhou: {u.erro}</span>}</td>
                <td><button className="btn-link" onClick={() => reimprimir(u.id)}><Icon name="printer" size={14} /> Reimprimir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
