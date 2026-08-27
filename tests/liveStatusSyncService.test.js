const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const timeService = require('../electron/services/timeService');
const liveStatusSyncService = require('../electron/services/liveStatusSyncService');

// Só getResumoHoje/getCatalogoProdutos são testáveis localmente sem rede
// -- publicarStatusAoVivo e iniciarPublicacaoContinua dependem de
// Firestore de verdade (a primeira é best-effort e engole erro de rede; a
// segunda mantém um
// setInterval vivo, que travaria `node --test` esperando o processo
// terminar -- por isso nenhuma das duas é chamada aqui).

function inserirVendaFinalizada(db, { locationId, operadorId, produtoId, finalizadaEmUtc, total, desconto = 0, descontoGerente = 0 }) {
  const saleId = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, desconto, desconto_gerente, finalizada_em)
     VALUES (?, ?, ?, 'finalizada', ?, ?, ?, ?)`
  ).run(saleId, locationId, operadorId, total, desconto, descontoGerente, finalizadaEmUtc);
  db.prepare(
    `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, 1, ?)`
  ).run(randomUUID(), saleId, produtoId, total);
  return saleId;
}

test('getResumoHoje soma só as vendas finalizadas hoje (local), descontando desconto e desconto_gerente', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 100 });
  const hoje = timeService.hojeLocalISO();
  const { inicioUtc } = timeService.localDateRangeToUtcBounds(hoje, hoje);

  inserirVendaFinalizada(db, { locationId, operadorId, produtoId, finalizadaEmUtc: inicioUtc, total: 100, desconto: 10, descontoGerente: 5 });
  inserirVendaFinalizada(db, { locationId, operadorId, produtoId, finalizadaEmUtc: inicioUtc, total: 50 });
  // Fora do dia local de hoje -- não deveria entrar.
  inserirVendaFinalizada(db, { locationId, operadorId, produtoId, finalizadaEmUtc: '2000-01-01 00:00:00', total: 999 });

  const resumo = liveStatusSyncService.getResumoHoje(locationId);
  assert.equal(resumo.totalVendasHoje, 2);
  assert.equal(resumo.faturamentoHoje, 135); // (100 - 10 - 5) + 50
  assert.equal(resumo.ticketMedioHoje, 67.5);
});

test('getResumoHoje ignora venda aberta/cancelada e venda de outro local', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const produtoId = createProduct(db, { preco: 100 });
  const outroLocationId = randomUUID();
  db.prepare(`INSERT INTO locations (id, nome, tipo) VALUES (?, 'Outra loja', 'loja')`).run(outroLocationId);
  const hoje = timeService.hojeLocalISO();
  const { inicioUtc } = timeService.localDateRangeToUtcBounds(hoje, hoje);

  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES (?, ?, ?, 'aberta', 999)`)
    .run(randomUUID(), locationId, operadorId);
  inserirVendaFinalizada(db, { locationId: outroLocationId, operadorId, produtoId, finalizadaEmUtc: inicioUtc, total: 999 });

  const saleCanceladaId = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total, finalizada_em) VALUES (?, ?, ?, 'cancelada', 999, ?)`
  ).run(saleCanceladaId, locationId, operadorId, inicioUtc);

  const resumo = liveStatusSyncService.getResumoHoje(locationId);
  assert.equal(resumo.totalVendasHoje, 0);
  assert.equal(resumo.faturamentoHoje, 0);
  assert.equal(resumo.ticketMedioHoje, 0);
});

test('getCatalogoProdutos só traz produto ativo, ordenado por nome, com o preço promocional vigente já aplicado', () => {
  const { db } = freshTestDb();
  const hoje = timeService.hojeLocalISO();

  const zebraId = createProduct(db, { nome: 'Zebrinha', preco: 20, categoria: 'Bebidas' });
  const aguaId = createProduct(db, { nome: 'Agua Mineral', preco: 5, categoria: 'Bebidas' });
  createProduct(db, { nome: 'Descontinuado', preco: 15, categoria: 'Bebidas' });
  db.prepare('UPDATE products SET ativo = 0 WHERE nome = ?').run('Descontinuado');

  // Promoção vigente (vale até hoje) -- deve aparecer com o preço promocional.
  db.prepare('UPDATE products SET preco_promocional = 12, promocao_valida_ate = ? WHERE id = ?').run(hoje, zebraId);

  const catalogo = liveStatusSyncService.getCatalogoProdutos();
  assert.equal(catalogo.length, 2); // o desativado não entra

  const [primeiro, segundo] = catalogo;
  assert.equal(primeiro.id, aguaId); // ordenado por nome
  assert.equal(primeiro.preco, 5);
  assert.equal(segundo.id, zebraId);
  assert.equal(segundo.preco, 12); // preço promocional vigente, não o preco cheio (20)
  assert.equal(segundo.categoria, 'Bebidas');
});

test('getCatalogoProdutos ignora promoção já expirada, usando o preço normal', () => {
  const { db } = freshTestDb();
  const produtoId = createProduct(db, { nome: 'Item Vencido', preco: 30 });
  db.prepare(`UPDATE products SET preco_promocional = 10, promocao_valida_ate = '2000-01-01' WHERE id = ?`).run(produtoId);

  const catalogo = liveStatusSyncService.getCatalogoProdutos();
  assert.equal(catalogo.length, 1);
  assert.equal(catalogo[0].preco, 30);
});
