const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');

// 22h30 em Brasília, 09/08/2026 == 01h30 UTC, 10/08/2026 -- bem na
// janela perigosa (dia já virou em UTC, ainda não virou em Brasília).
// Congela Date.now() nesse instante pra testar de forma determinística,
// sem depender de rodar o teste bem nessa hora da madrugada de verdade
// (foi assim que esse bug real escapou até agora).
const INSTANTE_JANELA_PERIGOSA = new Date('2026-08-10T01:30:00.000Z').getTime();

function comRelogioCongelado(fn) {
  const originalNow = Date.now;
  Date.now = () => INSTANTE_JANELA_PERIGOSA;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

test('timeService.hojeLocalISO() não adianta o dia durante a janela de 21h-meia-noite em Brasília', () => {
  const timeService = require('../electron/services/timeService');
  comRelogioCongelado(() => {
    // UTC já é 10/08 de madrugada, mas em Brasília (UTC-3) ainda são 22h30 do dia 09/08.
    assert.equal(timeService.hojeLocalISO(), '2026-08-09');
  });
});

test('precoEfetivo não corta a promoção um dia cedo demais durante a janela perigosa', () => {
  delete require.cache[require.resolve('../electron/services/productService')];
  const productService = require('../electron/services/productService');
  comRelogioCongelado(() => {
    // Promoção válida até 09/08 -- em Brasília ainda é dia 09, deveria continuar valendo.
    const produto = { preco: 10, preco_promocional: 7, promocao_valida_ate: '2026-08-09' };
    assert.equal(productService.precoEfetivo(produto), 7, 'a promoção ainda deveria valer -- em Brasília ainda é o último dia dela');
  });
});

test('sugestoesDescontoValidade não pega produto que só vence amanhã em Brasília, durante a janela perigosa', () => {
  const { db, locationId } = freshTestDb();
  const stockService = require('../electron/services/stockService');
  const produtoId = createProduct(db, { nome: 'Pão', preco: 10 });
  // Vence 10/08 -- em Brasília ainda é 09/08, ou seja, vence "amanhã" pro calendário local.
  db.prepare(`INSERT INTO product_batches (id, product_id, location_id, quantidade, validade) VALUES (?, ?, ?, 10, '2026-08-10')`)
    .run(randomUUID(), produtoId, locationId);

  comRelogioCongelado(() => {
    // diasLimiar 0 = só o que vence HOJE (calendário de Brasília) -- não deveria pegar esse produto.
    const sugestoes = stockService.sugestoesDescontoValidade({ locationId, diasLimiar: 0 });
    assert.equal(sugestoes.length, 0, 'produto que só vence amanhã em Brasília não deveria aparecer como \"vence hoje\"');
  });
});

test('petService.listLembretesPendentes não antecipa vacina que só vence amanhã em Brasília', () => {
  const { db } = freshTestDb();
  const petService = require('../electron/services/petService');
  const clienteId = randomUUID();
  db.prepare('INSERT INTO customers (id, nome, telefone) VALUES (?, ?, ?)').run(clienteId, 'Dono', '81988887777');
  const r = petService.upsert({ customerId: clienteId, nome: 'Rex', proximaVacinaEm: '2026-08-10' });

  comRelogioCongelado(() => {
    const lembretes = petService.listLembretesPendentes({ diasAntecedencia: 0 });
    assert.equal(lembretes.length, 0, 'vacina que só vence amanhã em Brasília não deveria aparecer como pendente hoje');
  });
});

test('quoteService.createQuote calcula a validade pelo calendário de Brasília, não UTC', () => {
  const { db, locationId, adminId } = freshTestDb();
  const quoteService = require('../electron/services/quoteService');

  comRelogioCongelado(() => {
    const r = quoteService.createQuote({ locationId, operadorId: adminId, validadeDias: 1 });
    const quote = quoteService.getQuote(r.id);
    // Hoje em Brasília é 09/08 -- +1 dia = 10/08, não 11/08 (que seria o resultado se usasse UTC puro, já em 10/08 de madrugada).
    assert.equal(quote.validade_ate, '2026-08-10');
  });
});
