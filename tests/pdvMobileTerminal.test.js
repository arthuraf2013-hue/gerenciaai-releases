const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const migracao = require('../electron/services/pdvMobileMigracaoService');
const terminal = require('../electron/services/pdvMobileTerminalService');
const cashService = require('../electron/services/cashService');

// Gerados pelo PRÓPRIO app do celular (mobile/scripts/gerarFixtureMigracao.mjs):
// backup 1 = migração; eventos = o celular virando terminal logo depois
// (o "atraso" -- tudo o que está no backup 2 e não no 1 -- e mais vendas já
// como terminal).
const ler = (nome) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', nome), 'utf-8'));
const backup = (n) => ler(`pdv-mobile-backup-${n}.json`);
const fixture = ler('pdv-mobile-terminal-eventos.json');
const INSTALL = fixture.installId;
const r2 = (v) => Math.round(v * 100) / 100;

function saldoEstoque(db, productId, locationId) {
  return r2(db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS s FROM stock_movements WHERE product_id = ? AND location_id = ?').get(productId, locationId).s);
}
function saldoFiado(db, customerId) {
  return r2(db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END), 0) AS s FROM customer_credit_movements WHERE customer_id = ?`).get(customerId).s);
}
function retrato(db, locationId) {
  const o = { estoque: {}, fiado: {} };
  for (const p of db.prepare(`SELECT id, nome FROM products WHERE tipo = 'produto' ORDER BY id`).all()) o.estoque[p.nome] = saldoEstoque(db, p.id, locationId);
  for (const c of db.prepare('SELECT id, nome FROM customers ORDER BY id').all()) o.fiado[c.nome] = saldoFiado(db, c.id);
  o.vendas = db.prepare(`SELECT status, COUNT(*) AS n, ROUND(SUM(total - desconto - desconto_gerente), 2) AS t FROM sales GROUP BY status ORDER BY status`).all();
  o.pagamentos = db.prepare(`SELECT p.metodo, ROUND(SUM(p.valor), 2) AS t FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.status = 'finalizada' GROUP BY p.metodo ORDER BY p.metodo`).all();
  return o;
}
const aplicarTodos = (eventos) => eventos.map((e) => ({ tipo: e.tipo, ...terminal.aplicarEvento(INSTALL, e) }));
const atraso = fixture.eventos.filter((e) => e.criadoEmMs <= fixture.geradoBackup2EmMs);
const comoTerminal = fixture.eventos.filter((e) => e.criadoEmMs > fixture.geradoBackup2EmMs);

test('o atraso aplicado por eventos chega EXATAMENTE no mesmo lugar que importar o backup 2 (complemento)', () => {
  assert.equal(atraso.length, fixture.eventosDoAtraso);
  const a = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: a.adminId });
  const res = aplicarTodos(atraso);
  assert.deepEqual(res.filter((r) => !['aplicado', 'ignorado'].includes(r.status)), [], JSON.stringify(res));
  const viaEventos = retrato(a.db, a.locationId);

  const b = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: b.adminId });
  migracao.importarDump(backup(2), { operadorId: b.adminId });
  assert.deepEqual(viaEventos, retrato(b.db, b.locationId));
});

test('ida e volta: depois dos eventos, importar o backup 2 não duplica nada (mesmos ids nos dois caminhos)', () => {
  const { db, locationId, adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  const antes = retrato(db, locationId);
  const r = migracao.importarDump(backup(2), { operadorId: adminId });
  assert.equal(r.conferencia.tudoBateu, true);
  assert.equal(r.vendas.novas, 0);
  assert.deepEqual(retrato(db, locationId), antes);
});

test('vendas como terminal: entram com origem própria, cancelamento estorna, fiado e cliente novo chegam; reenvio não reaplica', () => {
  const { db, locationId, adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  const res = aplicarTodos(comoTerminal);
  assert.deepEqual(res.map((r) => r.status), comoTerminal.map(() => 'aplicado'));

  const dados = comoTerminal.map((e) => JSON.parse(e.dadosJson));
  const vendaTroco = dados.find((d) => d.venda?.troco_centavos > 0).venda;
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(vendaTroco.id);
  assert.equal(sale.status, 'cancelada');
  assert.match(sale.motivo_cancelamento, /Troco errado.*cancelada no celular/);
  const pag = db.prepare('SELECT * FROM payments WHERE sale_id = ?').get(vendaTroco.id);
  const det = JSON.parse(pag.detalhes);
  assert.deepEqual([det.origem, det.numeroPdvMobile, det.troco], ['pdv_mobile_terminal', vendaTroco.numero, 14.27]);
  // Estoque da coca: venda -4 e estorno +4 se anulam.
  const mov = db.prepare(`SELECT tipo, quantidade FROM stock_movements WHERE sale_id = ? ORDER BY tipo`).all(vendaTroco.id);
  assert.deepEqual(mov.map((m) => [m.tipo, m.quantidade]).filter((m) => m[1] === 4 || m[1] === -4), [['estorno', 4], ['venda', -4]]);

  const carla = db.prepare(`SELECT * FROM customers WHERE nome = 'Carla Souza'`).get();
  assert.equal(carla.cpf, '11144477735');
  assert.equal(saldoFiado(db, carla.id), 16.9);
  const joao = db.prepare(`SELECT id FROM customers WHERE nome = 'João Pedro'`).get();
  assert.equal(saldoFiado(db, joao.id), 0, 'João pagou o fiado no celular');

  // Reenvio (o recibo não chegou no celular): responde de novo, sem reaplicar.
  const antes = retrato(db, locationId);
  const de_novo = aplicarTodos(fixture.eventos);
  assert.ok(de_novo.every((r) => r.repetido && ['aplicado', 'ignorado'].includes(r.status)));
  assert.deepEqual(retrato(db, locationId), antes);
});

test('caixa do computador não conta venda que foi recebida no caixa do celular (migração ou terminal); PDV móvel pareado continua contando', () => {
  const { db, locationId, adminId } = freshTestDb();
  const sessao = randomUUID();
  db.prepare(`INSERT INTO cash_sessions (id, location_id, operador_abertura_id, valor_abertura, aberta_em) VALUES (?, ?, ?, 100, '2026-01-01 00:00:00')`).run(sessao, locationId, adminId);
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(fixture.eventos);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE json_extract(detalhes, '$.origem') = 'pdv_mobile_terminal'`).get().n > 0);
  let resumo = cashService.getSessionSummary(sessao);
  assert.deepEqual(resumo.porMetodo, []);
  assert.equal(resumo.valorEsperado, 100);

  // Venda feita aqui (ou no PDV móvel pareado, que vende pelo caixa daqui) conta normalmente.
  const prod = createProduct(db, { nome: 'Bala', preco: 2 });
  const venda = randomUUID();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total, finalizada_em) VALUES (?, ?, ?, 'finalizada', 2, '2026-10-17 12:00:00')`).run(venda, locationId, adminId);
  db.prepare('INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, 1, 2)').run(randomUUID(), venda, prod);
  db.prepare(`INSERT INTO payments (id, sale_id, metodo, valor, detalhes) VALUES (?, ?, 'dinheiro', 2, ?)`).run(randomUUID(), venda, JSON.stringify({ origem: 'pdv_movel' }));
  db.prepare(`INSERT INTO payments (id, sale_id, metodo, valor, detalhes) VALUES (?, ?, 'pix', 1, 'texto antigo não-JSON')`).run(randomUUID(), venda);
  resumo = cashService.getSessionSummary(sessao);
  assert.deepEqual(resumo.porMetodo.map((m) => [m.metodo, m.total]).sort(), [['dinheiro', 2], ['pix', 1]]);
  assert.equal(resumo.valorEsperado, 102);
});

test('cancelamento que chega antes da venda espera; entra sozinho quando a venda chega', () => {
  const { db, adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  const cancel = comoTerminal.find((e) => e.tipo === 'venda_cancelada');
  const vendaId = JSON.parse(cancel.dadosJson).vendaId;
  const venda = comoTerminal.find((e) => e.tipo === 'venda' && e.refId === vendaId);
  assert.equal(terminal.aplicarEvento(INSTALL, cancel).status, 'aguardando');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales WHERE id = ?').get(vendaId).n, 0);
  assert.equal(terminal.aplicarEvento(INSTALL, venda).status, 'aplicado');
  assert.equal(terminal.aplicarEvento(INSTALL, cancel).status, 'aplicado');
  assert.equal(db.prepare('SELECT status FROM sales WHERE id = ?').get(vendaId).status, 'cancelada');
  assert.equal(terminal.listarEventos({ soProblemas: true }).length, 0);
});

test('venda já cancelada no computador: cancelamento do celular não estorna de novo', () => {
  const { db, adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  const cancel = comoTerminal.find((e) => e.tipo === 'venda_cancelada');
  const vendaId = JSON.parse(cancel.dadosJson).vendaId;
  terminal.aplicarEvento(INSTALL, comoTerminal.find((e) => e.tipo === 'venda' && e.refId === vendaId));
  db.prepare(`UPDATE sales SET status = 'cancelada' WHERE id = ?`).run(vendaId);
  const movAntes = db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE sale_id = ?').get(vendaId).n;
  assert.equal(terminal.aplicarEvento(INSTALL, cancel).status, 'ignorado');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE sale_id = ?').get(vendaId).n, movAntes);
});

test('recusa: celular que não foi migrado pra cá, evento de versão mais nova, venda adulterada -- nada gravado', () => {
  const { db, adminId } = freshTestDb();
  const venda = fixture.eventos.find((e) => e.tipo === 'venda');
  const n = () => db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  const r1 = terminal.aplicarEvento(INSTALL, venda);
  assert.equal(r1.status, 'erro');
  assert.match(r1.erro, /não foi migrado/);
  assert.equal(n(), 0);

  migracao.importarDump(backup(1), { operadorId: adminId });
  const antes = n();
  assert.match(terminal.aplicarEvento(INSTALL, { ...venda, id: randomUUID(), versao: 99 }).erro, /atualize o computador/);
  const d = JSON.parse(venda.dadosJson);
  d.pagamentos[0].valor_centavos += 100;
  const r3 = terminal.aplicarEvento(INSTALL, { ...venda, id: randomUUID(), dadosJson: JSON.stringify(d) });
  assert.match(r3.erro, /inconsistente/);
  assert.equal(n(), antes);
  assert.equal(terminal.listarEventos({ soProblemas: true }).length, 3);

  // Depois do erro (corrigido), o mesmo evento pode ser aplicado.
  assert.equal(terminal.aplicarEvento(INSTALL, venda).status, 'aplicado');
});

test('produto do celular ligado a um daqui pelo código de barras: venda, cancelamento e catálogo usam o daqui', () => {
  const { db, locationId, adminId } = freshTestDb();
  const cocaAqui = createProduct(db, { nome: 'COCA LATA', preco: 6 });
  db.prepare('UPDATE products SET codigo_barras = ? WHERE id = ?').run('7894900011517', cocaAqui);
  addStock(db, { productId: cocaAqui, locationId, quantidade: 100, operadorId: adminId });
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  const antes = saldoEstoque(db, cocaAqui, locationId);
  // Como terminal, o celular já recebeu o catálogo: o código foi limpo do produto antigo dele.
  const eventos = comoTerminal.map((e) => {
    const d = JSON.parse(e.dadosJson);
    for (const p of d.produtos || []) if (p.codigo_barras === '7894900011517') p.codigo_barras = null;
    return { ...e, dadosJson: JSON.stringify(d) };
  });
  assert.ok(aplicarTodos(eventos).every((r) => r.status === 'aplicado'));
  assert.equal(saldoEstoque(db, cocaAqui, locationId), antes, 'venda -4 e cancelamento +4 no produto daqui');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM products WHERE codigo_barras IS NULL AND nome LIKE 'Coca%'`).get().n, 0, 'não criou produto duplicado');

  const cat = terminal.montarCatalogo(INSTALL);
  const coca = cat.produtos.find((p) => p.id === cocaAqui);
  assert.equal(coca.preco_centavos, 600);
  assert.equal(coca.estoque_mil, Math.round(antes * 1000));
  assert.equal(coca.apelidos.length, 1);
  assert.ok(cat.eventosAplicados.length >= eventos.length);
  const maria = cat.clientes.find((c) => c.nome === 'Maria das Graças');
  assert.equal(maria.documento, '52998224725');
  assert.equal(maria.saldo_fiado_centavos, Math.round(saldoFiado(db, maria.id) * 100));
});

test('catálogo: preço promocional vigente, serviço sem estoque, partes de até 1000 produtos, versão estável', () => {
  const { db } = freshTestDb();
  const p = createProduct(db, { nome: 'Arroz', preco: 30 });
  db.prepare(`UPDATE products SET preco_promocional = 25.5, promocao_valida_ate = '2999-12-31' WHERE id = ?`).run(p);
  const s = createProduct(db, { nome: 'Frete', preco: 10, tipo: 'servico' });
  const cat = terminal.montarCatalogo(INSTALL);
  assert.equal(cat.produtos.find((x) => x.id === p).preco_centavos, 2550);
  assert.deepEqual([cat.produtos.find((x) => x.id === s).controla_estoque, cat.produtos.find((x) => x.id === s).estoque_mil], [0, 0]);
  assert.equal(terminal.versaoDoCatalogo(cat), terminal.versaoDoCatalogo(terminal.montarCatalogo(INSTALL)));
  const { partesProdutos } = terminal.partirCatalogo({ produtos: Array.from({ length: 2001 }, (_, i) => ({ id: i })), clientes: [] });
  assert.equal(partesProdutos, 3);
});

test('NFC-e: desligada por padrão; fora da janela não emite e avisa', async () => {
  const { adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  assert.deepEqual(terminal.getConfig(), { emitirNfce: false, janelaNfceMin: 10 });
  const venda = comoTerminal.find((e) => e.tipo === 'venda');
  const semNota = await terminal.processarEvento(INSTALL, venda, { agoraMs: venda.criadoEmMs + 60000 });
  assert.equal(semNota.nfce, undefined);

  assert.equal(terminal.salvarConfig({ emitirNfce: true, janelaNfceMin: 0 }).ok, false);
  assert.equal(terminal.salvarConfig({ emitirNfce: true, janelaNfceMin: 15 }).ok, true);
  const outra = comoTerminal.filter((e) => e.tipo === 'venda')[1];
  const atrasada = await terminal.processarEvento(INSTALL, outra, { agoraMs: outra.criadoEmMs + 60 * 60000 });
  assert.equal(atrasada.status, 'aplicado');
  assert.equal(atrasada.nfce.status, 'nao_emitida');
  assert.match(atrasada.nfce.mensagem, /60 min/);
});

test('recebimento de fiado maior que a dívida não entra sozinho (evento forjado); com revisão humana entra', () => {
  const { adminId } = freshTestDb();
  migracao.importarDump(backup(1), { operadorId: adminId });
  aplicarTodos(atraso);
  const ev = comoTerminal.find((e) => e.tipo === 'fiado_pagamento');
  assert.ok(ev, 'fixture tem um recebimento de fiado');
  const dados = JSON.parse(ev.dadosJson);
  const forjado = { ...ev, id: `forjado-${ev.id}`, dadosJson: JSON.stringify({ ...dados, lancamento: { ...dados.lancamento, id: `forjado-${dados.lancamento.id}`, valor_centavos: 99999999 } }) };
  const r = terminal.aplicarEvento(INSTALL, forjado);
  assert.equal(r.status, 'erro');
  assert.match(r.erro, /maior que a dívida/);
  const revisado = terminal.aplicarEvento(INSTALL, forjado, { forcarRevisado: true });
  assert.equal(revisado.status, 'aplicado');
});
