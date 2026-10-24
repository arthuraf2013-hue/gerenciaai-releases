import { icon } from './icons.js';
import {
  formatarMoeda, formatarQuantidade, unidadeFracionada, arred2, lerNumero, escapeHtml, normalizar, METODOS,
  formatarDataHora, mostrarToast, abrirSheet, bipe, vibrar, lerJSON, gravarJSON,
} from './pdv-util.js';
import * as S from './pdv-servidor.js';
import { cameraDisponivel, abrirScanner, pedirCodigoDigitado } from './pdv-scanner.js';
import { mostrarRecibo } from './pdv-recibo.js';
import { abrirCadastro } from './pdv-gestao.js';

/**
 * Aba "Vender" do PDV móvel: catálogo (busca, categorias, câmera/leitor),
 * carrinho, cliente, desconto, pagamento (dinheiro com troco, cartão,
 * Pix com QR, fiado) e envio da venda pro computador da loja, que
 * confere tudo e devolve o resultado (ver pdv-servidor.js).
 *
 * O carrinho fica salvo no próprio celular (localStorage) -- fechar o
 * app, trocar de aba ou a tela apagar não perde a venda em montagem. A
 * venda já enviada também fica marcada ("em andamento") até o resultado
 * chegar, pra nunca ser reenviada em duplicidade.
 */

const LIMITE_CATALOGO_PUBLICADO = 800; // ver liveStatusSyncService.LIMITE_CATALOGO_GARCOM
const NOTAS = [2, 5, 10, 20, 50, 100, 200];

function mount(container, ctx) {
  const { loja, prefs } = ctx;
  const chaveVenda = `gerenciaai_pdv_venda_${loja.installId}`;

  const vazia = () => ({ itens: [], cliente: null, desconto: { valor: 0, motivo: '' }, pagamentos: [], vendaEmAndamento: null });
  let venda = { ...vazia(), ...lerJSON(chaveVenda, {}) };
  const salvar = () => gravarJSON(chaveVenda, venda);

  let tela = 'catalogo'; // 'catalogo' | 'pagamento'
  let categoria = 'todas';
  let busca = '';
  let resultadosRemotos = null; // null = não buscou; [] = buscou e não achou
  let buscandoRemoto = false;
  let timerBuscaRemota = null;
  let metodoSelecionado = null;
  let fecharScanner = null;
  let pararAcompanhamento = null;
  let sheetCarrinho = null;

  // ---------------- contas ----------------

  function contas() {
    const subtotal = venda.itens.reduce((s, i) => s + i.produto.preco * i.quantidade, 0);
    const desconto = Math.min(arred2(venda.desconto?.valor || 0), arred2(subtotal));
    const total = arred2(subtotal - desconto);
    const pago = arred2(venda.pagamentos.reduce((s, p) => s + p.valor, 0));
    const restante = arred2(total - pago);
    const troco = arred2(venda.pagamentos.reduce((s, p) => s + (p.metodo === 'dinheiro' && p.valorRecebido ? p.valorRecebido - p.valor : 0), 0));
    const qtdItens = venda.itens.reduce((s, i) => s + (unidadeFracionada(i.produto.unidade) ? 1 : i.quantidade), 0);
    return { subtotal, desconto, total, pago, restante, troco, qtdItens };
  }

  function limiteDesconto(subtotal) {
    const { config } = ctx.estado();
    if (!config) return 0;
    if (!config.exigeAutorizacaoDesconto) return arred2(subtotal);
    return arred2(subtotal * ((config.descontoMaximoPercentual || 0) / 100));
  }

  /** Por que a venda NÃO pode ser finalizada agora (null = pode). */
  function bloqueioFinalizar() {
    const { config, online, doServidor } = ctx.estado();
    const c = contas();
    if (!online || !doServidor) return 'Sem conexão com a internet — a venda só finaliza conectada.';
    if (!config) return 'A loja ainda não liberou este celular. Confira se o GerenciaAI está aberto no computador.';
    if (!S.servidorRespondendo(config)) return 'O computador da loja não está respondendo. Confira se o GerenciaAI está aberto e com internet.';
    if (!config.caixaAberto) return 'O caixa está fechado no computador. Abra o caixa lá para vender.';
    if (venda.itens.length === 0) return 'O carrinho está vazio.';
    if (c.pago > c.total + 0.005) return 'Os pagamentos passam do total da venda — remova um pagamento.';
    if (c.restante > 0.005) return `Ainda faltam ${formatarMoeda(c.restante)}.`;
    return null;
  }

  // ---------------- catálogo ----------------

  function catalogo() {
    return ctx.estado().statusLoja?.catalogoProdutos || [];
  }

  /** Mantém o preço/estoque do carrinho igual ao catálogo publicado mais
   * recente -- é o mesmo preço que o computador vai cobrar, então evita a
   * recusa por "preços alterados" na hora de finalizar. */
  function sincronizarCarrinhoComCatalogo() {
    const porId = new Map(catalogo().map((p) => [p.id, p]));
    let mudouPreco = false;
    for (const item of venda.itens) {
      const atual = porId.get(item.produto.id);
      if (!atual) continue;
      if (Math.abs(atual.preco - item.produto.preco) > 0.0001) mudouPreco = true;
      item.produto = { ...item.produto, ...atual };
    }
    if (mudouPreco) {
      salvar();
      mostrarToast('O preço de um item do carrinho foi atualizado pela loja.');
    }
  }

  function produtosFiltrados() {
    const termo = normalizar(busca);
    return catalogo().filter((p) => {
      if (categoria !== 'todas' && p.categoria !== categoria) return false;
      if (!termo) return true;
      return normalizar(p.nome).includes(termo) || (p.codigoBarras && p.codigoBarras.includes(busca.trim()));
    });
  }

  // ---------------- carrinho ----------------

  function itemDoCarrinho(produtoId) {
    return venda.itens.find((i) => i.produto.id === produtoId);
  }

  function definirQuantidade(produto, quantidade, { avisar = true } = {}) {
    const q = Math.round(quantidade * 1000) / 1000;
    if (q <= 0) {
      venda.itens = venda.itens.filter((i) => i.produto.id !== produto.id);
    } else {
      if (produto.tipo !== 'servico' && produto.estoque != null && q > produto.estoque + 1e-9) {
        if (avisar) {
          mostrarToast(`Estoque insuficiente: ${formatarQuantidade(Math.max(produto.estoque, 0), produto.unidade)} ${produto.unidade || 'un'} disponível.`, 'erro');
          if (prefs().bipe) bipe('erro');
        }
        return false;
      }
      const item = itemDoCarrinho(produto.id);
      if (item) item.quantidade = q;
      else venda.itens.push({ produto: { id: produto.id, nome: produto.nome, preco: produto.preco, unidade: produto.unidade || 'un', tipo: produto.tipo || 'produto', estoque: produto.estoque ?? null }, quantidade: q });
    }
    salvar();
    return true;
  }

  function adicionar(produto, quantidade = 1) {
    if (venda.vendaEmAndamento) { mostrarToast('Aguarde a venda enviada terminar.', 'erro'); return; }
    const atual = itemDoCarrinho(produto.id)?.quantidade || 0;
    if (definirQuantidade(produto, atual + quantidade)) {
      if (prefs().vibrar) vibrar();
      mostrarToast(`${produto.nome} ${quantidade !== 1 ? `(${formatarQuantidade(quantidade, produto.unidade)} ${produto.unidade})` : ''} adicionado`);
      atualizarCatalogoEBarra();
    }
  }

  /** Toque num produto: fracionado (kg, l...) pergunta a quantidade;
   * o resto soma 1. */
  function tocarProduto(produto) {
    if (unidadeFracionada(produto.unidade)) pedirQuantidade(produto, null, (q) => adicionar(produto, q));
    else adicionar(produto, 1);
  }

  function pedirQuantidade(produto, inicial, aoConfirmar) {
    const fr = unidadeFracionada(produto.unidade);
    const { el, fechar } = abrirSheet(`
      <h2>${escapeHtml(produto.nome)}</h2>
      <p class="subtexto">${formatarMoeda(produto.preco)} / ${escapeHtml(produto.unidade || 'un')}${produto.estoque != null && ctx.prefs().mostrarEstoque ? ` · ${formatarQuantidade(produto.estoque, produto.unidade)} em estoque` : ''}</p>
      <label class="rotulo" for="qtd-produto">Quantidade (${escapeHtml(produto.unidade || 'un')})</label>
      <input id="qtd-produto" class="campo campo-grande" inputmode="decimal" autocomplete="off" value="${inicial != null ? formatarQuantidade(inicial, produto.unidade) : ''}" placeholder="${fr ? '0,000' : '1'}" />
      <p id="qtd-total" class="subtexto"></p>
      <p id="qtd-erro" class="msg-erro" hidden></p>
      <button id="btn-qtd-ok" class="btn-primario">Confirmar</button>
      <button id="btn-qtd-cancelar" class="btn-secundario">Cancelar</button>
    `);
    const input = el.querySelector('#qtd-produto');
    const total = el.querySelector('#qtd-total');
    const erro = el.querySelector('#qtd-erro');
    const atualizarTotal = () => {
      const q = lerNumero(input.value);
      total.textContent = Number.isFinite(q) && q > 0 ? `Total: ${formatarMoeda(q * produto.preco)}` : '';
    };
    input.addEventListener('input', atualizarTotal);
    atualizarTotal();
    input.focus();
    input.select();
    const confirmar = () => {
      const q = lerNumero(input.value);
      if (!Number.isFinite(q) || q < 0 || (!fr && !Number.isInteger(q))) {
        erro.textContent = fr ? 'Digite uma quantidade válida (ex: 0,750).' : 'Digite uma quantidade inteira.';
        erro.hidden = false;
        return;
      }
      fechar();
      aoConfirmar(q);
    };
    el.querySelector('#btn-qtd-ok').addEventListener('click', confirmar);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmar(); });
    el.querySelector('#btn-qtd-cancelar').addEventListener('click', fechar);
  }

  // ---------------- código de barras ----------------

  async function tratarCodigo(codigoBruto) {
    const codigo = String(codigoBruto || '').trim();
    if (!codigo) return;
    const local = catalogo().find((p) => p.codigoBarras && p.codigoBarras === codigo);
    if (local) {
      if (prefs().bipe) bipe('ok');
      tocarProduto(local);
      return;
    }
    // Fora do catálogo publicado (ou etiqueta de balança com peso/preço
    // embutido) -- pergunta pro computador da loja.
    try {
      mostrarToast('Procurando o código no computador da loja...');
      const r = await S.consultar(loja.installId, 'codigo', { codigo });
      if (!r || r.naoEncontrado) {
        if (prefs().bipe) bipe('erro');
        // Celular de gerente/administrador: cadastra ali mesmo e já põe
        // no carrinho. Etiqueta de balança (código de balança sem produto)
        // não entra aqui -- código de balança se cadastra no computador.
        if (ctx.gestaoLiberada() && r && !r.etiquetaBalanca) {
          oferecerCadastro(codigo);
          return;
        }
        mostrarToast(r?.mensagem || `Código não encontrado: ${codigo}`, 'erro');
        return;
      }
      if (prefs().bipe) bipe('ok');
      if (r.quantidade) adicionar(r.produto, r.quantidade);
      else tocarProduto(r.produto);
    } catch (err) {
      if (prefs().bipe) bipe('erro');
      mostrarToast(err.message, 'erro');
    }
  }

  function oferecerCadastro(codigo) {
    if (fecharScanner) { fecharScanner(); fecharScanner = null; }
    const { el, fechar } = abrirSheet(`
      <h2>Código não cadastrado</h2>
      <p class="subtexto">Nenhum produto da loja tem o código <strong>${escapeHtml(codigo)}</strong>.</p>
      <button id="btn-cadastrar-codigo" class="btn-primario">Cadastrar este produto</button>
      <button id="btn-cancelar-codigo-novo" class="btn-secundario">Agora não</button>
    `);
    el.querySelector('#btn-cadastrar-codigo').addEventListener('click', () => {
      fechar();
      abrirCadastro(ctx, {
        codigoBarras: codigo,
        onCriado: (p) => tocarProduto({
          id: p.id, nome: p.nome, preco: p.precoVenda, unidade: p.unidade, tipo: p.tipo, estoque: p.estoque ?? null,
          codigoBarras: p.codigoBarras, categoria: p.categoria,
        }),
      });
    });
    el.querySelector('#btn-cancelar-codigo-novo').addEventListener('click', fechar);
  }

  async function abrirLeitor() {
    if (cameraDisponivel()) {
      fecharScanner = await abrirScanner({ onCodigo: tratarCodigo });
    } else {
      pedirCodigoDigitado({ onCodigo: tratarCodigo, abrirSheet });
    }
  }

  function agendarBuscaRemota() {
    clearTimeout(timerBuscaRemota);
    resultadosRemotos = null;
    const termo = busca.trim();
    if (termo.length < 2) return;
    // Busca no computador sozinho quando nada bateu no catálogo do
    // celular -- ou sempre que o catálogo publicado veio cortado no limite.
    const precisa = produtosFiltrados().length === 0 || catalogo().length >= LIMITE_CATALOGO_PUBLICADO;
    if (precisa) timerBuscaRemota = setTimeout(buscarNoComputador, 650);
  }

  async function buscarNoComputador() {
    const termo = busca.trim();
    if (termo.length < 1) return;
    buscandoRemoto = true;
    renderListaProdutos();
    try {
      const r = await S.consultar(loja.installId, 'produtos', { termo });
      if (busca.trim() !== termo) return; // usuário já digitou outra coisa
      resultadosRemotos = Array.isArray(r) ? r : [];
    } catch (err) {
      resultadosRemotos = [];
      mostrarToast(err.message, 'erro');
    } finally {
      buscandoRemoto = false;
      renderListaProdutos();
    }
  }

  // ---------------- render: catálogo ----------------

  function avisosHtml() {
    const { config, online, doServidor } = ctx.estado();
    const avisos = [];
    if (!online || !doServidor) avisos.push(['erro', 'semSinal', 'Sem internet — dá pra montar o carrinho, mas a venda só finaliza conectada.']);
    else if (!config) avisos.push(['alerta', 'ajustes', 'Aguardando o computador da loja liberar este celular (GerenciaAI aberto e com internet).']);
    else if (!S.servidorRespondendo(config)) avisos.push(['erro', 'semSinal', 'O computador da loja não está respondendo — confira se o GerenciaAI está aberto.']);
    else if (!config.caixaAberto) avisos.push(['alerta', 'dinheiro', 'Caixa fechado no computador. Abra o caixa lá para finalizar vendas.']);
    return avisos.map(([tipo, ic, texto]) => `<div class="aviso aviso-${tipo}">${icon(ic, 18)}<span>${escapeHtml(texto)}</span></div>`).join('');
  }

  function render() {
    if (fecharScanner) { fecharScanner(); fecharScanner = null; }
    if (tela === 'pagamento') renderPagamento();
    else renderCatalogo();
  }

  function renderCatalogo() {
    const categorias = ['todas', ...new Set(catalogo().map((p) => p.categoria).filter(Boolean))];
    if (!categorias.includes(categoria)) categoria = 'todas';
    container.innerHTML = `
      <div id="avisos-venda">${avisosHtml()}</div>
      <div class="barra-busca">
        <div class="campo-busca">
          ${icon('busca', 18)}
          <input id="input-busca-pdv" type="search" enterkeyhint="search" autocomplete="off"
                 placeholder="Buscar produto ou código" value="${escapeHtml(busca)}" aria-label="Buscar produto ou código" />
        </div>
        <button id="btn-scanner" class="btn-scanner" aria-label="Ler código de barras">${icon('codigoBarras', 24)}</button>
      </div>
      <div class="chips-categoria">
        ${categorias.map((c) => `<button class="chip ${c === categoria ? 'chip-ativo' : ''}" data-cat="${escapeHtml(c)}">${c === 'todas' ? 'Todos' : escapeHtml(c)}</button>`).join('')}
      </div>
      <div id="lista-produtos"></div>
      <div id="barra-venda" class="barra-venda" hidden></div>
    `;

    const input = container.querySelector('#input-busca-pdv');
    input.addEventListener('input', () => { busca = input.value; renderListaProdutos(); agendarBuscaRemota(); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const termo = input.value.trim();
      // Leitor Bluetooth/USB "digita" o código e manda Enter.
      if (/^\d{6,14}$/.test(termo)) { busca = ''; input.value = ''; renderListaProdutos(); tratarCodigo(termo); return; }
      const lista = produtosFiltrados();
      if (lista.length === 1) { tocarProduto(lista[0]); return; }
      clearTimeout(timerBuscaRemota);
      if (termo.length >= 2 && lista.length === 0) buscarNoComputador();
    });
    container.querySelector('#btn-scanner').addEventListener('click', abrirLeitor);
    container.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      categoria = b.dataset.cat;
      container.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('chip-ativo', x === b));
      renderListaProdutos();
    }));

    renderListaProdutos();
    renderBarra();
  }

  function cartaoProdutoHtml(p, { remoto = false } = {}) {
    const noCarrinho = itemDoCarrinho(p.id);
    const mostrarEstoque = prefs().mostrarEstoque && p.estoque != null && p.tipo !== 'servico';
    const semEstoque = p.tipo !== 'servico' && p.estoque != null && p.estoque <= 0;
    return `
      <button class="cartao-produto ${semEstoque ? 'cartao-sem-estoque' : ''}" data-produto="${escapeHtml(p.id)}" ${remoto ? 'data-remoto="1"' : ''}>
        <span class="nome-produto">${escapeHtml(p.nome)}</span>
        <span class="linha-preco">
          <span class="preco-produto">${formatarMoeda(p.preco)}${unidadeFracionada(p.unidade) ? `<small>/${escapeHtml(p.unidade)}</small>` : ''}</span>
          ${mostrarEstoque ? `<span class="estoque-produto">${semEstoque ? 'sem estoque' : `${formatarQuantidade(p.estoque, p.unidade)} ${escapeHtml(p.unidade || 'un')}`}</span>` : ''}
        </span>
        ${noCarrinho ? `<span class="badge-qtd">${escapeHtml(formatarQuantidade(noCarrinho.quantidade, p.unidade))}</span>` : ''}
      </button>`;
  }

  function renderListaProdutos() {
    const el = container.querySelector('#lista-produtos');
    if (!el) return;
    const locais = produtosFiltrados();
    const idsLocais = new Set(locais.map((p) => p.id));
    const remotos = (resultadosRemotos || []).filter((p) => !idsLocais.has(p.id));
    const classeGrade = prefs().layout === 'lista' ? 'lista-produtos-linhas' : 'grid-produtos';

    let html = '';
    if (catalogo().length === 0 && !busca) {
      html = `<p class="estado-vazio">Carregando o catálogo da loja...<br><small>Se demorar, confira se o GerenciaAI está aberto no computador.</small></p>`;
    } else if (locais.length === 0 && remotos.length === 0 && !buscandoRemoto) {
      html = `<p class="estado-vazio">Nenhum produto encontrado${busca ? ` para "${escapeHtml(busca)}"` : ''}.</p>`;
    } else {
      html = `<div class="${classeGrade}">${locais.slice(0, 200).map((p) => cartaoProdutoHtml(p)).join('')}</div>`;
      if (locais.length > 200) html += `<p class="subtexto centro">Mostrando 200 de ${locais.length}. Refine a busca.</p>`;
    }
    if (remotos.length) {
      html += `<div class="subtitulo-secao">Encontrados no computador da loja</div><div class="${classeGrade}">${remotos.map((p) => cartaoProdutoHtml(p, { remoto: true })).join('')}</div>`;
    }
    if (buscandoRemoto) html += `<p class="estado-vazio"><span class="spinner spinner-pequeno"></span> Buscando no computador da loja...</p>`;
    else if (busca.trim().length >= 2 && resultadosRemotos === null) {
      html += `<button id="btn-buscar-remoto" class="btn-link-centro">Não achou? Buscar no computador da loja</button>`;
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-produto]').forEach((b) => b.addEventListener('click', () => {
      const lista = b.dataset.remoto ? resultadosRemotos : catalogo();
      const produto = lista.find((p) => p.id === b.dataset.produto);
      if (produto) tocarProduto(produto);
    }));
    el.querySelector('#btn-buscar-remoto')?.addEventListener('click', buscarNoComputador);
  }

  function renderBarra() {
    const barra = container.querySelector('#barra-venda');
    if (!barra) return;
    const c = contas();
    if (venda.itens.length === 0) { barra.hidden = true; return; }
    barra.hidden = false;
    barra.innerHTML = `
      <button id="btn-abrir-carrinho" class="btn-carrinho">
        <span class="carrinho-qtd">${icon('cart', 20)} ${venda.itens.length} ${venda.itens.length === 1 ? 'item' : 'itens'}</span>
        <span class="carrinho-total">${formatarMoeda(c.total)}</span>
        <span class="carrinho-acao">Ver venda ${icon('chevronRight', 16)}</span>
      </button>`;
    barra.querySelector('#btn-abrir-carrinho').addEventListener('click', abrirCarrinho);
  }

  function atualizarCatalogoEBarra() {
    if (tela !== 'catalogo') return;
    renderListaProdutos();
    renderBarra();
  }

  // ---------------- carrinho (sheet) ----------------

  function abrirCarrinho() {
    sheetCarrinho?.fechar();
    sheetCarrinho = abrirSheet('<div id="conteudo-carrinho"></div>', { onFechar: () => { sheetCarrinho = null; atualizarCatalogoEBarra(); } });
    renderCarrinho();
  }

  function renderCarrinho() {
    if (!sheetCarrinho) return;
    const el = sheetCarrinho.el.querySelector('#conteudo-carrinho');
    const { config } = ctx.estado();
    const c = contas();
    const limite = limiteDesconto(c.subtotal);
    const podeCliente = config?.permitirCliente !== false;

    if (venda.itens.length === 0) {
      el.innerHTML = `<h2>Venda</h2><p class="estado-vazio">Carrinho vazio.</p><button id="btn-fechar-carrinho" class="btn-secundario">Voltar</button>`;
      el.querySelector('#btn-fechar-carrinho').addEventListener('click', () => sheetCarrinho.fechar());
      return;
    }

    el.innerHTML = `
      <div class="cabecalho-sheet">
        <h2>Venda</h2>
        <button id="btn-limpar-venda" class="btn-texto-perigo">${icon('lixeira', 16)} Limpar</button>
      </div>
      <div class="linhas-carrinho">
        ${venda.itens.map((i) => `
          <div class="linha-carrinho">
            <div class="linha-carrinho-info">
              <div class="linha-nome">${escapeHtml(i.produto.nome)}</div>
              <div class="subtexto">${formatarMoeda(i.produto.preco)}${unidadeFracionada(i.produto.unidade) ? `/${escapeHtml(i.produto.unidade)}` : ' un.'} · <strong>${formatarMoeda(i.produto.preco * i.quantidade)}</strong></div>
            </div>
            <div class="controles-qtd">
              <button data-menos="${escapeHtml(i.produto.id)}" aria-label="Diminuir ${escapeHtml(i.produto.nome)}">${unidadeFracionada(i.produto.unidade) ? icon('lixeira', 15) : '−'}</button>
              <button class="qtd-valor" data-editar="${escapeHtml(i.produto.id)}" aria-label="Editar quantidade de ${escapeHtml(i.produto.nome)}">${escapeHtml(formatarQuantidade(i.quantidade, i.produto.unidade))}</button>
              <button data-mais="${escapeHtml(i.produto.id)}" aria-label="Aumentar ${escapeHtml(i.produto.nome)}">+</button>
            </div>
          </div>`).join('')}
      </div>

      ${podeCliente ? `
        <button id="btn-cliente" class="linha-acao">
          ${icon('usuario', 18)}
          <span>${venda.cliente ? `<strong>${escapeHtml(venda.cliente.nome)}</strong>${venda.cliente.documentoFinal ? ` <small>${escapeHtml(venda.cliente.documentoFinal)}</small>` : ''}` : 'Adicionar cliente'}</span>
          ${venda.cliente ? `<span class="acao-remover" id="btn-remover-cliente" role="button" aria-label="Remover cliente">${icon('fechar', 16)}</span>` : icon('chevronRight', 16)}
        </button>` : ''}
      ${limite > 0 || c.desconto > 0 ? `
        <button id="btn-desconto" class="linha-acao">
          ${icon('etiqueta', 18)}
          <span>${c.desconto > 0 ? `Desconto <strong>−${formatarMoeda(c.desconto)}</strong>` : 'Dar desconto'}</span>
          ${icon('chevronRight', 16)}
        </button>` : ''}

      <div class="totais">
        <div><span>Subtotal</span><span>${formatarMoeda(c.subtotal)}</span></div>
        ${c.desconto > 0 ? `<div><span>Desconto</span><span>−${formatarMoeda(c.desconto)}</span></div>` : ''}
        ${c.pago > 0 ? `<div><span>Já pago</span><span>${formatarMoeda(c.pago)}</span></div>` : ''}
        <div class="total-final"><span>Total</span><span>${formatarMoeda(c.total)}</span></div>
      </div>
      <button id="btn-ir-pagamento" class="btn-primario">Cobrar ${formatarMoeda(c.restante > 0 ? c.restante : c.total)}</button>
      <button id="btn-continuar" class="btn-secundario">Continuar vendendo</button>
    `;

    el.querySelectorAll('[data-mais]').forEach((b) => b.addEventListener('click', () => {
      const item = itemDoCarrinho(b.dataset.mais);
      if (unidadeFracionada(item.produto.unidade)) { editarQuantidade(item); return; }
      definirQuantidade(item.produto, item.quantidade + 1);
      renderCarrinho();
    }));
    el.querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => {
      const item = itemDoCarrinho(b.dataset.menos);
      definirQuantidade(item.produto, unidadeFracionada(item.produto.unidade) ? 0 : item.quantidade - 1);
      renderCarrinho();
    }));
    el.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => editarQuantidade(itemDoCarrinho(b.dataset.editar))));
    el.querySelector('#btn-limpar-venda').addEventListener('click', () => {
      if (venda.pagamentos.length && !confirm('Já tem pagamento lançado nesta venda. Limpar mesmo assim? (cobranças já feitas no cartão/Pix precisam ser estornadas fora do sistema)')) return;
      if (!venda.pagamentos.length && !confirm('Limpar todos os itens da venda?')) return;
      venda = vazia();
      salvar();
      sheetCarrinho.fechar();
    });
    el.querySelector('#btn-cliente')?.addEventListener('click', (e) => {
      if (e.target.closest('#btn-remover-cliente')) {
        venda.cliente = null;
        venda.pagamentos = venda.pagamentos.filter((p) => p.metodo !== 'fiado');
        salvar();
        renderCarrinho();
        return;
      }
      abrirBuscaCliente();
    });
    el.querySelector('#btn-desconto')?.addEventListener('click', abrirDesconto);
    el.querySelector('#btn-ir-pagamento').addEventListener('click', () => {
      sheetCarrinho.fechar();
      tela = 'pagamento';
      metodoSelecionado = null;
      render();
    });
    el.querySelector('#btn-continuar').addEventListener('click', () => sheetCarrinho.fechar());
  }

  function editarQuantidade(item) {
    if (!item) return;
    pedirQuantidade(item.produto, item.quantidade, (q) => {
      definirQuantidade(item.produto, q);
      renderCarrinho();
      if (tela === 'pagamento') renderPagamento();
    });
  }

  // ---------------- cliente ----------------

  function abrirBuscaCliente() {
    const { el, fechar } = abrirSheet(`
      <h2>Cliente</h2>
      <div class="campo-busca">${icon('busca', 18)}<input id="busca-cliente" type="search" autocomplete="off" placeholder="Nome, telefone ou CPF" /></div>
      <div id="resultado-clientes" class="lista-clientes"><p class="subtexto">Digite ao menos 2 letras ou números.</p></div>
      <button id="btn-fechar-cliente" class="btn-secundario">Cancelar</button>
    `);
    const input = el.querySelector('#busca-cliente');
    const lista = el.querySelector('#resultado-clientes');
    let timer = null;
    let ultimaBusca = 0;
    input.focus();
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const termo = input.value.trim();
      if (termo.length < 2) { lista.innerHTML = '<p class="subtexto">Digite ao menos 2 letras ou números.</p>'; return; }
      timer = setTimeout(async () => {
        const minha = ++ultimaBusca;
        lista.innerHTML = '<p class="subtexto"><span class="spinner spinner-pequeno"></span> Buscando...</p>';
        try {
          const clientes = await S.consultar(loja.installId, 'clientes', { termo });
          if (minha !== ultimaBusca) return;
          if (!clientes?.length) { lista.innerHTML = '<p class="estado-vazio">Nenhum cliente encontrado.</p>'; return; }
          lista.innerHTML = clientes.map((c) => `
            <button class="cartao-cliente" data-cliente="${escapeHtml(c.id)}">
              <span><strong>${escapeHtml(c.nome)}</strong><br><small>${[c.telefoneFinal && `Tel ${c.telefoneFinal}`, c.documentoFinal && `Doc ${c.documentoFinal}`].filter(Boolean).map(escapeHtml).join(' · ')}</small></span>
              <span class="cliente-extra">${c.pontos ? `${c.pontos} pts` : ''}${c.saldoFiado > 0.005 ? `<br><span class="erro-texto">deve ${formatarMoeda(c.saldoFiado)}</span>` : ''}</span>
            </button>`).join('');
          lista.querySelectorAll('[data-cliente]').forEach((b) => b.addEventListener('click', () => {
            const c = clientes.find((x) => x.id === b.dataset.cliente);
            venda.cliente = { id: c.id, nome: c.nome, documentoFinal: c.documentoFinal || c.telefoneFinal || null, saldoFiado: c.saldoFiado || 0 };
            salvar();
            fechar();
            renderCarrinho();
            if (tela === 'pagamento') renderPagamento();
          }));
        } catch (err) {
          if (minha === ultimaBusca) lista.innerHTML = `<p class="msg-erro">${escapeHtml(err.message)}</p>`;
        }
      }, 600);
    });
    el.querySelector('#btn-fechar-cliente').addEventListener('click', fechar);
  }

  // ---------------- desconto ----------------

  function abrirDesconto() {
    const c = contas();
    const limite = limiteDesconto(c.subtotal);
    const { config } = ctx.estado();
    let modo = 'valor';
    const { el, fechar } = abrirSheet(`
      <h2>Desconto</h2>
      <p class="subtexto">${config?.exigeAutorizacaoDesconto
        ? `Máximo pelo celular: ${escapeHtml(String(config.descontoMaximoPercentual))}% (${formatarMoeda(limite)} nesta venda). Acima disso, só no caixa do computador com senha de gerente.`
        : `Até ${formatarMoeda(limite)}. Fica registrado na auditoria da loja.`}</p>
      <div class="seletor-periodo">
        <button class="btn-periodo btn-periodo-ativo" data-modo="valor">R$</button>
        <button class="btn-periodo" data-modo="pct">%</button>
      </div>
      <input id="valor-desconto" class="campo campo-grande" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${c.desconto > 0 ? String(c.desconto).replace('.', ',') : ''}" />
      <input id="motivo-desconto" class="campo" maxlength="120" placeholder="Motivo (opcional)" value="${escapeHtml(venda.desconto?.motivo || '')}" />
      <p id="preview-desconto" class="subtexto"></p>
      <p id="erro-desconto" class="msg-erro" hidden></p>
      <button id="btn-aplicar-desconto" class="btn-primario">Aplicar</button>
      ${c.desconto > 0 ? '<button id="btn-remover-desconto" class="btn-secundario">Remover desconto</button>' : ''}
      <button id="btn-cancelar-desconto" class="btn-secundario">Cancelar</button>
    `);
    const input = el.querySelector('#valor-desconto');
    const preview = el.querySelector('#preview-desconto');
    const erro = el.querySelector('#erro-desconto');
    const valorEmReais = () => {
      const n = lerNumero(input.value);
      if (!Number.isFinite(n) || n < 0) return NaN;
      return arred2(modo === 'pct' ? c.subtotal * (n / 100) : n);
    };
    const atualizar = () => {
      const v = valorEmReais();
      preview.textContent = Number.isFinite(v) && v > 0 ? `Desconto de ${formatarMoeda(v)} — total ${formatarMoeda(Math.max(c.subtotal - v, 0))}` : '';
    };
    el.querySelectorAll('[data-modo]').forEach((b) => b.addEventListener('click', () => {
      modo = b.dataset.modo;
      el.querySelectorAll('[data-modo]').forEach((x) => x.classList.toggle('btn-periodo-ativo', x === b));
      input.placeholder = modo === 'pct' ? '0%' : '0,00';
      input.value = '';
      atualizar();
      input.focus();
    }));
    input.addEventListener('input', atualizar);
    input.focus();
    el.querySelector('#btn-aplicar-desconto').addEventListener('click', () => {
      const v = valorEmReais();
      if (!Number.isFinite(v) || v <= 0) { erro.textContent = 'Digite um desconto válido.'; erro.hidden = false; return; }
      if (v > limite + 0.005) { erro.textContent = `O máximo pelo celular é ${formatarMoeda(limite)}.`; erro.hidden = false; return; }
      venda.desconto = { valor: v, motivo: el.querySelector('#motivo-desconto').value.trim() };
      salvar();
      fechar();
      renderCarrinho();
      if (tela === 'pagamento') renderPagamento();
    });
    el.querySelector('#btn-remover-desconto')?.addEventListener('click', () => {
      venda.desconto = { valor: 0, motivo: '' };
      salvar();
      fechar();
      renderCarrinho();
      if (tela === 'pagamento') renderPagamento();
    });
    el.querySelector('#btn-cancelar-desconto').addEventListener('click', fechar);
  }

  // ---------------- pagamento ----------------

  function metodosPermitidos() {
    const lista = ctx.estado().config?.metodosPagamento || ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix'];
    return lista.filter((m) => METODOS[m]);
  }

  function renderPagamento() {
    const c = contas();
    const metodos = metodosPermitidos();
    if (!metodoSelecionado || !metodos.includes(metodoSelecionado)) metodoSelecionado = metodos[0] || null;
    const bloqueio = bloqueioFinalizar();
    const quitado = c.restante <= 0.005;
    const notas = NOTAS.filter((n) => n > c.restante).slice(0, 3);

    container.innerHTML = `
      <div class="topo-secao">
        <button id="btn-voltar-catalogo" class="btn-icone" aria-label="Voltar ao catálogo">${icon('voltar', 22)}</button>
        <h2>Pagamento</h2>
      </div>
      <div id="avisos-venda">${avisosHtml()}</div>

      <div class="painel-total">
        <div class="painel-total-rotulo">${quitado ? 'Venda paga' : 'Falta pagar'}</div>
        <div class="painel-total-valor">${formatarMoeda(Math.max(c.restante, 0))}</div>
        <div class="painel-total-detalhe">
          Total ${formatarMoeda(c.total)}${c.desconto > 0 ? ` · desconto ${formatarMoeda(c.desconto)}` : ''} ·
          <button id="btn-ver-itens" class="btn-link-inline">${venda.itens.length} ${venda.itens.length === 1 ? 'item' : 'itens'}</button>
        </div>
        ${venda.cliente ? `<div class="painel-total-detalhe">${icon('usuario', 14)} ${escapeHtml(venda.cliente.nome)}</div>` : ''}
      </div>

      ${!quitado ? `
        <div class="metodos-pagamento" role="radiogroup" aria-label="Forma de pagamento">
          ${metodos.map((m) => `
            <button class="metodo ${m === metodoSelecionado ? 'metodo-ativo' : ''}" data-metodo="${m}" role="radio" aria-checked="${m === metodoSelecionado}"
              ${m === 'fiado' && !venda.cliente ? 'data-precisa-cliente="1"' : ''}>
              ${icon(METODOS[m].icone, 22)}<span>${METODOS[m].rotulo}</span>
            </button>`).join('')}
        </div>
        ${metodoSelecionado === 'fiado' && !venda.cliente ? '<p class="aviso aviso-alerta">Fiado precisa de cliente — <button id="btn-escolher-cliente" class="btn-link-inline">escolher cliente</button>.</p>' : ''}
        <div class="entrada-valor">
          <span class="prefixo">R$</span>
          <input id="valor-pagamento" inputmode="decimal" autocomplete="off" value="${Number(c.restante).toFixed(2).replace('.', ',')}" aria-label="Valor do pagamento" />
        </div>
        ${metodoSelecionado === 'dinheiro' ? `
          <div class="atalhos-valor">
            <button class="chip" data-valor="${Number(c.restante)}">Exato</button>
            ${notas.map((n) => `<button class="chip" data-valor="${n}">${formatarMoeda(n)}</button>`).join('')}
          </div>
          <p id="preview-troco" class="preview-troco"></p>` : ''}
        <p id="erro-pagamento" class="msg-erro" hidden></p>
        <button id="btn-adicionar-pagamento" class="btn-primario">${metodoSelecionado === 'pix' ? 'Gerar QR do Pix' : `Receber em ${METODOS[metodoSelecionado]?.rotulo || ''}`}</button>
      ` : ''}

      ${venda.pagamentos.length ? `
        <div class="subtitulo-secao">Pagamentos</div>
        <div class="lista-pagamentos">
          ${venda.pagamentos.map((p, idx) => `
            <div class="linha-pagamento">
              ${icon(METODOS[p.metodo]?.icone || 'dinheiro', 18)}
              <span class="linha-pagamento-desc">${METODOS[p.metodo]?.rotulo || escapeHtml(p.metodo)}${p.metodo === 'dinheiro' && p.valorRecebido > p.valor ? ` <small>(recebido ${formatarMoeda(p.valorRecebido)})</small>` : ''}</span>
              <strong>${formatarMoeda(p.valor)}</strong>
              <button class="btn-icone btn-icone-pequeno" data-remover-pagamento="${idx}" aria-label="Remover pagamento">${icon('fechar', 16)}</button>
            </div>`).join('')}
        </div>` : ''}

      ${c.troco > 0 ? `<div class="destaque-troco">Troco: <strong>${formatarMoeda(c.troco)}</strong></div>` : ''}

      ${bloqueio && quitado ? `<p class="aviso aviso-alerta">${escapeHtml(bloqueio)}</p>` : ''}
      <button id="btn-finalizar" class="btn-primario btn-finalizar" ${bloqueio ? 'disabled' : ''}>${icon('check', 20)} Finalizar venda</button>
    `;

    container.querySelector('#btn-voltar-catalogo').addEventListener('click', () => { tela = 'catalogo'; render(); });
    container.querySelector('#btn-ver-itens').addEventListener('click', abrirCarrinho);
    container.querySelectorAll('[data-metodo]').forEach((b) => b.addEventListener('click', () => { metodoSelecionado = b.dataset.metodo; renderPagamento(); }));
    container.querySelector('#btn-escolher-cliente')?.addEventListener('click', abrirBuscaCliente);

    const input = container.querySelector('#valor-pagamento');
    const previewTroco = container.querySelector('#preview-troco');
    const atualizarTroco = () => {
      if (!previewTroco) return;
      const v = lerNumero(input.value);
      previewTroco.textContent = Number.isFinite(v) && v > c.restante + 0.005 ? `Troco: ${formatarMoeda(v - c.restante)}` : '';
    };
    if (input) {
      input.addEventListener('focus', () => input.select());
      input.addEventListener('input', atualizarTroco);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') adicionarPagamento(); });
    }
    container.querySelectorAll('[data-valor]').forEach((b) => b.addEventListener('click', () => {
      input.value = Number(b.dataset.valor).toFixed(2).replace('.', ',');
      atualizarTroco();
    }));
    container.querySelector('#btn-adicionar-pagamento')?.addEventListener('click', adicionarPagamento);
    container.querySelectorAll('[data-remover-pagamento]').forEach((b) => b.addEventListener('click', () => {
      const p = venda.pagamentos[Number(b.dataset.removerPagamento)];
      if (p && p.metodo !== 'dinheiro' && !confirm(`Remover o pagamento de ${formatarMoeda(p.valor)} em ${METODOS[p.metodo]?.rotulo}? Se já foi cobrado, estorne na maquininha/banco.`)) return;
      venda.pagamentos.splice(Number(b.dataset.removerPagamento), 1);
      salvar();
      renderPagamento();
    }));
    container.querySelector('#btn-finalizar').addEventListener('click', finalizar);
  }

  function adicionarPagamento() {
    const c = contas();
    const erro = container.querySelector('#erro-pagamento');
    const mostrarErro = (t) => { erro.textContent = t; erro.hidden = false; };
    const metodo = metodoSelecionado;
    const digitado = lerNumero(container.querySelector('#valor-pagamento').value);
    if (!Number.isFinite(digitado) || digitado <= 0) return mostrarErro('Digite um valor válido.');
    if (c.restante <= 0.005) return mostrarErro('A venda já está paga.');
    if (metodo === 'fiado') {
      if (!venda.cliente) return mostrarErro('Escolha o cliente antes de lançar fiado.');
      if (digitado > c.restante + 0.005) return mostrarErro(`Fiado não pode passar do que falta (${formatarMoeda(c.restante)}).`);
    }
    const aplicado = arred2(Math.min(digitado, c.restante));

    if (metodo === 'pix') { abrirPix(aplicado); return; }

    venda.pagamentos.push({
      metodo, valor: aplicado,
      // Dinheiro: o que passou do que faltava é troco. Cartão: valor
      // passado na maquininha acima do que faltava fica registrado
      // (mesma regra do caixa do computador).
      valorRecebido: digitado > aplicado + 0.005 ? arred2(digitado) : null,
    });
    salvar();
    if (prefs().vibrar) vibrar(25);
    renderPagamento();
  }

  async function abrirPix(valor) {
    const txid = `M${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const { el, fechar } = abrirSheet(`
      <h2>Pix — ${formatarMoeda(valor)}</h2>
      <div id="area-pix" class="area-pix"><p class="subtexto"><span class="spinner spinner-pequeno"></span> Gerando QR Code no computador da loja...</p></div>
      <button id="btn-pix-recebido" class="btn-primario" disabled>${icon('check', 18)} Pix recebido</button>
      <button id="btn-pix-cancelar" class="btn-secundario">Cancelar</button>
    `, { fecharTocandoFora: false });
    el.querySelector('#btn-pix-cancelar').addEventListener('click', fechar);
    try {
      const r = await S.consultar(loja.installId, 'pix', { valor, txid });
      const area = el.querySelector('#area-pix');
      if (!area) return; // sheet já fechado
      area.innerHTML = `
        <canvas id="qr-pix" width="260" height="260" aria-label="QR Code do Pix"></canvas>
        <p class="subtexto centro">Peça pro cliente ler o QR no app do banco e confira o recebimento antes de confirmar.</p>
        <button id="btn-copiar-pix" class="btn-secundario">Copiar "Pix copia e cola"</button>`;
      desenharQr(area.querySelector('#qr-pix'), r.qr);
      area.querySelector('#btn-copiar-pix').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(r.payload); mostrarToast('Código Pix copiado.'); } catch { mostrarToast('Não foi possível copiar.', 'erro'); }
      });
      const btn = el.querySelector('#btn-pix-recebido');
      btn.disabled = false;
      btn.addEventListener('click', () => {
        const atual = contas();
        venda.pagamentos.push({ metodo: 'pix', valor: arred2(Math.min(r.valor, atual.restante)), valorRecebido: null });
        salvar();
        fechar();
        renderPagamento();
      });
    } catch (err) {
      const area = el.querySelector('#area-pix');
      if (area) area.innerHTML = `<p class="msg-erro">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------------- finalizar / acompanhar ----------------

  function finalizar() {
    const bloqueio = bloqueioFinalizar();
    if (bloqueio) { mostrarToast(bloqueio, 'erro'); return; }
    if (venda.vendaEmAndamento) { acompanhar(venda.vendaEmAndamento.id); return; }
    const c = contas();
    const vendaId = S.novoIdVenda(loja.installId);
    const dados = {
      itens: venda.itens.map((i) => ({ productId: i.produto.id, nome: i.produto.nome, quantidade: i.quantidade, precoUnitario: i.produto.preco })),
      pagamentos: venda.pagamentos.map((p) => ({ metodo: p.metodo, valor: p.valor, valorRecebido: p.valorRecebido ?? null })),
      desconto: c.desconto > 0 ? { valor: c.desconto, motivo: venda.desconto?.motivo || null } : null,
      clienteId: venda.cliente?.id || null,
      clienteNome: venda.cliente?.nome || null,
      subtotalEsperado: c.subtotal,
      totalEsperado: c.total,
      observacoes: null,
    };
    // Marca ANTES de enviar: se o app fechar no meio, ao abrir de novo
    // ele só acompanha esta mesma venda, nunca manda outra.
    venda.vendaEmAndamento = { id: vendaId, enviadaEm: Date.now(), total: c.total, troco: c.troco };
    salvar();
    S.enviarVenda(loja.installId, vendaId, dados).catch((err) => {
      console.error('[pdv] envio da venda falhou', err);
      if (venda.vendaEmAndamento?.id !== vendaId) return;
      venda.vendaEmAndamento = null;
      salvar();
      encerrarAcompanhamento?.();
      mostrarResultadoErro(S.traduzirErro(err).message, null);
    });
    acompanhar(vendaId);
  }

  let sheetAcompanhamento = null;
  let encerrarAcompanhamento = null;

  function acompanhar(vendaId) {
    pararAcompanhamento?.();
    sheetAcompanhamento?.fechar();
    sheetAcompanhamento = abrirSheet('<div id="acompanhamento" class="acompanhamento"></div>', { fecharTocandoFora: false, classe: 'sheet-acompanhamento' });
    const el = sheetAcompanhamento.el.querySelector('#acompanhamento');
    const inicio = venda.vendaEmAndamento?.enviadaEm || Date.now();
    let fase = 'enviando';
    let timerDemora = null;

    const renderEspera = () => {
      const demorando = Date.now() - inicio > 30000;
      el.innerHTML = `
        <div class="spinner spinner-grande"></div>
        <h2>${fase === 'enviando' ? 'Enviando a venda...' : 'Aguardando o computador da loja...'}</h2>
        <p class="subtexto">${fase === 'enviando' ? 'Mantenha o celular conectado.' : 'Conferindo preço, estoque e pagamento.'}</p>
        ${demorando ? `
          <p class="aviso aviso-alerta">Está demorando. A venda já foi enviada e será processada assim que o computador responder — <strong>não refaça a venda</strong>. O resultado aparece na aba Vendas.</p>
          <button id="btn-liberar" class="btn-secundario">Liberar o celular para outra venda</button>` : ''}
      `;
      el.querySelector('#btn-liberar')?.addEventListener('click', () => {
        if (!confirm('A venda continua na fila do computador e aparece na aba Vendas. Liberar o celular?')) return;
        encerrar();
        venda = vazia();
        salvar();
        tela = 'catalogo';
        render();
      });
    };
    timerDemora = setInterval(() => { if (fase === 'enviando' || fase === 'aguardando') renderEspera(); }, 10000);

    const encerrar = () => {
      clearInterval(timerDemora);
      pararAcompanhamento?.();
      pararAcompanhamento = null;
      sheetAcompanhamento?.fechar();
      sheetAcompanhamento = null;
      encerrarAcompanhamento = null;
    };
    encerrarAcompanhamento = encerrar;

    renderEspera();
    pararAcompanhamento = S.observarVenda(loja.installId, vendaId, ({ fase: novaFase, dados, erro }) => {
      if (novaFase === 'enviando' || novaFase === 'aguardando') {
        if (novaFase !== fase) { fase = novaFase; renderEspera(); }
        return;
      }
      if (novaFase === 'inexistente') {
        // O servidor diz que o documento não existe E não há escrita
        // pendente neste celular: a venda nunca chegou (escrita recusada
        // -- o .catch do envio mostra o motivo -- ou o cache local foi
        // apagado antes de sincronizar). Nada foi registrado: devolve o
        // carrinho pro operador finalizar de novo.
        encerrar();
        if (venda.vendaEmAndamento?.id === vendaId) {
          venda.vendaEmAndamento = null;
          salvar();
          render();
          mostrarResultadoErro('A venda não chegou ao computador da loja. Confira a conexão e finalize de novo.', null);
        }
        return;
      }
      encerrar();
      if (novaFase === 'erro-escuta') { mostrarResultadoErro(erro?.message || 'Falha ao acompanhar a venda.', null); return; }
      if (novaFase === 'finalizada' || novaFase === 'pendente') {
        const resumo = dados.resumo;
        venda = vazia(); // venda aceita -- carrinho zera na hora, nunca é reenviado
        salvar();
        tela = 'catalogo';
        render();
        mostrarResultadoSucesso({ dados, resumo, pendente: novaFase === 'pendente' });
        return;
      }
      // erro de negócio: volta pra venda com tudo como estava
      venda.vendaEmAndamento = null;
      if (dados.codigoErro === 'precos_alterados' && dados.precosAtuais) {
        for (const item of venda.itens) {
          const novo = dados.precosAtuais[item.produto.id];
          if (novo != null) item.produto.preco = novo;
        }
      }
      if (dados.codigoErro === 'cliente_invalido') venda.cliente = null;
      salvar();
      render();
      mostrarResultadoErro(dados.erro || 'O computador da loja recusou a venda.', dados.codigoErro);
    });
  }

  function mostrarResultadoErro(mensagem, codigo) {
    const { el, fechar } = abrirSheet(`
      <div class="resultado resultado-erro">
        <div class="resultado-icone">${icon('fechar', 34)}</div>
        <h2>Venda não finalizada</h2>
        <p>${escapeHtml(mensagem)}</p>
        ${codigo === 'precos_alterados' ? '<p class="subtexto">Os preços do carrinho já foram atualizados. Confira o total e os pagamentos antes de finalizar de novo.</p>' : ''}
        <p class="subtexto">Nada foi registrado no computador. O carrinho e os pagamentos continuam aqui para corrigir.</p>
      </div>
      <button id="btn-ok-erro" class="btn-primario">Corrigir a venda</button>
    `);
    el.querySelector('#btn-ok-erro').addEventListener('click', fechar);
    if (prefs().vibrar) vibrar([60, 60, 60]);
  }

  function mostrarResultadoSucesso({ dados, resumo, pendente }) {
    if (prefs().vibrar) vibrar(40);
    const { el, fechar } = abrirSheet(`
      <div class="resultado ${pendente ? 'resultado-pendente' : 'resultado-ok'}">
        <div class="resultado-icone">${icon(pendente ? 'recibo' : 'check', 36)}</div>
        <h2>${pendente ? 'Venda registrada' : 'Venda finalizada'}</h2>
        ${pendente ? `<p class="subtexto">${escapeHtml(dados.erro || 'Aguardando confirmar o estoque com as outras máquinas da loja — finaliza sozinha.')}</p>` : ''}
        <div class="resultado-total">${formatarMoeda(resumo?.total ?? dados.totalEsperado)}</div>
        ${resumo?.troco > 0 ? `<div class="destaque-troco destaque-troco-grande">Troco: <strong>${formatarMoeda(resumo.troco)}</strong></div>` : ''}
        ${resumo ? `<p class="subtexto">Venda ${escapeHtml(resumo.numero)} · ${escapeHtml(formatarDataHora(resumo.finalizadaEm))}${resumo.clienteNome ? ` · ${escapeHtml(resumo.clienteNome)}` : ''}</p>` : ''}
      </div>
      ${resumo ? `<button id="btn-recibo" class="btn-secundario">${icon('compartilhar', 18)} Recibo para o cliente</button>` : ''}
      <button id="btn-nova-venda" class="btn-primario">Nova venda</button>
    `, { fecharTocandoFora: false });
    el.querySelector('#btn-recibo')?.addEventListener('click', () => mostrarRecibo({ venda: dados, nomeLoja: ctx.estado().config?.nomeNegocio || loja.nomeNegocio }));
    el.querySelector('#btn-nova-venda').addEventListener('click', fechar);
  }

  // ---------------- ciclo de vida ----------------

  const pararAssinatura = ctx.assinar((motivo) => {
    if (motivo === 'catalogo') sincronizarCarrinhoComCatalogo();
    if (tela === 'pagamento') {
      // Não redesenha a tela de pagamento inteira a cada mudança (apagaria
      // o valor que o operador está digitando) -- só os avisos e o botão.
      const avisos = container.querySelector('#avisos-venda');
      if (avisos) avisos.innerHTML = avisosHtml();
      const btn = container.querySelector('#btn-finalizar');
      if (btn) btn.disabled = !!bloqueioFinalizar();
      return;
    }
    const avisos = container.querySelector('#avisos-venda');
    if (avisos) avisos.innerHTML = avisosHtml();
    if (motivo === 'catalogo' || motivo === 'prefs') {
      // Categoria nova pode ter aparecido -- redesenha os chips também,
      // preservando foco/texto da busca.
      const temFoco = document.activeElement?.id === 'input-busca-pdv';
      renderCatalogo();
      if (temFoco) {
        const i = container.querySelector('#input-busca-pdv');
        i?.focus();
        i?.setSelectionRange(i.value.length, i.value.length);
      }
    }
    if (sheetCarrinho && (motivo === 'catalogo' || motivo === 'config')) renderCarrinho();
  });

  render();
  if (venda.vendaEmAndamento?.id) acompanhar(venda.vendaEmAndamento.id);

  return () => {
    pararAssinatura();
    pararAcompanhamento?.();
    clearTimeout(timerBuscaRemota);
    fecharScanner?.();
    sheetCarrinho?.fechar();
    sheetAcompanhamento?.fechar();
  };
}

/** Desenha a matriz do QR (string de 0/1 linha por linha, vinda do
 * computador -- ver pdvMobileConsultaService.gerarPix) num canvas. */
function desenharQr(canvas, qr) {
  if (!canvas || !qr?.size || !qr?.bits) return;
  const margem = 4;
  const total = qr.size + margem * 2;
  const escala = Math.floor(canvas.width / total);
  const lado = escala * total;
  canvas.width = lado;
  canvas.height = lado;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, lado, lado);
  g.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.bits[y * qr.size + x] === '1') g.fillRect((x + margem) * escala, (y + margem) * escala, escala, escala);
    }
  }
}

export { mount, desenharQr };
