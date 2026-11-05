import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Testes de TELA do painel de mesas: o React de verdade num DOM de mentira
// (jsdom), com o servidor trocado por um falso (tests/apoio). Confere o que
// a pessoa vê e o que a tela pede ao computador -- não o Firestore.

const AQUI = dirname(fileURLToPath(import.meta.url));
const SAIDA = join(AQUI, '.tmp', 'telas.mjs');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://celular.teste/', pretendToBeVisual: true });
const g = globalThis;
for (const nome of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(g, nome, { value: dom.window[nome], configurable: true, writable: true });
}
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
g.IS_REACT_ACT_ENVIRONMENT = true;

mkdirSync(dirname(SAIDA), { recursive: true });
await build({
  entryPoints: [join(AQUI, 'apoio', 'entrada-telas.jsx')],
  outfile: SAIDA,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
  plugins: [{
    name: 'trocar-servidor',
    setup(b) {
      b.onResolve({ filter: /servidorMesas\.js$/ }, () => ({ path: join(AQUI, 'apoio', 'servidorFalso.js') }));
      b.onResolve({ filter: /(pdv-util|pdv-servidor)\.js$/ }, () => ({ path: join(AQUI, 'apoio', 'utilFalso.js') }));
      b.onResolve({ filter: /firebase-config\.js$/ }, () => { throw new Error('o painel não pode falar com o Firebase direto'); });
    },
  }],
});
const { PainelMesas, servidor, toasts, createElement, act, createRoot } = await import(pathToFileURL(SAIDA).href);

// ------------------------------------------------------------------ dados

const loja = { installId: 'loja1', nomeNegocio: 'Bar Teste', vinculoUserId: 'u-garcom', vinculoNome: 'Rafa' };

function docMesas(extra = {}) {
  return {
    versao: 1,
    vivoEmMs: Date.now(),
    caixaAberto: true,
    exigeAutorizacaoCancelamento: true,
    metodosPagamento: ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix'],
    permitirVenda: true,
    autorizadores: [{ id: 'u-gerente', nome: 'Gerente' }],
    chavePublica: 'CHAVE',
    mesas: [
      { id: 'm1', numero: '1', status: 'livre', unidas: [], total: 0, pago: 0, restante: 0 },
      { id: 'm2', numero: '2', status: 'ocupada', pessoas: 2, unidas: ['4'], total: 47, pago: 0, restante: 47, abertaEm: '2026-11-04 20:00:00', abertaPorId: 'u-garcom' },
      { id: 'm3', numero: '3', status: 'aguardando_limpeza', unidas: [] },
      { id: 'm4', numero: '4', status: 'ocupada', unidaA: 'm2', unidaANumero: '2', unidas: [] },
    ],
    ...extra,
  };
}

function comandaM2(conta = {}) {
  return {
    mesaId: 'm2', numero: '2', nome: null, unidas: [{ id: 'm4', numero: '4' }], saleId: 's2',
    abertaEm: '2026-11-04 20:00:00', abertaPorNome: 'Rafa',
    pessoas: [{ numero: 1, nome: 'Ana' }, { numero: 2, nome: null }],
    itens: [
      { id: 'i1', nome: 'Prato feito', unidade: 'un', quantidade: 1, precoUnitario: 30, total: 30, pessoaNumero: 1, observacao: null, preparo: 'preparando' },
      { id: 'i2', nome: 'Suco', unidade: 'un', quantidade: 1, precoUnitario: 8, total: 8, pessoaNumero: 2, observacao: 'sem gelo', preparo: 'pronto' },
      { id: 'i3', nome: 'Água', unidade: 'un', quantidade: 2, precoUnitario: 4.5, total: 9, pessoaNumero: null, observacao: null, preparo: 'pendente' },
    ],
    conta: {
      subtotal: 47, desconto: 0, taxaServicoPercentual: 0, totalAPagar: 47, pago: 0, restante: 47,
      grupos: [
        { grupo: 'p1', pessoaNumero: 1, rotulo: 'Ana', subtotal: 30, valor: 30, pago: 0, devido: 30 },
        { grupo: 'p2', pessoaNumero: 2, rotulo: 'Pessoa 2', subtotal: 8, valor: 8, pago: 0, devido: 8 },
        { grupo: 'mesa', pessoaNumero: null, rotulo: 'Mesa (sem pessoa)', subtotal: 9, valor: 9, pago: 0, devido: 9 },
      ],
      pagamentos: [],
      ...conta,
    },
  };
}

const catalogo = {
  produtos: [
    { id: 'suco', nome: 'Suco', categoria: 'Bebidas', preco: 8, unidade: 'un', tipo: 'produto', estoque: 20 },
    { id: 'prato', nome: 'Prato feito', categoria: 'Pratos', preco: 30, unidade: 'un', tipo: 'produto', estoque: 10 },
    { id: 'pudim', nome: 'Pudim', categoria: 'Sobremesas', preco: 12, unidade: 'un', tipo: 'produto', estoque: 0 },
  ],
};

// ------------------------------------------------------------------ ajudantes

let raiz = null;
let container = null;

async function montar({ modo = 'garcom', aoSemPainel = () => {} } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    raiz = createRoot(container);
    raiz.render(createElement(PainelMesas, { loja, modo, aoSemPainel }));
  });
}

async function desmontar() {
  if (raiz) await act(async () => raiz.unmount());
  raiz = null;
  container?.remove();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
}

async function esperar() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function botoes() {
  return [...document.querySelectorAll('button')];
}

function botao(texto) {
  const b = botoes().find((x) => x.textContent.replace(/\s+/g, ' ').trim().includes(texto));
  if (!b) throw new Error(`Botão "${texto}" não encontrado. Tem: ${botoes().map((x) => x.textContent.trim()).join(' | ')}`);
  return b;
}

function botaoExato(texto) {
  const b = botoes().find((x) => x.textContent.replace(/\s+/g, ' ').trim() === texto);
  if (!b) throw new Error(`Botão "${texto}" não encontrado. Tem: ${botoes().map((x) => x.textContent.trim()).join(' | ')}`);
  return b;
}

function temBotao(texto) {
  return botoes().some((x) => x.textContent.replace(/\s+/g, ' ').includes(texto));
}

async function clicar(el) {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await esperar();
}

async function digitar(el, valor) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  await act(async () => {
    setter.call(el, valor);
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

function texto() {
  return document.body.textContent.replace(/\s+/g, ' ');
}

function prepararLoja({ mesas = docMesas(), comandas = { m2: comandaM2() } } = {}) {
  servidor.reiniciar();
  toasts.length = 0;
  servidor.estado.catalogo = catalogo;
  servidor.publicarMesas(mesas);
  for (const [id, c] of Object.entries(comandas)) servidor.publicarComanda(id, c);
}

test.afterEach(desmontar);
// O jsdom segura o processo aberto (timers da janela) se não for fechado.
// O jsdom e o act() do React (MessageChannel) seguram o processo aberto
// depois dos testes -- por isso o `npm test` roda com --test-force-exit.
test.after(() => dom.window.close());

// ------------------------------------------------------------------ testes

test('tela de mesas: status, mesa unida e totais', async () => {
  prepararLoja();
  await montar();
  const t = texto();
  assert.match(t, /Mesa 1.*livre/);
  assert.match(t, /Mesa 2 \+ 4/);
  assert.match(t, /R\$\s?47,00/);
  assert.match(t, /Mesa 3.*limpeza/);
  assert.match(t, /unida à mesa 2/);
  assert.match(t, /Mesa 2 \+ 4\s*unida com 4/, 'a principal mostra com quem está unida');
  assert.match(t, /1 ocupada · 1 livre/);
});

test('mesa unida: garçom cai direto na comanda do grupo; operador escolhe abrir ou separar', async () => {
  prepararLoja();
  await montar({ modo: 'garcom' });
  await clicar(botao('Mesa 4'));
  assert.ok(document.querySelector('[aria-label="Voltar para as mesas"]'), 'abriu a comanda da principal');
  assert.match(texto(), /Ana.*R\$\s?30,00/);
  await desmontar();

  prepararLoja();
  await montar({ modo: 'pdv' });
  await clicar(botao('Mesa 4'));
  assert.ok(temBotao('Abrir a comanda (Mesa 2 + 4)'));
  await clicar(botao('Separar a Mesa 4'));
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'separar', campos: { mesaId: 'm4' } });
  assert.ok(toasts.some((t) => /Mesa 4 separada/.test(t.texto)));
});

test('mesa unida a uma mesa que não está com a comanda: não trava, oferece separar', async () => {
  const mesas = docMesas();
  mesas.mesas = mesas.mesas.map((m) => (m.id === 'm2' ? { ...m, status: 'livre', unidas: [], total: 0, restante: 0 } : m));
  prepararLoja({ mesas, comandas: {} });
  await montar({ modo: 'garcom' });
  await clicar(botao('Mesa 4'));
  assert.equal(temBotao('Abrir a comanda'), false);
  assert.ok(botao('Para separar, peça ao caixa').disabled);
  await desmontar();

  prepararLoja({ mesas, comandas: {} });
  await montar({ modo: 'pdv' });
  await clicar(botao('Mesa 4'));
  assert.equal(temBotao('Abrir a comanda'), false);
  await clicar(botao('Separar a Mesa 4'));
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'separar', campos: { mesaId: 'm4' } });
});

test('o computador não publica as mesas: o painel avisa para usar a tela antiga', async () => {
  servidor.reiniciar();
  let motivo = null;
  servidor.publicarMesas(null, { existe: false, doServidor: true });
  await montar({ aoSemPainel: (m) => { motivo = m; } });
  assert.equal(motivo, 'sem_publicacao');
});

test('garçom abre mesa livre, lança para pessoas diferentes e o pedido sai separado por pessoa', async () => {
  prepararLoja();
  servidor.estado.respostas.abrir = { saleId: 's1', mesaId: 'm1', abriu: true };
  await montar();
  await clicar(botao('Mesa 1'));
  assert.match(texto(), /Abrir Mesa 1/);
  await clicar(botao('Abrir e lançar'));
  assert.deepEqual(servidor.estado.pedidos[0], { tipo: 'abrir', campos: { mesaId: 'm1', pessoas: 2 } });
  // Comanda acabou de abrir com 2 pessoas.
  await act(async () => servidor.publicarComanda('m1', { ...comandaM2(), mesaId: 'm1', numero: '1', unidas: [], itens: [], conta: { ...comandaM2().conta, grupos: [], totalAPagar: 0, restante: 0 } }));
  assert.match(texto(), /Lançar · Mesa 1/);
  await clicar(botao('Ana'));
  await clicar(botao('Prato feito'));
  await clicar(botao('Pessoa 2'));
  await clicar(botao('Suco'));
  await clicar(botao('Suco'));
  assert.ok(botao('Pudim').disabled, 'sem estoque não deixa tocar');
  await clicar(botao('Enviar'));
  assert.equal(servidor.estado.lancamentos.length, 1);
  const l = servidor.estado.lancamentos[0];
  assert.equal(l.mesaId, 'm1');
  assert.deepEqual(l.itens.map((i) => [i.produtoId, i.pessoaNumero, i.quantidade]), [['prato', 1, 1], ['suco', 2, 2]]);
  // Volta para a comanda com os itens chegando.
  assert.match(texto(), /Lançar para/);
  assert.match(texto(), /enviando/);
});

test('observação por item no pedido vai junto do item', async () => {
  prepararLoja();
  await montar();
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('Adicionar itens para Mesa'));
  await clicar(botao('Suco'));
  await clicar(botao('Ver pedido'));
  await clicar(botao('+ observação'));
  const campo = document.querySelector('.pm-revisao input');
  await digitar(campo, 'sem açúcar');
  await clicar(botao('Enviar para a comanda'));
  const item = servidor.estado.lancamentos[0].itens[0];
  assert.equal(item.observacao, 'sem açúcar');
  assert.equal(item.pessoaNumero, null);
});

test('comanda: agrupada por pessoa, status da cozinha e mover item para outra pessoa', async () => {
  prepararLoja();
  await montar();
  await clicar(botao('Mesa 2 + 4'));
  const t = texto();
  assert.match(t, /Ana.*R\$\s?30,00/);
  assert.match(t, /preparando/);
  assert.match(t, /pronto/);
  assert.match(t, /sem gelo/);
  await clicar(botao('Prato feito'));
  await clicar(botao('Mover para outra pessoa'));
  await clicar(botoes().filter((b) => b.textContent.includes('Pessoa 2')).pop());
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'mover_item', campos: { mesaId: 'm2', itemId: 'i1', pessoaNumero: 2 } });
});

test('garçom não vê "Fechar conta" nem juntar/transferir; operador vê', async () => {
  prepararLoja();
  await montar({ modo: 'garcom' });
  await clicar(botao('Mesa 2 + 4'));
  assert.equal(temBotao('Fechar conta'), false);
  await clicar(document.querySelector('[aria-label="Mais opções da mesa"]'));
  assert.equal(temBotao('Juntar com outra mesa'), false);
  assert.equal(temBotao('Separar a mesa 4'), false);
  await desmontar();

  prepararLoja();
  await montar({ modo: 'pdv' });
  await clicar(botao('Mesa 2 + 4'));
  assert.ok(temBotao('Fechar conta'));
  await clicar(document.querySelector('[aria-label="Mais opções da mesa"]'));
  assert.ok(temBotao('Juntar com outra mesa'));
  await clicar(botao('Separar a mesa 4'));
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'separar', campos: { mesaId: 'm4' } });
});

test('pessoas: nova pessoa com nome; tocar de novo no nome abre renomear/tirar', async () => {
  prepararLoja();
  servidor.estado.respostas.adicionar_pessoa = { numero: 3 };
  await montar();
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('+ Pessoa'));
  await digitar(document.querySelector('#pm-texto'), 'Caio');
  await clicar(botaoExato('Adicionar'));
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'adicionar_pessoa', campos: { mesaId: 'm2', nome: 'Caio' } });
  await clicar(botao('Ana'));
  await clicar(botao('Ana'));
  await clicar(botao('Tirar esta pessoa da mesa'));
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'remover_pessoa', campos: { mesaId: 'm2', numero: 1 } });
});

test('cancelar item sem pagamento: só motivo; com pagamento: PIN do gerente vai cifrado', async () => {
  prepararLoja();
  await montar();
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('Água'));
  await clicar(botao('Cancelar item'));
  await digitar(document.querySelector('#pm-texto'), 'desistiu');
  await clicar(botoes().filter((b) => b.textContent.trim() === 'Cancelar item').pop());
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'cancelar_item', campos: { mesaId: 'm2', itemId: 'i3', motivo: 'desistiu' } });
  await desmontar();

  prepararLoja({ comandas: { m2: comandaM2({ pago: 10, restante: 37 }) } });
  await montar();
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('Água'));
  await clicar(botao('Cancelar item'));
  assert.match(texto(), /Autorização do gerente/);
  await digitar(document.querySelector('#pm-pin'), '1234');
  await clicar(botao('Autorizar'));
  await esperar();
  assert.deepEqual(servidor.estado.pinsCifrados, [{ chave: 'CHAVE', pin: '1234' }]);
  const pedido = servidor.estado.pedidos.at(-1);
  assert.equal(pedido.tipo, 'cancelar_item');
  assert.equal(pedido.campos.pinCifrado, 'cifrado(1234)');
  assert.equal(pedido.campos.autorizadorId, 'u-gerente');
  assert.equal(JSON.stringify(pedido).includes('"1234"'), false, 'o PIN em claro nunca sai na mensagem');
});

test('operador fecha a conta por pessoa: dinheiro com troco', async () => {
  prepararLoja();
  servidor.estado.respostas.receber = { saleId: 's2', recebidos: [], troco: 20, restante: 17, finalizar: false };
  await montar({ modo: 'pdv' });
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('Fechar conta'));
  await clicar(botao('Por pessoa'));
  const ana = [...document.querySelectorAll('.pm-pessoa-conta')].find((x) => x.textContent.includes('Ana')).querySelector('input');
  await clicar(ana);
  assert.match(texto(), /A receber\s*R\$\s?30,00/);
  await clicar(botao('Dinheiro'));
  await digitar(document.querySelector('[id^="rec-"]'), '50');
  assert.match(texto(), /Troco: R\$\s?20,00/);
  await clicar(botao('Receber R$'));
  await esperar();
  const pedido = servidor.estado.pedidos.at(-1);
  assert.equal(pedido.tipo, 'receber');
  assert.deepEqual(pedido.campos, {
    mesaId: 'm2', grupos: ['p1'], valorEsperado: 30, pagamentos: [{ metodo: 'dinheiro', valor: 30, valorRecebido: 50 }],
  });
  assert.ok(toasts.some((t) => /Troco: R\$\s?20,00/.test(t.texto)));
});

test('operador: mesa inteira em duas formas; cartão acima do que falta não deixa receber', async () => {
  prepararLoja();
  servidor.estado.respostas.receber = { saleId: 's2', troco: 0, restante: 0, finalizar: true, finalizada: true };
  await montar({ modo: 'pdv' });
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('Fechar conta'));
  await clicar(botao('Pix'));
  const valor = document.querySelector('.pm-pagamento input');
  await digitar(valor, '20');
  assert.match(texto(), /Falta R\$\s?27,00/);
  await clicar(botao('Débito'));
  assert.equal(botao('Receber R$').disabled, false);
  const campos = document.querySelectorAll('.pm-pagamento-topo input');
  await digitar(campos[1], '40');
  assert.equal(botao('Receber R$').disabled, true, 'débito passando do total');
  await digitar(campos[1], '27');
  await clicar(botao('Receber R$'));
  await esperar();
  assert.deepEqual(servidor.estado.pedidos.at(-1).campos.pagamentos, [{ metodo: 'pix', valor: 20 }, { metodo: 'cartao_debito', valor: 27 }]);
  assert.deepEqual(servidor.estado.pedidos.at(-1).campos.grupos, 'tudo');
  assert.ok(toasts.some((t) => /Conta fechada/.test(t.texto)));
});

test('caixa fechado no computador: não deixa receber e avisa', async () => {
  prepararLoja({ mesas: docMesas({ caixaAberto: false }) });
  await montar({ modo: 'pdv' });
  await clicar(botao('Mesa 2 + 4'));
  await clicar(botao('Fechar conta'));
  assert.match(texto(), /caixa está fechado/);
  await clicar(botao('Pix'));
  assert.equal(botao('Receber R$').disabled, true);
});

test('computador sem responder: aviso no topo', async () => {
  prepararLoja({ mesas: docMesas({ vivoEmMs: Date.now() - 10 * 60 * 1000 }) });
  servidor.estado.mesas.ultimaNovidadeMs = 0;
  await act(async () => servidor.publicarMesas(docMesas({ vivoEmMs: Date.now() - 10 * 60 * 1000 }), { ultimaNovidadeMs: 0 }));
  await montar();
  assert.match(texto(), /não está respondendo/);
});

test('mesa aguardando limpeza: marcar como limpa', async () => {
  prepararLoja();
  await montar();
  await clicar(botao('Mesa 3'));
  await clicar(botao('Marcar como limpa'));
  assert.deepEqual(servidor.estado.pedidos.at(-1), { tipo: 'limpar_mesa', campos: { mesaId: 'm3' } });
});
