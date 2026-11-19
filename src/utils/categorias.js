// Busca de categoria no cadastro de produto (CampoCategoria.jsx).
// Ignora acento, maiúscula e espaço sobrando: "bebidas" acha "Bebidas",
// "acai" acha "Açaí". Funções puras -- testadas em tests/campoCategoria.test.js.

export function normalizarCategoria(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().replace(/\s+/g, ' ').toLowerCase();
}

function validas(categorias) {
  return (Array.isArray(categorias) ? categorias : [])
    .filter((c) => c && typeof c.nome === 'string' && c.nome.trim());
}

/** Categoria que já existe com o mesmo nome (sem contar acento/maiúscula/espaço), ou null. */
export function categoriaEquivalente(texto, categorias) {
  const alvo = normalizarCategoria(texto);
  if (!alvo) return null;
  return validas(categorias).find((c) => normalizarCategoria(c.nome) === alvo) || null;
}

/**
 * Categorias para mostrar na lista. Texto vazio = todas. Com texto: as que
 * começam com ele primeiro, depois as que só contêm; cada grupo em ordem
 * alfabética.
 */
export function filtrarCategorias(texto, categorias, limite = 100) {
  const alvo = normalizarCategoria(texto);
  const ordenar = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
  const lista = validas(categorias);
  if (!alvo) return [...lista].sort(ordenar).slice(0, limite);
  const comeca = [];
  const contem = [];
  for (const c of lista) {
    const n = normalizarCategoria(c.nome);
    if (n.startsWith(alvo)) comeca.push(c);
    else if (n.includes(alvo)) contem.push(c);
  }
  return [...comeca.sort(ordenar), ...contem.sort(ordenar)].slice(0, limite);
}

/** Texto digitado que ainda não é nenhuma categoria: a lista oferece "Criar categoria". */
export function ehCategoriaNova(texto, categorias) {
  return normalizarCategoria(texto) !== '' && !categoriaEquivalente(texto, categorias);
}

export function textoQuantidadeProdutos(total) {
  const n = Number(total) || 0;
  if (n === 0) return 'sem produtos';
  return n === 1 ? '1 produto' : `${n} produtos`;
}
