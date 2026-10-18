import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Primeiros passos da implantação, conferidos no banco (saudeService).
// Some sozinho quando tudo estiver feito; dá pra esconder nesta máquina.

const ONDE = { products: 'Produtos', settings: 'Configurações', users: 'Usuários', pos: 'PDV' };
const CHAVE_OCULTO = 'gerenciaai:primeirosPassosOculto';

export function PrimeirosPassos() {
  const [dados, setDados] = useState(null);
  const [oculto, setOculto] = useState(() => { try { return localStorage.getItem(CHAVE_OCULTO) === '1'; } catch { return false; } });

  useEffect(() => {
    window.pdv.saude?.implantacao().then((r) => { if (r && Array.isArray(r.passos)) setDados(r); }).catch(() => {});
  }, []);

  if (!dados || oculto || dados.feitos >= dados.total) return null;
  const pct = Math.round((dados.feitos / dados.total) * 100);

  return (
    <section className="settings-section primeiros-passos">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}><Icon name="checkCircle" size={16} /> Primeiros passos: {dados.feitos} de {dados.total}</h2>
        <button className="btn-link" onClick={() => { try { localStorage.setItem(CHAVE_OCULTO, '1'); } catch { /* ok */ } setOculto(true); }}>Esconder</button>
      </div>
      <div className="primeiros-passos-barra" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      <ul className="primeiros-passos-lista">
        {dados.passos.map((p) => (
          <li key={p.id} className={p.feito ? 'feito' : ''}>
            <Icon name={p.feito ? 'check' : 'warning'} size={14} />
            <span><strong>{p.titulo}</strong>{!p.feito && p.tela ? ` — em ${ONDE[p.tela] || p.tela}` : ''}<br /><small>{p.detalhe}</small></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
