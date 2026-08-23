import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';

/**
 * @param {{ items: {id: string, icon?: string, label: string}[], onNavigate: (id: string) => void }} props
 */
export function CommandPalette({ items, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selecionado, setSelecionado] = useState(0);
  const inputRef = useRef(null);

  const filtrados = query.trim()
    ? items.filter((i) => i.label.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  useEffect(() => {
    function handleGlobalKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setSelecionado(0);
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => { setSelecionado(0); }, [query]);

  function ir(item) {
    onNavigate(item.id);
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelecionado((s) => Math.min(s + 1, filtrados.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelecionado((s) => Math.max(s - 1, 0)); return; }
    if (e.key === 'Enter' && filtrados[selecionado]) { e.preventDefault(); ir(filtrados[selecionado]); }
  }

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          style={{ maxWidth: 'none' }}
          placeholder="Pra onde ir? (Ctrl+K pra abrir/fechar, Esc pra fechar)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <ul className="command-palette-list">
          {filtrados.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                className={i === selecionado ? 'command-palette-item command-palette-item-active' : 'command-palette-item'}
                onMouseEnter={() => setSelecionado(i)}
                onClick={() => ir(item)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                  {item.icon && <Icon name={item.icon} size={15} />}
                  {item.label}
                </span>
              </button>
            </li>
          ))}
          {filtrados.length === 0 && <p className="empty-state">Nada encontrado.</p>}
        </ul>
      </div>
    </div>
  );
}
