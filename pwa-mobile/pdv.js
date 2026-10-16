import { icon } from './icons.js';
import * as S from './pdv-servidor.js';
import {
  escapeHtml, lerPrefs, gravarPrefs, mostrarToast, abrirSheet, METODOS,
} from './pdv-util.js';
import * as telaVenda from './pdv-venda.js';
import * as telaHistorico from './pdv-historico.js';
import * as garcom from './garcom.js';

/**
 * PDV MÓVEL -- celular pareado com tipo 'pdv' (Configurações → Celular
 * no computador). Junta num app só, com abas configuráveis:
 *   Vender  -- venda completa (pdv-venda.js)
 *   Mesas   -- o mesmo fluxo do app do garçom (garcom.js, embutido)
 *   Vendas  -- histórico e recibos deste celular (pdv-historico.js)
 *   Ajustes -- preferências deste celular + o que a loja liberou
 * Quais abas aparecem quem decide é a loja (config_mobile/pdv, publicada
 * pelo computador); a tela inicial e a aparência, o próprio operador.
 *
 * Este arquivo é só a "casca": cabeçalho com o indicador de conexão,
 * barra de abas e o estado compartilhado (config da loja, catálogo,
 * conexão) que as telas leem via `ctx.estado()` e escutam via
 * `ctx.assinar()`.
 */

const ABAS = {
  vender: { rotulo: 'Vender', icone: 'vender' },
  mesas: { rotulo: 'Mesas', icone: 'mesa' },
  vendas: { rotulo: 'Vendas', icone: 'recibo' },
  ajustes: { rotulo: 'Ajustes', icone: 'ajustes' },
};

function mount(root, { loja, lojas, onTrocarLoja, onParearOutra, onEsquecerLoja }) {
  const estado = {
    config: null, configCarregada: false, doServidor: false, online: navigator.onLine,
    statusLoja: null, acessoNegado: false,
  };
  let prefs = lerPrefs();
  const assinantes = new Set();
  const notificar = (motivo) => assinantes.forEach((fn) => { try { fn(motivo); } catch (err) { console.error('[pdv]', err); } });
  const ctx = {
    loja,
    estado: () => estado,
    prefs: () => prefs,
    assinar: (fn) => { assinantes.add(fn); return () => assinantes.delete(fn); },
  };

  root.innerHTML = `
    <div class="app-shell pdv-shell">
      <header class="topo">
        <div class="topo-info">
          <div class="nome-loja">${escapeHtml(loja.nomeNegocio)}</div>
          <div class="subtexto">${escapeHtml(loja.vinculoNome || '')} · PDV móvel</div>
        </div>
        <button id="indicador-conexao" class="indicador-conexao" aria-live="polite"></button>
      </header>
      <main id="conteudo-pdv" class="conteudo-pdv"></main>
      <nav id="nav-inferior" class="nav-inferior" aria-label="Seções"></nav>
    </div>
  `;
  document.body.classList.add('modo-pdv');
  const conteudo = root.querySelector('#conteudo-pdv');
  const nav = root.querySelector('#nav-inferior');
  const indicador = root.querySelector('#indicador-conexao');

  let abaAtiva = null;
  let desmontarAba = () => {};

  function abasDisponiveis() {
    const c = estado.config;
    const lista = [];
    if (!c || c.permitirVenda) lista.push('vender');
    if (c?.permitirMesas) lista.push('mesas');
    if (!c || c.permitirVenda) lista.push('vendas');
    lista.push('ajustes');
    return lista;
  }

  function renderNav() {
    const abas = abasDisponiveis();
    nav.innerHTML = abas.map((a) => `
      <button class="nav-item ${a === abaAtiva ? 'nav-item-ativo' : ''}" data-aba="${a}" ${a === abaAtiva ? 'aria-current="page"' : ''}>
        ${icon(ABAS[a].icone, 22)}<span>${ABAS[a].rotulo}</span>
      </button>`).join('');
    nav.querySelectorAll('[data-aba]').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
  }

  function trocarAba(aba) {
    if (aba === abaAtiva) return;
    desmontarAba();
    desmontarAba = () => {};
    abaAtiva = aba;
    conteudo.className = `conteudo-pdv conteudo-${aba}`;
    conteudo.scrollTop = 0;
    if (aba === 'vender') desmontarAba = telaVenda.mount(conteudo, ctx) || (() => {});
    else if (aba === 'vendas') desmontarAba = telaHistorico.mount(conteudo, ctx) || (() => {});
    else if (aba === 'mesas') desmontarAba = garcom.mount(conteudo, { loja, lojas, embutido: true }) || (() => {});
    else desmontarAba = montarAjustes();
    renderNav();
  }

  /** Garante que a aba ativa continua permitida depois de uma mudança na
   * config da loja (ex: gerente desligou "Mesas" agora). */
  function reconciliarAbas() {
    const abas = abasDisponiveis();
    if (!abaAtiva || !abas.includes(abaAtiva)) {
      const preferida = prefs.telaInicial === 'mesas' ? 'mesas' : 'vender';
      trocarAba(abas.includes(preferida) ? preferida : abas[0]);
    } else {
      renderNav();
    }
  }

  // ---------------- indicador de conexão ----------------

  function situacao() {
    if (estado.acessoNegado) return { cor: 'erro', texto: 'Sem acesso' };
    if (!estado.online || !estado.doServidor) return { cor: 'erro', texto: 'Sem internet' };
    if (!estado.config) return { cor: 'alerta', texto: 'Aguardando loja' };
    if (!S.servidorRespondendo(estado.config)) return { cor: 'erro', texto: 'Computador offline' };
    if (estado.config.permitirVenda && !estado.config.caixaAberto) return { cor: 'alerta', texto: 'Caixa fechado' };
    return { cor: 'ok', texto: 'Conectado' };
  }

  function renderIndicador() {
    const s = situacao();
    indicador.className = `indicador-conexao indicador-${s.cor}`;
    indicador.innerHTML = `<span class="ponto"></span>${escapeHtml(s.texto)}`;
  }

  indicador.addEventListener('click', () => {
    const idade = S.idadeDoServidorMs(estado.config);
    const { el, fechar } = abrirSheet(`
      <h2>Conexão com a loja</h2>
      <div class="lista-status">
        <div><span>Internet deste celular</span><strong>${estado.online && estado.doServidor ? 'OK' : 'Sem conexão'}</strong></div>
        <div><span>Computador da loja</span><strong>${!estado.config ? 'Sem notícia ainda' : (S.servidorRespondendo(estado.config) ? `Respondendo (há ${Math.round(idade / 1000)}s)` : 'Não responde')}</strong></div>
        ${estado.config?.permitirVenda ? `<div><span>Caixa</span><strong>${estado.config.caixaAberto ? 'Aberto' : 'Fechado'}</strong></div>` : ''}
      </div>
      <p class="subtexto">As vendas são conferidas e registradas no computador da loja — ele precisa estar com o GerenciaAI aberto, com internet e com o caixa aberto.</p>
      <button id="btn-fechar-status" class="btn-secundario">Fechar</button>
    `);
    el.querySelector('#btn-fechar-status').addEventListener('click', fechar);
  });

  // ---------------- Ajustes ----------------

  function montarAjustes() {
    const render = () => {
      const c = estado.config;
      const metodos = (c?.metodosPagamento || []).map((m) => METODOS[m]?.rotulo || m);
      const opcao = (nome, valor, rotulo) => `<button class="btn-periodo ${prefs[nome] === valor ? 'btn-periodo-ativo' : ''}" data-pref="${nome}" data-valor="${valor}">${rotulo}</button>`;
      const chave = (nome, rotulo) => `
        <label class="linha-chave">
          <span>${rotulo}</span>
          <input type="checkbox" role="switch" data-pref-bool="${nome}" ${prefs[nome] ? 'checked' : ''} />
        </label>`;
      conteudo.innerHTML = `
        <h2 class="titulo-secao">Este celular</h2>
        ${c?.permitirMesas && c?.permitirVenda ? `<div class="rotulo">Abrir o app em</div><div class="seletor-periodo">${opcao('telaInicial', 'vender', 'Vender')}${opcao('telaInicial', 'mesas', 'Mesas')}</div>` : ''}
        <div class="rotulo">Produtos</div>
        <div class="seletor-periodo">${opcao('layout', 'grade', 'Grade')}${opcao('layout', 'lista', 'Lista')}</div>
        <div class="cartao-config">
          ${chave('mostrarEstoque', 'Mostrar estoque nos produtos')}
          ${chave('bipe', 'Bipe ao ler código de barras')}
          ${chave('vibrar', 'Vibrar ao adicionar item')}
        </div>

        <h2 class="titulo-secao">O que a loja liberou</h2>
        ${c ? `
          <div class="cartao-config lista-status">
            <div><span>Vender</span><strong>${c.permitirVenda ? 'Sim' : 'Não'}</strong></div>
            <div><span>Pedidos em mesa</span><strong>${c.permitirMesas ? 'Sim' : 'Não'}</strong></div>
            <div><span>Cliente na venda</span><strong>${c.permitirCliente ? 'Sim' : 'Não'}</strong></div>
            <div><span>Pagamentos</span><strong>${escapeHtml(metodos.join(', ') || '—')}</strong></div>
            <div><span>Desconto máximo</span><strong>${c.exigeAutorizacaoDesconto ? `${escapeHtml(String(c.descontoMaximoPercentual || 0))}%` : 'Livre (com registro)'}</strong></div>
          </div>
          <p class="subtexto">Quem muda isso é o gerente, no computador: Configurações → Celular.</p>`
          : '<p class="subtexto">Ainda sem configuração da loja — o computador precisa estar com o GerenciaAI aberto.</p>'}

        <h2 class="titulo-secao">Loja</h2>
        <div class="cartao-config">
          <button class="item-menu" id="aj-renomear">Renomear este celular</button>
          ${lojas.filter((l) => l.installId !== loja.installId).map((l) => `<button class="item-menu" data-trocar="${escapeHtml(l.installId)}">Trocar para ${escapeHtml(l.nomeNegocio)}</button>`).join('')}
          <button class="item-menu" id="aj-parear">Parear outra loja</button>
          <button class="item-menu item-menu-perigo" id="aj-esquecer">Esquecer esta loja neste celular</button>
        </div>
      `;
      conteudo.querySelectorAll('[data-pref]').forEach((b) => b.addEventListener('click', () => {
        prefs = { ...prefs, [b.dataset.pref]: b.dataset.valor };
        gravarPrefs(prefs);
        render();
        notificar('prefs');
      }));
      conteudo.querySelectorAll('[data-pref-bool]').forEach((i) => i.addEventListener('change', () => {
        prefs = { ...prefs, [i.dataset.prefBool]: i.checked };
        gravarPrefs(prefs);
        notificar('prefs');
      }));
      conteudo.querySelector('#aj-renomear').addEventListener('click', renomear);
      conteudo.querySelectorAll('[data-trocar]').forEach((b) => b.addEventListener('click', () => onTrocarLoja(b.dataset.trocar)));
      conteudo.querySelector('#aj-parear').addEventListener('click', onParearOutra);
      conteudo.querySelector('#aj-esquecer').addEventListener('click', () => {
        if (confirm('Isso só remove esta loja da lista deste celular — não afeta o acesso no servidor. Continuar?')) onEsquecerLoja();
      });
    };
    render();
    const parar = ctx.assinar((motivo) => { if (motivo === 'config') render(); });
    return parar;
  }

  async function renomear() {
    const sugestao = `${loja.vinculoNome || 'Celular'} — PDV`;
    const novo = prompt('Nome deste celular (aparece pro gerente em Configurações → Celular):', sugestao);
    if (novo === null || !novo.trim()) return;
    try {
      await S.renomearDispositivo(loja.installId, novo.trim().slice(0, 60));
      mostrarToast('Nome atualizado!');
    } catch (err) {
      mostrarToast(S.traduzirErro(err).message, 'erro');
    }
  }

  // ---------------- acesso negado ----------------

  function renderAcessoNegado() {
    desmontarAba();
    desmontarAba = () => {};
    abaAtiva = null;
    nav.innerHTML = '';
    conteudo.innerHTML = `
      <div class="tela-erro-fatal">
        <p><strong>Este celular está sem acesso a ${escapeHtml(loja.nomeNegocio)}.</strong></p>
        <p>O gerente desconectou este celular, ou o módulo PDV móvel não está ativo para a loja. Peça um código novo em Configurações → Celular.</p>
        <button id="btn-parear-novo" class="btn-primario">Parear com um código novo</button>
        <button id="btn-esquecer-negado" class="btn-secundario">Esquecer esta loja</button>
      </div>`;
    conteudo.querySelector('#btn-parear-novo').addEventListener('click', onParearOutra);
    conteudo.querySelector('#btn-esquecer-negado').addEventListener('click', onEsquecerLoja);
  }

  // ---------------- escutas ----------------

  const pararConfig = S.observarConfig(loja.installId, ({ config, doServidor, erro }) => {
    if (erro) {
      if (erro.code === 'permission-denied') {
        estado.acessoNegado = true;
        renderIndicador();
        renderAcessoNegado();
      }
      return;
    }
    estado.config = config;
    estado.doServidor = doServidor;
    estado.configCarregada = true;
    if (config?.nomeNegocio) root.querySelector('.nome-loja').textContent = config.nomeNegocio;
    renderIndicador();
    reconciliarAbas();
    notificar('config');
  });

  const pararStatus = S.observarStatusAoVivo(loja.installId, (status) => {
    estado.statusLoja = status;
    notificar('catalogo');
  });

  const aoMudarConexao = () => { estado.online = navigator.onLine; renderIndicador(); notificar('conexao'); };
  window.addEventListener('online', aoMudarConexao);
  window.addEventListener('offline', aoMudarConexao);
  // Reavalia "computador respondendo?" mesmo sem evento nenhum chegar.
  const tick = setInterval(() => { renderIndicador(); notificar('tick'); }, 15000);

  S.registrarSinalDeVida(loja.installId);
  const sinalDeVida = setInterval(() => S.registrarSinalDeVida(loja.installId), 5 * 60 * 1000);

  renderIndicador();
  reconciliarAbas();

  return () => {
    document.body.classList.remove('modo-pdv');
    desmontarAba();
    pararConfig();
    pararStatus();
    clearInterval(tick);
    clearInterval(sinalDeVida);
    window.removeEventListener('online', aoMudarConexao);
    window.removeEventListener('offline', aoMudarConexao);
  };
}

export { mount };
