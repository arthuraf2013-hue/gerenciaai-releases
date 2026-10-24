import { icon } from './icons.js';
import {
  formatarMoeda, formatarQuantidade, unidadeFracionada, arred2, lerNumero, escapeHtml, normalizar,
  formatarDataHora, mostrarToast, abrirSheet, bipe,
} from './pdv-util.js';
import * as S from './pdv-servidor.js';
import { cameraDisponivel, abrirScanner, pedirCodigoDigitado } from './pdv-scanner.js';

/**
 * Aba "Produtos" do PDV móvel -- só aparece no celular de gerente,
 * administrador ou suporte que o computador liberou
 * (config_mobile/pdv.gestaoLiberadaPara). Ver preço, custo, margem e
 * estoque; alterar preço; entrada, perda ou contagem de estoque; cadastrar
 * produto. Cada mudança é um pedido ao computador (gestao_pdv), que confere
 * o papel do usuário vinculado, aplica pelos mesmos caminhos da tela de
 * Produtos e registra na Auditoria (electron/services/pdvMobileGestaoService.js).
 *
 * `abrirCadastro` também é usada pela aba Vender: código bipado que não
 * existe na loja vira "Cadastrar este produto".
 */

const UNIDADES = [
  ['un', 'Unidade (un)'], ['kg', 'Quilo (kg)'], ['g', 'Grama (g)'], ['l', 'Litro (l)'], ['ml', 'Mililitro (ml)'],
  ['m', 'Metro (m)'], ['cx', 'Caixa (cx)'], ['pct', 'Pacote (pct)'], ['dz', 'Dúzia (dz)'], ['par', 'Par'],
];
const MOVIMENTOS = {
  entrada: { rotulo: 'Entrada', campo: 'Quantidade que chegou', dica: 'Ex: nota 1234, reposição do fornecedor' },
  perda: { rotulo: 'Perda', campo: 'Quantidade perdida', dica: 'Ex: vencido, quebrado, avariado' },
  contagem: { rotulo: 'Contei', campo: 'Quantidade contada agora', dica: 'Ex: inventário do mês' },
};
const LIMITE_LISTA = 150;

function pct(v) {
  return `${String(v.toFixed(1)).replace('.', ',')}%`;
}

function margemDe(preco, custo) {
  return custo > 0 && preco > 0 ? ((preco - custo) / preco) * 100 : null;
}

/** Resultado de um pedido que chegou depois do aviso de "ainda não
 * confirmou" -- o operador já saiu da tela, então vira um toast. */
function avisoTardio(ctx) {
  return (saida) => {
    if (saida.erro) { mostrarToast(saida.erro, 'erro'); return; }
    mostrarToast(saida.resultado?.mensagem || 'Alteração confirmada pelo computador.');
    if (saida.resultado?.produto) ctx.aplicarProdutoNoCatalogo(saida.resultado.produto);
  };
}

function htmlCarregando(texto) {
  return `<p class="estado-vazio"><span class="spinner spinner-pequeno"></span> ${escapeHtml(texto)}</p>`;
}

// ---------------------------------------------------------------------
// Detalhe do produto
// ---------------------------------------------------------------------

function htmlDetalhe(p) {
  const servico = p.tipo === 'servico';
  const margem = p.margem;
  const classeMargem = margem == null ? '' : (margem < 0 ? 'valor-perigo' : (margem < 15 ? 'valor-alerta' : 'valor-ok'));
  const estoqueBaixo = !servico && p.estoque != null && p.estoqueMinimo > 0 && p.estoque <= p.estoqueMinimo;
  return `
    <div class="cabecalho-sheet">
      <div class="detalhe-titulo">
        <h2>${escapeHtml(p.nome)}</h2>
        <p class="subtexto">${escapeHtml([p.categoria, p.codigoBarras ? `Código ${p.codigoBarras}` : null].filter(Boolean).join(' · ') || 'Sem categoria')}</p>
      </div>
      <button class="btn-icone" data-fechar aria-label="Fechar">${icon('fechar', 20)}</button>
    </div>
    <div class="grade-indicadores">
      <div class="indicador"><span>Preço de venda</span><strong>${formatarMoeda(p.precoVenda)}${unidadeFracionada(p.unidade) ? `<small>/${escapeHtml(p.unidade)}</small>` : ''}</strong></div>
      <div class="indicador"><span>Custo</span><strong>${p.custo > 0 ? formatarMoeda(p.custo) : '—'}</strong></div>
      <div class="indicador"><span>Margem</span><strong class="${classeMargem}">${margem == null ? '—' : pct(margem)}</strong></div>
      <div class="indicador"><span>Estoque</span><strong class="${estoqueBaixo ? 'valor-alerta' : ''}">${servico ? 'Serviço' : `${escapeHtml(formatarQuantidade(p.estoque ?? 0, p.unidade))} ${escapeHtml(p.unidade)}`}</strong>
        ${!servico && p.estoqueMinimo > 0 ? `<small>mínimo ${escapeHtml(formatarQuantidade(p.estoqueMinimo, p.unidade))}</small>` : ''}</div>
    </div>
    ${p.emPromocao ? `<div class="aviso aviso-alerta">${icon('etiqueta', 18)}<span>Em promoção por validade até ${escapeHtml(p.promocaoValidaAte || '')}. Preço normal: ${formatarMoeda(p.preco)}.</span></div>` : ''}
    ${p.custo > 0 ? '' : '<p class="subtexto">Sem custo cadastrado — a margem aparece quando o custo for informado no computador.</p>'}
    ${p.ultimaAlteracaoPreco ? `<p class="subtexto">Última mudança de preço: ${formatarMoeda(p.ultimaAlteracaoPreco.de)} → ${formatarMoeda(p.ultimaAlteracaoPreco.para)}, ${escapeHtml(formatarDataHora(p.ultimaAlteracaoPreco.em))}${p.ultimaAlteracaoPreco.por ? ` por ${escapeHtml(p.ultimaAlteracaoPreco.por)}` : ''}.</p>` : ''}
    <button class="btn-primario" data-acao="preco">${icon('etiqueta', 18)} Alterar preço</button>
    ${servico ? '' : `<button class="btn-secundario" data-acao="estoque">${icon('caderno', 18)} Ajustar estoque</button>`}
  `;
}

/** Abre o detalhe de um produto (busca sempre no computador: custo e
 * margem não vêm no catálogo publicado). */
function abrirDetalhe(ctx, produtoId) {
  const { loja } = ctx;
  const { el, fechar } = abrirSheet(htmlCarregando('Buscando o produto no computador da loja...'));
  let produto = null;

  const render = () => {
    el.innerHTML = htmlDetalhe(produto);
    el.querySelector('[data-fechar]').addEventListener('click', fechar);
    el.querySelector('[data-acao="preco"]').addEventListener('click', () => { fechar(); abrirAlterarPreco(ctx, produto); });
    el.querySelector('[data-acao="estoque"]')?.addEventListener('click', () => { fechar(); abrirAjustarEstoque(ctx, produto); });
  };

  S.pedirGestao(loja.installId, 'detalhe', { produtoId })
    .then((p) => {
      if (!p?.id) throw new Error('Resposta inesperada do computador da loja.');
      produto = p;
      render();
    })
    .catch((err) => {
      el.innerHTML = `<h2>Não consegui abrir o produto</h2><p class="msg-erro">${escapeHtml(err.message)}</p><button class="btn-secundario" data-fechar>Fechar</button>`;
      el.querySelector('[data-fechar]').addEventListener('click', fechar);
    });
}

// ---------------------------------------------------------------------
// Alterar preço
// ---------------------------------------------------------------------

function abrirAlterarPreco(ctx, produto) {
  const { loja } = ctx;
  const { el, fechar } = abrirSheet(`
    <h2>Alterar preço</h2>
    <p class="subtexto">${escapeHtml(produto.nome)} · preço atual <strong>${formatarMoeda(produto.preco)}</strong>${produto.emPromocao ? ` (em promoção: ${formatarMoeda(produto.precoVenda)})` : ''}</p>
    <label class="rotulo" for="novo-preco">Preço novo (R$${unidadeFracionada(produto.unidade) ? ` por ${escapeHtml(produto.unidade)}` : ''})</label>
    <input id="novo-preco" class="campo campo-grande" inputmode="decimal" autocomplete="off" placeholder="0,00" />
    <div id="previa-preco" class="previa"></div>
    <p id="erro-preco" class="msg-erro" hidden></p>
    <button id="btn-salvar-preco" class="btn-primario">Salvar preço</button>
    <button id="btn-cancelar-preco" class="btn-secundario">Cancelar</button>
  `);
  const input = el.querySelector('#novo-preco');
  const previa = el.querySelector('#previa-preco');
  const erro = el.querySelector('#erro-preco');
  const btn = el.querySelector('#btn-salvar-preco');

  const ler = () => arred2(lerNumero(input.value));
  const atualizarPrevia = () => {
    const v = ler();
    if (!Number.isFinite(v) || v <= 0) { previa.innerHTML = ''; return; }
    const margem = margemDe(v, produto.custo);
    const variacao = produto.preco > 0 ? ((v - produto.preco) / produto.preco) * 100 : null;
    const avisos = [];
    if (margem != null && margem < 0) avisos.push(`Abaixo do custo (${formatarMoeda(produto.custo)}): vende com prejuízo.`);
    if (variacao != null && Math.abs(variacao) >= 50) avisos.push(`Mudança grande: ${variacao > 0 ? '+' : ''}${pct(variacao)} sobre o preço atual. Confira se digitou certo.`);
    previa.innerHTML = `
      <div class="lista-status cartao-config">
        <div><span>Variação</span><strong>${variacao == null ? '—' : `${variacao > 0 ? '+' : ''}${pct(variacao)}`}</strong></div>
        <div><span>Margem com o preço novo</span><strong class="${margem != null && margem < 0 ? 'valor-perigo' : ''}">${margem == null ? 'sem custo cadastrado' : pct(margem)}</strong></div>
      </div>
      ${avisos.map((a) => `<div class="aviso aviso-alerta">${icon('etiqueta', 18)}<span>${escapeHtml(a)}</span></div>`).join('')}`;
  };
  input.addEventListener('input', atualizarPrevia);
  input.focus();

  const salvar = async () => {
    const v = ler();
    erro.hidden = true;
    if (!Number.isFinite(v) || v <= 0) { erro.textContent = 'Digite um preço maior que zero (ex: 12,90).'; erro.hidden = false; return; }
    if (Math.abs(v - produto.preco) < 0.005) { erro.textContent = 'O preço novo é igual ao atual.'; erro.hidden = false; return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-pequeno"></span> Salvando no computador...';
    try {
      const r = await S.pedirGestao(loja.installId, 'preco', { produtoId: produto.id, preco: v, precoAnterior: produto.preco },
        { aoResponderDepois: avisoTardio(ctx) });
      fechar();
      mostrarToast(r.mensagem || 'Preço atualizado.');
      ctx.aplicarProdutoNoCatalogo(r.produto);
      abrirDetalheComDados(ctx, r.produto);
    } catch (err) {
      if (err.semResposta) { fechar(); mostrarToast(err.message, 'erro'); return; }
      btn.disabled = false;
      btn.textContent = 'Salvar preço';
      erro.textContent = err.message;
      erro.hidden = false;
    }
  };
  btn.addEventListener('click', salvar);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') salvar(); });
  el.querySelector('#btn-cancelar-preco').addEventListener('click', fechar);
}

/** Depois de salvar, volta pro detalhe já com os números novos (sem
 * outra ida ao computador). */
function abrirDetalheComDados(ctx, produto) {
  if (!produto?.id) return;
  const { el, fechar } = abrirSheet(htmlDetalhe(produto));
  el.querySelector('[data-fechar]').addEventListener('click', fechar);
  el.querySelector('[data-acao="preco"]').addEventListener('click', () => { fechar(); abrirAlterarPreco(ctx, produto); });
  el.querySelector('[data-acao="estoque"]')?.addEventListener('click', () => { fechar(); abrirAjustarEstoque(ctx, produto); });
}

// ---------------------------------------------------------------------
// Ajustar estoque
// ---------------------------------------------------------------------

function abrirAjustarEstoque(ctx, produto) {
  const { loja } = ctx;
  let movimento = 'entrada';
  const fr = unidadeFracionada(produto.unidade);
  const atual = Number(produto.estoque) || 0;
  const { el, fechar } = abrirSheet(`
    <h2>Ajustar estoque</h2>
    <p class="subtexto">${escapeHtml(produto.nome)} · estoque atual <strong>${escapeHtml(formatarQuantidade(atual, produto.unidade))} ${escapeHtml(produto.unidade)}</strong></p>
    <div class="seletor-periodo" role="radiogroup" aria-label="Tipo de ajuste">
      ${Object.entries(MOVIMENTOS).map(([k, m]) => `<button class="btn-periodo ${k === movimento ? 'btn-periodo-ativo' : ''}" data-mov="${k}" role="radio" aria-checked="${k === movimento}">${escapeHtml(m.rotulo)}</button>`).join('')}
    </div>
    <label class="rotulo" for="qtd-ajuste" id="rotulo-qtd"></label>
    <input id="qtd-ajuste" class="campo campo-grande" inputmode="decimal" autocomplete="off" placeholder="${fr ? '0,000' : '0'}" />
    <label class="rotulo" for="motivo-ajuste">Motivo</label>
    <input id="motivo-ajuste" class="campo" maxlength="120" autocomplete="off" />
    <div id="previa-estoque" class="previa"></div>
    <p id="erro-ajuste" class="msg-erro" hidden></p>
    <button id="btn-salvar-ajuste" class="btn-primario">Salvar ajuste</button>
    <button id="btn-cancelar-ajuste" class="btn-secundario">Cancelar</button>
  `);
  const input = el.querySelector('#qtd-ajuste');
  const motivo = el.querySelector('#motivo-ajuste');
  const previa = el.querySelector('#previa-estoque');
  const erro = el.querySelector('#erro-ajuste');
  const btn = el.querySelector('#btn-salvar-ajuste');

  const atualizar = () => {
    const m = MOVIMENTOS[movimento];
    el.querySelector('#rotulo-qtd').textContent = `${m.campo} (${produto.unidade})`;
    motivo.placeholder = m.dica;
    el.querySelectorAll('[data-mov]').forEach((b) => {
      const ativo = b.dataset.mov === movimento;
      b.classList.toggle('btn-periodo-ativo', ativo);
      b.setAttribute('aria-checked', String(ativo));
    });
    const q = lerNumero(input.value);
    if (!Number.isFinite(q) || q < 0) { previa.innerHTML = ''; return; }
    const fica = movimento === 'contagem' ? q : (movimento === 'perda' ? atual - q : atual + q);
    previa.innerHTML = `<div class="lista-status cartao-config"><div><span>Estoque fica</span><strong class="${fica < 0 ? 'valor-perigo' : ''}">${escapeHtml(formatarQuantidade(fica, produto.unidade))} ${escapeHtml(produto.unidade)}</strong></div></div>
      ${movimento === 'contagem' ? '<p class="subtexto">A diferença é calculada no computador na hora em que chega — se vender algo enquanto você digita, a conta continua certa.</p>' : ''}`;
  };
  el.querySelectorAll('[data-mov]').forEach((b) => b.addEventListener('click', () => { movimento = b.dataset.mov; atualizar(); input.focus(); }));
  input.addEventListener('input', atualizar);
  atualizar();
  input.focus();

  const salvar = async () => {
    erro.hidden = true;
    const q = lerNumero(input.value);
    const falhar = (t) => { erro.textContent = t; erro.hidden = false; };
    if (!Number.isFinite(q) || q < 0 || (movimento !== 'contagem' && q === 0)) return falhar('Digite uma quantidade válida.');
    if (!fr && !Number.isInteger(q)) return falhar(`Este produto é vendido por ${produto.unidade}: digite um número inteiro.`);
    if (!motivo.value.trim()) return falhar('Informe o motivo — ele vai para a Auditoria.');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-pequeno"></span> Salvando no computador...';
    try {
      const r = await S.pedirGestao(loja.installId, 'estoque', {
        produtoId: produto.id, movimento, quantidade: q, motivo: motivo.value.trim().slice(0, 120),
      }, { aoResponderDepois: avisoTardio(ctx) });
      fechar();
      mostrarToast(r.mensagem || 'Estoque atualizado.');
      ctx.aplicarProdutoNoCatalogo(r.produto);
      abrirDetalheComDados(ctx, r.produto);
    } catch (err) {
      if (err.semResposta) { fechar(); mostrarToast(err.message, 'erro'); return; }
      btn.disabled = false;
      btn.textContent = 'Salvar ajuste';
      falhar(err.message);
    }
  };
  btn.addEventListener('click', salvar);
  el.querySelector('#btn-cancelar-ajuste').addEventListener('click', fechar);
}

// ---------------------------------------------------------------------
// Cadastrar produto
// ---------------------------------------------------------------------

/**
 * Cadastro rápido. `codigoBarras` vem preenchido quando a pessoa bipou um
 * código que não existe. `onCriado(produto)` recebe o produto no formato
 * do detalhe (a aba Vender usa pra já pôr no carrinho).
 */
function abrirCadastro(ctx, { codigoBarras = '', onCriado } = {}) {
  const { loja } = ctx;
  const categorias = [...new Set((ctx.estado().statusLoja?.catalogoProdutos || []).map((p) => p.categoria).filter(Boolean))].sort();
  const { el, fechar } = abrirSheet(`
    <h2>Cadastrar produto</h2>
    <label class="rotulo" for="cad-nome">Nome</label>
    <input id="cad-nome" class="campo" maxlength="120" autocomplete="off" placeholder="Ex: Refrigerante cola 2 L" />
    <div class="linha-dupla">
      <div><label class="rotulo" for="cad-preco">Preço de venda (R$)</label>
        <input id="cad-preco" class="campo" inputmode="decimal" autocomplete="off" placeholder="0,00" /></div>
      <div><label class="rotulo" for="cad-custo">Custo (opcional)</label>
        <input id="cad-custo" class="campo" inputmode="decimal" autocomplete="off" placeholder="0,00" /></div>
    </div>
    <p id="cad-margem" class="subtexto"></p>
    <label class="rotulo" for="cad-codigo">Código de barras (opcional)</label>
    <div class="barra-busca barra-sem-margem">
      <input id="cad-codigo" class="campo" inputmode="numeric" maxlength="60" autocomplete="off" value="${escapeHtml(codigoBarras)}" />
      <button id="cad-ler" class="btn-scanner" aria-label="Ler código de barras">${icon('codigoBarras', 22)}</button>
    </div>
    <div class="linha-dupla">
      <div><label class="rotulo" for="cad-unidade">Unidade</label>
        <select id="cad-unidade" class="campo">${UNIDADES.map(([v, r]) => `<option value="${v}">${escapeHtml(r)}</option>`).join('')}</select></div>
      <div><label class="rotulo" for="cad-estoque">Estoque inicial</label>
        <input id="cad-estoque" class="campo" inputmode="decimal" autocomplete="off" placeholder="0" /></div>
    </div>
    <label class="rotulo" for="cad-categoria">Categoria (opcional)</label>
    <input id="cad-categoria" class="campo" maxlength="60" autocomplete="off" list="cad-categorias" />
    <datalist id="cad-categorias">${categorias.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
    <p class="subtexto">Dados fiscais (NCM, CFOP...) e foto continuam sendo preenchidos no computador.</p>
    <p id="cad-erro" class="msg-erro" hidden></p>
    <button id="cad-salvar" class="btn-primario">Cadastrar</button>
    <button id="cad-cancelar" class="btn-secundario">Cancelar</button>
  `);
  const $ = (id) => el.querySelector(id);
  const erro = $('#cad-erro');
  const btn = $('#cad-salvar');
  let fecharLeitor = null;

  const atualizarMargem = () => {
    const preco = lerNumero($('#cad-preco').value);
    const custo = lerNumero($('#cad-custo').value);
    const m = Number.isFinite(preco) && Number.isFinite(custo) ? margemDe(preco, custo) : null;
    $('#cad-margem').textContent = m == null ? '' : `Margem: ${pct(m)}${m < 0 ? ' — abaixo do custo' : ''}`;
  };
  $('#cad-preco').addEventListener('input', atualizarMargem);
  $('#cad-custo').addEventListener('input', atualizarMargem);
  $('#cad-ler').addEventListener('click', async () => {
    const preencher = (c) => { $('#cad-codigo').value = String(c || '').trim(); if (ctx.prefs().bipe) bipe('ok'); };
    if (cameraDisponivel()) fecharLeitor = await abrirScanner({ onCodigo: preencher });
    else pedirCodigoDigitado({ onCodigo: preencher, abrirSheet });
  });
  $('#cad-nome').focus();

  const falhar = (t) => { erro.textContent = t; erro.hidden = false; };
  const salvar = async () => {
    erro.hidden = true;
    const nome = $('#cad-nome').value.trim();
    const preco = arred2(lerNumero($('#cad-preco').value));
    const custoTexto = $('#cad-custo').value.trim();
    const custo = custoTexto ? arred2(lerNumero(custoTexto)) : null;
    const unidade = $('#cad-unidade').value;
    const estoqueTexto = $('#cad-estoque').value.trim();
    const estoqueInicial = estoqueTexto ? lerNumero(estoqueTexto) : 0;
    if (nome.length < 2) return falhar('Informe o nome do produto.');
    if (!Number.isFinite(preco) || preco <= 0) return falhar('Digite um preço maior que zero (ex: 12,90).');
    if (custo != null && (!Number.isFinite(custo) || custo < 0)) return falhar('Custo inválido.');
    if (!Number.isFinite(estoqueInicial) || estoqueInicial < 0) return falhar('Estoque inicial inválido.');
    if (!unidadeFracionada(unidade) && !Number.isInteger(estoqueInicial)) return falhar('Para essa unidade, o estoque inicial é um número inteiro.');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-pequeno"></span> Cadastrando no computador...';
    try {
      const r = await S.pedirGestao(loja.installId, 'produto_novo', {
        nome, preco, custo, unidade, estoqueInicial,
        codigoBarras: $('#cad-codigo').value.replace(/\s/g, '').slice(0, 60) || null,
        categoria: $('#cad-categoria').value.trim().slice(0, 60) || null,
      }, { aoResponderDepois: avisoTardio(ctx) });
      fecharLeitor?.();
      fechar();
      mostrarToast(r.mensagem || 'Produto cadastrado.');
      ctx.aplicarProdutoNoCatalogo(r.produto);
      onCriado?.(r.produto);
    } catch (err) {
      if (err.semResposta) { fechar(); mostrarToast(err.message, 'erro'); return; }
      btn.disabled = false;
      btn.textContent = 'Cadastrar';
      falhar(err.message);
    }
  };
  btn.addEventListener('click', salvar);
  $('#cad-cancelar').addEventListener('click', () => { fecharLeitor?.(); fechar(); });
}

// ---------------------------------------------------------------------
// Aba
// ---------------------------------------------------------------------

function mount(container, ctx) {
  let busca = '';
  let resultadosRemotos = null;
  let buscando = false;
  let timer = null;
  let fecharScanner = null;

  const catalogo = () => ctx.estado().statusLoja?.catalogoProdutos || [];
  const filtrados = () => {
    const termo = normalizar(busca);
    if (!termo) return catalogo();
    return catalogo().filter((p) => normalizar(p.nome).includes(termo) || (p.codigoBarras && p.codigoBarras.includes(busca.trim())));
  };

  async function tratarCodigo(bruto) {
    const codigo = String(bruto || '').trim();
    if (!codigo) return;
    const local = catalogo().find((p) => p.codigoBarras === codigo);
    if (local) { if (ctx.prefs().bipe) bipe('ok'); abrirDetalhe(ctx, local.id); return; }
    try {
      mostrarToast('Procurando o código no computador da loja...');
      const r = await S.consultar(ctx.loja.installId, 'codigo', { codigo });
      if (r?.produto) { if (ctx.prefs().bipe) bipe('ok'); abrirDetalhe(ctx, r.produto.id); return; }
      if (ctx.prefs().bipe) bipe('erro');
      if (r?.etiquetaBalanca) { mostrarToast(r.mensagem, 'erro'); return; }
      abrirCadastro(ctx, { codigoBarras: codigo, onCriado: (p) => abrirDetalheComDados(ctx, p) });
    } catch (err) {
      mostrarToast(err.message, 'erro');
    }
  }

  async function buscarNoComputador() {
    const termo = busca.trim();
    if (termo.length < 2) return;
    buscando = true;
    renderLista();
    try {
      const r = await S.consultar(ctx.loja.installId, 'produtos', { termo });
      if (busca.trim() !== termo) return;
      resultadosRemotos = Array.isArray(r) ? r : [];
    } catch (err) {
      resultadosRemotos = [];
      mostrarToast(err.message, 'erro');
    } finally {
      buscando = false;
      renderLista();
    }
  }

  function linhaHtml(p) {
    const estoque = p.tipo === 'servico' ? 'serviço' : (p.estoque == null ? '' : `${formatarQuantidade(p.estoque, p.unidade)} ${p.unidade || 'un'}`);
    return `
      <button class="cartao-produto" data-produto="${escapeHtml(p.id)}">
        <span class="nome-produto">${escapeHtml(p.nome)}</span>
        <span class="linha-preco">
          <span class="preco-produto">${formatarMoeda(p.preco)}${unidadeFracionada(p.unidade) ? `<small>/${escapeHtml(p.unidade)}</small>` : ''}</span>
          ${estoque ? `<span class="estoque-produto ${p.tipo !== 'servico' && p.estoque <= 0 ? 'valor-perigo' : ''}">${escapeHtml(estoque)}</span>` : ''}
        </span>
      </button>`;
  }

  function renderLista() {
    const el = container.querySelector('#lista-gestao');
    if (!el) return;
    const locais = filtrados();
    const ids = new Set(locais.map((p) => p.id));
    const remotos = (resultadosRemotos || []).filter((p) => !ids.has(p.id));
    let html = '';
    if (catalogo().length === 0 && !busca) html = '<p class="estado-vazio">Carregando o catálogo da loja...</p>';
    else if (locais.length === 0 && remotos.length === 0 && !buscando) html = `<p class="estado-vazio">Nenhum produto encontrado${busca ? ` para "${escapeHtml(busca)}"` : ''}.</p>`;
    else {
      html = `<div class="lista-produtos-linhas">${locais.slice(0, LIMITE_LISTA).map(linhaHtml).join('')}</div>`;
      if (locais.length > LIMITE_LISTA) html += `<p class="subtexto centro">Mostrando ${LIMITE_LISTA} de ${locais.length}. Refine a busca.</p>`;
    }
    if (remotos.length) html += `<div class="subtitulo-secao">Encontrados no computador da loja</div><div class="lista-produtos-linhas">${remotos.map(linhaHtml).join('')}</div>`;
    if (buscando) html += htmlCarregando('Buscando no computador da loja...');
    else if (busca.trim().length >= 2 && resultadosRemotos === null) html += '<button id="btn-buscar-remoto-gestao" class="btn-link-centro">Não achou? Buscar no computador da loja</button>';
    el.innerHTML = html;
    el.querySelectorAll('[data-produto]').forEach((b) => b.addEventListener('click', () => abrirDetalhe(ctx, b.dataset.produto)));
    el.querySelector('#btn-buscar-remoto-gestao')?.addEventListener('click', buscarNoComputador);
  }

  function render() {
    container.innerHTML = `
      <div class="cabecalho-aba">
        <div>
          <h2 class="titulo-secao">Produtos</h2>
          <p class="subtexto">Toque num produto para ver custo, margem e estoque. Cada alteração é conferida pelo computador e fica na Auditoria.</p>
        </div>
      </div>
      <button id="btn-cadastrar" class="btn-primario">${icon('etiqueta', 18)} Cadastrar produto</button>
      <div class="barra-busca" style="margin-top:12px">
        <div class="campo-busca">
          ${icon('busca', 18)}
          <input id="input-busca-gestao" type="search" enterkeyhint="search" autocomplete="off" placeholder="Buscar produto ou código" value="${escapeHtml(busca)}" aria-label="Buscar produto ou código" />
        </div>
        <button id="btn-scanner-gestao" class="btn-scanner" aria-label="Ler código de barras">${icon('codigoBarras', 24)}</button>
      </div>
      <div id="lista-gestao"></div>`;
    const input = container.querySelector('#input-busca-gestao');
    input.addEventListener('input', () => {
      busca = input.value;
      resultadosRemotos = null;
      renderLista();
      clearTimeout(timer);
      if (busca.trim().length >= 2 && filtrados().length === 0) timer = setTimeout(buscarNoComputador, 650);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const termo = input.value.trim();
      if (/^\d{6,14}$/.test(termo)) { busca = ''; input.value = ''; renderLista(); tratarCodigo(termo); }
    });
    container.querySelector('#btn-scanner-gestao').addEventListener('click', async () => {
      if (cameraDisponivel()) fecharScanner = await abrirScanner({ onCodigo: tratarCodigo });
      else pedirCodigoDigitado({ onCodigo: tratarCodigo, abrirSheet });
    });
    container.querySelector('#btn-cadastrar').addEventListener('click', () => abrirCadastro(ctx, { onCriado: (p) => abrirDetalheComDados(ctx, p) }));
    renderLista();
  }

  render();
  const parar = ctx.assinar((motivo) => { if (motivo === 'catalogo') renderLista(); });
  return () => {
    parar();
    clearTimeout(timer);
    fecharScanner?.();
  };
}

export { mount, abrirCadastro };
