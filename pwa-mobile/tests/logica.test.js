import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agruparComanda, fecharPagamentos, filtrarMesas, formatarQuantidade, itensParaLancar, lerValor, paraData, resumoCarrinho,
  rotuloMesaComUnidas, servidorVivo, somarNoCarrinho, tempoDesde, valorDaSelecao,
} from '../src/mesas/logica.js';

const comanda = {
  pessoas: [{ numero: 1, nome: 'Ana' }, { numero: 2, nome: null }, { numero: 3, nome: 'Caio' }],
  itens: [
    { id: 'a', nome: 'Suco', quantidade: 1, precoUnitario: 8, total: 8, pessoaNumero: 1, preparo: 'pronto' },
    { id: 'b', nome: 'Água', quantidade: 2, precoUnitario: 4.5, total: 9, pessoaNumero: null, preparo: 'pendente' },
    { id: 'c', nome: 'Prato', quantidade: 1, precoUnitario: 30, total: 30, pessoaNumero: 3, preparo: 'preparando' },
  ],
};

test('comanda agrupada: uma seção por pessoa (mesmo sem item), "Mesa" por último só se tiver item', () => {
  const g = agruparComanda(comanda);
  assert.deepEqual(g.map((x) => [x.rotulo, x.itens.length, x.subtotal]), [['Ana', 1, 8], ['Pessoa 2', 0, 0], ['Caio', 1, 30], ['Mesa', 1, 9]]);
  const semMesa = agruparComanda({ ...comanda, itens: comanda.itens.filter((i) => i.pessoaNumero) });
  assert.equal(semMesa.some((x) => x.pessoaNumero == null), false);
});

test('itens que este celular mandou e ainda não chegaram aparecem no lugar certo, marcados', () => {
  const g = agruparComanda(comanda, [{ id: 'env1', situacao: 'na_fila', itens: [{ nome: 'Café', quantidade: 2, preco: 5, pessoaNumero: 2 }] }]);
  const p2 = g.find((x) => x.pessoaNumero === 2);
  assert.equal(p2.itens.length, 1);
  assert.equal(p2.itens[0].provisorio, true);
  assert.equal(p2.itens[0].situacao, 'na_fila');
  assert.equal(p2.subtotal, 10);
});

test('mesa sem comanda ainda (fila sem internet): só os itens enviados', () => {
  const g = agruparComanda(null, [{ id: 'e', situacao: 'enviando', itens: [{ nome: 'Suco', quantidade: 1, preco: 8, pessoaNumero: null }] }]);
  assert.deepEqual(g.map((x) => x.rotulo), ['Mesa']);
});

test('carrinho: mesma pessoa e mesmo produto somam; outra pessoa vira linha nova; observação nunca soma', () => {
  const suco = { id: 's', nome: 'Suco', preco: 8, unidade: 'un' };
  let c = somarNoCarrinho([], suco, 1);
  c = somarNoCarrinho(c, suco, 1);
  c = somarNoCarrinho(c, suco, 2);
  assert.deepEqual(c.map((l) => [l.pessoaNumero, l.quantidade]), [[1, 2], [2, 1]]);
  c = c.map((l, i) => (i === 0 ? { ...l, observacao: 'sem gelo' } : l));
  c = somarNoCarrinho(c, suco, 1);
  assert.equal(c.length, 3);
  assert.deepEqual(resumoCarrinho(c), { linhas: 3, quantidade: 4, total: 32 });
  assert.deepEqual(itensParaLancar(c)[0], { produtoId: 's', nome: 'Suco', quantidade: 2, pessoaNumero: 1, observacao: 'sem gelo' });
  assert.equal(itensParaLancar(c)[1].observacao, null);
});

test('filtro de mesas: "minhas" são as abertas por este usuário; unida fica fora de "minhas"', () => {
  const mesas = [
    { id: '1', status: 'ocupada', abertaPorId: 'eu' },
    { id: '2', status: 'ocupada', abertaPorId: 'outro' },
    { id: '3', status: 'livre' },
    { id: '4', status: 'ocupada', unidaA: '1', abertaPorId: null },
  ];
  assert.deepEqual(filtrarMesas(mesas, 'minhas', 'eu').map((m) => m.id), ['1']);
  assert.deepEqual(filtrarMesas(mesas, 'livres', 'eu').map((m) => m.id), ['3']);
  assert.equal(filtrarMesas(mesas, 'todas', 'eu').length, 4);
});

test('valor da seleção: escolher todo mundo que deve é a conta toda (sem sobrar centavo)', () => {
  const conta = {
    restante: 46.75,
    grupos: [
      { grupo: 'p1', devido: 33 }, { grupo: 'p2', devido: 8.8 }, { grupo: 'mesa', devido: 4.95 }, { grupo: 'p3', devido: 0 },
    ],
  };
  assert.equal(valorDaSelecao(conta, ['p1'], false), 33);
  assert.equal(valorDaSelecao(conta, ['p2', 'mesa'], false), 13.75);
  assert.equal(valorDaSelecao(conta, ['p1', 'p2', 'mesa'], false), 46.75);
  assert.equal(valorDaSelecao(conta, [], true), 46.75);
  assert.equal(valorDaSelecao(conta, ['p3'], false), 0, 'quem já pagou não conta');
});

test('pagamentos: dinheiro dá troco, cartão não passa do que falta', () => {
  let r = fecharPagamentos(30, [{ metodo: 'dinheiro', valor: 30, valorRecebido: 50 }]);
  assert.equal(r.faltaC, 0);
  assert.equal(r.trocoC, 2000);
  r = fecharPagamentos(30, [{ metodo: 'pix', valor: 10 }, { metodo: 'cartao_debito', valor: 25 }]);
  assert.equal(r.faltaC, 0);
  assert.equal(r.linhas[1].excede, true);
  r = fecharPagamentos(30, [{ metodo: 'pix', valor: 10 }]);
  assert.equal(r.faltaC, 2000);
});

test('números e datas no formato do Brasil', () => {
  assert.equal(lerValor('12,50'), 12.5);
  assert.equal(lerValor('1.234,56'), 1234.56);
  assert.equal(lerValor('12.5'), 12.5);
  assert.ok(Number.isNaN(lerValor('')));
  assert.equal(formatarQuantidade(2, 'un'), '2×');
  assert.equal(formatarQuantidade(0.35, 'kg'), '0,35 kg');
  assert.equal(paraData('2026-11-04 20:00:00').toISOString(), '2026-11-04T20:00:00.000Z', 'hora do computador é UTC');
  assert.equal(tempoDesde('2026-11-04 20:00:00', Date.UTC(2026, 10, 4, 20, 42)), '42 min');
  assert.equal(tempoDesde('2026-11-04 20:00:00', Date.UTC(2026, 10, 4, 21, 10)), '1h10');
  assert.equal(rotuloMesaComUnidas({ numero: '4', unidas: ['5', '6'] }), 'Mesa 4 + 5 + 6');
});

test('computador vivo: pelo relógio dele, ou por ter chegado novidade há pouco', () => {
  const agora = 1_000_000_000;
  assert.equal(servidorVivo({ vivoEmMs: agora - 20_000 }, 0, agora), true);
  assert.equal(servidorVivo({ vivoEmMs: agora - 600_000 }, 0, agora), false);
  assert.equal(servidorVivo({ vivoEmMs: agora - 600_000 }, agora - 10_000, agora), true, 'relógio do computador atrasado');
  assert.equal(servidorVivo(null, 0, agora), false);
});
