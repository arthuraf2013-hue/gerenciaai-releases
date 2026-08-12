import { useEffect, useRef, useState } from 'react';

/**
 * Botão que abre um menu com uma lista de ações — pra agrupar
 * ferramentas secundárias (importar, exportar, manutenção...) que
 * não precisam de destaque igual à ação principal da tela, em vez de
 * empilhar botão atrás de botão no cabeçalho.
 *
 * @param {{ label: string, children: React.ReactNode }} props
 */
export function DropdownMenu({ label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClickFora(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleEsc(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickFora);
    window.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickFora);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  return (
    <div className="dropdown-menu-wrap" ref={ref}>
      <button type="button" className="btn-secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {label} <span className="dropdown-menu-caret">▾</span>
      </button>
      {open && (
        <div className="dropdown-menu-list" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Um item clicável dentro do DropdownMenu — mesma aparência de
 * botão de link, só que já dentro da lista suspensa. */
export function DropdownMenuItem({ onClick, danger, disabled, children }) {
  return (
    <button type="button" className={danger ? 'dropdown-menu-item dropdown-menu-item-danger' : 'dropdown-menu-item'} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
