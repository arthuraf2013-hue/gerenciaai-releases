import React from 'react';

/*
 * Ícones próprios do GerenciaAI.
 *
 * Substituem os emojis que estavam espalhados pelo app (💾, 🗑, 📊, etc.)
 * por SVG inline "duotone": cada ícone tem uma parte "de fundo" mais suave
 * (opacity baixa) e um traço/detalhe "de destaque" (opacity cheia), os dois
 * sempre em `currentColor`. Como não usam cor fixa, herdam a cor do texto
 * de quem os envolve — o que já muda sozinho entre os temas claro e escuro
 * (ver --color-text em theme.css) — então nenhum ícone precisa de uma
 * versão separada por tema.
 *
 * Uso: <Icon name="save" />  ou  <Icon name="trash" size={16} />
 * Se quiser, dá pra passar title="..." pra virar acessível (role="img").
 */

const SOFT = 0.32; // opacidade da parte "de fundo" dos ícones pictóricos
const RING = 0.14; // opacidade do círculo de fundo dos ícones de traço/glifo
const LINE = { stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };

// Círculo de fundo usado atrás dos ícones "de traço" (setas, check, x, etc.)
function Ring() {
  return <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity={RING} />;
}

const ICONS = {
  // --- setas e ações de navegação/edição ---------------------------------
  arrowLeft: <><Ring /><path d="M14 7l-5 5 5 5" {...LINE} /></>,
  arrowRight: <><Ring /><path d="M10 7l5 5-5 5" {...LINE} /></>,
  arrowUp: <><Ring /><path d="M7 14l5-5 5 5" {...LINE} /></>,
  arrowDown: <><Ring /><path d="M7 10l5 5 5-5" {...LINE} /></>,
  undo: <><Ring /><path d="M5 12h8a5 5 0 1 1-3.6 8.5" {...LINE} /><path d="M9 8L5 12l4 4" {...LINE} /></>,
  refresh: (
    <>
      <Ring />
      <path d="M7 10a5.2 5.2 0 0 1 8.7-3.1L17 8" {...LINE} />
      <path d="M17 5.5V8h-2.5" {...LINE} />
      <path d="M17 14a5.2 5.2 0 0 1-8.7 3.1L7 16" {...LINE} />
      <path d="M7 18.5V16h2.5" {...LINE} />
    </>
  ),
  restore: (
    <>
      <Ring />
      <path d="M6 9h8a5 5 0 1 1-3.8 8.7" {...LINE} />
      <path d="M9.5 5.5L6 9l3.5 3.5" {...LINE} />
      <path d="M12 12.2v3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity={SOFT + 0.2} />
    </>
  ),
  add: <><Ring /><path d="M12 7v10M7 12h10" {...LINE} /></>,
  close: <><Ring /><path d="M8 8l8 8M16 8l-8 8" {...LINE} /></>,
  check: <><Ring /><path d="M7 12.5l3.3 3.3L17 9" {...LINE} /></>,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity={SOFT} />
      <path d="M7.5 12.3l3 3L16.8 9" {...LINE} />
    </>
  ),
  edit: (
    <>
      <Ring />
      <path d="M8.5 15.5L8 17.7l2.2-.5L17.9 9.5a1.4 1.4 0 0 0 0-2l-.9-.9a1.4 1.4 0 0 0-2 0L8.5 15.5z" fill="currentColor" opacity={SOFT} />
      <path d="M8.5 15.5L8 17.7l2.2-.5L18.4 9a1.4 1.4 0 0 0 0-2l-.9-.9a1.4 1.4 0 0 0-2 0z" {...LINE} strokeWidth="1.5" />
    </>
  ),
  signature: (
    <>
      <Ring />
      <path d="M5 16.5c2-1 3-3 3.3-5.4.2-1.7 2-1.7 2.2 0 .2 1.7 1 3 2 3 1.3 0 1.6-1.7 2.7-1.7 1 0 1 1.4 2.3 1.4" {...LINE} />
    </>
  ),
  sparkle: (
    <>
      <Ring />
      <path d="M12 6l1.1 3 3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1L12 6z" fill="currentColor" />
      <circle cx="17.5" cy="7" r="1" fill="currentColor" opacity={SOFT + 0.3} />
    </>
  ),
  update: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity={SOFT} />
      <path d="M12 16V8" {...LINE} />
      <path d="M8.3 11.2L12 7.5l3.7 3.7" {...LINE} />
    </>
  ),
  star: (
    <>
      <Ring />
      <path d="M12 6.3l1.6 3.3 3.6.5-2.6 2.5.6 3.6L12 14.5l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5L12 6.3z" fill="currentColor" />
    </>
  ),

  // --- estados / avisos -----------------------------------------------
  warning: (
    <>
      <path d="M12 4.2L21 19H3L12 4.2z" fill="currentColor" opacity={SOFT} />
      <path d="M12 10v4" {...LINE} />
      <circle cx="12" cy="16.6" r="1" fill="currentColor" />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity={SOFT} />
      <path d="M6.5 6.5l11 11" {...LINE} />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="11" width="13" height="9" rx="2" fill="currentColor" opacity={SOFT} />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" {...LINE} />
      <circle cx="12" cy="15.3" r="1.3" fill="currentColor" />
    </>
  ),
  key: (
    <>
      <Ring />
      <circle cx="8.3" cy="15.7" r="3.2" fill="currentColor" opacity={SOFT} />
      <path d="M10.4 13.5L17 7l1.6 1.6L17 10.2l1.3 1.3-1.5 1.5-1.3-1.3-1 1" {...LINE} />
    </>
  ),
  scale: (
    <>
      <path d="M12 4v16M8 20h8" {...LINE} />
      <path d="M5 7h14" {...LINE} />
      <path d="M5 7l-2.5 5a2.5 2.5 0 0 0 5 0L5 7z" fill="currentColor" opacity={SOFT} />
      <path d="M19 7l-2.5 5a2.5 2.5 0 0 0 5 0L19 7z" fill="currentColor" opacity={SOFT} />
    </>
  ),

  // --- pessoas ----------------------------------------------------------
  user: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity={RING} />
      <circle cx="12" cy="9.3" r="2.8" fill="currentColor" />
      <path d="M6.2 18.5a6 6 0 0 1 11.6 0" {...LINE} />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="2.6" fill="currentColor" />
      <circle cx="16" cy="9.5" r="2.1" fill="currentColor" opacity={SOFT + 0.3} />
      <path d="M4 19a5.2 5.2 0 0 1 10 0" {...LINE} />
      <path d="M14.5 14.3a4.4 4.4 0 0 1 5.5 4.2" {...LINE} />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.5" y="8" width="17" height="11" rx="2" fill="currentColor" opacity={SOFT} />
      <path d="M9 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2" {...LINE} />
      <path d="M3.5 13h17" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),

  // --- documentos / organização ------------------------------------------
  save: (
    <>
      <path d="M5.5 4a1.7 1.7 0 0 1 1.7-1.7h8l4.3 4.3v13.7a1.7 1.7 0 0 1-1.7 1.7H7.2a1.7 1.7 0 0 1-1.7-1.7V4z" fill="currentColor" opacity={SOFT} />
      <rect x="8" y="3" width="6.3" height="4.6" rx="0.6" fill="currentColor" />
      <rect x="7.3" y="13" width="9.4" height="6.7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 7.2a1.5 1.5 0 0 1 1.5-1.5h4l1.8 2h8.2a1.5 1.5 0 0 1 1.5 1.5v9.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V7.2z" fill="currentColor" opacity={SOFT} />
      <path d="M3.5 10.2h17" stroke="currentColor" strokeWidth="1.6" opacity={SOFT + 0.35} />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4" width="17" height="5.4" rx="1.2" fill="currentColor" opacity={SOFT} />
      <rect x="4.3" y="10.2" width="15.4" height="9.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.2 14.3h3.6" {...LINE} />
    </>
  ),
  document: (
    <>
      <path d="M6.5 3.5h7l4 4v13H6.5v-17z" fill="currentColor" opacity={SOFT} />
      <path d="M13.5 3.5v4h4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 13h6M9 16.3h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5.5" y="4.5" width="13" height="16" rx="1.6" fill="currentColor" opacity={SOFT} />
      <rect x="9" y="3" width="6" height="3.2" rx="1" fill="currentColor" />
      <path d="M8.5 12h7M8.5 15.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="11" height="12.5" rx="1.6" fill="currentColor" opacity={SOFT} />
      <rect x="5" y="3.5" width="11" height="12.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  trash: (
    <>
      <path d="M6.3 8.5h11.4l-1 11.2a2 2 0 0 1-2 1.8h-5.4a2 2 0 0 1-2-1.8l-1-11.2z" fill="currentColor" opacity={SOFT} />
      <path d="M4 8.5h16M9.5 8.5V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 6v2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 11.7v6M14 11.7v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  book: (
    <>
      <path d="M12 5.2c-1.7-1-4.4-1.3-6.7-.9v13.4c2.3-.4 5 0 6.7.9V5.2z" fill="currentColor" opacity={SOFT} />
      <path d="M12 5.2c1.7-1 4.4-1.3 6.7-.9v13.4c-2.3-.4-5 0-6.7.9V5.2z" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  history: (
    <>
      <path d="M6 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8.5A2.5 2.5 0 0 1 6 17V4.5z" fill="currentColor" opacity={SOFT} />
      <path d="M6 4.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 9h6M9 12.3h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="1.8" fill="currentColor" opacity={SOFT} />
      <path d="M4 9.5h16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 3.5v4M16 3.5v4" {...LINE} />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="13" cy="14" r="1" fill="currentColor" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity={SOFT} />
      <path d="M12 7.5V12l3.2 2" {...LINE} />
    </>
  ),
  attachment: (
    <>
      <Ring />
      <path d="M16.5 8.3l-6 6a2.4 2.4 0 0 0 3.4 3.4l6.2-6.2a4 4 0 1 0-5.7-5.7L8 12.2" {...LINE} />
    </>
  ),
  link: (
    <>
      <Ring />
      <path d="M10.3 13.7a3.4 3.4 0 0 0 4.8 0l2-2a3.4 3.4 0 0 0-4.8-4.8l-1 1" {...LINE} />
      <path d="M13.7 10.3a3.4 3.4 0 0 0-4.8 0l-2 2a3.4 3.4 0 0 0 4.8 4.8l1-1" {...LINE} />
    </>
  ),
  plug: (
    <>
      <Ring />
      <path d="M9 9V6M15 9V6" {...LINE} />
      <path d="M8 9h8v2.5a4 4 0 0 1-4 4 4 4 0 0 1-4-4V9z" fill="currentColor" opacity={SOFT + 0.2} />
      <path d="M12 15.5V19" {...LINE} />
    </>
  ),
  wrench: (
    <>
      <Ring />
      <path d="M14.7 6.3a3.6 3.6 0 0 0-4.8 4.4L5 15.6l2 2 4.9-4.9a3.6 3.6 0 0 0 4.4-4.8l-2.2 2.2-2-.6-.6-2 2.2-2.2z" fill="currentColor" opacity={SOFT} />
      <path d="M14.7 6.3a3.6 3.6 0 0 0-4.8 4.4L5 15.6l2 2 4.9-4.9a3.6 3.6 0 0 0 4.4-4.8l-2.2 2.2-2-.6-.6-2 2.2-2.2z" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  lab: (
    <>
      <Ring />
      <path d="M10 3.5h4M10.5 3.5v6l-4 8a2 2 0 0 0 1.8 3h7.4a2 2 0 0 0 1.8-3l-4-8v-6" {...LINE} />
      <path d="M8.3 14.5h7.4" stroke="currentColor" strokeWidth="1.6" opacity={SOFT + 0.35} />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" fill="currentColor" opacity={SOFT} />
      <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15.5 15.5L20 20" {...LINE} />
    </>
  ),
  sliders: (
    <>
      <Ring />
      <path d="M6 8h12M6 16h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9.5" cy="8" r="1.7" fill="currentColor" />
      <circle cx="14.5" cy="16" r="1.7" fill="currentColor" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity={RING} />
      <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 5.7v1.8M12 16.5v1.8M18.3 12h-1.8M7.5 12H5.7M16.4 7.6l-1.3 1.3M8.9 15.1l-1.3 1.3M16.4 16.4l-1.3-1.3M8.9 8.9L7.6 7.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8 0 1 0 0 16c1.3 0 1.9-.8 1.9-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6h1.9a3.1 3 0 0 0 3-3c0-4-3.8-7.4-7.5-7.4z" fill="currentColor" opacity={SOFT} />
      <circle cx="8.3" cy="10.5" r="1.2" fill="currentColor" />
      <circle cx="11.3" cy="7.6" r="1.2" fill="currentColor" />
      <circle cx="15.2" cy="9" r="1.2" fill="currentColor" />
      <circle cx="8.5" cy="14.7" r="1.2" fill="currentColor" />
    </>
  ),
  graduation: (
    <>
      <path d="M12 5L2.5 9.2 12 13.4l9.5-4.2L12 5z" fill="currentColor" opacity={SOFT} />
      <path d="M6 11.4v3.7c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6v-3.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M21.5 9.2V15" {...LINE} />
    </>
  ),
  cake: (
    <>
      <rect x="4" y="12.5" width="16" height="7.5" rx="1.5" fill="currentColor" opacity={SOFT} />
      <path d="M4 15.5c1.4 1 2.6 1 4 0s2.6-1 4 0 2.6 1 4 0 2.6-1 4 0" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 12.5V9.8M12 12.5V9.8M16 12.5V9.8" {...LINE} />
      <circle cx="8" cy="7.6" r="1" fill="currentColor" />
      <circle cx="12" cy="7.6" r="1" fill="currentColor" />
      <circle cx="16" cy="7.6" r="1" fill="currentColor" />
    </>
  ),
  celebrate: (
    <>
      <Ring />
      <path d="M6 18l3.2-9.4a1 1 0 0 1 1.5-.5l6.8 4.5a1 1 0 0 1 0 1.7L8.4 18.6a1.2 1.2 0 0 1-1.7-.2z" fill="currentColor" opacity={SOFT + 0.2} />
      <path d="M14.5 4.5l1 2M18 6l.3 2.2M17.7 3.3L16 4.8" {...LINE} />
    </>
  ),

  // --- comida / mesas -----------------------------------------------------
  cooking: (
    <>
      <ellipse cx="10.5" cy="14" rx="7.5" ry="3" fill="currentColor" opacity={SOFT} />
      <path d="M18 14a7.5 3 0 0 0 0-.4" />
      <path d="M18 11.5h3.2M19 9.3l1.6-1.6M19 13.7l1.6 1.6" {...LINE} />
    </>
  ),
  plate: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity={SOFT} />
      <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),

  // --- financeiro -----------------------------------------------------
  money: (
    <>
      <path d="M5 9a2 2 0 0 1 2-2h1a5 3.4 0 0 0 8 0h1a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-1a5 3.4 0 0 0-8 0H7a2 2 0 0 1-2-2V9z" fill="currentColor" opacity={SOFT} />
      <circle cx="12" cy="12.3" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  cash: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="1.8" fill="currentColor" opacity={SOFT} />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 9v6M18.5 9v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" fill="currentColor" opacity={SOFT} />
      <rect x="2.5" y="9" width="19" height="3" fill="currentColor" />
      <rect x="5" y="14" width="5" height="1.8" rx="0.9" fill="currentColor" opacity={SOFT + 0.4} />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3v-17z" fill="currentColor" opacity={SOFT} />
      <path d="M8.5 8h7M8.5 11.3h7M8.5 14.6h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),

  // --- comunicação -----------------------------------------------------
  chat: (
    <>
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.7V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5z" fill="currentColor" opacity={SOFT} />
      <path d="M7 9.5h10M7 12.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="1.8" fill="currentColor" opacity={SOFT} />
      <path d="M3.6 6.3L12 13l8.4-6.7" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  hourglass: (
    <>
      <Ring />
      <path d="M8 5.5h8M8 18.5h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 5.5v2.3c0 1.6 1 2.9 3.5 4.2 2.5-1.3 3.5-2.6 3.5-4.2V5.5" fill="currentColor" opacity={SOFT + 0.2} />
      <path d="M8.5 18.5v-2.3c0-1.6 1-2.9 3.5-4.2 2.5 1.3 3.5 2.6 3.5 4.2v2.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity={SOFT} />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),

  // --- estoque / logística -----------------------------------------------------
  box: (
    <>
      <path d="M12 3.3l8 4.2v9L12 20.7l-8-4.2v-9L12 3.3z" fill="currentColor" opacity={SOFT} />
      <path d="M4 7.5L12 11.7l8-4.2M12 11.7v9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  ingredient: (
    <>
      <rect x="6" y="8" width="12" height="12.5" rx="1.8" fill="currentColor" opacity={SOFT} />
      <rect x="7.5" y="4.5" width="9" height="4" rx="1" fill="currentColor" />
      <path d="M6 13h12" stroke="currentColor" strokeWidth="1.4" opacity={SOFT + 0.35} />
    </>
  ),
  tag: (
    <>
      <path d="M11.8 3.5H19a1.5 1.5 0 0 1 1.5 1.5v7.2a1.5 1.5 0 0 1-.44 1.06l-8 8a1.5 1.5 0 0 1-2.12 0l-6.2-6.2a1.5 1.5 0 0 1 0-2.12l8-8A1.5 1.5 0 0 1 11.8 3.5z" fill="currentColor" opacity={SOFT} />
      <circle cx="15.8" cy="8.2" r="1.7" fill="currentColor" />
    </>
  ),
  export: <><Ring /><path d="M8 12h8M12.5 8l3.5 4-3.5 4" {...LINE} /><path d="M6 6v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity={SOFT + 0.2} /></>,
  import: <><Ring /><path d="M16 12H8M11.5 8L8 12l3.5 4" {...LINE} /><path d="M18 6v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity={SOFT + 0.2} /></>,
  trendUp: (
    <>
      <Ring />
      <path d="M5 16l4.5-5 3.2 2.8L18.5 7" {...LINE} />
      <path d="M14.3 7h4.2v4.2" {...LINE} />
    </>
  ),
  trendDown: (
    <>
      <Ring />
      <path d="M5 8l4.5 5 3.2-2.8 5.8 6.8" {...LINE} />
      <path d="M14.3 17.8h4.2v-4.2" {...LINE} />
    </>
  ),
  chart: (
    <>
      <Ring />
      <path d="M6 18V11M12 18V6M18 18v-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity={SOFT + 0.55} />
      <path d="M6 18V13M12 18V9M18 18v-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </>
  ),
  map: (
    <>
      <path d="M9 4.5L4 6.3v13.2l5-1.8 6 1.8 5-1.8V4.5l-5 1.8-6-1.8z" fill="currentColor" opacity={SOFT} />
      <path d="M9 4.5v13.2M15 6.3v13.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.3 2.3" />
    </>
  ),
  home: (
    <>
      <path d="M4 11.5L12 4l8 7.5" {...LINE} />
      <path d="M6 10.5V20h12v-9.5" fill="currentColor" opacity={SOFT} />
      <rect x="10" y="14" width="4" height="6" fill="currentColor" />
    </>
  ),
  store: (
    <>
      <path d="M4 4.5h16l1.5 5.5a2.3 2.3 0 0 1-4.5.7 2.3 2.3 0 0 1-4.5 0 2.3 2.3 0 0 1-4.5 0 2.3 2.3 0 0 1-4.5-.7L4 4.5z" fill="currentColor" opacity={SOFT} />
      <path d="M5.5 11v9h13v-9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="14.5" width="4" height="5.5" fill="currentColor" />
    </>
  ),
  cart: (
    <>
      <Ring />
      <path d="M5 6h2l1.6 9.2a1.6 1.6 0 0 0 1.6 1.3h6.4a1.6 1.6 0 0 0 1.6-1.3L19.5 9H8" {...LINE} />
      <circle cx="10.5" cy="19.5" r="1.2" fill="currentColor" />
      <circle cx="16.5" cy="19.5" r="1.2" fill="currentColor" />
    </>
  ),
  truck: (
    <>
      <rect x="2.5" y="8" width="11.5" height="8.5" rx="1" fill="currentColor" opacity={SOFT} />
      <path d="M14 11h3.5L20 14v2.5h-6V11z" fill="currentColor" opacity={SOFT} />
      <circle cx="7" cy="18" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16.5" cy="18" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  car: (
    <>
      <path d="M4.5 15.5v-3l2-4.2a2 2 0 0 1 1.8-1.1h7.4a2 2 0 0 1 1.8 1.1l2 4.2v3z" fill="currentColor" opacity={SOFT} />
      <path d="M4.5 15.5v-3l2-4.2a2 2 0 0 1 1.8-1.1h7.4a2 2 0 0 1 1.8 1.1l2 4.2v3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7.5" cy="16" r="1.6" fill="currentColor" />
      <circle cx="16.5" cy="16" r="1.6" fill="currentColor" />
    </>
  ),
  scooter: (
    <>
      <path d="M5 17a2.2 2.2 0 1 0 0-.1z" fill="currentColor" />
      <circle cx="5.3" cy="16.7" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="17.5" cy="16.7" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.3 16.7h6.5l1.7-6.2h3.2M8.5 10.5h4.2M17.5 16.7a3 3 0 0 0-3-3h-1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 6.5h2.5l1 2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity={SOFT + 0.3} />
    </>
  ),

  // --- diversos -----------------------------------------------------
  robot: (
    <>
      <rect x="5" y="8.5" width="14" height="10" rx="2.3" fill="currentColor" opacity={SOFT} />
      <path d="M12 8.5V5.5" {...LINE} />
      <circle cx="12" cy="4.3" r="1.1" fill="currentColor" />
      <circle cx="9.3" cy="13" r="1.3" fill="currentColor" />
      <circle cx="14.7" cy="13" r="1.3" fill="currentColor" />
      <path d="M2.8 12v3M21.2 12v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  paw: (
    <>
      <ellipse cx="12" cy="16" rx="5" ry="3.6" fill="currentColor" opacity={SOFT} />
      <circle cx="6.5" cy="10.5" r="1.7" fill="currentColor" />
      <circle cx="10.3" cy="7.5" r="1.7" fill="currentColor" />
      <circle cx="13.7" cy="7.5" r="1.7" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r="1.7" fill="currentColor" />
    </>
  ),
  glasses: (
    <>
      <Ring />
      <circle cx="7.3" cy="13" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.7" cy="13" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.3 12.4h3.4M4.3 12.4L3 10M19.7 12.4L21 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  mobile: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" fill="currentColor" opacity={SOFT} />
      <rect x="8.5" y="4.5" width="7" height="12.5" fill="currentColor" opacity={SOFT + 0.35} />
      <circle cx="12" cy="19" r="1" fill="currentColor" />
    </>
  ),
  camera: (
    <>
      <path d="M9 5.5l-1.2 2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-2.8l-1.2-2z" fill="currentColor" opacity={SOFT} />
      <circle cx="12" cy="13.3" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" fill="currentColor" opacity={SOFT} />
      <circle cx="8.3" cy="9.5" r="1.6" fill="currentColor" />
      <path d="M5 18l5-5 3.2 3.2L17.5 12l1.5 1.5V18z" fill="currentColor" opacity={SOFT + 0.4} />
    </>
  ),
  printer: (
    <>
      <rect x="4" y="8.5" width="16" height="8" rx="1.4" fill="currentColor" opacity={SOFT} />
      <path d="M7 8.5V4.5h10v4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="13.5" width="10" height="6" fill="currentColor" opacity={SOFT + 0.4} />
      <circle cx="16.5" cy="11" r="0.9" fill="currentColor" />
    </>
  ),
};

export default function Icon({ name, size = 18, className, style, title }) {
  const content = ICONS[name];
  if (!content) {
    // Nunca deve acontecer em produção -- se acontecer, é sinal de um nome
    // de ícone digitado errado em algum componente. Mostra um marcador
    // discreto em vez de quebrar a tela.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[Icon] ícone desconhecido: "${name}"`);
    }
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.2" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={{ flexShrink: 0, verticalAlign: 'middle', ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {content}
    </svg>
  );
}
