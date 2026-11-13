/**
 * Preferências de tela por usuário: padrões, mescla com o que veio do banco
 * e a montagem do menu da esquerda personalizado. Sem React aqui, para os
 * testes (tests/preferenciasUtils.test.js).
 */

export const ZOOM_OPCOES = [0.9, 1, 1.1, 1.25, 1.4];
export const MODOS_CATEGORIAS = ['faixa', 'suspenso', 'oculto'];
export const DENSIDADES = ['auto', 'confortavel', 'compacta'];

export const PREFERENCIAS_PADRAO = Object.freeze({
  // favoritos: ids das telas fixadas no topo, na ordem escolhida
  // ocultos: ids das telas que a pessoa não quer ver no menu
  menu: Object.freeze({ favoritos: [], ocultos: [] }),
  // categorias: faixa de botões | menu suspenso | ocultas
  pdv: Object.freeze({ categorias: 'faixa', recentes: true, foco: false }),
  // zoom: tamanho da letra; densidade: auto (compacta em tela até 1440 px)
  visual: Object.freeze({ zoom: 1, densidade: 'auto', tema: null }),
});

const listaDeTextos = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);

/** O que veio do banco (pode estar velho, incompleto ou estragado) + padrões. */
export function mesclarPreferencias(salvo) {
  const s = salvo && typeof salvo === 'object' ? salvo : {};
  const menu = s.menu || {};
  const pdv = s.pdv || {};
  const visual = s.visual || {};
  return {
    menu: { favoritos: listaDeTextos(menu.favoritos), ocultos: listaDeTextos(menu.ocultos) },
    pdv: {
      categorias: MODOS_CATEGORIAS.includes(pdv.categorias) ? pdv.categorias : PREFERENCIAS_PADRAO.pdv.categorias,
      recentes: pdv.recentes !== false,
      foco: pdv.foco === true,
    },
    visual: {
      zoom: ZOOM_OPCOES.includes(visual.zoom) ? visual.zoom : 1,
      densidade: DENSIDADES.includes(visual.densidade) ? visual.densidade : 'auto',
      tema: visual.tema === 'escuro' || visual.tema === 'claro' ? visual.tema : null,
    },
  };
}

/** Densidade que vale agora: no automático, compacta em tela de notebook. */
export function densidadeEfetiva(preferida, larguraUtil) {
  if (preferida === 'compacta' || preferida === 'confortavel') return preferida;
  return larguraUtil <= 1440 ? 'compacta' : 'confortavel';
}

/** Próximo/anterior tamanho de letra (A+ / A−), sem sair da lista. */
export function proximoZoom(atual, direcao) {
  const i = Math.max(0, ZOOM_OPCOES.indexOf(atual));
  return ZOOM_OPCOES[Math.min(ZOOM_OPCOES.length - 1, Math.max(0, i + direcao))];
}

/**
 * Menu da esquerda já personalizado.
 * @param itens itens que a pessoa PODE ver (já filtrados por papel/perfil), na ordem padrão
 * @param menu  { favoritos, ocultos } da pessoa
 * @returns { favoritos: item[], resto: item[] (ordem padrão, sem favoritos nem ocultos), ocultos: item[] }
 */
export function montarMenu(itens, menu) {
  const porId = new Map(itens.map((i) => [i.id, i]));
  const favoritosIds = (menu?.favoritos || []).filter((id) => porId.has(id));
  const ocultosIds = new Set((menu?.ocultos || []).filter((id) => porId.has(id) && !favoritosIds.includes(id)));
  const fav = new Set(favoritosIds);
  return {
    favoritos: favoritosIds.map((id) => porId.get(id)),
    resto: itens.filter((i) => !fav.has(i.id) && !ocultosIds.has(i.id)),
    ocultos: itens.filter((i) => ocultosIds.has(i.id)),
  };
}

/** Liga/desliga favorito (entra no fim da lista; tirar não mexe na ordem dos outros). */
export function alternarFavorito(menu, id) {
  const favoritos = menu.favoritos.includes(id) ? menu.favoritos.filter((x) => x !== id) : [...menu.favoritos, id];
  // Favoritar algo escondido mostra de novo -- não faz sentido os dois.
  return { favoritos, ocultos: menu.ocultos.filter((x) => x !== id) };
}

export function alternarOculto(menu, id) {
  const ocultos = menu.ocultos.includes(id) ? menu.ocultos.filter((x) => x !== id) : [...menu.ocultos, id];
  return { favoritos: menu.favoritos.filter((x) => x !== id), ocultos };
}

/** Sobe/desce um favorito (direcao -1 ou +1). */
export function moverFavorito(menu, id, direcao) {
  const lista = [...menu.favoritos];
  const i = lista.indexOf(id);
  const j = i + direcao;
  if (i < 0 || j < 0 || j >= lista.length) return menu;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  return { ...menu, favoritos: lista };
}
