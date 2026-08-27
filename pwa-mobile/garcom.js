import { auth, db, firestoreFns } from './firebase-config.js';

const formatarMoeda = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Tela do garçom: escolher mesa, montar o pedido a partir do catálogo
 * publicado em status_ao_vivo/atual (ver liveStatusSyncService.js) e
 * mandar pra installations/{installId}/pedidos_garcom -- o desktop
 * converte em comanda de verdade (ver pedidoGarcomSyncService.js).
 *
 * O SDK do Firestore já foi inicializado com cache local persistente
 * (ver firebase-config.js) -- então addDoc() funciona e resolve mesmo
 * sem internet (fica na fila local e sincroniza sozinho depois); é essa
 * a "fila offline" pedida, sem precisar escrever fila nenhuma à mão.
 */
function mount(root, { loja, lojas, onTrocarLoja, onParearOutra, onEsquecerLoja }) {
  let status = { catalogoProdutos: [], mesas: [], nomeNegocio: loja.nomeNegocio, perfilAtivo: null };
  let mesaSelecionada = null;
  let categoriaAtiva = 'todas';
  let busca = '';
  const carrinho = new Map(); // productId -> { produto, quantidade }
  let abaAtiva = 'novo'; // 'novo' | 'meus-pedidos'

  root.innerHTML = `
    <div class="app-shell">
      <header class="topo">
        <div>
          <div class="nome-loja">${escapeHtml(status.nomeNegocio)}</div>
          <div class="subtexto">Garçom: ${escapeHtml(loja.vinculoNome)}</div>
        </div>
        <button id="btn-menu-topo" class="btn-icone" aria-label="Menu">⋮</button>
      </header>
      <div id="menu-topo" class="menu-suspenso" hidden></div>

      <nav class="abas">
        <button class="aba ativa" data-aba="novo">Novo pedido</button>
        <button class="aba" data-aba="meus-pedidos">Meus pedidos</button>
      </nav>

      <div id="conteudo-aba"></div>

      <div id="carrinho-flutuante" class="carrinho-flutuante" hidden></div>
    </div>
  `;

  montarMenuTopo();
  root.querySelectorAll('.aba').forEach((btn) => {
    btn.addEventListener('click', () => {
      abaAtiva = btn.dataset.aba;
      root.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b === btn));
      renderAbaAtiva();
    });
  });

  function montarMenuTopo() {
    const btnMenu = root.querySelector('#btn-menu-topo');
    const menu = root.querySelector('#menu-topo');
    let itensTroca = '';
    if (lojas.length > 1) {
      itensTroca = lojas
        .filter((l) => l.installId !== loja.installId)
        .map((l) => `<button class="item-menu" data-trocar="${escapeHtml(l.installId)}">Trocar pra ${escapeHtml(l.nomeNegocio)}</button>`)
        .join('');
    }
    menu.innerHTML = `
      ${itensTroca}
      <button class="item-menu" id="btn-parear-outra">Parear outra loja</button>
      <button class="item-menu item-menu-perigo" id="btn-esquecer">Esquecer esta loja neste celular</button>
    `;
    btnMenu.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    menu.querySelectorAll('[data-trocar]').forEach((b) => b.addEventListener('click', () => onTrocarLoja(b.dataset.trocar)));
    menu.querySelector('#btn-parear-outra').addEventListener('click', onParearOutra);
    menu.querySelector('#btn-esquecer').addEventListener('click', () => {
      if (confirm('Isso só remove essa loja da lista deste celular -- não afeta o acesso no servidor. Continuar?')) onEsquecerLoja();
    });
  }

  function renderAbaAtiva() {
    if (abaAtiva === 'novo') renderNovoPedido();
    else renderMeusPedidos();
  }

  // ---------- Aba "novo pedido" ----------

  function renderNovoPedido() {
    const conteudo = root.querySelector('#conteudo-aba');
    const categorias = ['todas', ...new Set(status.catalogoProdutos.map((p) => p.categoria).filter(Boolean))];

    conteudo.innerHTML = `
      ${status.perfilAtivo === 'restaurante' ? renderSeletorMesa() : ''}
      <div class="busca-produtos">
        <input id="input-busca" type="search" placeholder="Buscar produto..." value="${escapeHtml(busca)}" />
      </div>
      <div class="chips-categoria">
        ${categorias.map((c) => `<button class="chip ${c === categoriaAtiva ? 'chip-ativo' : ''}" data-cat="${escapeHtml(c)}">${c === 'todas' ? 'Todas' : escapeHtml(c)}</button>`).join('')}
      </div>
      <div id="grid-produtos" class="grid-produtos"></div>
    `;

    conteudo.querySelector('#input-busca').addEventListener('input', (e) => { busca = e.target.value; renderGridProdutos(); });
    conteudo.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => { categoriaAtiva = btn.dataset.cat; renderNovoPedido(); });
    });

    if (status.perfilAtivo === 'restaurante') {
      conteudo.querySelectorAll('[data-mesa]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          mesaSelecionada = btn.dataset.mesa === '__sem_mesa__' ? null : btn.dataset.mesa;
          renderNovoPedido();
        });
      });
    }

    renderGridProdutos();
    renderCarrinhoFlutuante();
  }

  function renderSeletorMesa() {
    const mesas = status.mesas || [];
    const chipsMesas = mesas.map((m) => {
      const ocupada = m.status === 'ocupada';
      const limpeza = m.status === 'aguardando_limpeza';
      const ativa = mesaSelecionada === m.numero;
      return `<button class="chip-mesa ${ativa ? 'chip-mesa-ativa' : ''} ${ocupada ? 'chip-mesa-ocupada' : ''}"
                data-mesa="${escapeHtml(m.numero)}" ${limpeza ? 'disabled' : ''}>
                Mesa ${escapeHtml(m.numero)}${m.nome ? ' · ' + escapeHtml(m.nome) : ''}
              </button>`;
    }).join('');
    return `
      <div class="seletor-mesa">
        <div class="rotulo">Mesa</div>
        <div class="chips-mesa">
          <button class="chip-mesa ${mesaSelecionada === null ? 'chip-mesa-ativa' : ''}" data-mesa="__sem_mesa__">Sem mesa (retirada/entrega)</button>
          ${chipsMesas}
        </div>
      </div>
    `;
  }

  function renderGridProdutos() {
    const grid = root.querySelector('#grid-produtos');
    if (!grid) return;
    const termo = busca.trim().toLowerCase();
    const produtos = status.catalogoProdutos.filter((p) => {
      if (categoriaAtiva !== 'todas' && p.categoria !== categoriaAtiva) return false;
      if (termo && !p.nome.toLowerCase().includes(termo)) return false;
      return true;
    });

    if (produtos.length === 0) {
      grid.innerHTML = `<p class="estado-vazio">Nenhum produto encontrado.</p>`;
      return;
    }

    grid.innerHTML = produtos.map((p) => {
      const noCarrinho = carrinho.get(p.id);
      return `
        <button class="cartao-produto" data-produto="${escapeHtml(p.id)}">
          <span class="nome-produto">${escapeHtml(p.nome)}</span>
          <span class="preco-produto">${formatarMoeda(p.preco)}</span>
          ${noCarrinho ? `<span class="badge-qtd">${noCarrinho.quantidade}</span>` : ''}
        </button>
      `;
    }).join('');

    grid.querySelectorAll('[data-produto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const produto = status.catalogoProdutos.find((p) => p.id === btn.dataset.produto);
        adicionarAoCarrinho(produto);
      });
    });
  }

  function adicionarAoCarrinho(produto) {
    const atual = carrinho.get(produto.id);
    carrinho.set(produto.id, { produto, quantidade: (atual?.quantidade || 0) + 1 });
    renderGridProdutos();
    renderCarrinhoFlutuante();
  }

  function renderCarrinhoFlutuante() {
    const el = root.querySelector('#carrinho-flutuante');
    if (!el) return;
    const totalItens = [...carrinho.values()].reduce((s, i) => s + i.quantidade, 0);
    if (totalItens === 0) { el.hidden = true; return; }
    el.hidden = false;
    const totalValor = [...carrinho.values()].reduce((s, i) => s + i.quantidade * i.produto.preco, 0);
    el.innerHTML = `
      <button id="btn-abrir-carrinho" class="btn-carrinho">
        <span>${totalItens} ${totalItens === 1 ? 'item' : 'itens'}</span>
        <span>${formatarMoeda(totalValor)}</span>
        <span>Ver pedido →</span>
      </button>
    `;
    el.querySelector('#btn-abrir-carrinho').addEventListener('click', renderModalCarrinho);
  }

  function renderModalCarrinho() {
    const modal = document.createElement('div');
    modal.className = 'modal-fundo';
    const linhas = [...carrinho.values()].map(({ produto, quantidade }) => `
      <div class="linha-carrinho">
        <div>
          <div>${escapeHtml(produto.nome)}</div>
          <div class="subtexto">${formatarMoeda(produto.preco)} un.</div>
        </div>
        <div class="controles-qtd">
          <button data-menos="${escapeHtml(produto.id)}">−</button>
          <span>${quantidade}</span>
          <button data-mais="${escapeHtml(produto.id)}">+</button>
        </div>
      </div>
    `).join('');
    const total = [...carrinho.values()].reduce((s, i) => s + i.quantidade * i.produto.preco, 0);

    modal.innerHTML = `
      <div class="modal-caixa">
        <h2>Seu pedido</h2>
        ${status.perfilAtivo === 'restaurante' ? `<p class="subtexto">${mesaSelecionada ? 'Mesa ' + escapeHtml(mesaSelecionada) : 'Sem mesa (retirada/entrega)'}</p>` : ''}
        <div id="linhas-carrinho">${linhas}</div>
        <textarea id="obs-pedido" placeholder="Observações (opcional)"></textarea>
        <div class="total-carrinho">Total: <strong>${formatarMoeda(total)}</strong></div>
        <p id="msg-erro-envio" class="msg-erro" hidden></p>
        <button id="btn-enviar-pedido" class="btn-primario">Enviar pedido</button>
        <button id="btn-fechar-modal" class="btn-secundario">Continuar comprando</button>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-mais]').forEach((b) => b.addEventListener('click', () => {
      const item = carrinho.get(b.dataset.mais);
      item.quantidade += 1;
      modal.remove(); renderModalCarrinho();
    }));
    modal.querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => {
      const item = carrinho.get(b.dataset.menos);
      item.quantidade -= 1;
      if (item.quantidade <= 0) carrinho.delete(b.dataset.menos);
      modal.remove(); renderModalCarrinho();
    }));
    modal.querySelector('#btn-fechar-modal').addEventListener('click', () => {
      modal.remove();
      if (carrinho.size === 0) { renderGridProdutos(); renderCarrinhoFlutuante(); }
    });
    modal.querySelector('#btn-enviar-pedido').addEventListener('click', () => enviarPedido(modal));
  }

  async function enviarPedido(modal) {
    const btn = modal.querySelector('#btn-enviar-pedido');
    const msgErro = modal.querySelector('#msg-erro-envio');
    msgErro.hidden = true;
    if (carrinho.size === 0) return;
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    const observacoes = modal.querySelector('#obs-pedido').value.trim() || null;
    const itens = [...carrinho.values()].map(({ produto, quantidade }) => ({
      productId: produto.id, nome: produto.nome, quantidade, precoUnitario: produto.preco,
    }));

    try {
      await firestoreFns.addDoc(
        firestoreFns.collection(db, 'installations', loja.installId, 'pedidos_garcom'),
        {
          garcomUid: auth.currentUser.uid,
          mesaNumero: mesaSelecionada || null,
          itens, observacoes,
          status: 'novo',
          criadoEm: firestoreFns.serverTimestamp(),
        }
      );
      // addDoc já resolveu (mesmo offline, fica na fila local -- ver
      // comentário no topo do arquivo) -- pode limpar e avisar sucesso.
      carrinho.clear();
      mesaSelecionada = null;
      modal.remove();
      mostrarToast('Pedido enviado!');
      renderNovoPedido();
    } catch (err) {
      console.error('[garcom] falha ao enviar pedido', err);
      msgErro.textContent = 'Não foi possível enviar agora. Tente de novo.';
      msgErro.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Enviar pedido';
    }
  }

  // ---------- Aba "meus pedidos" ----------

  let pararEscutaMeusPedidos = null;

  function renderMeusPedidos() {
    const conteudo = root.querySelector('#conteudo-aba');
    conteudo.innerHTML = `<div id="lista-meus-pedidos"><p class="estado-vazio">Carregando...</p></div>`;
    if (pararEscutaMeusPedidos) pararEscutaMeusPedidos();

    const q = firestoreFns.query(
      firestoreFns.collection(db, 'installations', loja.installId, 'pedidos_garcom'),
      firestoreFns.where('garcomUid', '==', auth.currentUser.uid),
      firestoreFns.orderBy('criadoEm', 'desc'),
      firestoreFns.limit(20)
    );
    pararEscutaMeusPedidos = firestoreFns.onSnapshot(q, (snap) => {
      const lista = conteudo.querySelector('#lista-meus-pedidos');
      if (!lista) return;
      if (snap.empty) { lista.innerHTML = `<p class="estado-vazio">Nenhum pedido enviado ainda.</p>`; return; }
      lista.innerHTML = snap.docs.map((d) => {
        const p = d.data();
        const statusLabel = { novo: 'Enviado, aguardando', recebido: 'Recebido na loja', erro: 'Erro — avise o gerente' }[p.status] || p.status;
        const statusClasse = { novo: 'status-pendente', recebido: 'status-ok', erro: 'status-erro' }[p.status] || '';
        const totalItens = (p.itens || []).reduce((s, i) => s + (i.quantidade || 0), 0);
        return `
          <div class="cartao-pedido">
            <div>
              <div>${p.mesaNumero ? 'Mesa ' + escapeHtml(p.mesaNumero) : 'Sem mesa'} · ${totalItens} ${totalItens === 1 ? 'item' : 'itens'}</div>
              ${p.erro ? `<div class="subtexto erro-texto">${escapeHtml(p.erro)}</div>` : ''}
            </div>
            <span class="pilula ${statusClasse}">${statusLabel}</span>
          </div>
        `;
      }).join('');
    }, (err) => console.error('[garcom] escuta de meus pedidos falhou', err));
  }

  function mostrarToast(texto) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = texto;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  // ---------- Assinatura do status ao vivo (catálogo + mesas) ----------

  const pararEscutaStatus = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'status_ao_vivo', 'atual'),
    (snap) => {
      if (!snap.exists()) return;
      status = snap.data();
      root.querySelector('.nome-loja').textContent = status.nomeNegocio || loja.nomeNegocio;
      if (abaAtiva === 'novo') renderNovoPedido();
    },
    (err) => console.error('[garcom] escuta de status ao vivo falhou', err)
  );

  // Heartbeat -- atualiza "visto por último" pro gerente ver em
  // Configurações → Celular (só os dois campos que a regra permite).
  firestoreFns.setDoc(
    firestoreFns.doc(db, 'installations', loja.installId, 'dispositivos', auth.currentUser.uid),
    { ultimoAcesso: firestoreFns.serverTimestamp() },
    { merge: true }
  ).catch(() => {});

  renderNovoPedido();

  return () => {
    pararEscutaStatus();
    if (pararEscutaMeusPedidos) pararEscutaMeusPedidos();
  };
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

export { mount };
