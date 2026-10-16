/** Ícones próprios do app do celular — mesmo espírito duotone,
 * currentColor, sem cor fixa (adapta sozinho ao tema claro/escuro) do
 * conjunto usado em admin-panel/index.html: mesma identidade visual em
 * todo o produto. Só os poucos ícones que este app realmente usa. */
const T = 'stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"';
const ICON_SVGS = {
  menu: '<circle cx="12" cy="5.2" r="2.1" fill="currentColor"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/><circle cx="12" cy="18.8" r="2.1" fill="currentColor"/>',
  chevronRight: '<path d="M9.5 5.5l6.5 6.5-6.5 6.5" stroke="currentColor" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  cart: '<path d="M3 4.5h2.2l1.7 10a2 2 0 0 0 2 1.7h7.6a2 2 0 0 0 1.97-1.66L19.7 8H6.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="20" r="1.4" fill="currentColor"/><circle cx="17" cy="20" r="1.4" fill="currentColor"/>',
  // --- PDV móvel ---
  voltar: `<path d="M14.5 5.5L8 12l6.5 6.5" ${T} stroke-width="2.3"/>`,
  fechar: `<path d="M6 6l12 12M18 6L6 18" ${T}/>`,
  busca: `<circle cx="10.5" cy="10.5" r="6" ${T}/><path d="M15 15l5 5" ${T}/>`,
  codigoBarras: `<path d="M4 6v12M7 6v12M10.5 6v12M13 6v12M16.5 6v12M20 6v12" ${T} stroke-width="1.8"/><rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="currentColor" opacity="0.08"/>`,
  usuario: `<circle cx="12" cy="8.5" r="3.6" ${T}/><path d="M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5" ${T}/>`,
  lixeira: `<path d="M5 7h14M10 4h4M7 7l.9 12.1A2 2 0 0 0 9.9 21h4.2a2 2 0 0 0 2-1.9L17 7" ${T}/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5" ${T} stroke-width="2.4"/>`,
  vender: `<rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="currentColor" opacity="0.12"/><path d="M3.5 9.5h17M7.5 14.5h4" ${T}/><rect x="3.5" y="5" width="17" height="14" rx="2.5" ${T}/>`,
  mesa: `<path d="M3.5 9h17M6 9v10M18 9v10M8.5 9l1-4h5l1 4" ${T}/>`,
  recibo: `<path d="M6 3.5h12v17l-2.2-1.4-1.9 1.4-1.9-1.4-1.9 1.4-1.9-1.4L6 20.5z" fill="currentColor" opacity="0.1"/><path d="M6 3.5h12v17l-2.2-1.4-1.9 1.4-1.9-1.4-1.9 1.4-1.9-1.4L6 20.5zM9 8h6M9 11.5h6M9 15h3.5" ${T}/>`,
  ajustes: `<circle cx="12" cy="12" r="3" ${T}/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" ${T}/>`,
  etiqueta: `<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0z" ${T}/><circle cx="8" cy="8" r="1.5" fill="currentColor"/>`,
  compartilhar: `<circle cx="18" cy="5.5" r="2.5" ${T}/><circle cx="6" cy="12" r="2.5" ${T}/><circle cx="18" cy="18.5" r="2.5" ${T}/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" ${T}/>`,
  semSinal: `<path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0" ${T}/><circle cx="12" cy="19" r="1.3" fill="currentColor"/><path d="M3 3l18 18" ${T}/>`,
  pix: '<path d="M12 2.8l3.2 3.2-3.2 3.2L8.8 6zM12 14.8l3.2 3.2-3.2 3.2-3.2-3.2zM2.8 12L6 8.8 9.2 12 6 15.2zM14.8 12L18 8.8l3.2 3.2-3.2 3.2z" fill="currentColor" opacity="0.85"/>',
  dinheiro: `<rect x="2.5" y="6" width="19" height="12" rx="2" fill="currentColor" opacity="0.12"/><rect x="2.5" y="6" width="19" height="12" rx="2" ${T}/><circle cx="12" cy="12" r="2.6" ${T}/>`,
  cartao: `<rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="currentColor" opacity="0.12"/><rect x="2.5" y="5" width="19" height="14" rx="2.5" ${T}/><path d="M2.5 9.5h19M6.5 15h4" ${T}/>`,
  caderno: `<rect x="5" y="3.5" width="14" height="17" rx="2" fill="currentColor" opacity="0.12"/><rect x="5" y="3.5" width="14" height="17" rx="2" ${T}/><path d="M9 8h6M9 12h6M9 16h3" ${T}/>`,
};

function icon(name, size = 18) {
  const svg = ICON_SVGS[name];
  if (!svg) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="flex-shrink:0;vertical-align:middle" aria-hidden="true">${svg}</svg>`;
}

export { icon };
