const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const database = require('../electron/db/database');
const productService = require('../electron/services/productService');
const saleService = require('../electron/services/saleService');
const liveStatusSyncService = require('../electron/services/liveStatusSyncService');

// Otimizações da v1.0 -- cada teste confere que a versão rápida devolve
// EXATAMENTE o mesmo que a lógica antiga (reproduzida aqui), e que os
// caches/marcas são invalidados por qualquer caminho de escrita.

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Cópia fiel da busca ANTIGA de productService.list (antes do índice em memória). */
function buscaAntiga(db, { query, tipo, comConflito, limit, offset, cursorId }) {
  const queryNormalizada = normalizar(query);
  const queryLower = query.toLowerCase();
  const filtroTipoSql = tipo ? ' AND tipo = ?' : '';
  const filtroConflitoSql = comConflito ? ' AND conflito_codigo_barras_pendente IS NOT NULL' : '';
  const todosAtivos = db.prepare(`SELECT * FROM products WHERE ativo = 1${filtroTipoSql}${filtroConflitoSql}`).all(...(tipo ? [tipo] : []));
  const comecam = [];
  const outros = [];
  for (const p of todosAtivos) {
    const nomeNormalizado = normalizar(p.nome);
    const idxNome = nomeNormalizado.indexOf(queryNormalizada);
    const skuMatch = p.sku && String(p.sku).toLowerCase().includes(queryLower);
    const codigoMatch = p.codigo_barras && String(p.codigo_barras).includes(query);
    if (idxNome === 0) { comecam.push(p); continue; }
    if (idxNome === -1 && !skuMatch && !codigoMatch) continue;
    let relevancia;
    if (idxNome > 0 && nomeNormalizado[idxNome - 1] === ' ') relevancia = 1;
    else if (idxNome > 0) relevancia = 2;
    else relevancia = 3;
    outros.push({ produto: p, relevancia, idxNome: idxNome === -1 ? 9999 : idxNome });
  }
  let r;
  if (comecam.length > 0) { comecam.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')); r = comecam; }
  else {
    outros.sort((a, b) => a.relevancia - b.relevancia || a.idxNome - b.idxNome || a.produto.nome.localeCompare(b.produto.nome, 'pt-BR'));
    r = outros.map((x) => x.produto);
  }
  if (limit) {
    if (cursorId) { const i = r.findIndex((p) => p.id === cursorId); r = i === -1 ? [] : r.slice(i + 1, i + 1 + limit); }
    else r = r.slice(offset || 0, (offset || 0) + limit);
  }
  return r;
}

function popularCatalogo(db) {
  const nomes = ['Café Pilão 250g', 'Cafeteira Elétrica', 'Pão de Queijo', 'Açaí 500ml', 'Água Mineral', 'Biscoito Maizena',
    'Caixa de Fósforo', 'Detergente Ypê', 'café solúvel', 'Arroz Camil 5kg', 'Feijão Carioca', 'Coca-Cola Lata', 'Cacau em pó'];
  nomes.forEach((nome, i) => {
    const id = createProduct(db, { nome, preco: 5 + i, tipo: i % 5 === 0 ? 'servico' : 'produto' });
    db.prepare('UPDATE products SET sku = ?, codigo_barras = ? WHERE id = ?').run(`SKU-${i}A`, `789100000${String(i).padStart(4, '0')}`, id);
  });
  const inativo = createProduct(db, { nome: 'Café Antigo Desativado' });
  db.prepare('UPDATE products SET ativo = 0 WHERE id = ?').run(inativo);
}

test('busca do PDV com índice em memória devolve exatamente o mesmo que a busca antiga', () => {
  const { db } = freshTestDb();
  popularCatalogo(db);
  const casos = [
    { query: 'caf' }, { query: 'cafe' }, { query: 'CAFÉ' }, { query: 'ca' }, { query: 'a' }, { query: 'agua' },
    { query: 'queijo' }, { query: 'sku-3' }, { query: '7891000000004' }, { query: '0000' }, { query: 'nada-disso' },
    { query: 'ca', tipo: 'servico' }, { query: 'ca', limit: 3 }, { query: 'ca', limit: 2, offset: 2 },
  ];
  for (const caso of casos) {
    const novo = productService.list(caso).map((p) => p.id);
    const antigo = buscaAntiga(db, caso).map((p) => p.id);
    assert.deepEqual(novo, antigo, JSON.stringify(caso));
  }
  const primeiro = productService.list({ query: 'ca', limit: 2 });
  assert.deepEqual(
    productService.list({ query: 'ca', limit: 2, cursorId: primeiro[1].id }).map((p) => p.id),
    buscaAntiga(db, { query: 'ca', limit: 2, cursorId: primeiro[1].id }).map((p) => p.id)
  );
});

test('índice de busca enxerga na hora produto novo, renomeado, desativado e com código alterado (sem cache velho)', () => {
  const { db } = freshTestDb();
  popularCatalogo(db);
  assert.equal(productService.list({ query: 'zebra' }).length, 0); // monta o cache
  const id = createProduct(db, { nome: 'Zebra de Pelúcia' });
  assert.deepEqual(productService.list({ query: 'zebra' }).map((p) => p.id), [id]);
  db.prepare('UPDATE products SET nome = ? WHERE id = ?').run('Girafa de Pelúcia', id);
  assert.equal(productService.list({ query: 'zebra' }).length, 0);
  assert.equal(productService.list({ query: 'girafa' }).length, 1);
  db.prepare('UPDATE products SET codigo_barras = ? WHERE id = ?').run('5551234', id);
  assert.equal(productService.list({ query: '5551234' })[0].id, id);
  db.prepare('UPDATE products SET ativo = 0 WHERE id = ?').run(id);
  assert.equal(productService.list({ query: 'girafa' }).length, 0);
  // Preço sempre vem do banco na hora (o cache só guarda o que a busca compara).
  const cafe = productService.list({ query: 'cafe pilao' })[0];
  db.prepare('UPDATE products SET preco = 99 WHERE id = ?').run(cafe.id);
  assert.equal(productService.list({ query: 'cafe pilao' })[0].preco, 99);
});

test('busca com locationId e limit continua anexando o estoque só dos resultados', () => {
  const { db, locationId, adminId } = freshTestDb();
  const id = createProduct(db, { nome: 'Leite Integral' });
  addStock(db, { productId: id, locationId, quantidade: 7, operadorId: adminId });
  const [p] = productService.list({ query: 'leite', locationId, limit: 8 });
  assert.equal(p.estoque_atual, 7);
});

/** Consulta ANTIGA de "vendidos recentemente" (agrupava o histórico inteiro). */
function recentesAntigo(db, locationId, limit) {
  return db.prepare(
    `SELECT p.*, MAX(si.criado_em) as ultima_venda_em FROM sale_items si JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id WHERE s.location_id = ? AND si.cancelado = 0 AND si.eh_personalizado = 0
     GROUP BY p.id ORDER BY ultima_venda_em DESC LIMIT ?`
  ).all(locationId, limit);
}

function venderEm(db, { locationId, operadorId, productId, criadoEm, cancelado = 0 }) {
  const saleId = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total, criado_em, finalizada_em) VALUES (?, ?, ?, 'finalizada', 10, ?, ?)`)
    .run(saleId, locationId, operadorId, criadoEm, criadoEm);
  db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, cancelado, criado_em) VALUES (?, ?, ?, 1, 10, ?, ?)`)
    .run(randomUUID(), saleId, productId, cancelado, criadoEm);
  return saleId;
}

test('vendidos recentemente: varredura das últimas linhas == agrupamento do histórico inteiro (inclusive o caso de repetição)', () => {
  const { db, locationId, adminId } = freshTestDb();
  const produtos = Array.from({ length: 30 }, (_, i) => createProduct(db, { nome: `Produto ${String(i).padStart(2, '0')}` }));
  // 1200 vendas espalhadas -- produtos repetem muito, segundos distintos.
  for (let i = 0; i < 1200; i++) {
    const seg = String(i % 60).padStart(2, '0');
    const min = String(Math.floor(i / 60) % 60).padStart(2, '0');
    const hora = String(Math.floor(i / 3600)).padStart(2, '0');
    venderEm(db, { locationId, operadorId: adminId, productId: produtos[(i * 7) % (i % 50 === 0 ? 30 : 6)], criadoEm: `2026-01-01 ${hora}:${min}:${seg}`, cancelado: i % 97 === 0 ? 1 : 0 });
  }
  for (const limit of [3, 6, 12, 25]) {
    const novo = saleService.listRecentlySold({ locationId, limit });
    const antigo = recentesAntigo(db, locationId, limit);
    assert.deepEqual(novo.map((p) => p.id), antigo.map((p) => p.id), `limit ${limit}`);
    assert.deepEqual(novo.map((p) => p.ultima_venda_em), antigo.map((p) => p.ultima_venda_em));
  }
});

test('marca de "venda já enviada ao grupo" some sozinha se a venda, os itens ou os pagamentos mudarem', () => {
  const { db, locationId, adminId } = freshTestDb();
  const productId = createProduct(db, { nome: 'X' });
  const saleId = venderEm(db, { locationId, operadorId: adminId, productId, criadoEm: '2026-01-01 10:00:00' });
  const marcar = () => db.prepare(`INSERT OR REPLACE INTO group_sync_sales (sale_id, grupo_id) VALUES (?, 'g1')`).run(saleId);
  const marcada = () => !!db.prepare('SELECT 1 FROM group_sync_sales WHERE sale_id = ?').get(saleId);

  marcar();
  db.prepare('UPDATE sales SET total = 12 WHERE id = ?').run(saleId);
  assert.equal(marcada(), false);
  marcar();
  db.prepare(`INSERT INTO payments (id, sale_id, metodo, valor) VALUES (?, ?, 'pix', 12)`).run(randomUUID(), saleId);
  assert.equal(marcada(), false);
  marcar();
  db.prepare('UPDATE sale_items SET cancelado = 1 WHERE sale_id = ?').run(saleId);
  assert.equal(marcada(), false);
  marcar();
  db.prepare(`UPDATE products SET nome = 'Y' WHERE id = ?`).run(productId); // produto não é a venda
  assert.equal(marcada(), true);
});

test('catálogo do celular com estoque (só dos produtos do catálogo) == estoque somado do ledger inteiro', () => {
  const { db, locationId, adminId } = freshTestDb();
  const a = createProduct(db, { nome: 'A' });
  const b = createProduct(db, { nome: 'B' });
  const s = createProduct(db, { nome: 'Serviço', tipo: 'servico' });
  addStock(db, { productId: a, locationId, quantidade: 5, operadorId: adminId });
  addStock(db, { productId: a, locationId, quantidade: -2, operadorId: adminId });
  addStock(db, { productId: b, locationId, quantidade: 1, operadorId: adminId });
  const cat = liveStatusSyncService.getCatalogoProdutos(locationId);
  const porId = Object.fromEntries(cat.map((p) => [p.id, p.estoque]));
  assert.equal(porId[a], 3);
  assert.equal(porId[b], 1);
  assert.equal(porId[s], null);
});

test('banco antigo: índice novo no schema.sql citando coluna ainda não migrada não impede o app de abrir', () => {
  const db = new Database(':memory:');
  db.function('NOW_SYNCED', () => '2026-01-01 00:00:00');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'electron', 'db', 'schema.sql'), 'utf-8');
  db.exec(schema);
  // Simula uma instalação de antes das colunas de pendência de estoque do grupo.
  db.exec('DROP INDEX IF EXISTS idx_sales_pendente_estoque_grupo');
  for (const c of ['pendente_estoque_grupo', 'pendente_estoque_tentativas', 'pendente_estoque_proxima_tentativa']) {
    db.exec(`ALTER TABLE sales DROP COLUMN ${c}`);
  }
  // E um schema.sql "com o erro" (o mesmo que travou a abertura do app).
  const schemaComErro = `${schema}\nCREATE INDEX IF NOT EXISTS idx_teste_regressao ON sales(status, pendente_estoque_grupo);`;
  assert.throws(() => db.exec(schemaComErro), /no such column/);
  database.aplicarSchemaComRedeDeSeguranca(db, schemaComErro);
  const colunas = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
  assert.ok(colunas.includes('pendente_estoque_grupo'));
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_teste_regressao'`).get());
});

test('migração remove o índice antigo de estoque, que virou redundante com o índice cobrindo', () => {
  const db = new Database(':memory:');
  db.function('NOW_SYNCED', () => '2026-01-01 00:00:00');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'electron', 'db', 'schema.sql'), 'utf-8'));
  db.exec('CREATE INDEX idx_stock_mov_product_loc ON stock_movements(product_id, location_id)');
  database.migrateColumnsIfNeeded(db);
  assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_stock_mov_product_loc'`).get(), undefined);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_stock_mov_prod_loc_qtd'`).get());
});

test('perfil de hardware: campos esperados e decisão de modo leve coerente', () => {
  const { getPerfil } = require('../electron/services/hardwareService');
  const p = getPerfil();
  assert.ok(p.memoriaTotalGb > 0);
  assert.ok(p.nucleos >= 1);
  assert.equal(typeof p.modoLeveAutomatico, 'boolean');
  if (p.memoriaTotalGb <= 4.6 || p.nucleos <= 2) assert.equal(p.modoLeveAutomatico, true);
});

test('otimizarBanco mantém o sqlite_stat1 e esvazia o sqlite_stat4 (que forçava repreparar cada consulta em laço)', () => {
  const { db } = freshTestDb();
  for (let i = 0; i < 300; i++) createProduct(db, { nome: `Produto ${i}`, categoria: `cat${i % 7}` });
  db.exec('ANALYZE');
  assert.ok(db.prepare('SELECT count(*) AS c FROM sqlite_stat4').get().c > 0, 'pré-condição: build com STAT4 gera amostras');
  database.otimizarBanco(db);
  assert.equal(db.prepare('SELECT count(*) AS c FROM sqlite_stat4').get().c, 0);
  assert.ok(db.prepare(`SELECT count(*) AS c FROM sqlite_stat1 WHERE tbl = 'products'`).get().c > 0);
  // Chamar de novo (sem nada pra limpar) é inofensivo, e o banco segue consultável.
  database.otimizarBanco(db, { naAbertura: true });
  assert.equal(productService.list({ query: 'Produto 29', limit: 5 }).length > 0, true);
});
