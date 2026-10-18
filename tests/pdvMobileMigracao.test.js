const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const migracao = require('../electron/services/pdvMobileMigracaoService');

// Backups gerados pelo PRÓPRIO app do celular (mobile/scripts/gerarFixtureMigracao.mjs):
// 1 = primeira migração; 2 = o mesmo celular depois de mais uso (complemento).
const backup = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `pdv-mobile-backup-${n}.json`), 'utf-8'));
const linhas = (dump, t) => dump.tabelas[t].linhas.map((l) => Object.fromEntries(dump.tabelas[t].colunas.map((c, i) => [c, l[i]])));
const r2 = (v) => Math.round(v * 100) / 100;

function saldoEstoque(db, productId, locationId) {
  return db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS s FROM stock_movements WHERE product_id = ? AND location_id = ?').get(productId, locationId).s;
}
function saldoFiado(db, customerId) {
  return db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END), 0) AS s FROM customer_credit_movements WHERE customer_id = ?`).get(customerId).s;
}
function contagens(db) {
  const o = {};
  for (const t of ['users', 'products', 'customers', 'sales', 'sale_items', 'payments', 'stock_movements', 'customer_credit_movements', 'cash_sessions']) {
    o[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  return o;
}

test('primeira migração: tudo entra com os mesmos números do celular (vendas, estoque, fiado) e conferência bate', () => {
  const { db, locationId, adminId } = freshTestDb();
  const dump = backup(1);
  const resumo = migracao.importarDump(dump, { operadorId: adminId });

  assert.equal(resumo.conferencia.tudoBateu, true);
  assert.equal(resumo.produtos.novos, 4);
  assert.equal(resumo.clientes.novos, 2);
  assert.equal(resumo.usuarios.novos, 3);
  assert.equal(resumo.vendas.novas, 6);
  assert.equal(resumo.caixas.importados, 1);
  assert.equal(resumo.caixas.abertoNoCelularNaoImportado, true);

  // Faturamento pela MESMA fórmula do Painel do desktop.
  const fat = db.prepare(`SELECT COALESCE(SUM(total - desconto - desconto_gerente), 0) AS t FROM sales WHERE status = 'finalizada'`).get().t;
  const esperado = linhas(dump, 'vendas').filter((v) => v.status === 'finalizada').reduce((s, v) => s + v.total_centavos, 0) / 100;
  assert.equal(r2(fat), r2(esperado));

  // Estoque = saldo do celular (as vendas NÃO baixam de novo).
  for (const p of linhas(dump, 'produtos')) {
    if (!p.controla_estoque) {
      assert.equal(db.prepare('SELECT tipo FROM products WHERE id = ?').get(p.id).tipo, 'servico');
      continue;
    }
    assert.equal(saldoEstoque(db, p.id, locationId), p.estoque_mil / 1000, p.nome);
  }
  // Fiado = saldo do celular.
  for (const c of linhas(dump, 'clientes')) assert.equal(r2(saldoFiado(db, c.id)), c.saldo_fiado_centavos / 100, c.nome);

  // Datas no formato do desktop (filtros por período comparam texto).
  for (const s of db.prepare('SELECT criado_em, finalizada_em FROM sales').all()) {
    assert.match(s.criado_em, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  // Troco não entra no caixa: pagamento em dinheiro = valor aplicado, recebido/troco nos detalhes.
  const pagDinheiro = db.prepare(`SELECT valor, detalhes FROM payments WHERE metodo = 'dinheiro' AND json_extract(detalhes, '$.troco') IS NOT NULL`).get();
  assert.equal(pagDinheiro.valor, 23.68);
  assert.equal(JSON.parse(pagDinheiro.detalhes).troco, 26.32);
  // Métodos convertidos pros nomes do desktop.
  const metodos = db.prepare('SELECT DISTINCT metodo FROM payments ORDER BY metodo').all().map((r) => r.metodo);
  assert.deepEqual(metodos, ['cartao_credito', 'cartao_debito', 'dinheiro', 'fiado', 'pix']);
  // Desconto autorizado vira desconto de gerente, com quem autorizou.
  const comDesconto = db.prepare('SELECT desconto_gerente, desconto_autorizado_por_id FROM sales WHERE desconto_gerente > 0').get();
  assert.equal(comDesconto.desconto_gerente, 7);
  assert.ok(comDesconto.desconto_autorizado_por_id);
  // Venda cancelada no celular entra como cancelada.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE status = 'cancelada'`).get().n, 1);
  // Operadores do celular entram DESATIVADOS (PIN não é conversível).
  const usuariosCel = db.prepare(`SELECT ativo, pin_temporario FROM users WHERE nome LIKE '%(celular)'`).all();
  assert.equal(usuariosCel.length, 3);
  assert.ok(usuariosCel.every((u) => u.ativo === 0 && u.pin_temporario === 1));
});

test('pré-visualização roda a conferência inteira e não grava NADA', () => {
  const { db, adminId } = freshTestDb();
  const antes = contagens(db);
  const resumo = migracao.importarDump(backup(1), { operadorId: adminId, previa: true });
  assert.equal(resumo.conferencia.tudoBateu, true);
  assert.equal(resumo.vendas.novas, 6);
  assert.deepEqual(contagens(db), antes);
});

test('segunda migração (complemento): só traz o novo, aplica movimentos depois do corte, cancela venda cancelada depois — sem duplicar', () => {
  const { db, locationId, adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  const dump2 = backup(2);
  const r = migracao.importarDump(dump2, { operadorId: adminId });

  assert.equal(r.vendas.novas, 2);
  assert.equal(r.vendas.jaImportadas, 5);
  assert.equal(r.vendas.canceladasDepois, 1);
  assert.equal(r.produtos.novos, 1);
  assert.equal(r.clientes.novos, 1);
  assert.equal(r.usuarios.existentes, 3);
  // Sem venda nenhuma no computador entre as duas, o saldo daqui tem que
  // ser exatamente o do celular de novo -- prova que não contou nada duas vezes.
  for (const p of linhas(dump2, 'produtos').filter((x) => x.controla_estoque)) {
    assert.equal(r2(saldoEstoque(db, p.id, locationId)), p.estoque_mil / 1000, p.nome);
  }
  for (const c of linhas(dump2, 'clientes')) assert.equal(r2(saldoFiado(db, c.id)), c.saldo_fiado_centavos / 100, c.nome);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 8);

  // Terceira vez com o mesmo backup: nada novo -> recusa sem mexer.
  const antes = contagens(db);
  assert.throws(() => migracao.importarDump(dump2, { operadorId: adminId }), /igual ou mais antigo/);
  assert.deepEqual(contagens(db), antes);
});

test('produto que o computador já tinha (mesmo código de barras): liga os dois e mantém o estoque daqui', () => {
  const { db, locationId, adminId } = freshTestDb();
  const cocaAqui = createProduct(db, { nome: 'COCA LATA 350', preco: 6 });
  db.prepare('UPDATE products SET codigo_barras = ? WHERE id = ?').run('7894900011517', cocaAqui);
  addStock(db, { productId: cocaAqui, locationId, quantidade: 100, operadorId: adminId });

  const r = migracao.importarDump(backup(1), { operadorId: adminId });
  assert.equal(r.produtos.ligadosPorCodigo, 1);
  assert.equal(r.produtos.estoqueMantidoDoComputador.length, 1);
  assert.equal(saldoEstoque(db, cocaAqui, locationId), 100);
  // As vendas do celular apontam pro produto daqui, com o nome que era usado no celular.
  const item = db.prepare(`SELECT product_id, nome_personalizado FROM sale_items WHERE nome_personalizado = 'Coca-Cola Lata 350ml' LIMIT 1`).get();
  assert.equal(item.product_id, cocaAqui);
});

test('conferência que não bate desfaz tudo (nada parcial fica no banco)', () => {
  const { db, adminId } = freshTestDb();
  const dump = backup(1);
  // Corrompe um pagamento: soma das formas de pagamento deixa de bater com o total.
  const t = dump.tabelas.pagamentos;
  t.linhas[0][t.colunas.indexOf('valor_centavos')] += 1;
  const antes = contagens(db);
  assert.throws(() => migracao.importarDump(dump, { operadorId: adminId }), /conferência não bateu/);
  assert.deepEqual(contagens(db), antes);
});

test('recusa arquivo que não é backup do PDV mobile e backup de versão mais nova', () => {
  const { adminId } = freshTestDb();
  assert.throws(() => migracao.importarDump({ formato: 'outro' }, { operadorId: adminId }), /não é um backup do PDV mobile/);
  assert.throws(() => migracao.importarDump({ ...backup(1), versaoFormato: 99 }, { operadorId: adminId }), /versão mais nova/);
});
