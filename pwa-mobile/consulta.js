import { auth, db, firestoreFns } from './firebase-config.js';

const formatarMoeda = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function formatarRelativo(ms) {
  if (!ms) return '';
  const segundos = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (segundos < 60) return `há ${segundos}s`;
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  return `há ${Math.floor(minutos / 60)} h`;
}

/** Tela de consulta remota (Adm/Gerente): resumo financeiro do dia +
 * operação ao vivo (mesas, pedidos em andamento), lendo direto de
 * installations/{installId}/status_ao_vivo/atual -- publicado a cada
 * ~25s pelo desktop (ver liveStatusSyncService.js). Suporta trocar
 * entre várias lojas paradas no mesmo celular ("dono de rede"). */
function mount(root, { loja, lojas, onTrocarLoja, onParearOutra, onEsquecerLoja }) {
  let status = null;
  let ultimaAtualizacaoMs = null;

  root.innerHTML = `
    <div class="app-shell">
      <header class="topo">
        <div>
          <div class="nome-loja">${escapeHtml(loja.nomeNegocio)}</div>
          <div class="subtexto">${escapeHtml(loja.vinculoNome)} · <span id="tempo-atualizacao">--</span></div>
        </div>
        <button id="btn-menu-topo" class="btn-icone" aria-label="Menu">⋮</button>
      </header>
      <div id="menu-topo" class="menu-suspenso" hidden></div>
      <div id="conteudo-consulta"><p class="estado-vazio">Carregando...</p></div>
    </div>
  `;

  montarMenuTopo();

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

  function render() {
    const conteudo = root.querySelector('#conteudo-consulta');
    if (!status) { conteudo.innerHTML = `<p class="estado-vazio">Carregando...</p>`; return; }

    const resumo = status.resumoHoje || { totalVendasHoje: 0, faturamentoHoje: 0, ticketMedioHoje: 0 };
    const mesas = status.mesas || [];
    const mesasOcupadas = mesas.filter((m) => m.status === 'ocupada');
    const pedidos = status.pedidosEmAndamento || [];

    conteudo.innerHTML = `
      <div class="grid-resumo">
        <div class="cartao-metrica">
          <div class="rotulo-metrica">Faturamento hoje</div>
          <div class="valor-metrica">${formatarMoeda(resumo.faturamentoHoje)}</div>
        </div>
        <div class="cartao-metrica">
          <div class="rotulo-metrica">Vendas hoje</div>
          <div class="valor-metrica">${resumo.totalVendasHoje}</div>
        </div>
        <div class="cartao-metrica">
          <div class="rotulo-metrica">Ticket médio</div>
          <div class="valor-metrica">${formatarMoeda(resumo.ticketMedioHoje)}</div>
        </div>
      </div>

      ${status.perfilAtivo === 'restaurante' ? `
        <h2 class="titulo-secao">Mesas (${mesasOcupadas.length} ocupada${mesasOcupadas.length === 1 ? '' : 's'} de ${mesas.length})</h2>
        <div class="grid-mesas">
          ${mesas.length === 0 ? '<p class="estado-vazio">Nenhuma mesa cadastrada.</p>' : mesas.map((m) => `
            <div class="cartao-mesa ${m.status === 'ocupada' ? 'cartao-mesa-ocupada' : ''}">
              <div class="numero-mesa">Mesa ${escapeHtml(m.numero)}</div>
              ${m.status === 'ocupada' ? `<div class="total-mesa">${formatarMoeda(m.totalAtual)}</div>` : `<div class="subtexto">${rotuloStatusMesa(m.status)}</div>`}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <h2 class="titulo-secao">Pedidos em andamento (${pedidos.length})</h2>
      <div class="lista-pedidos-andamento">
        ${pedidos.length === 0 ? '<p class="estado-vazio">Nenhum pedido em andamento.</p>' : pedidos.map((p) => `
          <div class="cartao-pedido">
            <div>
              <div>${escapeHtml(p.clienteNome || 'Cliente')}</div>
              <div class="subtexto">${p.tipoEntrega === 'entrega' ? 'Entrega' : 'Retirada'}</div>
            </div>
            <span class="pilula status-pendente">${rotuloStatusPedido(p.status)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function rotuloStatusMesa(status) {
    return { livre: 'Livre', aguardando_limpeza: 'Aguardando limpeza' }[status] || status;
  }

  function rotuloStatusPedido(status) {
    return { novo: 'Novo', em_separacao: 'Em separação', pronto: 'Pronto' }[status] || status;
  }

  function atualizarTempoRelativo() {
    const el = root.querySelector('#tempo-atualizacao');
    if (el) el.textContent = ultimaAtualizacaoMs ? `atualizado ${formatarRelativo(ultimaAtualizacaoMs)}` : 'conectando...';
  }

  const pararEscutaStatus = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'status_ao_vivo', 'atual'),
    (snap) => {
      if (!snap.exists()) { status = null; render(); return; }
      status = snap.data();
      ultimaAtualizacaoMs = status.atualizadoEm?.toMillis ? status.atualizadoEm.toMillis() : Date.now();
      render();
      atualizarTempoRelativo();
    },
    (err) => console.error('[consulta] escuta de status ao vivo falhou', err)
  );

  const intervaloRelativo = setInterval(atualizarTempoRelativo, 1000);

  firestoreFns.setDoc(
    firestoreFns.doc(db, 'installations', loja.installId, 'dispositivos', auth.currentUser.uid),
    { ultimoAcesso: firestoreFns.serverTimestamp() },
    { merge: true }
  ).catch(() => {});

  return () => {
    pararEscutaStatus();
    clearInterval(intervaloRelativo);
  };
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

export { mount };
