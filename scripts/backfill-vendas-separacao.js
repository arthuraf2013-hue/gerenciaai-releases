/**
 * Converte em vendas de verdade (Histórico + baixa de estoque) os
 * pedidos de Separação que já foram marcados "Concluído" ANTES da
 * correção do bug que impedia isso de acontecer sozinho (ver
 * converterEmVendaSeAplicavel em electron/services/botOrderService.js).
 * Pedidos concluídos DEPOIS da correção já viram venda automaticamente
 * — este script é só pro passado.
 *
 * ⚠️ LEIA ANTES DE RODAR: se você já lançou manualmente no caixa
 * alguma venda ou ajuste de estoque pra "compensar" um desses pedidos
 * antigos (por exemplo, deu baixa na mão porque o sistema não fazia
 * isso sozinho), rodar este script pra ESSE pedido especificamente vai
 * debitar o estoque DUAS VEZES pelo mesmo produto. Revise a lista do
 * modo de simulação com cuidado antes de aplicar de verdade.
 *
 * Uso:
 *   1. Feche o GerenciaAI completamente (o arquivo do banco não pode
 *      estar em uso).
 *   2. Modo simulação (não muda nada, só mostra o que faria):
 *        node scripts/backfill-vendas-separacao.js
 *   3. Depois de revisar a lista, pra aplicar de verdade:
 *        node scripts/backfill-vendas-separacao.js --aplicar
 *
 * Pedidos sem um operador responsável (separado_por vazio — não
 * deveria acontecer, mas pedidos bem antigos podem não ter isso) são
 * pulados e listados à parte; não têm quem atribuir a venda.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const APLICAR = process.argv.includes('--aplicar');

const candidates = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'gerenciaai', 'gerenciaai.sqlite3'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'GerenciaAI', 'gerenciaai.sqlite3'),
  path.join(os.homedir(), '.config', 'gerenciaai', 'gerenciaai.sqlite3'),
];
const dbPath = candidates.find((p) => fs.existsSync(p));

if (!dbPath) {
  console.error('Não encontrei o banco em nenhum destes caminhos:');
  candidates.forEach((p) => console.error('  ' + p));
  console.error('\nSe o app já rodou pelo menos uma vez, edite este script e adicione o caminho certo em "candidates".');
  process.exit(1);
}

console.log('Banco encontrado em:', dbPath);
console.log(APLICAR ? '\n>>> MODO APLICAR — isso vai gravar vendas de verdade. <<<\n' : '\n(modo simulação — nada será alterado; rode com --aplicar pra valer)\n');

const db = new Database(dbPath);
db.function('NOW_SYNCED', () => new Date().toISOString());

const pedidosPendentes = db.prepare(`SELECT * FROM bot_orders WHERE status = 'concluido' AND sale_id IS NULL`).all();

if (pedidosPendentes.length === 0) {
  console.log('Nenhum pedido concluído sem venda associada — não há nada pra converter.');
  process.exit(0);
}

const buscarItens = db.prepare('SELECT * FROM bot_order_items WHERE bot_order_id = ?');

const convertiveis = [];
const semOperador = [];
const semItemComProduto = [];

for (const pedido of pedidosPendentes) {
  const itens = buscarItens.all(pedido.id);
  const itensComProduto = itens.filter((i) => i.product_id);
  if (itensComProduto.length === 0) {
    semItemComProduto.push(pedido);
    continue;
  }
  if (!pedido.separado_por) {
    semOperador.push(pedido);
    continue;
  }
  const total = itensComProduto.reduce((acc, i) => acc + (i.preco_unitario || 0) * i.quantidade, 0);
  convertiveis.push({ pedido, itensComProduto, total });
}

console.log(`Pedidos concluídos sem venda: ${pedidosPendentes.length}`);
console.log(`  → Convertíveis: ${convertiveis.length}`);
console.log(`  → Pulados (sem produto cadastrado nos itens, só descrição livre): ${semItemComProduto.length}`);
console.log(`  → Pulados (sem operador responsável — não dá pra atribuir a venda): ${semOperador.length}`);
console.log('');

if (convertiveis.length > 0) {
  console.log('--- Pedidos que serão convertidos ---');
  let totalGeral = 0;
  for (const { pedido, itensComProduto, total } of convertiveis) {
    totalGeral += total;
    console.log(
      `  ${pedido.id.slice(0, 8)}... — ${pedido.cliente_nome} (${pedido.tipo_entrega}) — ` +
      `${itensComProduto.length} item(ns) — R$ ${total.toFixed(2)} — concluído em ${pedido.concluido_em || '—'}`
    );
    for (const item of itensComProduto) {
      console.log(`      • produto ${item.product_id.slice(0, 8)}... × ${item.quantidade} (baixa de estoque)`);
    }
  }
  console.log(`\nTotal a entrar no Histórico: R$ ${totalGeral.toFixed(2)} em ${convertiveis.length} venda(s).`);
}

if (semOperador.length > 0) {
  console.log('\n--- Pulados: sem operador responsável ---');
  for (const p of semOperador) {
    console.log(`  ${p.id.slice(0, 8)}... — ${p.cliente_nome} — concluído em ${p.concluido_em || '—'}`);
  }
}

if (semItemComProduto.length > 0) {
  console.log('\n--- Pulados: só têm itens de descrição livre (sem produto cadastrado) ---');
  for (const p of semItemComProduto) {
    console.log(`  ${p.id.slice(0, 8)}... — ${p.cliente_nome} — concluído em ${p.concluido_em || '—'}`);
  }
}

if (!APLICAR) {
  console.log('\nNada foi alterado (modo simulação). Revise a lista acima com cuidado — principalmente se');
  console.log('algum desses pedidos já foi compensado manualmente por você antes — e rode de novo com --aplicar.');
  process.exit(0);
}

console.log('\nAplicando...\n');

const inserirVenda = db.prepare(
  `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, finalizada_em)
   VALUES (?, ?, ?, ?, 'finalizada', 0, NOW_SYNCED())`
);
const inserirItemVenda = db.prepare(
  `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?, ?)`
);
const inserirMovimento = db.prepare(
  `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, sale_id, sale_item_id, operador_id, device_id)
   VALUES (?, ?, ?, 'venda', ?, ?, ?, ?, 'bot_orders_backfill')`
);
const atualizarTotalVenda = db.prepare('UPDATE sales SET total = ? WHERE id = ?');
const inserirPagamento = db.prepare(
  `INSERT INTO payments (id, sale_id, metodo, valor, detalhes) VALUES (?, ?, 'outro', ?, ?)`
);
const marcarPedidoConvertido = db.prepare('UPDATE bot_orders SET sale_id = ? WHERE id = ?');
const inserirEntrega = db.prepare(
  `INSERT INTO deliveries (id, location_id, sale_id, customer_id, endereco, operador_id, status)
   VALUES (?, ?, ?, ?, ?, ?, 'pendente')`
);
const marcarPedidoComEntrega = db.prepare('UPDATE bot_orders SET delivery_id = ? WHERE id = ?');

let convertidos = 0;
for (const { pedido, itensComProduto, total } of convertiveis) {
  const aplicarUmPedido = db.transaction(() => {
    const saleId = randomUUID();
    inserirVenda.run(saleId, pedido.location_id, pedido.separado_por, pedido.customer_id || null);

    let totalReal = 0;
    for (const item of itensComProduto) {
      const preco = item.preco_unitario != null ? item.preco_unitario : 0;
      const saleItemId = randomUUID();
      inserirItemVenda.run(saleItemId, saleId, item.product_id, item.quantidade, preco);
      inserirMovimento.run(randomUUID(), item.product_id, pedido.location_id, -Math.abs(item.quantidade), saleId, saleItemId, pedido.separado_por);
      totalReal += preco * item.quantidade;
    }
    atualizarTotalVenda.run(totalReal, saleId);
    inserirPagamento.run(randomUUID(), saleId, totalReal, JSON.stringify({ origem: 'pedido_separacao_backfill', observacao: 'Backfill de pedido concluído antes da correção' }));
    marcarPedidoConvertido.run(saleId, pedido.id);

    if (pedido.tipo_entrega === 'entrega') {
      const deliveryId = randomUUID();
      inserirEntrega.run(deliveryId, pedido.location_id, saleId, pedido.customer_id || null, pedido.endereco, pedido.separado_por);
      marcarPedidoComEntrega.run(deliveryId, pedido.id);
    }
  });
  aplicarUmPedido();
  convertidos++;
}

console.log(`Pronto — ${convertidos} pedido(s) convertido(s) em venda no Histórico.`);
if (semOperador.length > 0 || semItemComProduto.length > 0) {
  console.log(`${semOperador.length + semItemComProduto.length} pedido(s) continuam sem venda (motivos listados acima) — não foram tocados.`);
}
