// Monta o HTML de um treinamento (um slide por página, 1280×720) a partir
// do conteúdo em conteudo.cjs. Sem dependências: o gerar.cjs abre este HTML
// numa janela escondida do Electron e imprime em PDF.
const path = require('path');
const { pathToFileURL } = require('url');

const PASTA = __dirname;
const arquivo = (rel) => pathToFileURL(path.join(PASTA, rel)).href;

const esc = (t) => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// **negrito** dentro dos textos do conteúdo.
const txt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const PAPEIS = {
  caixa: 'Caixa', garcom: 'Garçom', cozinha: 'Cozinha', gerente: 'Gerente', dono: 'Dono',
};

// Ícones de traço (24×24), no mesmo espírito dos ícones do app.
const ICONE = {
  usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.4 3.6-5 6.5-5s5.3 1.6 6.5 5"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.2c2.6.2 4.2 1.8 5 4.6"/>',
  dinheiro: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v5M18 9.5v5"/>',
  cartao: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 9.5h19M6 15h4"/>',
  pix: '<path d="M12 3l3.2 3.2a2 2 0 0 0 2.8 0L19 5.2M12 3 8.8 6.2a2 2 0 0 1-2.8 0L5 5.2"/><path d="M3 12l4.5-4.5L12 12l4.5-4.5L21 12l-4.5 4.5L12 12l-4.5 4.5z"/>',
  maquininha: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><rect x="8.5" y="5" width="7" height="5" rx="1"/><path d="M9 13.5h.01M12 13.5h.01M15 13.5h.01M9 16.5h.01M12 16.5h.01M15 16.5h.01"/>',
  carrinho: '<path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H6.4"/><circle cx="9" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>',
  busca: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5.5 5.5"/>',
  codigo: '<path d="M4 5v14M7 5v14M10.5 5v14M13 5v14M16.5 5v14M20 5v14"/>',
  grade: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  desfazer: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>',
  recibo: '<path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  estrela: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chef: '<path d="M7 14.5V20h10v-5.5"/><path d="M7 14.5a4 4 0 0 1-1.5-7.4A4.5 4.5 0 0 1 12 4a4.5 4.5 0 0 1 6.5 3.1A4 4 0 0 1 17 14.5z"/><path d="M7 17h10"/>',
  prato: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>',
  mesa: '<path d="M3 9h18M5 9v10M19 9v10M8 9v5h8V9"/>',
  celular: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  moto: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M9 17h6l-2.5-6H9M14 8h3l2 6"/>',
  conversa: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  globo: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
  tv: '<rect x="2.5" y="4.5" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 17v3.5"/>',
  grafico: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  caixa: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  etiqueta: '<path d="M3 12V3.5h8.5L21 13l-8 8z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  alerta: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  documento: '<path d="M6 2.5h8l4.5 4.5V21.5H6z"/><path d="M13.5 2.5V7.5h5M9 12h6M9 16h6"/>',
  engrenagem: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  chave: '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 9.3-9.3M17 6l2.5 2.5M14.5 8.5 17 11"/>',
  balanca: '<path d="M12 4v16M5 20h14M5 7h14"/><path d="M5 7 2.5 13a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
  calendario: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  pata: '<circle cx="7" cy="10" r="1.8"/><circle cx="11" cy="6.5" r="1.8"/><circle cx="16" cy="7" r="1.8"/><circle cx="18.5" cy="11.5" r="1.8"/><path d="M8.5 18c0-3 2-5.5 4.5-5.5s4 2 4 4.5c0 2-1.5 2.5-3 2.5s-2-.7-3-.7-1.5.7-2.5.7S8.5 19 8.5 18z"/>',
  oculos: '<circle cx="6.5" cy="14" r="3.5"/><circle cx="17.5" cy="14" r="3.5"/><path d="M10 14h4M3 14 4.5 7M21 14l-1.5-7"/>',
  remedio: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="m9.5 9.5 5 5"/>',
  ferramenta: '<path d="M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8M14.5 6.5 13 5 3 15l3 3"/>',
  pao: '<path d="M4 13a8 5 0 0 1 16 0v5H4z"/><path d="M8 10.5 9 13M12 10l.5 3M16 10.5 15 13"/>',
  tesoura: '<circle cx="6" cy="17" r="2.5"/><circle cx="6" cy="7" r="2.5"/><path d="M8 8.5 20 18M8 15.5 20 6"/>',
  insumo: '<path d="M7 3.5h10M8.5 3.5v3l-3 4.5v8.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V11l-3-4.5v-3"/><path d="M5.5 13h13"/>',
  lixo: '<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14"/>',
  paleta: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.3-1.6-1.3-2.8 0-1 .8-1.6 1.8-1.6h2.2a4 4 0 0 0 4-4c0-3.8-3.8-6.9-8.5-6.9z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="10.5" cy="7.5" r="1.1"/><circle cx="15" cy="7.8" r="1.1"/>',
  teclado: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  ajuda: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
  robo: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5M2.5 12.5v3M21.5 12.5v3"/>',
  escudo: '<path d="M12 3 5 6v5.5c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  impressora: '<path d="M7 8V3.5h10V8"/><rect x="3.5" y="8" width="17" height="8.5" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v.01M17 20.5h3.5v-3"/>',
  sino: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  lista: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  copia: '<rect x="8" y="8" width="12.5" height="12.5" rx="2"/><path d="M16 8V5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 4 5v9a1.5 1.5 0 0 0 1.5 1.5H8"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>',
  nuvem: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.7A3.7 3.7 0 0 1 17.5 18.5z"/>',
  setas: '<path d="M7 4 3.5 7.5 7 11M3.5 7.5h13M17 13l3.5 3.5L17 20M20.5 16.5h-13"/>',
};
const icone = (nome, tam = 26) => `<svg class="ic" width="${tam}" height="${tam}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONE[nome] || ICONE.check}</svg>`;

const LOGO = `<svg viewBox="0 0 128 128" class="logo"><rect width="128" height="128" rx="28" fill="#0f6e63"/><path d="M78 38 C58 38 44 52 44 70 C44 86 56 94 70 94 C79 94 86 89 86 89 L86 70 L66 70" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M48 66 L58 76 L78 52" fill="none" stroke="#d9a84e" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const chips = (papeis) => (papeis && papeis.length
  ? `<div class="papeis"><span>Para</span>${papeis.map((p) => `<b class="papel papel-${p}">${PAPEIS[p] || p}</b>`).join('')}</div>` : '');

function cabecalho(s) {
  return `<header>
    <div class="kicker">${s.novo ? '<b class="novo">Novo</b>' : ''}${esc(s.kicker || '')}</div>
    <h1>${txt(s.titulo)}</h1>
    ${chips(s.papeis)}
  </header>`;
}
const nota = (n) => (n ? `<div class="nota">${icone(n.icone || 'ajuda', 22)}<p>${txt(n.texto || n)}</p></div>` : '');

const MODELOS = {
  capa(s, d) {
    return `<section class="slide capa">
      <div class="capa-fundo"></div>
      <div class="capa-conteudo">
        <div class="capa-marca">${LOGO}<span>GerenciaAI</span></div>
        <p class="capa-kicker">Treinamento da equipe</p>
        <h1>${esc(d.nome)}</h1>
        <p class="capa-sub">${txt(d.subtitulo)}</p>
        <div class="capa-papeis">${(d.papeis || []).map((p) => `<span>${PAPEIS[p]}</span>`).join('')}</div>
      </div>
      <p class="capa-data">Atualizado em ${esc(d.atualizadoEm)}</p>
    </section>`;
  },
  agenda(s, d) {
    const secoes = d.secoes;
    // Seção com muitos itens (salão e cozinha) ocupa duas colunas, com a lista em duas colunas.
    const larga = (sec) => sec.itens.length > 7;
    const unidades = secoes.reduce((n, sec) => n + (larga(sec) ? 2 : 1), 0);
    return `<section class="slide">${cabecalho({ kicker: 'Roteiro', titulo: 'O que tem neste treinamento' })}
      <div class="agenda" style="grid-template-columns: repeat(${unidades}, 1fr)">
        ${secoes.map((sec, i) => `<div class="agenda-col${larga(sec) ? ' agenda-larga' : ''}">
          <div class="agenda-num">${i + 1}</div>
          <h3>${esc(sec.titulo)}</h3>
          <p class="agenda-papeis">${(sec.papeis || []).map((p) => PAPEIS[p]).join(' · ')}</p>
          <ul>${sec.itens.map((it) => `<li>${it.novo ? '<b class="novo-mini">Novo</b>' : ''}${esc(it.titulo)}</li>`).join('')}</ul>
        </div>`).join('')}
      </div>
      <p class="agenda-dica">Cada slide diz para quem é. Quem trabalha só no caixa pode pular a parte de gestão.</p>
    </section>`;
  },
  secao(s) {
    return `<section class="slide secao">
      <div class="secao-num">${String(s.numero).padStart(2, '0')}</div>
      <div class="secao-texto">
        <p class="capa-kicker">Parte ${s.numero}</p>
        <h1>${esc(s.titulo)}</h1>
        <p>${txt(s.texto || '')}</p>
        <div class="capa-papeis">${(s.papeis || []).map((p) => `<span>${PAPEIS[p]}</span>`).join('')}</div>
      </div>
    </section>`;
  },
  passos(s) {
    return `<section class="slide">${cabecalho(s)}
      <ol class="passos">${s.passos.map((p, i) => `<li><span class="passo-num">${i + 1}</span><div><h3>${txt(p.t)}</h3>${p.d ? `<p>${txt(p.d)}</p>` : ''}</div></li>`).join('')}</ol>
      ${nota(s.nota)}
    </section>`;
  },
  cards(s) {
    const n = s.cards.length;
    const colunas = s.colunas || (n === 4 ? 2 : Math.min(n, 3));
    return `<section class="slide">${cabecalho(s)}
      <div class="cards" style="grid-template-columns: repeat(${colunas}, 1fr)">
        ${s.cards.map((c) => `<div class="card${c.novo ? ' card-novo' : ''}">
          <div class="card-topo"><span class="card-ic">${icone(c.icone)}</span>${c.novo ? '<b class="novo-mini">Novo</b>' : ''}</div>
          <h3>${txt(c.t)}</h3><p>${txt(c.d)}</p>
        </div>`).join('')}
      </div>
      ${nota(s.nota)}
    </section>`;
  },
  imagem(s) {
    const lado = s.lado === 'esquerda' ? ' img-esquerda' : '';
    return `<section class="slide">${cabecalho(s)}
      <div class="com-imagem${lado}${s.larga ? ' img-larga' : ''}">
        <ul class="pontos">${s.pontos.map((p) => `<li>${icone('check', 20)}<span>${txt(p)}</span></li>`).join('')}</ul>
        <figure><div class="janela"><i></i><i></i><i></i></div><img src="${arquivo(`imagens/${s.imagem}`)}" alt=""></figure>
      </div>
      ${nota(s.nota)}
    </section>`;
  },
  teclas(s) {
    return `<section class="slide">${cabecalho(s)}
      <div class="teclas">${s.teclas.map(([k, d]) => `<div class="tecla-linha"><kbd>${esc(k)}</kbd><p>${txt(d)}</p></div>`).join('')}</div>
      ${nota(s.nota)}
    </section>`;
  },
  fim(s, d) {
    return `<section class="slide capa fim">
      <div class="capa-fundo"></div>
      <div class="capa-conteudo">
        <div class="capa-marca">${LOGO}<span>GerenciaAI</span></div>
        <h1>Pronto para o turno!</h1>
        <div class="fim-ajuda">
          ${[['ajuda', 'Botão de ajuda (?)', 'Reabre o tour guiado e a lista de atalhos.'],
    ['robo', 'IA tutora', 'O robô no canto da tela tira dúvida sobre qualquer parte do sistema.'],
    ['documento', 'Este treinamento', `Fica no ícone de formatura do PDV, sempre na versão de ${esc(d.nome)}.`]]
    .map(([ic, t, x]) => `<div>${icone(ic, 30)}<h3>${t}</h3><p>${x}</p></div>`).join('')}
        </div>
      </div>
    </section>`;
  },
};

const CSS = `
@font-face { font-family: Inter; font-weight: 400; src: url('${arquivo('fontes/Inter-Regular-latin.ttf')}'); }
@font-face { font-family: Inter; font-weight: 500; src: url('${arquivo('fontes/Inter-Medium-latin.ttf')}'); }
@font-face { font-family: Inter; font-weight: 600; src: url('${arquivo('fontes/Inter-SemiBold-latin.ttf')}'); }
@font-face { font-family: Inter; font-weight: 700; src: url('${arquivo('fontes/Inter-Bold-latin.ttf')}'); }
@font-face { font-family: Inter; font-weight: 800; src: url('${arquivo('fontes/Inter-ExtraBold-latin.ttf')}'); }
@page { size: 1280px 720px; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --verde: #0f6e63; --verde-esc: #0a4a43; --verde-cl: #e7f2f0; --ouro: #d9a84e; --ouro-cl: #fbf1dc; --tinta: #14302c; --cinza: #5b6b69; --linha: #dde7e5; }
html, body { background: #fff; font-family: Inter, 'Segoe UI', sans-serif; color: var(--tinta); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.slide { width: 1280px; height: 720px; position: relative; overflow: hidden; padding: 56px 72px 70px; page-break-after: always; break-after: page; display: flex; flex-direction: column; gap: 26px; }
.slide::after { content: attr(data-rodape); position: absolute; left: 72px; bottom: 26px; font-size: 13px; color: #8a9a97; letter-spacing: .01em; }
.slide::before { content: attr(data-pag); position: absolute; right: 72px; bottom: 26px; font-size: 13px; color: #8a9a97; font-weight: 600; }
header { position: relative; padding-right: 330px; }
.kicker { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--verde); margin-bottom: 10px; }
h1 { font-size: 44px; line-height: 1.12; font-weight: 800; letter-spacing: -.02em; }
h3 { font-size: 20px; font-weight: 700; letter-spacing: -.01em; }
p { font-size: 17px; line-height: 1.5; color: var(--cinza); }
strong { color: var(--tinta); font-weight: 700; }
.novo { background: var(--ouro); color: #3b2a07; padding: 4px 10px; border-radius: 999px; font-size: 12px; letter-spacing: .12em; }
.novo-mini { background: var(--ouro-cl); color: #80580f; padding: 2px 8px; border-radius: 999px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; font-weight: 800; margin-right: 6px; }
.papeis { position: absolute; right: 0; top: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; max-width: 320px; }
.papeis span { font-size: 12px; color: #8a9a97; text-transform: uppercase; letter-spacing: .12em; font-weight: 600; margin-right: 2px; }
.papel { font-size: 13px; font-weight: 700; padding: 5px 11px; border-radius: 999px; background: var(--verde-cl); color: var(--verde); }
.papel-garcom { background: #e9eefb; color: #2f4e9b; } .papel-cozinha { background: #fdeee6; color: #a24b1c; }
.papel-gerente { background: #f1ecfb; color: #5b3aa5; } .papel-dono { background: #f3efe6; color: #6b5420; }
.ic { flex-shrink: 0; }

.capa { padding: 0; color: #fff; justify-content: center; }
.capa::after, .capa::before { display: none; }
.capa-fundo { position: absolute; inset: 0; background: radial-gradient(1100px 600px at 85% 15%, #16897b 0%, transparent 60%), linear-gradient(135deg, #0b544c 0%, #0a3f39 100%); }
.capa-fundo::after { content: ''; position: absolute; right: -120px; bottom: -160px; width: 620px; height: 620px; border-radius: 50%; border: 70px solid rgba(217, 168, 78, .16); }
.capa-conteudo { position: relative; padding: 0 96px; }
.capa-marca { display: flex; align-items: center; gap: 14px; font-size: 24px; font-weight: 800; margin-bottom: 64px; }
.logo { width: 52px; height: 52px; }
.capa-kicker { color: var(--ouro); font-size: 16px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; margin-bottom: 14px; }
.capa h1 { font-size: 76px; letter-spacing: -.035em; line-height: 1; color: #fff; }
.capa-sub { color: #cfe5e1; font-size: 22px; max-width: 820px; margin-top: 20px; }
.capa-papeis { display: flex; gap: 8px; margin-top: 34px; flex-wrap: wrap; }
.capa-papeis span { border: 1.5px solid rgba(255,255,255,.35); color: #fff; padding: 7px 16px; border-radius: 999px; font-size: 15px; font-weight: 600; }
.capa-data { position: absolute; left: 96px; bottom: 44px; color: #9fc6bf; font-size: 15px; }

.secao { flex-direction: row; align-items: center; gap: 56px; padding: 0 96px; background: linear-gradient(135deg, #0b544c, #0a3f39); color: #fff; }
.secao::after, .secao::before { color: #7fb3aa; }
.secao-num { font-size: 230px; font-weight: 800; letter-spacing: -.06em; color: rgba(217, 168, 78, .9); line-height: 1; }
.secao h1 { font-size: 60px; color: #fff; letter-spacing: -.03em; }
.secao p { color: #cfe5e1; font-size: 21px; margin-top: 14px; max-width: 700px; }

.agenda { display: grid; gap: 18px; flex: 1; }
.agenda-col { background: #f6faf9; border: 1px solid var(--linha); border-radius: 16px; padding: 20px 20px 16px; }
.agenda-num { width: 34px; height: 34px; border-radius: 10px; background: var(--verde); color: #fff; font-weight: 800; display: grid; place-items: center; font-size: 16px; margin-bottom: 12px; }
.agenda-col h3 { font-size: 19px; }
.agenda-papeis { font-size: 12.5px; color: var(--verde); font-weight: 600; margin: 3px 0 10px; }
.agenda-col ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.agenda-col li { font-size: 15px; color: var(--tinta); line-height: 1.35; padding-left: 12px; position: relative; }
.agenda-col li::before { content: ''; position: absolute; left: 0; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--ouro); }
.agenda-dica { font-size: 14px; }
.agenda-larga { grid-column: span 2; }
.agenda-larga ul { display: block; columns: 2; column-gap: 22px; }
.agenda-larga li { break-inside: avoid; margin-bottom: 6px; }

.passos { list-style: none; display: flex; flex-direction: column; gap: 20px; flex: 1; justify-content: center; }
.passos li { display: flex; gap: 22px; align-items: flex-start; }
.passo-num { flex-shrink: 0; width: 50px; height: 50px; border-radius: 14px; background: var(--verde); color: #fff; font-size: 22px; font-weight: 800; display: grid; place-items: center; }
.passos h3 { font-size: 25px; margin-top: 2px; }
.passos p { margin-top: 4px; font-size: 18.5px; }

.cards { display: grid; gap: 18px; flex: 1; align-content: center; }
.card { background: #f6faf9; border: 1px solid var(--linha); border-radius: 18px; padding: 26px 26px 28px; display: flex; flex-direction: column; gap: 8px; }
.card-novo { background: linear-gradient(180deg, #fffaf0, #fbf3e2); border-color: #eedcb4; }
.card-topo { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.card-ic { width: 48px; height: 48px; border-radius: 14px; background: #fff; color: var(--verde); display: grid; place-items: center; box-shadow: 0 1px 2px rgba(15,110,99,.12), inset 0 0 0 1px var(--linha); }
.card h3 { font-size: 22px; }
.card p { font-size: 17.5px; line-height: 1.45; }

.com-imagem { display: grid; grid-template-columns: 1fr 1.35fr; gap: 36px; flex: 1; min-height: 0; align-items: center; }
.img-larga { grid-template-columns: 1fr 2fr; }
.img-esquerda figure { order: -1; }
.pontos { list-style: none; display: flex; flex-direction: column; gap: 16px; }
.pontos li { display: flex; gap: 12px; align-items: flex-start; font-size: 18.5px; line-height: 1.45; color: var(--tinta); }
.pontos li .ic { color: var(--verde); margin-top: 3px; }
figure { background: #fff; border-radius: 14px; box-shadow: 0 18px 40px rgba(10, 63, 57, .18), 0 0 0 1px var(--linha); overflow: hidden; max-height: 100%; display: flex; flex-direction: column; }
.janela { height: 26px; background: #eef3f2; display: flex; gap: 6px; align-items: center; padding: 0 12px; flex-shrink: 0; }
.janela i { width: 10px; height: 10px; border-radius: 50%; background: #cfdad8; }
figure img { width: 100%; display: block; object-fit: contain; object-position: top center; min-height: 0; background: #fff; }

.teclas { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 40px; flex: 1; align-content: center; }
.tecla-linha { display: flex; gap: 18px; align-items: center; }
kbd { min-width: 110px; text-align: center; font-family: inherit; font-size: 20px; font-weight: 700; padding: 10px 14px; border-radius: 10px; background: #fff; border: 1.5px solid #c9d6d3; box-shadow: 0 3px 0 #c9d6d3; color: var(--tinta); }
.tecla-linha p { font-size: 19px; }

.nota { display: flex; gap: 14px; align-items: flex-start; background: var(--ouro-cl); border-radius: 14px; padding: 14px 18px; color: #80580f; }
.nota p { color: #5c4210; font-size: 17px; }

.fim .capa-conteudo h1 { font-size: 64px; }
.fim-ajuda { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 40px; max-width: 1060px; }
.fim-ajuda div { border: 1.5px solid rgba(255,255,255,.22); border-radius: 18px; padding: 22px; color: var(--ouro); }
.fim-ajuda h3 { color: #fff; margin: 12px 0 4px; }
.fim-ajuda p { color: #cfe5e1; font-size: 15.5px; }
`;

/** HTML completo de um treinamento. */
function montarHtml(deck) {
  const total = deck.slides.length;
  const corpo = deck.slides.map((s, i) => {
    const html = MODELOS[s.tipo](s, deck);
    return html.replace('<section class="slide', `<section data-pag="${i + 1} / ${total}" data-rodape="GerenciaAI · Treinamento ${esc(deck.nome)}" class="slide`);
  }).join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Treinamento ${esc(deck.nome)}</title><style>${CSS}</style></head><body>${corpo}</body></html>`;
}

module.exports = { montarHtml, ICONE };
