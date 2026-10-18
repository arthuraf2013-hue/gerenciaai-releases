// Ícones de traço (currentColor) -- adaptam sozinhos ao tema claro/escuro.
const P = {
  vender: <><path d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.4-1.1L21 8H6.3" /><circle cx="9.5" cy="19.5" r="1.5" /><circle cx="17" cy="19.5" r="1.5" /></>,
  recibo: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  caixa: <><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M3 11h18M7 15h3" /><path d="M8 7V5h8v2" /></>,
  produto: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  cliente: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  mais: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M7 12h10" /></>,
  voltar: <path d="M15 5l-7 7 7 7" />,
  fechar: <path d="M6 6l12 12M18 6L6 18" />,
  lixo: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  compartilhar: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" /></>,
  nuvem: <><path d="M7 18h10.5a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18z" /></>,
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  alerta: <><path d="M12 3.5L21.5 20h-19z" /><path d="M12 10v4.5M12 17.4v.1" /></>,
  cadeado: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  wifiOff: <><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5-2.5M14.5 10.2a10 10 0 0 1 4.5 2.4M2 9a15 15 0 0 1 4.3-2.7M12 5a15 15 0 0 1 10 4" /><path d="M12 20h.01" /></>,
  dinheiro: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></>,
  cartao: <><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6.5 15h4" /></>,
  pix: <><path d="M12 2.8l3.4 3.4-3.4 3.4-3.4-3.4zM12 14.4l3.4 3.4-3.4 3.4-3.4-3.4zM2.8 12l3.4-3.4L9.6 12l-3.4 3.4zM14.4 12l3.4-3.4 3.4 3.4-3.4 3.4z" /></>,
  fiado: <><path d="M4 4h12l4 4v12H4z" /><path d="M8 11h8M8 15h5" /></>,
  grafico: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  engrenagem: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>,
  sair: <><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10" /></>,
  mais1: <path d="M12 5v14M5 12h14" />,
  menos1: <path d="M5 12h14" />,
  editar: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  copiar: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  celular: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  computador: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  sincronizar: <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5" /><path d="M20 4v4.5h-4.5" /><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5" /><path d="M4 20v-4.5h4.5" /></>,
};

export default function Icone({ nome, titulo, ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden={titulo ? undefined : true} role={titulo ? 'img' : undefined} {...props}>
      {titulo && <title>{titulo}</title>}
      {P[nome]}
    </svg>
  );
}
