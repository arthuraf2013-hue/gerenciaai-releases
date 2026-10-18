#!/usr/bin/env node
/**
 * Benchmark do GerenciaAI com um banco sintético de "loja grande, 1 ano"
 * (padrão: 8.000 produtos, 65.000 vendas, ~3 itens por venda).
 *
 *   node bench/medir.js                 # mede e imprime a tabela
 *   node bench/medir.js --json          # saída em JSON (pra comparar entre versões)
 *   node bench/medir.js --limites       # falha (exit 1) se alguma operação passar do limite
 *   PRODUTOS=2000 VENDAS=20000 node bench/medir.js
 *
 * Para simular um Celeron no Linux: taskset -c 0 node bench/medir.js
 * Os números de referência estão em CHANGELOG_PERFORMANCE.md (v1.0).
 * Não roda no `npm test` de propósito: tempo varia com a máquina.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const { setDbForTesting } = require('../electron/db/database');

const PRODUTOS = Number(process.env.PRODUTOS || 8000);
const VENDAS = Number(process.env.VENDAS || 65000);
const args = new Set(process.argv.slice(2));

// Limites (ms, mediana) -- folgados o bastante pra não falhar à toa em CI,
// apertados o bastante pra pegar a volta de um problema como os da v1.0.
const LIMITES = {
  'Busca do PDV "ca"': 60, 'Busca por código de barras': 10, 'Vendidos recentemente (atalhos)': 40,
  'Painel 30 dias': 400, 'Sugestão de compra': 1500, 'Por que o resultado mudou (7 dias)': 400, 'Pendências (saúde)': 50,
};

const arquivo = path.join(os.tmpdir(), `gerenciaai-bench-${process.pid}.sqlite3`);
const db = setDbForTesting(new Database(arquivo));
db.pragma('journal_mode = WAL');
const locationId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;
const adminId = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get().id;

process.stderr.write(`Gerando ${PRODUTOS} produtos e ${VENDAS} vendas...\n`);
const nomes = ['cafe pilao', 'arroz camil', 'feijao', 'acucar', 'biscoito', 'cerveja', 'refrigerante', 'leite', 'pao', 'queijo', 'carne', 'sabao', 'detergente', 'macarrao', 'oleo'];
const produtos = [];
db.transaction(() => {
  const ins = db.prepare(`INSERT INTO products (id, nome, preco, custo, codigo_barras, estoque_minimo, ativo) VALUES (?, ?, ?, ?, ?, 5, 1)`);
  const est = db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id, criado_em) VALUES (?, ?, ?, 'entrada', 500, ?, 'bench', datetime('now', '-400 days'))`);
  for (let i = 0; i < PRODUTOS; i += 1) {
    const id = randomUUID();
    ins.run(id, `${nomes[i % nomes.length]} ${i}`, 5 + (i % 50), 2 + (i % 30), String(7890000000000 + i));
    est.run(randomUUID(), id, locationId, adminId);
    produtos.push(id);
  }
})();
db.transaction(() => {
  const venda = db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total, desconto, desconto_gerente, criado_em, finalizada_em) VALUES (?, ?, ?, 'finalizada', ?, 0, 0, ?, ?)`);
  const item = db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, criado_em) VALUES (?, ?, ?, ?, ?, ?)`);
  const mov = db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, sale_id, operador_id, device_id, criado_em) VALUES (?, ?, ?, 'venda', ?, ?, ?, 'bench', ?)`);
  for (let v = 0; v < VENDAS; v += 1) {
    const quando = new Date(Date.now() - Math.floor((v / VENDAS) * 365 * 86400000)).toISOString().slice(0, 19).replace('T', ' ');
    const saleId = randomUUID();
    let total = 0;
    const itens = [];
    for (let k = 0; k < 3; k += 1) {
      const p = produtos[(v * 7 + k * 13) % produtos.length];
      itens.push(p); total += 10;
    }
    venda.run(saleId, locationId, adminId, total, quando, quando);
    for (const p of itens) { item.run(randomUUID(), saleId, p, 1, 10, quando); mov.run(randomUUID(), p, locationId, -1, saleId, adminId, quando); }
  }
})();
db.exec('ANALYZE'); db.exec('DELETE FROM sqlite_stat4');

const productService = require('../electron/services/productService');
const saleService = require('../electron/services/saleService');
const dashboardService = require('../electron/services/dashboardService');
const supplierService = require('../electron/services/supplierService');
const saudeService = require('../electron/services/saudeService');
const timeService = require('../electron/services/timeService');
const hoje = timeService.hojeLocalISO();
const ha = (d) => timeService.diasAPartirDeHojeLocalISO(-d);

function medir(nome, fn, vezes = 7) {
  fn(); // aquece
  const t = [];
  for (let i = 0; i < vezes; i += 1) { const a = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - a) / 1e6); }
  t.sort((x, y) => x - y);
  return { nome, medianaMs: Number(t[Math.floor(t.length / 2)].toFixed(2)), limiteMs: LIMITES[nome] ?? null };
}

const resultados = [
  medir('Busca do PDV "ca"', () => productService.list({ query: 'ca', locationId, limit: 50 })),
  medir('Busca por código de barras', () => productService.findByBarcode('7890000004321')),
  medir('Vendidos recentemente (atalhos)', () => saleService.listRecentlySold({ locationId, limit: 12 })),
  medir('Painel 30 dias', () => dashboardService.getSummary({ locationId, dataInicio: ha(29), dataFim: hoje }), 5),
  medir('Sugestão de compra', () => supplierService.suggestPurchases({ locationId }), 3),
  medir('Por que o resultado mudou (7 dias)', () => dashboardService.explicarVariacao({ locationId, dataInicio: ha(6), dataFim: hoje }), 5),
  medir('Pendências (saúde)', () => saudeService.listarPendencias({ locationId })),
];

db.close();
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(arquivo + s); } catch { /* ok */ } }

if (args.has('--json')) {
  console.log(JSON.stringify({ produtos: PRODUTOS, vendas: VENDAS, node: process.version, resultados }, null, 2));
} else {
  console.log(`\n${PRODUTOS} produtos · ${VENDAS} vendas · Node ${process.version}\n`);
  for (const r of resultados) console.log(`${r.nome.padEnd(40)} ${String(r.medianaMs).padStart(9)} ms${r.limiteMs ? `   (limite ${r.limiteMs} ms)` : ''}`);
}
const estourou = resultados.filter((r) => r.limiteMs && r.medianaMs > r.limiteMs);
if (args.has('--limites') && estourou.length) {
  console.error(`\nAcima do limite: ${estourou.map((r) => `${r.nome} (${r.medianaMs} > ${r.limiteMs} ms)`).join('; ')}`);
  process.exit(1);
}
