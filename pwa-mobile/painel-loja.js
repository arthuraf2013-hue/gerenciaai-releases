import { db, firestoreFns } from './firebase-config.js';

/**
 * PAINEL DA LOJA -- o mesmo conteúdo da "Consulta remota" (resumo do dia,
 * por terminal do grupo, mesas, pedidos em andamento e histórico) num
 * componente só, usado em dois lugares:
 *   - consulta.js (celular pareado como "Consulta remota");
 *   - pdv.js, aba "Painel" (celular PDV móvel que a loja liberou em
 *     Configurações → Celular → "Painel da loja no celular").
 * Assim os dois apps mostram exatamente os mesmos números.
 *
 * Fontes (todas publicadas pelo computador da loja):
 *   installations/{id}/status_ao_vivo/atual   -- total do dia "ao vivo" (~25 s), mesas, pedidos
 *   installations/{id}/historico_vendas/atual -- hoje / 7 / 30 dias (~10 min): por dia, por hora,
 *                                                mais vendidos, por operador, formas de pagamento
 *   grupos_sincronizacao/{grupoId}/vendas     -- quando a loja tem mais de um terminal no grupo
 * Custo e margem ficam DE FORA de propósito (ver historySyncService.js).
 */

const formatarMoeda = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatarMoedaCurta = (v) => {
  const n = v || 0;
  if (Math.abs(n) >= 1000) return `R$ ${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return formatarMoeda(n);
};

const ROTULO_METODO = {
  dinheiro: 'Dinheiro', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito',
  pix: 'Pix', fiado: 'Fiado', outro: 'Outros', misto: 'Mais de uma forma',
};

const PERIODOS = { hoje: { dias: 1, rotulo: 'Hoje' }, ultimos7: { dias: 7, rotulo: '7 dias' }, ultimos30: { dias: 30, rotulo: '30 dias' } };

/** Dia local (America/Sao_Paulo) -- mesmo cálculo de salesSyncService.calcularDiaISO no desktop. */
function hojeLocalISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}
function diaLocalISOAtras(diasAtras) {
  const [ano, mes, dia] = hojeLocalISO().split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia - diasAtras)).toISOString().slice(0, 10);
}
function rotuloDia(iso, curto = false) {
  const [, m, d] = String(iso).split('-');
  if (curto) return `${d}/${m}`;
  const data = new Date(`${iso}T12:00:00Z`);
  return `${data.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '')} ${d}/${m}`;
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

/** Agrega as vendas cruas do grupo no MESMO formato do historico_vendas solo. */
function agregarVendasDoGrupo(vendas, dias) {
  let totalFaturado = 0;
  const porDia = new Map();
  const porHora = new Map();
  const porProduto = new Map();
  const porOperador = new Map();
  const porMetodo = new Map();
  for (const v of vendas) {
    const total = v.total || 0;
    totalFaturado += total;
    const dia = porDia.get(v.diaISO) || { dia: v.diaISO, total: 0 };
    dia.total += total;
    porDia.set(v.diaISO, dia);
    if (dias === 1 && v.finalizadaEm) {
      const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' })
        .format(typeof v.finalizadaEm?.toDate === 'function' ? v.finalizadaEm.toDate() : new Date(String(v.finalizadaEm).replace(' ', 'T') + 'Z')));
      const h = porHora.get(hora) || { hora, vendas: 0, total: 0 };
      h.vendas += 1;
      h.total += total;
      porHora.set(hora, h);
    }
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
    // O grupo guarda só QUAIS formas a venda usou (metodosPagamento), não
    // o valor de cada uma: venda com uma forma só entra inteira nela;
    // com mais de uma, num balde "Mais de uma forma" (não dá pra dividir).
    const metodosVenda = [...new Set(v.metodosPagamento || [])];
    if (metodosVenda.length) {
      const chave = metodosVenda.length === 1 ? metodosVenda[0] : 'misto';
      porMetodo.set(chave, (porMetodo.get(chave) || 0) + total);
    }
  }
  const totalVendas = vendas.length;
  return {
    totalVendas,
    totalFaturado,
    ticketMedio: totalVendas > 0 ? totalFaturado / totalVendas : 0,
    vendasPorDia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    vendasPorHora: [...porHora.values()].sort((a, b) => a.hora - b.hora),
    topProdutos: [...porProduto.values()].sort((a, b) => b.quantidade - a.quantidade).slice(0, 8),
    porOperador: [...porOperador.values()].sort((a, b) => b.totalVendido - a.totalVendido),
    porMetodo: [...porMetodo.entries()].map(([metodo, total]) => ({ metodo, total })).sort((a, b) => b.total - a.total),
  };
}

// ---------------------------------------------------------------------
// Gráficos simples em HTML/CSS (sem biblioteca): uma série, uma cor (a do
// app), barras finas com ponta arredondada, valor no toque/hover e uma
// tabela equivalente pra leitor de tela.

/** Colunas por dia (7/30 dias) ou por hora (hoje). `itens`: [{ chave, rotulo, rotuloLongo, valor, extra }]. */
function graficoColunas(itens, { idLeitura, rotuloEixo, destacar = 'ultimo' }) {
  if (!itens.length) return '';
  const max = Math.max(...itens.map((i) => i.valor), 0) || 1;
  const muitos = itens.length > 14;
  // Leitura inicial: o último dia (hoje) na série por dia; a hora de pico na série por hora.
  const idxDestaque = destacar === 'maior' ? itens.reduce((m, i, idx) => (i.valor > itens[m].valor ? idx : m), 0) : itens.length - 1;
  const ultimo = itens[idxDestaque];
  return `
    <div class="grafico-colunas ${muitos ? 'grafico-denso' : ''}" role="img" aria-label="${escapeHtml(rotuloEixo)}">
      <div class="grafico-leitura" id="${idLeitura}" aria-live="polite">
        <strong>${escapeHtml(ultimo.rotuloLongo)}</strong> · ${formatarMoeda(ultimo.valor)}${ultimo.extra ? ` · ${escapeHtml(ultimo.extra)}` : ''}
      </div>
      <div class="grafico-area">
        ${itens.map((i, idx) => `
          <button class="grafico-coluna ${idx === idxDestaque ? 'grafico-coluna-ativa' : ''}" data-leitura="${idLeitura}"
            data-texto="${escapeHtml(`${i.rotuloLongo}|${formatarMoeda(i.valor)}${i.extra ? `|${i.extra}` : ''}`)}"
            aria-label="${escapeHtml(`${i.rotuloLongo}: ${formatarMoeda(i.valor)}`)}">
            <span class="grafico-barra" style="height:${Math.max(2, Math.round((i.valor / max) * 100))}%"></span>
          </button>`).join('')}
      </div>
      <div class="grafico-eixo">
        ${itens.map((i, idx) => `<span>${!muitos || idx % 5 === 0 || idx === itens.length - 1 ? escapeHtml(i.rotulo) : ''}</span>`).join('')}
      </div>
    </div>
    <table class="so-leitor"><caption>${escapeHtml(rotuloEixo)}</caption>
      <tbody>${itens.map((i) => `<tr><th>${escapeHtml(i.rotuloLongo)}</th><td>${formatarMoeda(i.valor)}</td></tr>`).join('')}</tbody></table>`;
}

/** Barras horizontais com rótulo e valor em cada linha (formas de pagamento, mais vendidos...). */
function listaBarras(itens) {
  const max = Math.max(...itens.map((i) => i.valor), 0) || 1;
  return `
    <div class="lista-barras">
      ${itens.map((i) => `
        <div class="linha-barra">
          <div class="linha-barra-topo"><span>${escapeHtml(i.rotulo)}</span><strong>${escapeHtml(i.texto)}</strong></div>
          <div class="linha-barra-trilho"><span class="linha-barra-valor" style="width:${Math.max(1.5, (i.valor / max) * 100)}%"></span></div>
          ${i.sub ? `<div class="subtexto">${escapeHtml(i.sub)}</div>` : ''}
        </div>`).join('')}
    </div>`;
}

function seriePorDia(historico, dias) {
  // Completa os dias sem venda com zero -- senão a série "pula" dias.
  const mapa = new Map((historico.vendasPorDia || []).map((d) => [d.dia, d.total]));
  const itens = [];
  for (let i = dias - 1; i >= 0; i--) {
    const dia = diaLocalISOAtras(i);
    itens.push({ chave: dia, rotulo: rotuloDia(dia, true), rotuloLongo: rotuloDia(dia), valor: mapa.get(dia) || 0 });
  }
  return itens;
}

function seriePorHora(historico) {
  const lista = historico.vendasPorHora || [];
  if (!lista.length) return [];
  const primeira = Math.min(...lista.map((h) => h.hora), 8);
  const horaAgora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const ultima = Math.max(...lista.map((h) => h.hora), horaAgora);
  const mapa = new Map(lista.map((h) => [h.hora, h]));
  const itens = [];
  for (let h = primeira; h <= Math.min(23, ultima); h++) {
    const x = mapa.get(h);
    itens.push({ chave: h, rotulo: `${h}h`, rotuloLongo: `${h}h–${h + 1}h`, valor: x?.total || 0, extra: x ? `${x.vendas} venda${x.vendas === 1 ? '' : 's'}` : '0 vendas' });
  }
  return itens;
}

/**
 * Monta o painel em `container`. Opções:
 *   loja                { installId, nomeNegocio }
 *   aoAtualizar(ms)     avisado quando chega um status novo (pro "atualizado há…" do cabeçalho)
 *   introducao          HTML opcional mostrado no topo
 * Devolve a função de desmontar.
 */
function mount(container, { loja, aoAtualizar = () => {}, introducao = '' }) {
  let status = null;
  let historicoSolo = null;
  let historicoNegado = false;
  let periodo = 'hoje';
  let grupoId = null;
  let lojasDoGrupo = null;
  let resumoGrupo = null;
  const historicoGrupo = {};
  let pararVendasGrupo = null;
  let desmontado = false;

  container.innerHTML = '<p class="estado-vazio"><span class="spinner spinner-pequeno"></span> Carregando o painel da loja...</p>';

  // Delegado no container (os botões são recriados a cada render).
  const aoClicar = (e) => {
    const p = e.target.closest('[data-periodo-painel]');
    if (p) { periodo = p.dataset.periodoPainel; render(); return; }
    const col = e.target.closest('[data-leitura]');
    if (col) {
      const alvo = container.querySelector(`#${col.dataset.leitura}`);
      if (!alvo) return;
      const [titulo, valor, extra] = col.dataset.texto.split('|');
      alvo.innerHTML = `<strong>${escapeHtml(titulo)}</strong> · ${escapeHtml(valor)}${extra ? ` · ${escapeHtml(extra)}` : ''}`;
      col.parentElement.querySelectorAll('.grafico-coluna-ativa').forEach((b) => b.classList.remove('grafico-coluna-ativa'));
      col.classList.add('grafico-coluna-ativa');
    }
  };
  container.addEventListener('click', aoClicar);
  // Hover no computador/tablet com mouse: mesma leitura do toque.
  const aoPassar = (e) => { if (e.target.closest('[data-leitura]')) aoClicar(e); };
  container.addEventListener('mouseover', aoPassar);

  const temGrupo = () => Array.isArray(lojasDoGrupo) && lojasDoGrupo.length > 1;

  function historicoAtual() {
    if (temGrupo()) return historicoGrupo[periodo];
    return historicoSolo ? historicoSolo[periodo] : null;
  }

  function render() {
    if (desmontado) return;
    if (!status) {
      container.innerHTML = '<p class="estado-vazio">Esperando o computador da loja publicar os números (ele precisa estar com o GerenciaAI aberto e com internet).</p>';
      return;
    }
    const resumo = temGrupo() && resumoGrupo ? resumoGrupo : (status.resumoHoje || { totalVendasHoje: 0, faturamentoHoje: 0, ticketMedioHoje: 0 });
    const mesas = status.mesas || [];
    const mesasOcupadas = mesas.filter((m) => m.status === 'ocupada');
    const pedidos = status.pedidosEmAndamento || [];
    const hist = historicoAtual();
    const dias = PERIODOS[periodo].dias;
    const atualizadoHist = !temGrupo() && historicoSolo?.atualizadoEm?.toMillis ? historicoSolo.atualizadoEm.toMillis() : null;

    container.innerHTML = `
      ${introducao}
      ${temGrupo() ? `<p class="subtexto" style="margin-bottom:8px;">Somando os ${lojasDoGrupo.length} terminais deste grupo.</p>` : ''}
      <div class="grid-resumo">
        <div class="cartao-metrica"><div class="rotulo-metrica">Faturamento hoje</div><div class="valor-metrica">${formatarMoeda(resumo.faturamentoHoje)}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Vendas hoje</div><div class="valor-metrica">${resumo.totalVendasHoje}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Ticket médio</div><div class="valor-metrica">${formatarMoeda(resumo.ticketMedioHoje)}</div></div>
      </div>

      ${temGrupo() && resumoGrupo ? `
        <h2 class="titulo-secao">Por terminal</h2>
        <div class="lista-pedidos-andamento">
          ${lojasDoGrupo.map((l) => {
            const d = resumoGrupo.porLoja.get(l.installId) || { faturamento: 0, vendas: 0 };
            return `<div class="cartao-pedido"><div>${escapeHtml(l.nomeNegocio)}</div><div class="subtexto">${d.vendas} venda${d.vendas === 1 ? '' : 's'} · ${formatarMoeda(d.faturamento)}</div></div>`;
          }).join('')}
        </div>` : ''}

      <h2 class="titulo-secao">Histórico${temGrupo() ? ' — todos os terminais' : ''}</h2>
      <div class="seletor-periodo">
        ${Object.entries(PERIODOS).map(([k, p]) => `<button class="btn-periodo ${periodo === k ? 'btn-periodo-ativo' : ''}" data-periodo-painel="${k}">${p.rotulo}</button>`).join('')}
      </div>
      ${renderHistorico(hist, dias, atualizadoHist)}

      ${status.perfilAtivo === 'restaurante' ? `
        <h2 class="titulo-secao">Mesas${temGrupo() ? ` — ${escapeHtml(loja.nomeNegocio)}` : ''} (${mesasOcupadas.length} ocupada${mesasOcupadas.length === 1 ? '' : 's'} de ${mesas.length})</h2>
        <div class="grid-mesas">
          ${mesas.length === 0 ? '<p class="estado-vazio">Nenhuma mesa cadastrada.</p>' : mesas.map((m) => `
            <div class="cartao-mesa ${m.status === 'ocupada' ? 'cartao-mesa-ocupada' : ''}">
              <div class="numero-mesa">Mesa ${escapeHtml(m.numero)}</div>
              ${m.status === 'ocupada' ? `<div class="total-mesa">${formatarMoeda(m.totalAtual)}</div>` : `<div class="subtexto">${{ livre: 'Livre', aguardando_limpeza: 'Aguardando limpeza' }[m.status] || escapeHtml(m.status)}</div>`}
            </div>`).join('')}
        </div>` : ''}

      <h2 class="titulo-secao">Pedidos em andamento${temGrupo() ? ` — ${escapeHtml(loja.nomeNegocio)}` : ''} (${pedidos.length})</h2>
      <div class="lista-pedidos-andamento">
        ${pedidos.length === 0 ? '<p class="estado-vazio">Nenhum pedido em andamento.</p>' : pedidos.map((p) => `
          <div class="cartao-pedido">
            <div><div>${escapeHtml(p.clienteNome || 'Cliente')}</div><div class="subtexto">${p.tipoEntrega === 'entrega' ? 'Entrega' : 'Retirada'}</div></div>
            <span class="pilula status-pendente">${{ novo: 'Novo', em_separacao: 'Em separação', pronto: 'Pronto' }[p.status] || escapeHtml(p.status)}</span>
          </div>`).join('')}
      </div>
    `;
  }

  function renderHistorico(hist, dias, atualizadoMs) {
    if (historicoNegado && !temGrupo()) {
      return '<p class="estado-vazio">O histórico não está liberado para este celular. Quem libera é o gerente, no computador: Configurações → Celular.</p>';
    }
    if (hist === undefined && temGrupo()) return '<p class="estado-vazio"><span class="spinner spinner-pequeno"></span> Somando as vendas do grupo...</p>';
    if (!hist) {
      return `<p class="estado-vazio">${historicoSolo && !historicoSolo[periodo]
        ? 'O computador da loja ainda está numa versão sem este período — atualize o GerenciaAI.'
        : 'Sem histórico ainda — o computador da loja publica a cada ~10 minutos.'}</p>`;
    }
    if (hist.totalVendas === 0) return `<p class="estado-vazio">Nenhuma venda ${dias === 1 ? 'hoje' : `nos últimos ${dias} dias`}.</p>`;
    const serie = dias === 1 ? seriePorHora(hist) : seriePorDia(hist, dias);
    const melhorDia = dias > 1 ? [...serie].sort((a, b) => b.valor - a.valor)[0] : null;
    const metodos = (hist.porMetodo || []).filter((m) => m.total > 0);
    const totalMetodos = metodos.reduce((s, m) => s + m.total, 0);
    // "Hoje": os números grandes já estão lá em cima (ao vivo) -- aqui só o detalhe.
    const cartoes = dias === 1 ? '' : `
      <div class="grid-resumo grid-resumo-3">
        <div class="cartao-metrica"><div class="rotulo-metrica">Faturado ${dias === 1 ? 'hoje' : 'no período'}</div><div class="valor-metrica">${formatarMoeda(hist.totalFaturado)}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Vendas</div><div class="valor-metrica">${hist.totalVendas}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Ticket médio</div><div class="valor-metrica">${formatarMoeda(hist.ticketMedio)}</div></div>
        ${dias > 1 && melhorDia?.valor > 0 ? `<div class="cartao-metrica"><div class="rotulo-metrica">Melhor dia</div><div class="valor-metrica valor-metrica-menor">${escapeHtml(melhorDia.rotuloLongo)}</div><div class="subtexto">${formatarMoeda(melhorDia.valor)}</div></div>` : ''}
        ${hist.devolucoes?.total ? `<div class="cartao-metrica"><div class="rotulo-metrica">Devoluções</div><div class="valor-metrica valor-metrica-menor">${hist.devolucoes.total}</div><div class="subtexto">${formatarMoeda(hist.devolucoes.valor)}</div></div>` : ''}
      </div>`;
    return `
      ${cartoes}

      ${serie.length ? `
        <h3 class="subtitulo-secao">${dias === 1 ? 'Vendas por hora' : 'Faturamento por dia'}</h3>
        ${graficoColunas(serie, {
          idLeitura: `leitura-${periodo}`,
          rotuloEixo: dias === 1 ? 'Faturamento por hora, hoje' : `Faturamento por dia, últimos ${dias} dias`,
          destacar: dias === 1 ? 'maior' : 'ultimo',
        })}` : ''}

      ${metodos.length ? `
        <h3 class="subtitulo-secao">Formas de pagamento</h3>
        ${listaBarras(metodos.map((m) => ({
          rotulo: ROTULO_METODO[m.metodo] || m.metodo,
          valor: m.total,
          texto: `${formatarMoedaCurta(m.total)} · ${totalMetodos ? Math.round((m.total / totalMetodos) * 100) : 0}%`,
        })))}` : ''}

      ${hist.topProdutos?.length ? `
        <h3 class="subtitulo-secao">Mais vendidos (em R$)</h3>
        ${listaBarras([...hist.topProdutos].sort((a, b) => (b.valorTotal || 0) - (a.valorTotal || 0)).slice(0, 6).map((p) => ({
          // Barra pelo valor: dá pra comparar produto por kg com produto por unidade.
          rotulo: p.nome,
          valor: p.valorTotal || 0,
          texto: formatarMoeda(p.valorTotal),
          sub: `${Number(p.quantidade).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${String(p.unidade || 'un').toLowerCase() === 'kg' ? 'kg' : 'un'}`,
        })))}` : ''}

      ${hist.porOperador?.length ? `
        <h3 class="subtitulo-secao">Por operador</h3>
        ${listaBarras(hist.porOperador.map((o) => ({
          rotulo: o.operador,
          valor: o.totalVendido,
          texto: formatarMoedaCurta(o.totalVendido),
          sub: `${o.totalVendas} venda${o.totalVendas === 1 ? '' : 's'}`,
        })))}` : ''}

      ${atualizadoMs ? `<p class="subtexto rodape-painel">Histórico calculado pelo computador às ${new Date(atualizadoMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (atualiza a cada ~10 min). O total "hoje" lá em cima é ao vivo.</p>` : ''}
    `;
  }

  // ------------------------------- escutas -------------------------------

  const pararStatus = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'status_ao_vivo', 'atual'),
    (snap) => {
      status = snap.exists() ? snap.data() : null;
      aoAtualizar(status?.atualizadoEm?.toMillis ? status.atualizadoEm.toMillis() : (status ? Date.now() : null));
      render();
    },
    (err) => console.error('[painel] status ao vivo', err),
  );

  const pararHistorico = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'historico_vendas', 'atual'),
    (snap) => { historicoNegado = false; historicoSolo = snap.exists() ? snap.data() : null; render(); },
    (err) => {
      if (err?.code === 'permission-denied') { historicoNegado = true; render(); return; }
      console.error('[painel] histórico', err);
    },
  );

  async function carregarHistoricoGrupo(chave) {
    if (!grupoId) return;
    const { dias } = PERIODOS[chave];
    try {
      const q = firestoreFns.query(
        firestoreFns.collection(db, 'grupos_sincronizacao', grupoId, 'vendas'),
        firestoreFns.where('diaISO', '>=', diaLocalISOAtras(dias - 1)),
        firestoreFns.where('diaISO', '<=', hojeLocalISO()),
      );
      const snap = await firestoreFns.getDocs(q);
      historicoGrupo[chave] = agregarVendasDoGrupo(snap.docs.map((d) => d.data()), dias);
    } catch (err) {
      console.error('[painel] histórico do grupo', err);
      historicoGrupo[chave] = null;
    }
    render();
  }

  async function descobrirGrupo() {
    try {
      const instSnap = await firestoreFns.getDoc(firestoreFns.doc(db, 'installations', loja.installId));
      grupoId = (instSnap.exists() && instSnap.data().grupoSincronizacaoId) || null;
      if (!grupoId) { lojasDoGrupo = []; return; }
      const snap = await firestoreFns.getDocs(firestoreFns.query(
        firestoreFns.collection(db, 'installations'), firestoreFns.where('grupoSincronizacaoId', '==', grupoId),
      ));
      lojasDoGrupo = snap.docs.map((d) => ({ installId: d.id, nomeNegocio: d.data().nomeNegocio || 'Loja' }));
      if (lojasDoGrupo.length <= 1 || desmontado) return;
      Object.keys(PERIODOS).forEach((k) => carregarHistoricoGrupo(k));
      const nomes = new Map(lojasDoGrupo.map((l) => [l.installId, l.nomeNegocio]));
      pararVendasGrupo = firestoreFns.onSnapshot(
        firestoreFns.query(firestoreFns.collection(db, 'grupos_sincronizacao', grupoId, 'vendas'), firestoreFns.where('diaISO', '==', hojeLocalISO())),
        (snapVendas) => {
          const porLoja = new Map();
          let faturamentoHoje = 0;
          let totalVendasHoje = 0;
          const vendasHoje = [];
          snapVendas.forEach((d) => {
            const v = d.data();
            vendasHoje.push(v);
            faturamentoHoje += v.total || 0;
            totalVendasHoje += 1;
            const atual = porLoja.get(v.installId) || { nomeNegocio: nomes.get(v.installId) || 'Loja', faturamento: 0, vendas: 0 };
            atual.faturamento += v.total || 0;
            atual.vendas += 1;
            porLoja.set(v.installId, atual);
          });
          resumoGrupo = { faturamentoHoje, totalVendasHoje, ticketMedioHoje: totalVendasHoje ? faturamentoHoje / totalVendasHoje : 0, porLoja };
          // "Hoje" do grupo acompanha em tempo real (já temos as vendas do dia aqui).
          historicoGrupo.hoje = agregarVendasDoGrupo(vendasHoje, 1);
          render();
        },
        (err) => console.error('[painel] vendas do grupo', err),
      );
    } catch (err) {
      console.error('[painel] grupo de sincronização', err);
      lojasDoGrupo = [];
    }
  }
  descobrirGrupo();

  return () => {
    desmontado = true;
    container.removeEventListener('click', aoClicar);
    container.removeEventListener('mouseover', aoPassar);
    pararStatus();
    pararHistorico();
    if (pararVendasGrupo) pararVendasGrupo();
  };
}

export { mount, agregarVendasDoGrupo, seriePorDia, seriePorHora, PERIODOS };
