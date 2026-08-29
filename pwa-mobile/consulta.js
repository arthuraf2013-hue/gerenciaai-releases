import { auth, db, firestoreFns } from './firebase-config.js';
import { icon } from './icons.js';

const formatarMoeda = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Mesmo cálculo de "dia local" (America/Sao_Paulo) que
 * salesSyncService.calcularDiaISO usa no desktop pra gravar `diaISO`
 * em grupos_sincronizacao/{grupoId}/vendas/{saleId} -- precisa bater
 * exatamente, senão a consulta filtraria o dia errado perto da virada
 * da meia-noite. */
function hojeLocalISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

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
 * entre várias lojas paradas no mesmo celular ("dono de rede").
 *
 * GRUPO DE SINCRONIZAÇÃO (múltiplos PDVs da MESMA loja, ex: 2 caixas
 * compartilhando estoque -- ver syncStateService.js/CLAUDE.md): pareado
 * com QUALQUER terminal do grupo, o resumo financeiro (faturamento,
 * vendas, ticket médio) é AUTOMATICAMENTE agregado de todos os
 * terminais do grupo, sem precisar parear em cada um -- usa
 * grupos_sincronizacao/{grupoId}/vendas (já sincronizado ali por
 * salesSyncService.js pro relatório consolidado do desktop, e já
 * aberto pra leitura nas regras -- PARTE 1). `installations/{id}`
 * também é leitura aberta, então descobrir os terminais do grupo não
 * exige nenhuma regra nova.
 *
 * Mesas/pedidos em andamento continuam mostrando só o terminal
 * PAREADO -- esse dado é local de cada terminal (não existe hoje uma
 * sincronização de mesas/pedidos entre terminais do grupo, só de
 * estoque/produtos/vendas), então agregá-lo ficaria fora do escopo
 * desta mudança; a seção deixa isso explícito no rótulo.
 */
function mount(root, { loja, lojas, onTrocarLoja, onParearOutra, onEsquecerLoja }) {
  let status = null;
  let ultimaAtualizacaoMs = null;
  let grupoId = null;
  let lojasDoGrupo = null; // [{installId, nomeNegocio}] -- null enquanto não descobriu, [] se não tem grupo
  let resumoGrupo = null; // { faturamentoHoje, totalVendasHoje, ticketMedioHoje, porLoja: Map<installId, {nomeNegocio, faturamento, vendas}> }

  root.innerHTML = `
    <div class="app-shell">
      <header class="topo">
        <div>
          <div class="nome-loja">${escapeHtml(loja.nomeNegocio)}</div>
          <div class="subtexto">${escapeHtml(loja.vinculoNome)} · <span id="tempo-atualizacao">--</span></div>
        </div>
        <button id="btn-menu-topo" class="btn-icone" aria-label="Menu">${icon('menu')}</button>
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
      <button class="item-menu" id="btn-renomear-dispositivo">Renomear este celular</button>
      <button class="item-menu" id="btn-parear-outra">Parear outra loja</button>
      <button class="item-menu item-menu-perigo" id="btn-esquecer">Esquecer esta loja neste celular</button>
    `;
    btnMenu.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    menu.querySelectorAll('[data-trocar]').forEach((b) => b.addEventListener('click', () => onTrocarLoja(b.dataset.trocar)));
    menu.querySelector('#btn-renomear-dispositivo').addEventListener('click', renomearDispositivo);
    menu.querySelector('#btn-parear-outra').addEventListener('click', onParearOutra);
    menu.querySelector('#btn-esquecer').addEventListener('click', () => {
      if (confirm('Isso só remove essa loja da lista deste celular -- não afeta o acesso no servidor. Continuar?')) onEsquecerLoja();
    });
  }

  /** Ver comentário equivalente em garcom.js -- mesmo padrão, mesma
   * regra do Firestore (o próprio celular só pode alterar
   * ultimoAcesso/nomeDispositivo no seu doc de dispositivo). */
  async function renomearDispositivo() {
    const sugestao = `${loja.vinculoNome || 'Celular'} — ${navigator.platform || 'celular'}`;
    const novoNome = prompt('Nome deste celular (aparece pro gerente em Configurações → Celular):', sugestao);
    if (novoNome === null) return;
    const nome = novoNome.trim();
    if (!nome) return;
    try {
      await firestoreFns.updateDoc(
        firestoreFns.doc(db, 'installations', loja.installId, 'dispositivos', auth.currentUser.uid),
        { nomeDispositivo: nome }
      );
    } catch (err) {
      console.error('[consulta] falha ao renomear dispositivo', err);
      alert('Não foi possível salvar agora. Confira sua internet e tente de novo.');
    }
  }

  function temGrupoDeVerdade() {
    return Array.isArray(lojasDoGrupo) && lojasDoGrupo.length > 1;
  }

  function render() {
    const conteudo = root.querySelector('#conteudo-consulta');
    if (!status) { conteudo.innerHTML = `<p class="estado-vazio">Carregando...</p>`; return; }

    // Com grupo de verdade (mais de 1 terminal), o resumo financeiro é o
    // AGREGADO de todos os terminais (resumoGrupo, vindo da agregação de
    // grupos_sincronizacao/{grupoId}/vendas) -- senão, cai no resumo de
    // sempre, só deste terminal (status.resumoHoje).
    const resumo = temGrupoDeVerdade() && resumoGrupo
      ? resumoGrupo
      : (status.resumoHoje || { totalVendasHoje: 0, faturamentoHoje: 0, ticketMedioHoje: 0 });
    const mesas = status.mesas || [];
    const mesasOcupadas = mesas.filter((m) => m.status === 'ocupada');
    const pedidos = status.pedidosEmAndamento || [];

    conteudo.innerHTML = `
      ${temGrupoDeVerdade() ? `<p class="subtexto" style="margin-bottom:8px;">Resumo financeiro agregado de ${lojasDoGrupo.length} terminais deste grupo.</p>` : ''}
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

      ${temGrupoDeVerdade() && resumoGrupo ? `
        <h2 class="titulo-secao">Por terminal</h2>
        <div class="lista-pedidos-andamento">
          ${lojasDoGrupo.map((l) => {
            const dessaLoja = resumoGrupo.porLoja.get(l.installId) || { faturamento: 0, vendas: 0 };
            return `
              <div class="cartao-pedido">
                <div>${escapeHtml(l.nomeNegocio)}</div>
                <div class="subtexto">${dessaLoja.vendas} venda${dessaLoja.vendas === 1 ? '' : 's'} · ${formatarMoeda(dessaLoja.faturamento)}</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      ${status.perfilAtivo === 'restaurante' ? `
        <h2 class="titulo-secao">Mesas${temGrupoDeVerdade() ? ` — ${escapeHtml(loja.nomeNegocio)}` : ''} (${mesasOcupadas.length} ocupada${mesasOcupadas.length === 1 ? '' : 's'} de ${mesas.length})</h2>
        <div class="grid-mesas">
          ${mesas.length === 0 ? '<p class="estado-vazio">Nenhuma mesa cadastrada.</p>' : mesas.map((m) => `
            <div class="cartao-mesa ${m.status === 'ocupada' ? 'cartao-mesa-ocupada' : ''}">
              <div class="numero-mesa">Mesa ${escapeHtml(m.numero)}</div>
              ${m.status === 'ocupada' ? `<div class="total-mesa">${formatarMoeda(m.totalAtual)}</div>` : `<div class="subtexto">${rotuloStatusMesa(m.status)}</div>`}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <h2 class="titulo-secao">Pedidos em andamento${temGrupoDeVerdade() ? ` — ${escapeHtml(loja.nomeNegocio)}` : ''} (${pedidos.length})</h2>
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

  let pararEscutaVendas = null;

  /** Descobre se este terminal pertence a um grupo de sincronização e,
   * se pertencer a um com MAIS de um membro, liga a escuta agregada de
   * vendas do dia (grupos_sincronizacao/{grupoId}/vendas) -- leitura
   * aberta nas regras (PARTE 1), sem exigir pareamento novo em cada
   * terminal do grupo. `installations/{id}` também é leitura aberta. */
  async function descobrirGrupo() {
    try {
      const instSnap = await firestoreFns.getDoc(firestoreFns.doc(db, 'installations', loja.installId));
      grupoId = (instSnap.exists() && instSnap.data().grupoSincronizacaoId) || null;
      if (!grupoId) { lojasDoGrupo = []; return; }

      const q = firestoreFns.query(
        firestoreFns.collection(db, 'installations'),
        firestoreFns.where('grupoSincronizacaoId', '==', grupoId)
      );
      const snap = await firestoreFns.getDocs(q);
      lojasDoGrupo = snap.docs.map((d) => ({ installId: d.id, nomeNegocio: d.data().nomeNegocio || 'Loja' }));

      if (lojasDoGrupo.length <= 1) return; // "grupo" de 1 só -- nada a agregar

      const hoje = hojeLocalISO();
      const nomesPorInstall = new Map(lojasDoGrupo.map((l) => [l.installId, l.nomeNegocio]));
      const vendasQ = firestoreFns.query(
        firestoreFns.collection(db, 'grupos_sincronizacao', grupoId, 'vendas'),
        firestoreFns.where('diaISO', '==', hoje)
      );
      pararEscutaVendas = firestoreFns.onSnapshot(
        vendasQ,
        (snapVendas) => {
          const porLoja = new Map();
          let faturamentoHoje = 0;
          let totalVendasHoje = 0;
          snapVendas.forEach((docVenda) => {
            const v = docVenda.data();
            faturamentoHoje += v.total || 0;
            totalVendasHoje += 1;
            const atual = porLoja.get(v.installId) || { nomeNegocio: nomesPorInstall.get(v.installId) || v.locationNome || 'Loja', faturamento: 0, vendas: 0 };
            atual.faturamento += v.total || 0;
            atual.vendas += 1;
            porLoja.set(v.installId, atual);
          });
          resumoGrupo = {
            faturamentoHoje, totalVendasHoje,
            ticketMedioHoje: totalVendasHoje > 0 ? faturamentoHoje / totalVendasHoje : 0,
            porLoja,
          };
          render();
        },
        (err) => console.error('[consulta] escuta de vendas do grupo falhou', err)
      );
    } catch (err) {
      console.error('[consulta] falha ao descobrir grupo de sincronização', err);
      lojasDoGrupo = [];
    }
  }
  descobrirGrupo();

  return () => {
    pararEscutaStatus();
    if (pararEscutaVendas) pararEscutaVendas();
    clearInterval(intervaloRelativo);
  };
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

export { mount };
