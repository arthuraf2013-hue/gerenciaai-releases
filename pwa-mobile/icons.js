/** Ícones próprios do app do celular — mesmo espírito duotone,
 * currentColor, sem cor fixa (adapta sozinho ao tema claro/escuro) do
 * conjunto usado em admin-panel/index.html: mesma identidade visual em
 * todo o produto. Só os poucos ícones que este app realmente usa. */
const ICON_SVGS = {
  menu: '<circle cx="12" cy="5.2" r="2.1" fill="currentColor"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/><circle cx="12" cy="18.8" r="2.1" fill="currentColor"/>',
  chevronRight: '<path d="M9.5 5.5l6.5 6.5-6.5 6.5" stroke="currentColor" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  cart: '<path d="M3 4.5h2.2l1.7 10a2 2 0 0 0 2 1.7h7.6a2 2 0 0 0 1.97-1.66L19.7 8H6.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="20" r="1.4" fill="currentColor"/><circle cx="17" cy="20" r="1.4" fill="currentColor"/>',
};

function icon(name, size = 18) {
  const svg = ICON_SVGS[name];
  if (!svg) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="flex-shrink:0;vertical-align:middle" aria-hidden="true">${svg}</svg>`;
}

export { icon };
