import {
  formatarMoeda, unidadeFracionada, passoDa, quantidadeInicial, arred, formatarQuantidade, slugValido,
  itensDoCarrinho, totalDoCarrinho, montarMensagemPedido, linkWhatsapp, normalizar, PAGAMENTOS,
} from './loja-util.js';

/**
 * Vitrine online (loja.html?s=<endereço>) -- página pública da loja. Só
 * LÊ do Firestore (nada é gravado pelo público): o endereço em
 * vitrines/{endereço} (criado na Central, com o WhatsApp que recebe os
 * pedidos) e o catálogo publicado pelo computador da loja em
 * installations/{id}/vitrine (ver electron/services/vitrineService.js).
 * O pedido sai como mensagem pronta no WhatsApp da loja.
 *
 * Tudo que vem do Firestore passa por escapeHtml/Number antes de ir pro
 * HTML (o catálogo é gravado pela máquina sem login).
 */

const FIREBASE_SDK_VERSION = '11.10.0'; // mesma de firebase-config.js
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
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`);
  const app = initializeApp(FIREBASE_CONFIG, 'vitrine');
  try {
    const AC = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-check.js`);
    AC.initializeAppCheck(app, { provider: new AC.ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY), isTokenAutoRefreshEnabled: true });
  } catch { /* App Check é reforço; sem ele a leitura pública continua funcionando hoje */ }
  const db = F.getFirestore(app);

  const endereco = await F.getDoc(F.doc(db, 'vitrines', slug));
  if (!endereco.exists()) return { erro: ['Vitrine não encontrada', 'Confira o link com a loja.'] };
  const e = endereco.data();
  if (e.ativa === false || typeof e.installId !== 'string') return { erro: ['Vitrine fechada', 'A loja fechou a vitrine online por enquanto. Fale direto com ela.'] };
  const [config, catalogo] = await Promise.all([
    F.getDoc(F.doc(db, 'installations', e.installId, 'vitrine', 'config')),
    F.getDoc(F.doc(db, 'installations', e.installId, 'vitrine', 'catalogo')),
  ]);
  const c = config.exists() ? config.data() : null;
  if (!c || c.ativa === false) return { erro: ['Vitrine fechada', 'A loja fechou a vitrine online por enquanto. Fale direto com ela.'] };
  const itens = Array.isArray(catalogo.data()?.itens) ? catalogo.data().itens : [];
  return {
    whatsapp: String(e.whatsapp || ''),
    nomeLoja: String(c.nomeLoja || 'Nossa loja').slice(0, 80),
    mensagem: String(c.mensagem || '').slice(0, 280),
    modos: (Array.isArray(c.modos) ? c.modos : []).filter((m) => m === 'retirada' || m === 'entrega'),
    pedidoMinimo: Number(c.pedidoMinimo) > 0 ? Number(c.pedidoMinimo) : 0,
    // Só os campos esperados, com tipo conferido.
    produtos: itens.filter((p) => p && typeof p.id === 'string' && typeof p.nome === 'string' && Number(p.preco) > 0).map((p) => ({
      id: p.id, nome: p.nome.slice(0, 120), categoria: typeof p.categoria === 'string' ? p.categoria.slice(0, 60) : null,
      preco: Number(p.preco), precoDe: Number(p.precoDe) > Number(p.preco) ? Number(p.precoDe) : null,
      unidade: typeof p.unidade === 'string' ? p.unidade.slice(0, 10) : 'un',
      disponibilidade: ['disponivel', 'poucas', 'esgotado'].includes(p.disponibilidade) ? p.disponibilidade : 'disponivel',
    })),
  };
}

function montar(slug, loja) {
  document.title = loja.nomeLoja;
  const chave = `gerenciaai_vitrine_${slug}`;
  const ler = () => { try { return JSON.parse(localStorage.getItem(chave) || '{}') || {}; } catch { return {}; } };
  const gravar = () => { try { localStorage.setItem(chave, JSON.stringify({ carrinho, cliente })); } catch { /* sem armazenamento */ } };
  const salvo = ler();
  let carrinho = typeof salvo.carrinho === 'object' && salvo.carrinho ? salvo.carrinho : {};
  const cliente = { nome: '', modo: loja.modos[0] || 'retirada', endereco: '', pagamento: 'pix', trocoPara: '', ...(salvo.cliente || {}) };
  if (!loja.modos.includes(cliente.modo)) cliente.modo = loja.modos[0] || 'retirada';
  let busca = '';
  let categoria = 'todas';

  const categorias = ['todas', ...new Set(loja.produtos.map((p) => p.categoria).filter(Boolean))];

  raiz.innerHTML = `
    <header class="loja-topo">
      <h1>${escapeHtml(loja.nomeLoja)}</h1>
      ${loja.mensagem ? `<p>${escapeHtml(loja.mensagem)}</p>` : ''}
      <p>Monte o pedido aqui e envie pelo WhatsApp da loja.</p>
    </header>
    <div class="loja-busca"><input id="busca" type="search" placeholder="Buscar produto" aria-label="Buscar produto" autocomplete="off"></div>
    ${categorias.length > 2 ? `<div class="loja-chips" role="tablist">${categorias.map((c) => `<button class="loja-chip ${c === 'todas' ? 'ativo' : ''}" data-cat="${escapeHtml(c)}">${c === 'todas' ? 'Todos' : escapeHtml(c)}</button>`).join('')}</div>` : ''}
    <div id="lista"></div>
    <p class="loja-rodape">Vitrine feita com GerenciaAI</p>
    <div id="barra"></div>`;

  const lista = raiz.querySelector('#lista');
  const barra = raiz.querySelector('#barra');

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
            <button data-modo="retirada" class="${cliente.modo === 'retirada' ? 'ativo' : ''}" role="radio" aria-checked="${cliente.modo === 'retirada'}">Retirar na loja</button>
            <button data-modo="entrega" class="${cliente.modo === 'entrega' ? 'ativo' : ''}" role="radio" aria-checked="${cliente.modo === 'entrega'}">Entrega</button></div>`
            : `<p class="loja-nota">${cliente.modo === 'entrega' ? 'A loja entrega.' : 'Retirada na loja.'}</p>`}
          ${cliente.modo === 'entrega' ? `<label>Endereço de entrega<textarea id="p-endereco" rows="2" maxlength="200" autocomplete="street-address">${escapeHtml(cliente.endereco)}</textarea></label>` : ''}
          <label>Pagamento<select id="p-pagamento">${Object.entries(PAGAMENTOS).map(([k, v]) => `<option value="${escapeHtml(k)}" ${cliente.pagamento === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select></label>
          ${cliente.pagamento === 'dinheiro' ? `<label>Troco para quanto? (opcional)<input id="p-troco" inputmode="decimal" maxlength="10" value="${escapeHtml(cliente.trocoPara)}" placeholder="Ex: 50"></label>` : ''}
          <label>Observação (opcional)<input id="p-obs" maxlength="200" placeholder="Ex: pão bem assado"></label>
          <p id="p-erro" class="loja-erro" hidden></p>
          <button class="loja-enviar" id="p-enviar">Enviar pedido pelo WhatsApp</button>
          <button class="loja-secundario" id="p-voltar">Continuar escolhendo</button>
          <p class="loja-nota">O pedido abre no seu WhatsApp, já escrito, para você enviar à loja. A loja confirma valores e disponibilidade.</p>
        </div>`;
      const $ = (s) => fundo.querySelector(s);
      const lerCampos = () => {
        cliente.nome = ($('#p-nome')?.value || '').trim().slice(0, 60);
        if ($('#p-endereco')) cliente.endereco = $('#p-endereco').value.trim().slice(0, 200);
        cliente.pagamento = $('#p-pagamento')?.value || 'pix';
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
      $('#p-pagamento').addEventListener('change', () => { lerCampos(); render(); });
      $('#p-voltar').addEventListener('click', () => { lerCampos(); fechar(); });
      $('#p-enviar').addEventListener('click', () => {
        lerCampos();
        const erro = $('#p-erro');
        const falhar = (t) => { erro.textContent = t; erro.hidden = false; };
        if (cliente.nome.length < 2) return falhar('Escreva seu nome.');
        if (cliente.modo === 'entrega' && cliente.endereco.length < 6) return falhar('Escreva o endereço de entrega.');
        if (loja.pedidoMinimo && total < loja.pedidoMinimo) return falhar(`O pedido mínimo é ${formatarMoeda(loja.pedidoMinimo)}.`);
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
