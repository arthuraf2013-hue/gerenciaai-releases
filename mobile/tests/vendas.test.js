import test from 'node:test';
import assert from 'node:assert/strict';
import { lojaPronta } from './ajuda.js';
import { finalizarVenda, cancelarVenda, obterVenda } from '../src/services/vendas.js';
import { resumoDoCaixa, fecharCaixa, movimentarCaixa } from '../src/services/caixa.js';
import { salvarCliente, receberFiado, obterCliente } from '../src/services/clientes.js';
import { obterProduto, buscarProdutos, movimentarEstoque } from '../src/services/produtos.js';
import { lerCentavos, lerQuantidadeMil, totalItemCentavos } from '../src/services/base.js';
import { montarPayloadPix, crc16 } from '../src/services/pix.js';

test('venda com kg, troco em dinheiro: total exato em centavos, estoque baixa, troco fica fora do caixa', async () => {
  const { db, operador, coca, queijo, caixaId } = await lojaPronta();
  const v = await finalizarVenda(db, {
    itens: [{ produtoId: coca, qtdMil: 2000 }, { produtoId: queijo, qtdMil: 750 }],
    pagamentos: [{ metodo: 'dinheiro', valorCentavos: 1100 + 4118, recebidoCentavos: 6000 }],
  }, operador);
  // 0,750 kg x R$ 54,90 = 41,175 -> 41,18 (meio centavo sobe)
  assert.equal(totalItemCentavos(5490, 750), 4118);
  assert.equal(v.total_centavos, 5218);
  assert.equal(v.troco_centavos, 782);
  assert.equal(v.numero, 'MT-000001');
  assert.equal((await obterProduto(db, coca)).estoque_mil, 8000);
  assert.equal((await obterProduto(db, queijo)).estoque_mil, 3450);
  const r = await resumoDoCaixa(db, caixaId);
  assert.equal(r.porMetodo.dinheiro, 5218);
  assert.equal(r.dinheiroEsperadoCentavos, 5000 + 5218);
});

test('recusa: estoque insuficiente, unidade fracionada, pagamento que não fecha, fiado sem cliente', async () => {
  const { db, operador, coca } = await lojaPronta();
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 11000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 6050 }] }, operador), /Estoque insuficiente/);
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1500 }], pagamentos: [{ metodo: 'pix', valorCentavos: 825 }] }, operador), /por unidade/);
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 500 }] }, operador), /Falta pagamento/);
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'fiado', valorCentavos: 550 }] }, operador), /escolha o cliente/);
  // O mesmo produto em duas linhas soma pro teste de estoque.
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 6000 }, { produtoId: coca, qtdMil: 5000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 6050 }] }, operador), /Estoque insuficiente/);
  // Nada ficou pela metade.
  assert.equal((await obterProduto(db, coca)).estoque_mil, 10000);
  assert.equal(await db.valor('SELECT COUNT(*) FROM vendas'), 0);
});

test('desconto acima do limite exige gerente, e o próprio operador-gerente não se autoriza', async () => {
  const { db, operador, gerente, coca } = await lojaPronta();
  const base = { itens: [{ produtoId: coca, qtdMil: 2000 }], descontoCentavos: 300, pagamentos: [{ metodo: 'pix', valorCentavos: 800 }] };
  await assert.rejects(finalizarVenda(db, base, operador), /precisa de autorização/);
  await assert.rejects(finalizarVenda(db, { ...base, pinGerenteDesconto: '3333' }, operador), /incorreto/);
  await assert.rejects(finalizarVenda(db, { ...base, pinGerenteDesconto: '2222' }, gerente), /incorreto|outro gerente/);
  const v = await finalizarVenda(db, { ...base, pinGerenteDesconto: '2222' }, operador);
  assert.equal(v.desconto_autorizado_por, gerente);
  // Até 10% passa sem pedir nada.
  await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 2000 }], descontoCentavos: 110, pagamentos: [{ metodo: 'debito', valorCentavos: 990 }] }, operador);
});

test('fiado: venda aumenta saldo, limite é respeitado, pagamento em dinheiro entra no caixa, cancelamento estorna', async () => {
  const { db, operador, coca, caixaId } = await lojaPronta();
  const cli = await salvarCliente(db, { nome: 'Maria', telefone: '(81) 99999-0000', limiteFiadoCentavos: 2000 }, operador);
  const v = await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 3000 }], clienteId: cli, pagamentos: [{ metodo: 'fiado', valorCentavos: 1650 }] }, operador);
  assert.equal((await obterCliente(db, cli)).saldo_fiado_centavos, 1650);
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], clienteId: cli, pagamentos: [{ metodo: 'fiado', valorCentavos: 550 }] }, operador), /limite de fiado/);
  await receberFiado(db, { clienteId: cli, valorCentavos: 1000, metodo: 'dinheiro' }, operador);
  assert.equal((await obterCliente(db, cli)).saldo_fiado_centavos, 650);
  assert.equal((await resumoDoCaixa(db, caixaId)).dinheiroEsperadoCentavos, 5000 + 1000);
  await assert.rejects(cancelarVenda(db, { vendaId: v.id, motivo: 'erro', pinGerente: '3333' }, operador), /incorreto/);
  await cancelarVenda(db, { vendaId: v.id, motivo: 'cliente desistiu', pinGerente: '2222' }, operador);
  assert.equal((await obterCliente(db, cli)).saldo_fiado_centavos, -1000); // pagou 10,00 de uma dívida estornada: fica com crédito
  assert.equal((await obterProduto(db, coca)).estoque_mil, 10000);
  assert.equal((await obterVenda(db, v.id)).status, 'cancelada');
  const r = await resumoDoCaixa(db, caixaId);
  assert.equal(r.vendas.quantidade, 0);
  assert.equal(r.canceladas.quantidade, 1);
});

test('fechamento de caixa: esperado considera sangria/suprimento; caixa fechado bloqueia venda e cancelamento', async () => {
  const { db, operador, coca } = await lojaPronta();
  const v = await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'dinheiro', valorCentavos: 550, recebidoCentavos: 1000 }] }, operador);
  await movimentarCaixa(db, { tipo: 'suprimento', valorCentavos: 2000, motivo: 'troco' }, operador);
  await movimentarCaixa(db, { tipo: 'sangria', valorCentavos: 3000, motivo: 'banco' }, operador);
  await assert.rejects(movimentarCaixa(db, { tipo: 'sangria', valorCentavos: 999999 }, operador), /maior que o dinheiro/);
  const f = await fecharCaixa(db, { valorContadoCentavos: 4500 }, operador);
  assert.equal(f.dinheiroEsperadoCentavos, 5000 + 550 + 2000 - 3000);
  assert.equal(f.diferencaCentavos, 4500 - 4550);
  await assert.rejects(finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 550 }] }, operador), /Abra o caixa/);
  await assert.rejects(cancelarVenda(db, { vendaId: v.id, motivo: 'x', pinGerente: '2222' }, operador), /caixa já fechado/);
});

test('busca: código exato primeiro, sem acento, "%" digitado não vira coringa; contagem de estoque', async () => {
  const { db, admin, coca, queijo } = await lojaPronta();
  assert.equal((await buscarProdutos(db, '7894900011517'))[0].id, coca);
  assert.equal((await buscarProdutos(db, 'QUEIJO'))[0].id, queijo);
  assert.equal((await buscarProdutos(db, 'coalho'))[0].id, queijo);
  assert.equal((await buscarProdutos(db, '%')).length, 0);
  assert.equal(await movimentarEstoque(db, { produtoId: coca, modo: 'contagem', qtdMil: 7000 }, admin), 7000);
  assert.equal(await movimentarEstoque(db, { produtoId: coca, modo: 'entrada', qtdMil: 12000 }, admin), 19000);
  const livro = await db.valor('SELECT SUM(qtd_mil) FROM movimentos_estoque WHERE produto_id = ?', [coca]);
  assert.equal(livro, (await obterProduto(db, coca)).estoque_mil, 'saldo em cache bate com o livro');
});

test('leitura de valores digitados', () => {
  assert.equal(lerCentavos('12,50'), 1250);
  assert.equal(lerCentavos('R$ 1.234,56'), 123456);
  assert.equal(lerCentavos('1.234'), 123400);
  assert.equal(lerCentavos('12.5'), 1250);
  assert.equal(lerCentavos('0,1'), 10);
  assert.equal(lerCentavos('abc'), null);
  assert.equal(lerQuantidadeMil('0,750'), 750);
  assert.equal(lerQuantidadeMil('2'), 2000);
  assert.equal(lerQuantidadeMil('0'), null);
  assert.equal(lerQuantidadeMil('1,2345'), null);
});

test('Pix: payload BR Code com CRC correto (mesmo algoritmo do desktop)', () => {
  const p = montarPayloadPix({ chave: 'loja@exemplo.com', nomeRecebedor: 'Mercadinho Boa Vista', cidade: 'Recife', valorCentavos: 1250, referencia: 'MT-000001' });
  assert.match(p, /^000201/);
  assert.ok(p.includes('540512.50'));
  assert.ok(p.includes('5920MERCADINHO BOA VISTA'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  // Vetor conhecido do CRC16-CCITT (FALSE): "123456789" -> 29B1
  assert.equal(crc16('123456789'), '29B1');
});
