const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const saudeService = require('../electron/services/saudeService');

test('banco novo: sem pendências graves de venda/estoque; primeiros passos mostram o que falta', () => {
  freshTestDb();
  const pend = saudeService.listarPendencias({});
  assert.ok(Array.isArray(pend));
  assert.equal(pend.some((p) => p.id === 'vendas_presas_grupo'), false);
  const imp = saudeService.progressoImplantacao();
  assert.equal(imp.total, 8);
  assert.ok(imp.feitos < imp.total);
  assert.equal(imp.passos.find((p) => p.id === 'pix').feito, false);
});

test('aponta venda presa no grupo, caixa aberto há dias, NFC-e rejeitada e backup que falhou', () => {
  const { db, locationId, operadorId } = freshTestDb();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, pendente_estoque_grupo) VALUES (?, ?, ?, 'aberta', 1)`).run(randomUUID(), locationId, operadorId);
  db.prepare(`INSERT INTO cash_sessions (id, location_id, operador_abertura_id, valor_abertura, aberta_em) VALUES (?, ?, ?, 0, datetime('now', '-3 days'))`).run(randomUUID(), locationId, operadorId);
  const vendaNota = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status) VALUES (?, ?, ?, 'finalizada')`).run(vendaNota, locationId, operadorId);
  db.prepare(`INSERT INTO nfce_emitidas (id, sale_id, status) VALUES (?, ?, 'rejeitada')`).run(randomUUID(), vendaNota);
  db.prepare(`UPDATE backup_config SET ultimo_backup_ok = 0, ultimo_backup_em = datetime('now') WHERE id = 'default'`).run();
  const ids = saudeService.listarPendencias({ locationId }).map((p) => p.id);
  for (const id of ['vendas_presas_grupo', 'caixa_aberto_antigo', 'nfce_problema', 'backup']) assert.ok(ids.includes(id), id);
  // As graves vêm primeiro.
  const lista = saudeService.listarPendencias({ locationId });
  assert.equal(lista[0].gravidade, 'alta');
  const resumo = saudeService.resumoParaCentral({ locationId });
  assert.ok(resumo.pendenciasAltas >= 3);
});

test('primeiros passos: chave Pix e produtos com custo contam quando feitos', () => {
  const { db } = freshTestDb();
  db.prepare(`UPDATE payment_config SET pix_chave = 'loja@x.com' WHERE id = 'default'`).run();
  for (let i = 0; i < 5; i += 1) createProduct(db, { preco: 10, custo: 4 });
  const imp = saudeService.progressoImplantacao();
  assert.equal(imp.passos.find((p) => p.id === 'pix').feito, true);
  assert.equal(imp.passos.find((p) => p.id === 'produtos').feito, true);
  assert.equal(imp.passos.find((p) => p.id === 'custos').feito, true);
});
