import {
  formatarMoeda, unidadeFracionada, passoDa, quantidadeInicial, arred, formatarQuantidade, slugValido,
  itensDoCarrinho, totalDoCarrinho, montarMensagemPedido, linkWhatsapp, normalizar, PAGAMENTOS, montarPedidoDemo,
  PAGAMENTOS_LOJA, rotuloModo, modosOferecidos, montarPedidoLoja, hashTokenMesa, passosDoPedido, tempoRestante,
} from './loja-util.js';

/**
 * Vitrine online (loja.html?s=<endereço>) -- página pública da loja. Só
 * LÊ do Firestore (nada é gravado pelo público): o endereço em
 * vitrines/{endereço} (criado na Central, com o WhatsApp que recebe os
 * pedidos) e o catálogo publicado pelo computador da loja em
 * installations/{id}/vitrine (ver electron/services/vitrineService.js).
 * O pedido sai como mensagem pronta no WhatsApp da loja.
 *
 * Vitrine de DEMONSTRAÇÃO (vitrines/{endereço} com `demo`, criada na
 * Central): catálogo pronto do segmento publicado pela máquina de
 * demonstração em installations/{id}/vitrine/demo_<segmento>, e o pedido
 * é GRAVADO em installations/{id}/pedidos_vitrine (único caso em que a
 * página grava algo -- ver firestore.rules e vitrineDemoService.js); a
 * página acompanha até a loja confirmar o recebimento.
 *
 * Vitrine com "receber os pedidos direto no sistema" (config.pedidosOnline):
 * o pedido também é GRAVADO em installations/{id}/pedidos_vitrine (com nome,
 * retirada / comer aqui / entrega e a forma de pagamento) e a página
 * acompanha em pedidos_vitrine_status/{id}: Pix para pagar (pagamento
 * antecipado), senha, pronto. Pelo QR da mesa (?m=<segredo da mesa>) o
 * "comer aqui" vai para a comanda da mesa, na pessoa com o nome informado
 * (ver electron/services/vitrinePedidoService.js).
 *
 * Tudo que vem do Firestore passa por escapeHtml/Number antes de ir pro
 * HTML (o catálogo é gravado pela máquina sem login).
 */

// SDK do Firebase pelo npm (mesma versão de firebase-config.js, ver package.json),
// carregado só quando a página abre -- fica num arquivo separado do build.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};
const RECAPTCHA_ENTERPRISE_SITE_KEY = '6Lfl46otAAAAAOm70sNp8ZCdAqTZma6acynM4Dle'; // mesma de firebase-config.js

const raiz = document.getElementById('loja');

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

function aviso(titulo, texto) {
  document.title = titulo;
  raiz.innerHTML = `<div class="loja-aviso"><h1>${escapeHtml(titulo)}</h1><p>${escapeHtml(texto)}</p></div>`;
}

async function carregar(slug) {
  const { initializeApp } = await import('firebase/app');
  const F = await import('firebase/firestore');
  const app = initializeApp(FIREBASE_CONFIG, 'vitrine');
  try {
    const AC = await import('firebase/app-check');
    AC.initializeAppCheck(app, { provider: new AC.ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY), isTokenAutoRefreshEnabled: true });
  } catch { /* App Check é reforço; sem ele a leitura pública continua funcionando hoje */ }
  const db = F.getFirestore(app);

  const endereco = await F.getDoc(F.doc(db, 'vitrines', slug));
  if (!endereco.exists()) return { erro: ['Vitrine não encontrada', 'Confira o link com a loja.'] };
  const e = endereco.data();
  if (e.demo && typeof e.demo === 'object') return carregarDemo(F, db, slug, e);
  if (e.ativa === false || typeof e.installId !== 'string') return { erro: ['Vitrine fechada', 'A loja fechou a vitrine online por enquanto. Fale direto com ela.'] };
  const [config, catalogo] = await Promise.all([
    F.getDoc(F.doc(db, 'installations', e.installId, 'vitrine', 'config')),
    F.getDoc(F.doc(db, 'installations', e.installId, 'vitrine', 'catalogo')),
  ]);
  const c = config.exists() ? config.data() : null;
  if (!c || c.ativa === false) return { erro: ['Vitrine fechada', 'A loja fechou a vitrine online por enquanto. Fale direto com ela.'] };
  const itens = Array.isArray(catalogo.data()?.itens) ? catalogo.data().itens : [];
  const pedidosOnline = c.pedidosOnline === true;
  // QR da mesa: o link leva o segredo da mesa; a loja publica só o hash -> "Mesa 5".
  const tokenMesa = new URLSearchParams(location.search).get('m') || '';
  let mesaRotulo = null;
  let mesaInvalida = false;
  if (tokenMesa && pedidosOnline) {
    const h = await hashTokenMesa(tokenMesa).catch(() => null);
    const mapa = c.mesas && typeof c.mesas === 'object' ? c.mesas : {};
    if (h && typeof mapa[h] === 'string') mesaRotulo = mapa[h].slice(0, 30);
    else mesaInvalida = true;
  }
  return {
    F, db, slug, installId: e.installId, pedidosOnline,
    whatsapp: String(e.whatsapp || ''),
    nomeLoja: String(c.nomeLoja || 'Nossa loja').slice(0, 80),
    mensagem: String(c.mensagem || '').slice(0, 280),
    modos: modosOferecidos(c.modos, { mesaRotulo, pedidosOnline }),
    pedidoMinimo: Number(c.pedidoMinimo) > 0 ? Number(c.pedidoMinimo) : 0,
    pagamentoOnline: pedidosOnline && c.pagamentoOnline === true,
    mesaRotulo, mesaToken: mesaRotulo ? tokenMesa : null, mesaInvalida,
    produtos: produtosDoCatalogo(itens),
  };
}

// Só os campos esperados, com tipo conferido.
function produtosDoCatalogo(itens) {
  return (Array.isArray(itens) ? itens : []).filter((p) => p && typeof p.id === 'string' && typeof p.nome === 'string' && Number(p.preco) > 0).map((p) => ({
    id: p.id, nome: p.nome.slice(0, 120), categoria: typeof p.categoria === 'string' ? p.categoria.slice(0, 60) : null,
    preco: Number(p.preco), precoDe: Number(p.precoDe) > Number(p.preco) ? Number(p.precoDe) : null,
    unidade: typeof p.unidade === 'string' ? p.unidade.slice(0, 10) : 'un',
    disponibilidade: ['disponivel', 'poucas', 'esgotado'].includes(p.disponibilidade) ? p.disponibilidade : 'disponivel',
  }));
}

async function carregarDemo(F, db, slug, e) {
  const encerrada = ['Demonstração encerrada', 'Este link de demonstração não está mais ativo. Peça um novo a quem te apresentou o sistema.'];
  if (e.ativa === false || typeof e.installId !== 'string') return { erro: encerrada };
  const expiraMs = typeof e.demo.expiraEm?.toMillis === 'function' ? e.demo.expiraEm.toMillis() : 0;
  if (!(expiraMs > Date.now())) return { erro: encerrada };
  const segmento = typeof e.demo.segmento === 'string' && /^[a-z]{3,20}$/.test(e.demo.segmento) ? e.demo.segmento : null;
  if (!segmento) return { erro: encerrada };
  const catalogo = await F.getDoc(F.doc(db, 'installations', e.installId, 'vitrine', `demo_${segmento}`));
  return {
    demo: true, F, db, slug, installId: e.installId,
    nomeLoja: String(e.demo.nomeLoja || 'Loja de demonstração').slice(0, 80),
    mensagem: '',
    modos: ['retirada', 'entrega'],
    pedidoMinimo: 0,
    produtos: produtosDoCatalogo(catalogo.exists() ? catalogo.data().itens : []),
  };
}

/** Grava o pedido da demonstração e acompanha até a loja confirmar. */
async function enviarPedidoDemo(loja, dados) {
  const { F, db } = loja;
  const ref = F.doc(F.collection(db, 'installations', loja.installId, 'pedidos_vitrine'));
  await F.setDoc(ref, { ...montarPedidoDemo({ slug: loja.slug, ...dados }), criadoEm: F.serverTimestamp() });
  return ref;
}

function telaPedidoDemoEnviado(loja, ref, aoVoltar) {
  const fundo = document.createElement('div');
  fundo.className = 'loja-fundo loja-fundo-cheio';
  document.body.appendChild(fundo);
  let parar = () => {};
  let confirmado = false;
  let demora = null;
  const fechar = () => { parar(); clearTimeout(demora); fundo.remove(); aoVoltar(); };
  const render = (estado, detalhe) => {
    const recebido = estado === 'recebido';
    const erro = estado === 'erro';
    fundo.innerHTML = `
      <div class="loja-ok" role="dialog" aria-modal="true" aria-live="polite">
        <div class="loja-ok-icone ${erro ? 'loja-ok-icone-erro' : ''}">${erro ? '!' : (recebido ? '✓' : '<span class="loja-spinner"></span>')}</div>
        <h2>${erro ? 'A loja não registrou o pedido' : (recebido ? 'A loja recebeu seu pedido' : 'Pedido enviado')}</h2>
        <p>${erro ? escapeHtml(detalhe || 'Tente de novo.') : (recebido
          ? `${escapeHtml(loja.nomeLoja)} já está vendo o pedido na tela de separação.`
          : (detalhe ? escapeHtml(detalhe) : 'Aguardando o sistema da loja confirmar...'))}</p>
        <div class="loja-passos">
          <div class="loja-passo"><span class="loja-bola">✓</span> Pedido enviado</div>
          <div class="loja-passo ${recebido ? '' : 'pendente'}"><span class="loja-bola">${recebido ? '✓' : '2'}</span> Recebido pelo sistema da loja</div>
        </div>
        <button class="loja-secundario" id="ok-voltar">${erro ? 'Voltar' : 'Fazer outro pedido'}</button>
      </div>`;
    fundo.querySelector('#ok-voltar').addEventListener('click', fechar);
  };
  render('enviado');
  demora = setTimeout(() => {
    if (!confirmado) render('enviado', 'O pedido foi enviado, mas a loja ainda não confirmou. A máquina da demonstração precisa estar aberta e com internet.');
  }, 45000);
  parar = loja.F.onSnapshot(ref, (snap) => {
    const d = snap.data();
    if (d?.status === 'recebido') { confirmado = true; clearTimeout(demora); render('recebido'); }
    else if (d?.status === 'erro') { confirmado = true; clearTimeout(demora); render('erro', typeof d.erro === 'string' ? d.erro.slice(0, 200) : ''); }
  }, () => { /* sem leitura: fica a mensagem de enviado */ });
}

// ---------- pedido direto no sistema da loja ----------

const chavePedido = (slug) => `gerenciaai_vitrine_${slug}_pedido`;
const VALIDADE_ACOMPANHAMENTO_MS = 6 * 3600000;

function lerPedidoSalvo(slug) {
  try {
    const p = JSON.parse(localStorage.getItem(chavePedido(slug)) || 'null');
    if (p && /^[A-Za-z0-9]{20}$/.test(p.id) && Date.now() - Number(p.em) < VALIDADE_ACOMPANHAMENTO_MS) return p;
  } catch { /* sem armazenamento */ }
  return null;
}
function gravarPedidoSalvo(slug, p) {
  try { if (p) localStorage.setItem(chavePedido(slug), JSON.stringify(p)); else localStorage.removeItem(chavePedido(slug)); } catch { /* sem armazenamento */ }
}

/** Grava o pedido na loja (o id é gerado aqui: 20 letras, como a regra exige). */
async function enviarPedidoLoja(loja, dados) {
  const { F, db } = loja;
  const ref = F.doc(F.collection(db, 'installations', loja.installId, 'pedidos_vitrine'));
  await F.setDoc(ref, { ...montarPedidoLoja({ slug: loja.slug, mesaToken: loja.mesaToken, ...dados }), criadoEm: F.serverTimestamp() });
  return ref.id;
}

let audioCtx = null;
function avisarPronto() {
  try { navigator.vibrate?.([300, 120, 300, 120, 500]); } catch { /* sem vibração */ }
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tocar = (freq, inicio) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + inicio);
      g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + inicio + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + inicio + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + inicio);
      o.stop(audioCtx.currentTime + inicio + 0.4);
    };
    tocar(880, 0); tocar(1175, 0.4);
  } catch { /* sem som */ }
}

/**
 * Acompanha o pedido: confirmação de recebimento (pedidos_vitrine/{id}) e
 * etapa publicada pela loja (pedidos_vitrine_status/{id}): Pix, senha, pronto.
 */
function telaAcompanhamento(loja, salvo, aoVoltar) {
  const { F, db } = loja;
  const fundo = document.createElement('div');
  fundo.className = 'loja-fundo loja-fundo-cheio';
  document.body.appendChild(fundo);
  let statusDoc = 'novo';
  let erroDoc = '';
  let etapa = null;
  let avisouPronto = false;
  let relogio = null;
  const paradas = [];
  const fechar = (esquecer) => {
    paradas.forEach((p) => { try { p(); } catch { /* já parada */ } });
    clearInterval(relogio);
    if (esquecer) gravarPedidoSalvo(loja.slug, null);
    fundo.remove();
    aoVoltar();
  };

  const render = () => {
    const comMesa = !!salvo.mesa;
    const { fase, passos } = passosDoPedido({ statusDoc, etapa, comMesa, pixOnline: salvo.pagamento === 'pix_online' });
    const senha = Number.isInteger(etapa?.senha) ? etapa.senha : null;
    const encerrado = ['erro', 'cancelado', 'entregue', 'na_mesa', 'saiu'].includes(fase);
    let topo;
    if (fase === 'erro') {
      topo = `<div class="loja-ok-icone loja-ok-icone-erro">!</div><h2>A loja não registrou o pedido</h2><p>${escapeHtml(erroDoc || 'Tente de novo ou fale com um atendente.')}</p>`;
    } else if (fase === 'cancelado') {
      topo = `<div class="loja-ok-icone loja-ok-icone-erro">✕</div><h2>Pedido cancelado</h2><p>${escapeHtml(etapa?.motivo || 'A loja cancelou o pedido. Fale com um atendente.')}</p>`;
    } else if (fase === 'pagamento') {
      const pix = etapa?.pix || {};
      const resta = tempoRestante(pix.expiraEm);
      topo = `<h2>Pague com Pix para confirmar</h2>
        <p>${pix.valor ? `${formatarMoeda(pix.valor)}` : ''}${resta ? ` · vence em <span id="pix-resta">${resta}</span>` : ''}</p>
        ${typeof pix.qr === 'string' && pix.qr.startsWith('data:image/png;base64,') ? `<img class="loja-pix-qr" src="${escapeHtml(pix.qr)}" alt="QR Code Pix">` : (pix.gerando || !pix.copiaECola ? '<p><span class="loja-spinner"></span> Gerando o Pix...</p>' : '')}
        ${typeof pix.copiaECola === 'string' ? `<button class="loja-copiar" id="pix-copiar">Copiar código Pix</button>` : ''}
        <p class="loja-nota">Assim que o pagamento cair, a loja começa a preparar e você recebe a senha aqui.</p>`;
    } else if (senha != null && ['preparando', 'pronto', 'entregue'].includes(fase)) {
      topo = `<div class="loja-senha-rotulo">SUA SENHA</div>
        <div class="loja-senha ${fase === 'pronto' ? 'pronta' : ''}">${senha}</div>
        <h2>${fase === 'pronto' ? 'Pronto! Retire no balcão' : (fase === 'entregue' ? 'Pedido entregue. Bom apetite!' : 'Preparando seu pedido')}</h2>
        ${etapa?.pago ? '<span class="loja-selo loja-selo-ok">Pago no Pix</span>' : ''}`;
    } else if (fase === 'na_mesa') {
      topo = `<div class="loja-ok-icone">✓</div><h2>Pedido confirmado</h2><p>Lançado na ${escapeHtml(etapa?.mesa || 'sua mesa')}. É só aguardar.</p>`;
    } else if (fase === 'saiu') {
      topo = `<div class="loja-ok-icone">✓</div><h2>Saiu para entrega</h2><p>Seu pedido está a caminho.</p>`;
    } else {
      topo = `<div class="loja-ok-icone">${statusDoc === 'recebido' || etapa ? '✓' : '<span class="loja-spinner"></span>'}</div>
        <h2>${statusDoc === 'recebido' || etapa ? 'A loja recebeu seu pedido' : 'Pedido enviado'}</h2>
        <p>${statusDoc === 'recebido' || etapa ? (comMesa ? 'Um atendente confirma e lança na sua mesa.' : 'Um atendente vai confirmar e você recebe a senha aqui.') : 'Aguardando o sistema da loja confirmar...'}</p>`;
    }
    fundo.innerHTML = `
      <div class="loja-ok" role="dialog" aria-modal="true" aria-live="polite">
        ${topo}
        <div class="loja-passos">${passos.map((p, i) => `<div class="loja-passo ${p.feito ? '' : 'pendente'}"><span class="loja-bola">${p.feito ? '✓' : i + 1}</span> ${escapeHtml(p.texto)}</div>`).join('')}</div>
        ${!encerrado ? '<p class="loja-nota">Deixe esta página aberta: o celular vibra quando o pedido ficar pronto.</p>' : ''}
        <button class="loja-secundario" id="ok-voltar">${encerrado ? 'Fazer outro pedido' : 'Voltar ao cardápio'}</button>
      </div>`;
    fundo.querySelector('#ok-voltar').addEventListener('click', () => fechar(encerrado));
    const copiar = fundo.querySelector('#pix-copiar');
    if (copiar) {
      copiar.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(etapa.pix.copiaECola); copiar.textContent = 'Código copiado'; } catch { copiar.textContent = 'Não consegui copiar'; }
      });
    }
    if (fase === 'pronto' && !avisouPronto) { avisouPronto = true; avisarPronto(); }
  };

  render();
  relogio = setInterval(() => {
    const el = fundo.querySelector('#pix-resta');
    if (el && etapa?.pix?.expiraEm) el.textContent = tempoRestante(etapa.pix.expiraEm) || '00:00';
  }, 1000);
  paradas.push(F.onSnapshot(F.doc(db, 'installations', loja.installId, 'pedidos_vitrine', salvo.id), (snap) => {
    const d = snap.data();
    if (d?.status === 'recebido' || d?.status === 'erro') {
      statusDoc = d.status;
      erroDoc = typeof d.erro === 'string' ? d.erro.slice(0, 200) : '';
      render();
    }
  }, () => { /* sem leitura: segue com o que tem */ }));
  paradas.push(F.onSnapshot(F.doc(db, 'installations', loja.installId, 'pedidos_vitrine_status', salvo.id), (snap) => {
    if (!snap.exists()) return;
    etapa = snap.data();
    render();
  }, () => { /* sem leitura */ }));
}

function montar(slug, loja) {
  document.title = loja.nomeLoja;
  const chave = `gerenciaai_vitrine_${slug}`;
  const ler = () => { try { return JSON.parse(localStorage.getItem(chave) || '{}') || {}; } catch { return {}; } };
  const gravar = () => { try { localStorage.setItem(chave, JSON.stringify({ carrinho, cliente })); } catch { /* sem armazenamento */ } };
  const salvo = ler();
  let carrinho = typeof salvo.carrinho === 'object' && salvo.carrinho ? salvo.carrinho : {};
  const cliente = { nome: '', modo: loja.modos[0] || 'retirada', endereco: '', pagamento: '', trocoPara: '', ...(salvo.cliente || {}) };
  if (!loja.modos.includes(cliente.modo)) cliente.modo = loja.modos[0] || 'retirada';
  // Pelo QR da mesa, abre sempre em "comer aqui".
  if (loja.mesaRotulo) cliente.modo = 'local';
  const pedidoDireto = !loja.demo && loja.pedidosOnline;
  const pagamentos = Object.entries(PAGAMENTOS_LOJA).filter(([k]) => k !== 'pix_online' || loja.pagamentoOnline);
  // Primeira vez: com Pix pelo site, já sugere pagar agora (o cliente pode trocar).
  if (pedidoDireto && !pagamentos.some(([k]) => k === cliente.pagamento)) cliente.pagamento = loja.pagamentoOnline ? 'pix_online' : 'pix';
  if (!pedidoDireto && !Object.prototype.hasOwnProperty.call(PAGAMENTOS, cliente.pagamento)) cliente.pagamento = 'pix';
  let busca = '';
  let categoria = 'todas';

  const categorias = ['todas', ...new Set(loja.produtos.map((p) => p.categoria).filter(Boolean))];

  raiz.innerHTML = `
    ${loja.demo ? '<div class="loja-demo" role="note">Demonstração do GerenciaAI: o pedido vai direto para o sistema da loja. Nada é cobrado.</div>' : ''}
    <header class="loja-topo">
      <h1>${escapeHtml(loja.nomeLoja)}</h1>
      ${loja.mensagem ? `<p>${escapeHtml(loja.mensagem)}</p>` : ''}
      <p>${loja.demo || pedidoDireto ? 'Monte o pedido aqui. Ele chega na hora no sistema da loja.' : 'Monte o pedido aqui e envie pelo WhatsApp da loja.'}</p>
      ${loja.mesaRotulo ? `<span class="loja-mesa">${escapeHtml(loja.mesaRotulo)}</span>` : ''}
      ${loja.mesaInvalida ? '<p class="loja-erro">Este QR de mesa não vale mais. Você ainda pode pedir para retirar; para a mesa, chame um atendente.</p>' : ''}
    </header>
    <div id="acompanhar"></div>
    <div class="loja-busca"><input id="busca" type="search" placeholder="Buscar produto" aria-label="Buscar produto" autocomplete="off"></div>
    ${categorias.length > 2 ? `<div class="loja-chips" role="tablist">${categorias.map((c) => `<button class="loja-chip ${c === 'todas' ? 'ativo' : ''}" data-cat="${escapeHtml(c)}">${c === 'todas' ? 'Todos' : escapeHtml(c)}</button>`).join('')}</div>` : ''}
    <div id="lista"></div>
    <p class="loja-rodape">Vitrine feita com GerenciaAI</p>
    <div id="barra"></div>`;

  const lista = raiz.querySelector('#lista');
  const barra = raiz.querySelector('#barra');
  const acompanhar = raiz.querySelector('#acompanhar');

  function renderAcompanhar() {
    const p = pedidoDireto ? lerPedidoSalvo(slug) : null;
    if (!p) { acompanhar.innerHTML = ''; return; }
    acompanhar.innerHTML = '<button class="loja-acompanhar" id="btn-acompanhar">Acompanhar meu pedido</button>';
    acompanhar.querySelector('#btn-acompanhar').addEventListener('click', () => telaAcompanhamento(loja, p, () => { renderAcompanhar(); renderLista(); renderBarra(); }));
  }

  function quantidade(id) {
    return Number(carrinho[id]) || 0;
  }

  function mudar(produto, delta) {
    const atual = quantidade(produto.id);
    let novo = atual === 0 && delta > 0 ? quantidadeInicial(produto.unidade) : arred(atual + delta, 3);
    if (novo < (unidadeFracionada(produto.unidade) ? 0.1 : 1) - 1e-9) novo = 0;
    if (novo > 0) carrinho[produto.id] = novo; else delete carrinho[produto.id];
    gravar();
    renderLista();
    renderBarra();
  }

  function itemHtml(p) {
    const q = quantidade(p.id);
    const esgotado = p.disponibilidade === 'esgotado';
    return `
      <div class="loja-item ${esgotado ? 'esgotado' : ''}">
        <div class="loja-item-info">
          <div class="loja-item-nome">${escapeHtml(p.nome)}</div>
          <div class="loja-item-preco">${p.precoDe ? `<s>${formatarMoeda(p.precoDe)}</s>` : ''}${formatarMoeda(p.preco)}${unidadeFracionada(p.unidade) ? `<small>/${escapeHtml(p.unidade)}</small>` : ''}</div>
          ${p.disponibilidade === 'poucas' ? '<span class="loja-selo">Poucas unidades</span>' : ''}
        </div>
        ${esgotado ? '<button class="loja-add" disabled>Esgotado</button>'
          : (q > 0
            ? `<div class="loja-qtd"><button data-menos="${escapeHtml(p.id)}" aria-label="Diminuir">−</button><span>${escapeHtml(formatarQuantidade(q, p.unidade))}</span><button data-mais="${escapeHtml(p.id)}" aria-label="Aumentar">+</button></div>`
            : `<button class="loja-add" data-mais="${escapeHtml(p.id)}" aria-label="Adicionar ${escapeHtml(p.nome)}">+</button>`)}
      </div>`;
  }

  function renderLista() {
    const termo = normalizar(busca);
    const filtrados = loja.produtos.filter((p) => (categoria === 'todas' || p.categoria === categoria) && (!termo || normalizar(p.nome).includes(termo)));
    if (!filtrados.length) { lista.innerHTML = `<p class="loja-vazio">${loja.produtos.length ? 'Nenhum produto encontrado.' : 'A loja ainda não publicou produtos.'}</p>`; return; }
    const grupos = new Map();
    for (const p of filtrados) {
      const g = p.categoria || 'Outros';
      if (!grupos.has(g)) grupos.set(g, []);
      grupos.get(g).push(p);
    }
    lista.innerHTML = [...grupos.entries()].map(([g, ps]) => `
      ${grupos.size > 1 ? `<div class="loja-categoria">${escapeHtml(g)}</div>` : ''}
      <div class="loja-lista">${ps.map(itemHtml).join('')}</div>`).join('');
    const porId = new Map(loja.produtos.map((p) => [p.id, p]));
    lista.querySelectorAll('[data-mais]').forEach((b) => b.addEventListener('click', () => { const p = porId.get(b.dataset.mais); mudar(p, passoDa(p.unidade)); }));
    lista.querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => { const p = porId.get(b.dataset.menos); mudar(p, -passoDa(p.unidade)); }));
  }

  function renderBarra() {
    const itens = itensDoCarrinho(carrinho, loja.produtos);
    if (!itens.length) { barra.innerHTML = ''; return; }
    barra.innerHTML = `<div class="loja-barra"><button id="ver-pedido"><span>${itens.length} ${itens.length === 1 ? 'item' : 'itens'}</span><span>Ver pedido · ${formatarMoeda(totalDoCarrinho(itens))}</span></button></div>`;
    barra.querySelector('#ver-pedido').addEventListener('click', abrirPedido);
  }

  function abrirPedido() {
    const fundo = document.createElement('div');
    fundo.className = 'loja-fundo';
    document.body.appendChild(fundo);
    const fechar = () => { fundo.remove(); renderLista(); renderBarra(); };
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });

    const render = () => {
      const itens = itensDoCarrinho(carrinho, loja.produtos);
      if (!itens.length) { fechar(); return; }
      const total = totalDoCarrinho(itens);
      fundo.innerHTML = `
        <div class="loja-sheet" role="dialog" aria-modal="true" aria-label="Seu pedido">
          <h2>Seu pedido</h2>
          <div>${itens.map((i) => `
            <div class="loja-linha">
              <span class="loja-linha-nome">${escapeHtml(i.nome)}</span>
              <span class="loja-qtd"><button data-menos="${escapeHtml(i.id)}" aria-label="Diminuir">−</button><span>${escapeHtml(formatarQuantidade(i.quantidade, i.unidade))}</span><button data-mais="${escapeHtml(i.id)}" aria-label="Aumentar">+</button></span>
              <span class="loja-linha-total">${formatarMoeda(i.total)}</span>
            </div>`).join('')}</div>
          <div class="loja-total"><span>Total estimado</span><span>${formatarMoeda(total)}</span></div>
          ${loja.pedidoMinimo && total < loja.pedidoMinimo ? `<p class="loja-erro">Pedido mínimo da loja: ${formatarMoeda(loja.pedidoMinimo)}.</p>` : ''}
          <label>Seu nome<input id="p-nome" maxlength="60" autocomplete="name" value="${escapeHtml(cliente.nome)}"></label>
          ${loja.modos.length > 1 ? `<div class="loja-opcoes" role="radiogroup" aria-label="Como receber">
            ${loja.modos.map((m) => `<button data-modo="${escapeHtml(m)}" class="${cliente.modo === m ? 'ativo' : ''}" role="radio" aria-checked="${cliente.modo === m}">${escapeHtml(rotuloModo(m, loja.mesaRotulo))}</button>`).join('')}</div>`
            : `<p class="loja-nota">${escapeHtml(cliente.modo === 'entrega' ? 'A loja entrega.' : (cliente.modo === 'local' ? rotuloModo('local', loja.mesaRotulo) : 'Retirada na loja.'))}</p>`}
          ${cliente.modo === 'local' && !loja.mesaRotulo ? '<p class="loja-nota">Você recebe uma senha e retira no balcão quando chamar.</p>' : ''}
          ${cliente.modo === 'entrega' ? `<label>Endereço de entrega<textarea id="p-endereco" rows="2" maxlength="200" autocomplete="street-address">${escapeHtml(cliente.endereco)}</textarea></label>` : ''}
          ${cliente.modo === 'local' && loja.mesaRotulo
            ? '<p class="loja-nota"><strong>Pagamento:</strong> na conta da mesa, no final.</p>'
            : `<label>Pagamento<select id="p-pagamento">${(pedidoDireto ? pagamentos : Object.entries(PAGAMENTOS)).map(([k, v]) => `<option value="${escapeHtml(k)}" ${cliente.pagamento === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select></label>`}
          ${cliente.pagamento === 'dinheiro' ? `<label>Troco para quanto? (opcional)<input id="p-troco" inputmode="decimal" maxlength="10" value="${escapeHtml(cliente.trocoPara)}" placeholder="Ex: 50"></label>` : ''}
          <label>Observação (opcional)<input id="p-obs" maxlength="200" placeholder="Ex: pão bem assado"></label>
          <p id="p-erro" class="loja-erro" hidden></p>
          <button class="loja-enviar ${loja.demo || pedidoDireto ? 'loja-enviar-demo' : ''}" id="p-enviar">${loja.demo || pedidoDireto ? (cliente.pagamento === 'pix_online' && !(cliente.modo === 'local' && loja.mesaRotulo) ? 'Enviar e pagar com Pix' : 'Enviar pedido para a loja') : 'Enviar pedido pelo WhatsApp'}</button>
          <button class="loja-secundario" id="p-voltar">Continuar escolhendo</button>
          <p class="loja-nota">${loja.demo
            ? 'Demonstração: o pedido aparece no sistema da loja em segundos. Nada é cobrado.'
            : (pedidoDireto ? 'O pedido chega no sistema da loja e você acompanha por aqui. Valem os preços da loja.'
              : 'O pedido abre no seu WhatsApp, já escrito, para você enviar à loja. A loja confirma valores e disponibilidade.')}</p>
        </div>`;
      const $ = (s) => fundo.querySelector(s);
      const lerCampos = () => {
        cliente.nome = ($('#p-nome')?.value || '').trim().slice(0, 60);
        if ($('#p-endereco')) cliente.endereco = $('#p-endereco').value.trim().slice(0, 200);
        if ($('#p-pagamento')) cliente.pagamento = $('#p-pagamento').value || 'pix';
        if ($('#p-troco')) cliente.trocoPara = $('#p-troco').value.trim().slice(0, 10);
        gravar();
      };
      const porId = new Map(loja.produtos.map((p) => [p.id, p]));
      fundo.querySelectorAll('[data-mais]').forEach((b) => b.addEventListener('click', () => { lerCampos(); const p = porId.get(b.dataset.mais); carrinho[p.id] = arred(quantidade(p.id) + passoDa(p.unidade), 3); gravar(); render(); }));
      fundo.querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => {
        lerCampos();
        const p = porId.get(b.dataset.menos);
        const novo = arred(quantidade(p.id) - passoDa(p.unidade), 3);
        if (novo < (unidadeFracionada(p.unidade) ? 0.1 : 1) - 1e-9) delete carrinho[p.id]; else carrinho[p.id] = novo;
        gravar();
        render();
      }));
      fundo.querySelectorAll('[data-modo]').forEach((b) => b.addEventListener('click', () => { lerCampos(); cliente.modo = b.dataset.modo; render(); }));
      $('#p-pagamento')?.addEventListener('change', () => { lerCampos(); render(); });
      $('#p-voltar').addEventListener('click', () => { lerCampos(); fechar(); });
      $('#p-enviar').addEventListener('click', async () => {
        lerCampos();
        const erro = $('#p-erro');
        const falhar = (t) => { erro.textContent = t; erro.hidden = false; };
        if (cliente.nome.length < 2) return falhar('Escreva seu nome.');
        if (cliente.modo === 'entrega' && cliente.endereco.length < 6) return falhar('Escreva o endereço de entrega.');
        if (loja.pedidoMinimo && total < loja.pedidoMinimo) return falhar(`O pedido mínimo é ${formatarMoeda(loja.pedidoMinimo)}.`);
        if (pedidoDireto) {
          const botao = $('#p-enviar');
          botao.disabled = true;
          botao.textContent = 'Enviando...';
          const pagamento = cliente.modo === 'local' && loja.mesaRotulo ? 'mesa' : cliente.pagamento;
          try {
            const id = await enviarPedidoLoja(loja, {
              itens, nome: cliente.nome, modo: cliente.modo, endereco: cliente.endereco,
              pagamento, trocoPara: cliente.trocoPara, observacao: ($('#p-obs')?.value || ''),
            });
            const salvoPedido = { id, em: Date.now(), pagamento, mesa: cliente.modo === 'local' && !!loja.mesaRotulo };
            gravarPedidoSalvo(slug, salvoPedido);
            carrinho = {};
            gravar();
            fundo.remove();
            renderLista();
            renderBarra();
            renderAcompanhar();
            telaAcompanhamento(loja, salvoPedido, () => { renderAcompanhar(); renderLista(); renderBarra(); });
          } catch (err) {
            console.error('[vitrine] envio falhou', err);
            botao.disabled = false;
            botao.textContent = 'Enviar pedido para a loja';
            falhar(err?.code === 'permission-denied'
              ? 'A loja não está recebendo pedidos pelo site agora. Fale com um atendente.'
              : 'Não consegui enviar. Confira sua internet e tente de novo.');
          }
          return;
        }
        if (loja.demo) {
          const botao = $('#p-enviar');
          botao.disabled = true;
          botao.textContent = 'Enviando...';
          try {
            const ref = await enviarPedidoDemo(loja, {
              itens, nome: cliente.nome, modo: cliente.modo, endereco: cliente.endereco,
              pagamento: cliente.pagamento, trocoPara: cliente.trocoPara, observacao: ($('#p-obs')?.value || ''),
            });
            carrinho = {};
            gravar();
            fundo.remove();
            renderLista();
            renderBarra();
            telaPedidoDemoEnviado(loja, ref, () => { renderLista(); renderBarra(); });
          } catch (err) {
            console.error('[vitrine demo] envio falhou', err);
            botao.disabled = false;
            botao.textContent = 'Enviar pedido para a loja';
            falhar(err?.code === 'permission-denied'
              ? 'A demonstração não está mais aberta. Peça um novo link a quem te apresentou o sistema.'
              : 'Não consegui enviar. Confira sua internet e tente de novo.');
          }
          return;
        }
        const texto = montarMensagemPedido({
          nomeLoja: loja.nomeLoja, itens, nome: cliente.nome, modo: cliente.modo, endereco: cliente.endereco,
          pagamento: cliente.pagamento, trocoPara: Number(String(cliente.trocoPara).replace(',', '.')) || 0, observacao: ($('#p-obs')?.value || '').trim().slice(0, 200),
        });
        const link = linkWhatsapp(loja.whatsapp, texto);
        if (!link) return falhar('A loja ainda não informou o WhatsApp de pedidos.');
        window.location.href = link;
      });
    };
    render();
  }

  raiz.querySelector('#busca').addEventListener('input', (e) => { busca = e.target.value; renderLista(); });
  raiz.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    categoria = b.dataset.cat;
    raiz.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('ativo', x === b));
    renderLista();
  }));
  renderLista();
  renderBarra();
  renderAcompanhar();
  // Voltou para a página com um pedido em andamento: abre o acompanhamento.
  const emAndamento = pedidoDireto ? lerPedidoSalvo(slug) : null;
  if (emAndamento) telaAcompanhamento(loja, emAndamento, () => { renderAcompanhar(); renderLista(); renderBarra(); });
}

(async () => {
  const slug = new URLSearchParams(location.search).get('s') || '';
  if (!slugValido(slug)) { aviso('Vitrine não encontrada', 'Confira o link com a loja.'); return; }
  try {
    const loja = await carregar(slug);
    if (loja.erro) { aviso(...loja.erro); return; }
    montar(slug, loja);
  } catch (err) {
    console.error('[vitrine]', err);
    aviso('Não foi possível abrir a vitrine', 'Confira sua internet e tente de novo.');
  }
})();
