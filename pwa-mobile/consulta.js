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

/** "Hoje menos N dias" no fuso de São Paulo, mesmo critério de
 * hojeLocalISO() acima (e de timeService.diasAPartirDeHojeLocalISO no
 * desktop) -- usada só pra montar o intervalo de datas do histórico do
 * GRUPO (a consulta solo já vem pronta de historico_vendas/atual, ver
 * historySyncService.js, não precisa calcular intervalo aqui). */
function diaLocalISOAtras(diasAtras) {
  const [ano, mes, dia] = hojeLocalISO().split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia - diasAtras)).toISOString().slice(0, 10);
}

const PERIODOS_HISTORICO = { ultimos7: 7, ultimos30: 30 };

const ROTULO_PAPEL = {
  operador: 'Operador de caixa', gerente: 'Gerente', admin: 'Administrador',
  garcom: 'Garçom', suporte: 'Suporte',
};

function formatarRelativo(ms) {
  if (!ms) return '';
  const segundos = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (segundos < 60) return `há ${segundos}s`;
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  return `há ${Math.floor(minutos / 60)} h`;
}

/** Agrega os documentos crus de grupos_sincronizacao/{grupoId}/vendas
 * (ver salesSyncService.pushSale/republicarHistoricoCompleto -- cada um
 * é UMA venda, com itens e nome do operador) no MESMO formato que
 * historySyncService.getResumoPeriodo já publica pro terminal solo em
 * historico_vendas/atual -- assim a seção "Histórico" do render()
 * abaixo usa o mesmo template pros dois casos, sem duplicar HTML.
 * DELIBERADAMENTE sem custo/margem, mesmo critério de historySyncService. */
function agregarVendasDoGrupo(vendas) {
  let totalFaturado = 0;
  const porDia = new Map();
  const porProduto = new Map();
  const porOperador = new Map();

  for (const v of vendas) {
    const total = v.total || 0;
    totalFaturado += total;

    const dia = porDia.get(v.diaISO) || { dia: v.diaISO, total: 0 };
    dia.total += total;
    porDia.set(v.diaISO, dia);

    const chaveOperador = v.operadorNome || '—';
    const operador = porOperador.get(chaveOperador) || { operador: chaveOperador, totalVendas: 0, totalVendido: 0 };
    operador.totalVendas += 1;
    operador.totalVendido += total;
    porOperador.set(chaveOperador, operador);

    for (const item of v.itens || []) {
      const p = porProduto.get(item.nome) || { nome: item.nome, quantidade: 0, valorTotal: 0 };
      p.quantidade += item.quantidade || 0;
      p.valorTotal += (item.quantidade || 0) * (item.precoUnitario || 0);
      porProduto.set(item.nome, p);
    }
  }

  const totalVendas = vendas.length;
  return {
    totalVendas,
    totalFaturado,
    ticketMedio: totalVendas > 0 ? totalFaturado / totalVendas : 0,
    vendasPorDia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    topProdutos: [...porProduto.values()].sort((a, b) => b.quantidade - a.quantidade).slice(0, 8),
    porOperador: [...porOperador.values()].sort((a, b) => b.totalVendido - a.totalVendido),
  };
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
 *
 * HISTÓRICO (últimos 7/30 dias, com seletor de período): terminal SOLO
 * lê installations/{id}/historico_vendas/atual (publicado a cada ~10min
 * pelo desktop, ver historySyncService.js) -- é a forma que funciona
 * pra QUALQUER instalação, mesmo sem grupo de sincronização (a maioria
 * das lojas é solo e nunca escreve em grupos_sincronizacao/). Com grupo
 * de verdade, agrega direto de grupos_sincronizacao/{grupoId}/vendas
 * filtrando por diaISO (mesma coleção/leitura aberta que o resumo "hoje"
 * já usa acima) -- ver agregarVendasDoGrupo().
 */
function mount(root, { loja, lojas, onTrocarLoja, onParearOutra, onEsquecerLoja }) {
  let status = null;
  let ultimaAtualizacaoMs = null;
  let grupoId = null;
  let lojasDoGrupo = null; // [{installId, nomeNegocio}] -- null enquanto não descobriu, [] se não tem grupo
  let resumoGrupo = null; // { faturamentoHoje, totalVendasHoje, ticketMedioHoje, porLoja: Map<installId, {nomeNegocio, faturamento, vendas}> }
  let usuarios = []; // [{id, nome, role, ativo}] -- ver installations/{id}/gestao_usuarios/atual
  let dispositivos = []; // [{id (uid), tipo, nomeDispositivo, ativo, vinculoUserId}] -- ver installations/{id}/dispositivos
  let historicoSolo = null; // { ultimos7, ultimos30, atualizadoEm } -- ver installations/{id}/historico_vendas/atual
  let periodoHistorico = 'ultimos7'; // 'ultimos7' | 'ultimos30' -- seletor da seção Histórico
  let historicoGrupoCache = {}; // { ultimos7: {...}|null, ultimos30: {...}|null } -- preenchido sob demanda quando há grupo de verdade (ver carregarHistoricoGrupo)

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

  // Delegado no container (não nos botões em si, que são recriados a
  // cada render()) -- troca de período só muda estado local e re-renderiza;
  // pro terminal solo os dois períodos já vêm prontos no mesmo documento
  // (historicoSolo), pro grupo os dois já foram pré-carregados em
  // descobrirGrupo() (ver carregarHistoricoGrupo), então nenhum dos dois
  // casos precisa de uma consulta nova ao trocar de período aqui.
  root.querySelector('#conteudo-consulta').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-periodo]');
    if (!btn) return;
    periodoHistorico = btn.dataset.periodo;
    render();
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

    // Solo: os dois períodos já vêm prontos no mesmo doc (historicoSolo).
    // Grupo: pré-carregado sob demanda (ver descobrirGrupo/carregarHistoricoGrupo);
    // undefined = ainda carregando, null = falhou ao carregar.
    const historico = temGrupoDeVerdade()
      ? (historicoGrupoCache[periodoHistorico] || null)
      : (historicoSolo ? historicoSolo[periodoHistorico] : null);

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

      <h2 class="titulo-secao">Histórico${temGrupoDeVerdade() ? ' — todos os terminais do grupo' : ''}</h2>
      <div class="seletor-periodo">
        <button class="btn-periodo ${periodoHistorico === 'ultimos7' ? 'btn-periodo-ativo' : ''}" data-periodo="ultimos7">7 dias</button>
        <button class="btn-periodo ${periodoHistorico === 'ultimos30' ? 'btn-periodo-ativo' : ''}" data-periodo="ultimos30">30 dias</button>
      </div>
      ${!historico ? `<p class="estado-vazio">${temGrupoDeVerdade() ? 'Carregando histórico do grupo...' : 'Sem histórico ainda -- aguarde a próxima sincronização do computador da loja (a cada ~10 min).'}</p>` : `
        <div class="grid-resumo">
          <div class="cartao-metrica">
            <div class="rotulo-metrica">Faturado no período</div>
            <div class="valor-metrica">${formatarMoeda(historico.totalFaturado)}</div>
          </div>
          <div class="cartao-metrica">
            <div class="rotulo-metrica">Vendas no período</div>
            <div class="valor-metrica">${historico.totalVendas}</div>
          </div>
          <div class="cartao-metrica">
            <div class="rotulo-metrica">Ticket médio</div>
            <div class="valor-metrica">${formatarMoeda(historico.ticketMedio)}</div>
          </div>
        </div>

        ${historico.topProdutos && historico.topProdutos.length > 0 ? `
          <h3 class="subtitulo-secao">Mais vendidos no período</h3>
          <div class="lista-pedidos-andamento">
            ${historico.topProdutos.slice(0, 5).map((p) => `
              <div class="cartao-pedido">
                <div>${escapeHtml(p.nome)}</div>
                <div class="subtexto">${p.quantidade} un · ${formatarMoeda(p.valorTotal)}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${historico.porOperador && historico.porOperador.length > 0 ? `
          <h3 class="subtitulo-secao">Por operador no período</h3>
          <div class="lista-pedidos-andamento">
            ${historico.porOperador.map((o) => `
              <div class="cartao-pedido">
                <div>${escapeHtml(o.operador)}</div>
                <div class="subtexto">${o.totalVendas} venda${o.totalVendas === 1 ? '' : 's'} · ${formatarMoeda(o.totalVendido)}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      `}

      <h2 class="titulo-secao">Usuários (${usuarios.length})</h2>
      <div class="lista-pedidos-andamento">
        ${usuarios.length === 0 ? '<p class="estado-vazio">Nenhum usuário cadastrado.</p>' : usuarios.map((u) => `
          <div class="cartao-pedido">
            <div>
              <div>${escapeHtml(u.nome)}</div>
              <div class="subtexto">${escapeHtml(ROTULO_PAPEL[u.role] || u.role)}</div>
            </div>
            <span class="pilula ${u.ativo ? 'status-ok' : 'status-erro'}">${u.ativo ? 'Ativo' : 'Inativo'}</span>
          </div>
        `).join('')}
      </div>

      <h2 class="titulo-secao">Dispositivos pareados (${dispositivos.length})</h2>
      <div class="lista-pedidos-andamento">
        ${dispositivos.length === 0 ? '<p class="estado-vazio">Nenhum dispositivo pareado.</p>' : dispositivos.map((d) => `
          <div class="cartao-pedido">
            <div>
              <div>${escapeHtml(d.nomeDispositivo || 'Celular')}</div>
              <div class="subtexto">${d.tipo === 'garcom' ? 'Garçom' : 'Consulta remota'} · ${escapeHtml(nomeDoVinculo(d.vinculoUserId))}</div>
            </div>
            <span class="pilula ${d.ativo ? 'status-ok' : 'status-erro'}">${d.ativo ? 'Ativo' : 'Desconectado'}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  /** Resolve o nome de exibição de um vinculoUserId cruzando com a
   * lista de usuários (gestao_usuarios/atual) -- o doc de dispositivos
   * só guarda o id (uid da tabela `users` do SQLite), não o nome. Some
   * "—" se a lista de usuários ainda não chegou, ou se o usuário
   * vinculado já foi removido/não existe mais. */
  function nomeDoVinculo(vinculoUserId) {
    const usuario = usuarios.find((u) => u.id === vinculoUserId);
    return usuario ? usuario.nome : '—';
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

  // Lista de funcionários (nome/papel/status) -- ver
  // userStatusSyncService.js. Documento separado de status_ao_vivo, com
  // regra própria restrita a dispositivo tipo === 'consulta' (nunca
  // garçom) -- ver firestore.rules. Publicado a cada ~60s pelo desktop,
  // então pode demorar um pouco pra aparecer/atualizar depois de criar
  // ou desativar alguém.
  const pararEscutaUsuarios = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'gestao_usuarios', 'atual'),
    (snap) => {
      usuarios = snap.exists() ? (snap.data().usuarios || []) : [];
      render();
    },
    (err) => console.error('[consulta] escuta de usuários falhou', err)
  );

  // Histórico de vendas (últimos 7/30 dias) do terminal SOLO -- ver
  // historySyncService.js. Mesma regra restrita de gestao_usuarios
  // (dispositivo tipo === 'consulta', ver firestore.rules); publicado a
  // cada ~10min, então pode demorar pra refletir uma venda bem recente.
  // Ignorado quando há grupo de verdade (nesse caso usa-se
  // historicoGrupoCache, ver descobrirGrupo/carregarHistoricoGrupo).
  const pararEscutaHistorico = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'historico_vendas', 'atual'),
    (snap) => {
      historicoSolo = snap.exists() ? snap.data() : null;
      render();
    },
    (err) => console.error('[consulta] escuta de histórico falhou', err)
  );

  // Dispositivos pareados (garçom + consulta) -- mesma coleção que o
  // desktop já mostra em Configurações → Celular; leitura já era aberta
  // nas regras (allow read: if true), então não precisou de regra nova.
  const pararEscutaDispositivos = firestoreFns.onSnapshot(
    firestoreFns.collection(db, 'installations', loja.installId, 'dispositivos'),
    (snap) => {
      dispositivos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    },
    (err) => console.error('[consulta] escuta de dispositivos pareados falhou', err)
  );

  firestoreFns.setDoc(
    firestoreFns.doc(db, 'installations', loja.installId, 'dispositivos', auth.currentUser.uid),
    { ultimoAcesso: firestoreFns.serverTimestamp() },
    { merge: true }
  ).catch(() => {});

  let pararEscutaVendas = null;

  /** Histórico do GRUPO pra um período (7 ou 30 dias) -- consulta única
   * (não onSnapshot: um relatório de histórico não precisa ser tempo
   * real, e ficar reagregando a cada nova venda em tempo real custaria
   * uma leitura de documento por venda toda vez) contra
   * grupos_sincronizacao/{grupoId}/vendas, filtrando por diaISO (mesmo
   * campo/mesmo padrão de intervalo que salesSyncService.getGroupHistory
   * já usa no desktop). Guarda em cache por período pra trocar de 7↔30
   * dias sem nova consulta -- ver descobrirGrupo(), que chama isso pros
   * dois períodos assim que confirma um grupo com mais de 1 terminal. */
  async function carregarHistoricoGrupo(periodoChave) {
    if (!grupoId) return;
    const dias = PERIODOS_HISTORICO[periodoChave];
    const dataFim = hojeLocalISO();
    const dataInicio = diaLocalISOAtras(dias - 1);
    try {
      const q = firestoreFns.query(
        firestoreFns.collection(db, 'grupos_sincronizacao', grupoId, 'vendas'),
        firestoreFns.where('diaISO', '>=', dataInicio),
        firestoreFns.where('diaISO', '<=', dataFim)
      );
      const snap = await firestoreFns.getDocs(q);
      historicoGrupoCache[periodoChave] = agregarVendasDoGrupo(snap.docs.map((d) => d.data()));
    } catch (err) {
      console.error('[consulta] falha ao carregar histórico do grupo', err);
      historicoGrupoCache[periodoChave] = null;
    }
    render();
  }

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

      // Histórico (7/30 dias) agregado do grupo -- pré-carrega os dois
      // períodos de uma vez (ver carregarHistoricoGrupo) pra trocar de
      // aba sem esperar nova consulta.
      carregarHistoricoGrupo('ultimos7');
      carregarHistoricoGrupo('ultimos30');

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
    pararEscutaUsuarios();
    pararEscutaHistorico();
    pararEscutaDispositivos();
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
