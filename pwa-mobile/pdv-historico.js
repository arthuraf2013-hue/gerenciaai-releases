import { formatarMoeda, formatarQuantidade, escapeHtml, METODOS, formatarDataHora, paraData, abrirSheet } from './pdv-util.js';
import * as S from './pdv-servidor.js';
import { mostrarRecibo } from './pdv-recibo.js';
import { executar } from './src/mesas/servidorMesas.js';

/** Aba "Vendas": as vendas feitas por ESTE celular (finalizadas,
 * aguardando e recusadas), com o resumo do dia e o recibo de cada uma.
 * No topo, "Meu turno": o que o usuário deste celular vendeu no caixa
 * aberto do computador (balcão, mesas e o que mais tiver passado por ele),
 * pedido na hora ao computador (mesaCelularService.js, comando meu_turno). */

const STATUS = {
  novo: { rotulo: 'Aguardando', classe: 'status-pendente' },
  pendente: { rotulo: 'Confirmando estoque', classe: 'status-pendente' },
  finalizada: { rotulo: 'Finalizada', classe: 'status-ok' },
  erro: { rotulo: 'Recusada', classe: 'status-erro' },
};

function mesmoDiaLocal(data, ref = new Date()) {
  if (!data) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  return fmt.format(data) === fmt.format(ref);
}

function mount(container, ctx) {
  const { loja } = ctx;
  container.innerHTML = `
    <div id="meu-turno" class="meu-turno" hidden></div>
    <div id="lista-vendas"><p class="estado-vazio"><span class="spinner spinner-pequeno"></span> Carregando...</p></div>`;
  const lista = container.querySelector('#lista-vendas');
  const turno = container.querySelector('#meu-turno');
  let vendas = [];
  let desmontado = false;

  async function carregarTurno() {
    turno.hidden = false;
    turno.innerHTML = '<p class="subtexto"><span class="spinner spinner-pequeno"></span> Meu turno: perguntando ao computador...</p>';
    try {
      const r = await executar(loja.installId, 'meu_turno', {}, { timeoutMs: 12000 });
      if (desmontado) return;
      renderTurno(r);
    } catch (err) {
      if (desmontado) return;
      // Computador com versão antiga (não sabe responder) ou fora do ar: some, sem atrapalhar a lista.
      turno.innerHTML = `<p class="subtexto">Meu turno indisponível agora. <button type="button" class="btn-link-inline" id="btn-turno">Tentar de novo</button></p>`;
      turno.querySelector('#btn-turno').addEventListener('click', carregarTurno);
    }
  }

  function renderTurno(r) {
    if (!r.caixaAberto) {
      turno.innerHTML = '<p class="aviso aviso-alerta">O caixa está fechado no computador da loja.</p>';
      return;
    }
    turno.innerHTML = `
      <div class="topo-secao"><div class="subtitulo-secao">Meu turno (caixa aberto ${escapeHtml(formatarDataHora(r.caixaAbertoEm))})</div>
        <button type="button" class="btn-link-inline" id="btn-turno">Atualizar</button></div>
      <div class="grid-resumo">
        <div class="cartao-metrica"><div class="rotulo-metrica">Vendi no turno</div><div class="valor-metrica">${formatarMoeda(r.total)}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Vendas</div><div class="valor-metrica">${Number(r.vendas) || 0}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Recebi nas mesas</div><div class="valor-metrica">${formatarMoeda(r.recebidoNasMesas)}</div></div>
      </div>
      ${(r.porMetodo || []).length ? `<div class="chips-resumo">${r.porMetodo.map((m) => `<span class="chip-info">${escapeHtml(METODOS[m.metodo]?.rotulo || m.metodo)} ${formatarMoeda(m.total)}</span>`).join('')}</div>` : ''}`;
    turno.querySelector('#btn-turno').addEventListener('click', carregarTurno);
  }

  carregarTurno();

  const parar = S.observarMinhasVendas(loja.installId, ({ vendas: v, erro }) => {
    if (erro) { lista.innerHTML = `<p class="msg-erro">${escapeHtml(erro.message)}</p>`; return; }
    vendas = v || [];
    render();
  });

  function render() {
    if (vendas.length === 0) {
      lista.innerHTML = '<p class="estado-vazio">Nenhuma venda feita por este celular ainda.</p>';
      return;
    }
    const hoje = vendas.filter((v) => v.status === 'finalizada' && mesmoDiaLocal(paraData(v.criadoEm)));
    const totalHoje = hoje.reduce((s, v) => s + (v.resumo?.total ?? v.totalEsperado ?? 0), 0);
    const porMetodo = {};
    for (const v of hoje) for (const p of v.resumo?.pagamentos || []) porMetodo[p.metodo] = (porMetodo[p.metodo] || 0) + p.valor;

    lista.innerHTML = `
      <div class="grid-resumo">
        <div class="cartao-metrica"><div class="rotulo-metrica">Vendido hoje neste celular</div><div class="valor-metrica">${formatarMoeda(totalHoje)}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Vendas hoje</div><div class="valor-metrica">${hoje.length}</div></div>
        <div class="cartao-metrica"><div class="rotulo-metrica">Ticket médio</div><div class="valor-metrica">${formatarMoeda(hoje.length ? totalHoje / hoje.length : 0)}</div></div>
      </div>
      ${Object.keys(porMetodo).length ? `<div class="chips-resumo">${Object.entries(porMetodo).map(([m, v]) => `<span class="chip-info">${escapeHtml(METODOS[m]?.rotulo || m)} ${formatarMoeda(v)}</span>`).join('')}</div>` : ''}
      <div class="subtitulo-secao">Últimas vendas</div>
      ${vendas.map((v) => {
        const st = STATUS[v.status] || STATUS.novo;
        const total = v.resumo?.total ?? v.totalEsperado ?? 0;
        const qtd = (v.itens || []).length;
        return `
          <button class="cartao-pedido cartao-venda" data-venda="${escapeHtml(v.id)}">
            <div>
              <div><strong>${formatarMoeda(total)}</strong> · ${qtd} ${qtd === 1 ? 'item' : 'itens'}</div>
              <div class="subtexto">${escapeHtml(formatarDataHora(v.criadoEm))}${v.clienteNome ? ` · ${escapeHtml(v.clienteNome)}` : ''}</div>
              ${v.status === 'erro' && v.erro ? `<div class="subtexto erro-texto">${escapeHtml(v.erro)}</div>` : ''}
            </div>
            <span class="pilula ${st.classe}">${st.rotulo}</span>
          </button>`;
      }).join('')}
    `;
    lista.querySelectorAll('[data-venda]').forEach((b) => b.addEventListener('click', () => abrirDetalhe(vendas.find((v) => v.id === b.dataset.venda))));
  }

  function abrirDetalhe(v) {
    if (!v) return;
    if (v.status === 'finalizada' && v.resumo) {
      mostrarRecibo({ venda: v, nomeLoja: ctx.estado().config?.nomeNegocio || loja.nomeNegocio });
      return;
    }
    const st = STATUS[v.status] || STATUS.novo;
    const { el, fechar } = abrirSheet(`
      <h2>Venda — ${st.rotulo}</h2>
      <p class="subtexto">${escapeHtml(formatarDataHora(v.criadoEm))}</p>
      ${v.erro ? `<p class="${v.status === 'erro' ? 'msg-erro' : 'aviso aviso-alerta'}">${escapeHtml(v.erro)}</p>` : ''}
      <div class="recibo-itens">
        ${(v.itens || []).map((i) => `<div class="recibo-linha"><span>${escapeHtml(formatarQuantidade(i.quantidade))}× ${escapeHtml(i.nome)}</span><span>${formatarMoeda(i.precoUnitario * i.quantidade)}</span></div>`).join('')}
      </div>
      <div class="recibo-linha recibo-total"><span>Total</span><span>${formatarMoeda(v.totalEsperado)}</span></div>
      ${v.status === 'erro' ? '<p class="subtexto">Nada desta venda foi registrado no computador da loja.</p>' : ''}
      <button id="btn-fechar-detalhe" class="btn-secundario">Fechar</button>
    `);
    el.querySelector('#btn-fechar-detalhe').addEventListener('click', fechar);
  }

  return () => { desmontado = true; parar(); };
}

export { mount };
