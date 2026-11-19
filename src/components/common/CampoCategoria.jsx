import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import {
  categoriaEquivalente, ehCategoriaNova, filtrarCategorias, textoQuantidadeProdutos,
} from '../../utils/categorias';

/**
 * Campo de categoria do cadastro de produto: escolhe uma categoria que já
 * existe (lista com busca, sem acento/maiúscula) ou cria outra só digitando.
 *
 * - Toque/clique no campo ou na seta abre a lista com todas; digitar filtra.
 * - Setas + Enter escolhem; Esc fecha só a lista (não fecha o modal).
 * - Enter com a lista aberta e nada marcado só fecha a lista (não salva o
 *   formulário no meio da escolha); com a lista fechada, salva como antes.
 * - "bebidas" vira "Bebidas" ao sair do campo quando "Bebidas" já existe,
 *   para não nascer categoria repetida por causa de acento ou maiúscula.
 *
 * Não fica dentro de <label>: o clique numa opção seria repassado ao input
 * pelo navegador e reabriria a lista.
 */
export function CampoCategoria({
  rotulo = 'Categoria', value, onChange, placeholder = 'Escolha ou digite uma nova', maxLength = 60, dica = null,
}) {
  const [categorias, setCategorias] = useState([]);
  const [aberto, setAberto] = useState(false);
  const [digitou, setDigitou] = useState(false);
  const [ativo, setAtivo] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listaRef = useRef(null);
  const id = useId();
  const texto = value || '';

  useEffect(() => {
    let vivo = true;
    const api = window.pdv;
    const carregar = api?.categories?.list
      ? api.categories.list()
      : Promise.resolve(api?.products?.listCategories?.()).then((l) =>
        (Array.isArray(l) ? l : []).map((c) => ({ nome: c.categoria, totalProdutos: c.total })));
    Promise.resolve(carregar)
      .then((lista) => { if (vivo && Array.isArray(lista)) setCategorias(lista); })
      .catch(() => { /* sem lista: o campo continua aceitando texto livre */ });
    return () => { vivo = false; };
  }, []);

  const opcoes = useMemo(() => filtrarCategorias(digitou ? texto : '', categorias), [digitou, texto, categorias]);
  const oferecerCriar = digitou && ehCategoriaNova(texto, categorias);
  const itens = useMemo(() => [
    ...opcoes.map((c) => ({ tipo: 'existente', nome: c.nome, total: c.totalProdutos })),
    ...(oferecerCriar ? [{ tipo: 'nova', nome: texto.trim() }] : []),
  ], [opcoes, oferecerCriar, texto]);

  function fechar() {
    setAberto(false);
    setDigitou(false);
    setAtivo(-1);
  }

  /** Troca "bebidas" pela "Bebidas" que já existe; tira espaço sobrando. */
  function acertarTexto() {
    const igual = categoriaEquivalente(texto, categorias);
    if (igual && igual.nome !== texto) onChange(igual.nome);
    else if (texto !== texto.trim()) onChange(texto.trim());
  }

  function escolher(item) {
    onChange(item.nome);
    fechar();
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!aberto) return undefined;
    function aoTocarFora(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) fechar();
    }
    document.addEventListener('pointerdown', aoTocarFora);
    return () => document.removeEventListener('pointerdown', aoTocarFora);
  }, [aberto]);

  useEffect(() => {
    if (ativo >= 0) listaRef.current?.children[ativo]?.scrollIntoView?.({ block: 'nearest' });
  }, [ativo]);

  function aoTeclar(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!aberto) { setAberto(true); return; }
      if (itens.length === 0) return;
      const passo = e.key === 'ArrowDown' ? 1 : -1;
      setAtivo((a) => (a + passo + itens.length) % itens.length);
    } else if (e.key === 'Enter' && aberto) {
      e.preventDefault();
      e.stopPropagation();
      if (ativo >= 0 && itens[ativo]) escolher(itens[ativo]);
      else { acertarTexto(); fechar(); }
    } else if (e.key === 'Escape' && aberto) {
      e.preventDefault();
      e.stopPropagation();
      fechar();
    } else if (e.key === 'Tab') {
      fechar();
    }
  }

  const listaId = `${id}-lista`;
  const temCategorias = categorias.length > 0;

  return (
    <div className="campo-categoria-campo">
      <label htmlFor={`${id}-input`}>{rotulo}</label>
      <div className="campo-categoria" ref={wrapRef}>
        <input
          id={`${id}-input`}
          ref={inputRef}
          role="combobox"
          aria-expanded={aberto}
          aria-controls={listaId}
          aria-autocomplete="list"
          aria-activedescendant={aberto && ativo >= 0 ? `${id}-op-${ativo}` : undefined}
          autoComplete="off"
          value={texto}
          maxLength={maxLength}
          placeholder={temCategorias ? placeholder : 'Ex.: Bebidas'}
          onChange={(e) => { onChange(e.target.value); setDigitou(true); setAberto(true); setAtivo(-1); }}
          onClick={() => { if (temCategorias) setAberto(true); }}
          onBlur={acertarTexto}
          onKeyDown={aoTeclar}
        />
        {temCategorias && (
          <button
            type="button"
            className="campo-categoria-seta"
            aria-label={aberto ? 'Fechar lista de categorias' : 'Ver categorias existentes'}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (aberto) fechar();
              else { setDigitou(false); setAberto(true); }
              inputRef.current?.focus();
            }}
          >
            <Icon name={aberto ? 'arrowUp' : 'arrowDown'} size={16} />
          </button>
        )}
        {aberto && itens.length > 0 && (
          <ul className="campo-categoria-lista" id={listaId} role="listbox" ref={listaRef} aria-label="Categorias">
            {itens.map((item, i) => (
              <li
                key={`${item.tipo}-${item.nome}`}
                id={`${id}-op-${i}`}
                role="option"
                aria-selected={i === ativo}
                className={[
                  'campo-categoria-opcao',
                  i === ativo ? 'ativa' : '',
                  item.tipo === 'nova' ? 'nova' : '',
                  item.tipo === 'existente' && item.nome === texto ? 'escolhida' : '',
                ].filter(Boolean).join(' ')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => escolher(item)}
              >
                {item.tipo === 'nova' ? (
                  <span className="campo-categoria-nome"><Icon name="add" size={15} /> Criar categoria “{item.nome}”</span>
                ) : (
                  <>
                    <span className="campo-categoria-nome">
                      {item.nome === texto && <Icon name="check" size={15} />}{item.nome}
                    </span>
                    <small>{textoQuantidadeProdutos(item.total)}</small>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {aberto && itens.length === 0 && temCategorias && (
          <div className="campo-categoria-lista campo-categoria-vazia">Nenhuma categoria com esse nome.</div>
        )}
      </div>
      {dica && <small className="campo-categoria-dica">{dica}</small>}
    </div>
  );
}
