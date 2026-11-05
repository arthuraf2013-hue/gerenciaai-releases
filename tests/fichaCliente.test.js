const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createProduct, createFinalizedSale } = require('./helpers/testDb');
const ficha = require('../electron/services/fichaClienteService');
const profileService = require('../electron/services/profileService');

function cliente(db, nome = 'Ana Souza') {
  const id = randomUUID();
  db.prepare(`INSERT INTO customers (id, nome, telefone, cpf, criado_em) VALUES (?, ?, '81999990000', '52998224725', '2026-01-10 12:00:00')`)
    .run(id, nome);
  return id;
}

function venda(ctx, customerId, finalizadaEm, itens, pagamentos) {
  const id = createFinalizedSale(ctx.db, {
    locationId: ctx.locationId, operadorId: ctx.operadorId, finalizadaEm, itens,
    pagamentos: pagamentos || [['pix', itens.reduce((s, i) => s + i.quantidade * i.preco, 0)]],
  });
  ctx.db.prepare('UPDATE sales SET customer_id = ? WHERE id = ?').run(customerId, id);
  return id;
}

function produtoOtica(db, nome, campos, preco = 100) {
  const id = createProduct(db, { nome, preco, categoria: 'Lentes' });
  db.prepare('UPDATE products SET custom_fields = ? WHERE id = ?').run(JSON.stringify(campos), id);
  return id;
}

test('ótica: cada compra traz os itens com as especificações do produto NA HORA da venda', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('otica');
  const ana = cliente(ctx.db);
  const lente = produtoOtica(ctx.db, 'Lente multifocal', { grau: '-2,50 / -1,75', tipo_lente: 'Multifocal antirreflexo' }, 480);
  const armacao = produtoOtica(ctx.db, 'Armação Ray', { cor: 'Preta' }, 320);
  venda(ctx, ana, '2026-10-20 15:00:00', [{ productId: lente, quantidade: 2, preco: 480 }, { productId: armacao, quantidade: 1, preco: 320 }]);
  // O cadastro muda DEPOIS da venda: a ficha continua com o que foi vendido.
  ctx.db.prepare('UPDATE products SET custom_fields = ? WHERE id = ?').run(JSON.stringify({ grau: '-3,00', tipo_lente: 'Simples' }), lente);

  const r = ficha.getFicha({ customerId: ana });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.perfil.id, 'otica');
  assert.equal(r.resumo.compras, 1);
  assert.equal(r.resumo.totalGasto, 1280);
  const [itemLente, itemArmacao] = r.vendas[0].itens;
  assert.deepEqual(itemLente.especificacoes.map((e) => [e.label, e.valor]), [
    ['Grau da lente', '-2,50 / -1,75'], ['Tipo de lente', 'Multifocal antirreflexo'],
  ]);
  assert.equal(itemLente.especificacoesDoCadastroAtual, false);
  // "cor" é campo do perfil Loja de Roupas: usa o rótulo de lá.
  assert.deepEqual(itemArmacao.especificacoes.map((e) => [e.label, e.valor]), [['Cor', 'Preta']]);
  assert.equal(r.vendas[0].pagamentos[0].rotulo, 'Pix');
});

test('ótica: receitas do cliente vêm na ficha, mais nova primeiro', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('otica');
  const ana = cliente(ctx.db);
  const eyewear = require('../electron/services/eyewearService');
  eyewear.upsert({ customerId: ana, dataReceita: '2025-03-01', odEsferico: -2, oeEsferico: -1.75, tipoLente: 'Simples' });
  eyewear.upsert({ customerId: ana, dataReceita: '2026-09-15', odEsferico: -2.5, odCilindrico: -0.5, odEixo: 90, oeEsferico: -1.75, distanciaPupilar: 62, tipoLente: 'Multifocal' });
  const r = ficha.getFicha({ customerId: ana });
  assert.deepEqual(r.receitas.map((x) => x.dataReceita), ['2026-09-15', '2025-03-01']);
  assert.deepEqual(r.receitas[0].od, { esferico: -2.5, cilindrico: -0.5, eixo: 90, adicao: null });
  assert.equal(r.receitas[0].distanciaPupilar, 62);
});

test('qualquer perfil: período igual ao Histórico (dia local), só finalizadas e não excluídas, primeira/última compra do histórico todo', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('generico');
  const ana = cliente(ctx.db);
  const outro = cliente(ctx.db, 'Beto');
  const cafe = createProduct(ctx.db, { nome: 'Café', preco: 5 });
  const bolo = createProduct(ctx.db, { nome: 'Bolo', preco: 12 });
  // 02:30 UTC do dia 1 = 23:30 do dia 31 em Recife/SP: fica no dia 31.
  venda(ctx, ana, '2026-11-01 02:30:00', [{ productId: cafe, quantidade: 1, preco: 5 }]);
  venda(ctx, ana, '2026-11-01 15:00:00', [{ productId: cafe, quantidade: 2, preco: 5 }, { productId: bolo, quantidade: 1, preco: 12 }]);
  venda(ctx, ana, '2026-11-03 15:00:00', [{ productId: cafe, quantidade: 3, preco: 5 }]);
  const oculta = venda(ctx, ana, '2026-11-02 15:00:00', [{ productId: bolo, quantidade: 9, preco: 12 }]);
  ctx.db.prepare('UPDATE sales SET oculta_historico = 1 WHERE id = ?').run(oculta);
  const cancelada = venda(ctx, ana, '2026-11-02 16:00:00', [{ productId: bolo, quantidade: 9, preco: 12 }]);
  ctx.db.prepare(`UPDATE sales SET status = 'cancelada' WHERE id = ?`).run(cancelada);
  venda(ctx, outro, '2026-11-01 15:00:00', [{ productId: bolo, quantidade: 1, preco: 12 }]);

  const dia1 = ficha.getFicha({ customerId: ana, dataInicio: '2026-11-01', dataFim: '2026-11-01' });
  assert.equal(dia1.resumo.compras, 1);
  assert.equal(dia1.resumo.totalGasto, 22);
  assert.deepEqual(dia1.periodo, { dataInicio: '2026-11-01', dataFim: '2026-11-01' });

  const tudo = ficha.getFicha({ customerId: ana });
  assert.equal(tudo.periodo, null);
  assert.equal(tudo.resumo.compras, 3);
  assert.equal(tudo.resumo.totalGasto, 42);
  assert.equal(tudo.resumo.ticketMedio, 14);
  assert.deepEqual(tudo.vendas.map((v) => v.finalizadaEm), ['2026-11-03 15:00:00', '2026-11-01 15:00:00', '2026-11-01 02:30:00'], 'mais recente primeiro');
  assert.deepEqual(tudo.resumo.maisComprados.map((p) => [p.nome, p.quantidade]), [['Café', 6], ['Bolo', 1]]);
  assert.equal(dia1.cliente.primeiraCompra, '2026-11-01 02:30:00', 'primeira compra do histórico todo, mesmo filtrando');
  assert.equal(dia1.cliente.ultimaCompra, '2026-11-03 15:00:00');
  assert.equal(dia1.cliente.comprasNoTotal, 3);
  assert.ok(tudo.vendas.every((v) => v.itens.every((i) => i.especificacoes.length === 0)), 'produto sem especificação não inventa nada');
});

test('item de antes da migração usa o cadastro atual e avisa; sim/não desmarcado e vazio não aparecem', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('farmacia');
  const ana = cliente(ctx.db);
  const remedio = produtoOtica(ctx.db, 'Dipirona', { lote: 'L123', validade: '2027-05-01', controlado: false, exige_receita: true, principio_ativo: '' }, 8);
  const saleId = venda(ctx, ana, '2026-10-01 15:00:00', [{ productId: remedio, quantidade: 1, preco: 8 }]);
  ctx.db.prepare('UPDATE sale_items SET especificacoes_json = NULL WHERE sale_id = ?').run(saleId);
  const r = ficha.getFicha({ customerId: ana });
  const item = r.vendas[0].itens[0];
  assert.equal(item.especificacoesDoCadastroAtual, true);
  assert.deepEqual(item.especificacoes.map((e) => [e.label, e.tipo, e.valor]), [
    ['Lote', 'texto', 'L123'], ['Validade', 'data', '2027-05-01'], ['Exige receita médica', 'boolean', true],
  ]);
});

test('devolução: aparece na compra e sai do total líquido; mesa e pessoa da comanda vêm junto', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('restaurante');
  const ana = cliente(ctx.db);
  const prato = createProduct(ctx.db, { nome: 'Prato', preco: 40 });
  const saleId = venda(ctx, ana, '2026-10-05 20:00:00', [{ productId: prato, quantidade: 2, preco: 40 }]);
  ctx.db.prepare('UPDATE sale_items SET pessoa_numero = 1 WHERE sale_id = ?').run(saleId);
  ctx.db.prepare(`INSERT INTO sale_people (id, sale_id, numero, nome) VALUES (?, ?, 1, 'Ana')`).run(randomUUID(), saleId);
  ctx.db.prepare(`INSERT INTO sale_mesas (id, sale_id, table_id, numero, nome, principal) VALUES (?, ?, 't1', '4', NULL, 1)`).run(randomUUID(), saleId);
  const ret = randomUUID();
  ctx.db.prepare(`INSERT INTO returns (id, sale_id, location_id, operador_id, autorizado_por_id, valor_devolvido) VALUES (?, ?, ?, ?, ?, 40)`)
    .run(ret, saleId, ctx.locationId, ctx.operadorId, ctx.gerenteId);
  ctx.db.prepare('INSERT INTO return_items (id, return_id, product_id, quantidade, valor_unitario) VALUES (?, ?, ?, 1, 40)').run(randomUUID(), ret, prato);

  const r = ficha.getFicha({ customerId: ana });
  const v = r.vendas[0];
  assert.equal(v.mesa, 'Mesa 4');
  assert.equal(v.valorDevolvido, 40);
  assert.equal(v.itens[0].quantidadeDevolvida, 1);
  assert.equal(v.itens[0].pessoa, 'Ana');
  assert.equal(r.resumo.totalGasto, 80);
  assert.equal(r.resumo.totalDevolvido, 40);
  assert.equal(r.resumo.liquido, 40);
  assert.deepEqual(r.resumo.maisComprados.map((p) => [p.nome, p.quantidade]), [['Prato', 1]]);
});

test('erros: cliente que não existe e período invertido', () => {
  const ctx = freshTestDb();
  assert.match(ficha.getFicha({ customerId: 'nao-existe' }).error, /não encontrado/);
  const ana = cliente(ctx.db);
  assert.match(ficha.getFicha({ customerId: ana, dataInicio: '2026-11-05', dataFim: '2026-11-01' }).error, /depois da final/);
});

test('gatilho da migração 6 guarda as especificações em todo item novo (também pelo PDV)', () => {
  const ctx = freshTestDb();
  const p = produtoOtica(ctx.db, 'Camiseta', { tamanho: 'M', cor: 'Azul' }, 50);
  const semCampos = createProduct(ctx.db, { nome: 'Sacola', preco: 1 });
  const saleService = require('../electron/services/saleService');
  const { id: saleId } = saleService.openSale({ locationId: ctx.locationId, operadorId: ctx.operadorId });
  ctx.db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id) VALUES (?, ?, ?, 'entrada', 10, ?, 'd')`)
    .run(randomUUID(), p, ctx.locationId, ctx.operadorId);
  ctx.db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, operador_id, device_id) VALUES (?, ?, ?, 'entrada', 10, ?, 'd')`)
    .run(randomUUID(), semCampos, ctx.locationId, ctx.operadorId);
  assert.equal(saleService.addItem({ saleId, productId: p, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' }).ok, true);
  assert.equal(saleService.addItem({ saleId, productId: semCampos, locationId: ctx.locationId, quantidade: 1, operadorId: ctx.operadorId, deviceId: 'd' }).ok, true);
  const linhas = ctx.db.prepare('SELECT p.nome, si.especificacoes_json FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? ORDER BY p.nome').all(saleId);
  assert.deepEqual(linhas.map((l) => [l.nome, JSON.parse(l.especificacoes_json)]), [['Camiseta', { tamanho: 'M', cor: 'Azul' }], ['Sacola', {}]]);
});

// ---------------- peculiaridades de cada perfil ----------------

function comRelogio(isoUtc, fn) {
  const original = Date.now;
  Date.now = () => Date.parse(isoUtc);
  try { return fn(); } finally { Date.now = original; }
}

test('petshop: animais com vacina e vermífugo (atrasada, perto, em dia) e espécie que o cliente costuma levar', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('petshop');
  const ana = cliente(ctx.db);
  const ins = ctx.db.prepare(`INSERT INTO pets (id, customer_id, nome, especie, raca, ultima_vacina_em, proxima_vacina_em, proximo_vermifugo_em, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(randomUUID(), ana, 'Thor', 'Cão', 'Labrador', '2025-11-01', '2026-11-01', '2026-11-09', 1);
  ins.run(randomUUID(), ana, 'Mimi', 'Gato', null, null, '2027-03-01', null, 1);
  ins.run(randomUUID(), ana, 'Antigo', 'Cão', null, null, null, null, 0);
  const racao = produtoOtica(ctx.db, 'Ração 15 kg', { especie_animal: 'Cão', peso_volume: '15 kg' }, 180);
  const petisco = produtoOtica(ctx.db, 'Petisco', { especie_animal: 'cão' }, 12);
  const areia = produtoOtica(ctx.db, 'Areia', { especie_animal: 'Gato' }, 30);
  venda(ctx, ana, '2026-10-01 15:00:00', [{ productId: racao, quantidade: 1, preco: 180 }, { productId: areia, quantidade: 1, preco: 30 }]);
  venda(ctx, ana, '2026-10-20 15:00:00', [{ productId: petisco, quantidade: 3, preco: 12 }]);

  const r = comRelogio('2026-11-05T13:00:00Z', () => ficha.getFicha({ customerId: ana }));
  assert.deepEqual(r.pets.map((p) => [p.nome, p.situacaoVacina, p.situacaoVermifugo]), [
    ['Mimi', 'em_dia', null], ['Thor', 'atrasada', 'proxima'],
  ], 'desativado não aparece; vermífugo em 4 dias = perto (mesma antecedência dos lembretes)');
  const especie = r.preferencias.find((p) => p.campo === 'especie_animal');
  assert.equal(especie.label, 'Espécie (cão, gato, ave...)');
  assert.deepEqual(especie.valores.map((v) => [v.valor.toLowerCase(), v.vezes]), [['cão', 2], ['gato', 1]], '"Cão" e "cão" contam juntos');
});

test('loja de roupas: tamanhos e cores que o cliente costuma levar, só do período', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('vestuario');
  const ana = cliente(ctx.db);
  const blusaM = produtoOtica(ctx.db, 'Blusa M azul', { tamanho: 'M', cor: 'Azul' }, 60);
  const calca = produtoOtica(ctx.db, 'Calça 40', { tamanho: '40', cor: 'Preta' }, 120);
  const blusaG = produtoOtica(ctx.db, 'Blusa G', { tamanho: 'G', cor: 'Azul' }, 60);
  venda(ctx, ana, '2026-09-10 15:00:00', [{ productId: blusaG, quantidade: 1, preco: 60 }]);
  venda(ctx, ana, '2026-10-10 15:00:00', [{ productId: blusaM, quantidade: 2, preco: 60 }, { productId: calca, quantidade: 1, preco: 120 }]);
  venda(ctx, ana, '2026-10-20 15:00:00', [{ productId: blusaM, quantidade: 1, preco: 60 }]);
  const r = ficha.getFicha({ customerId: ana, dataInicio: '2026-10-01', dataFim: '2026-10-31' });
  const tam = r.preferencias.find((p) => p.campo === 'tamanho');
  assert.deepEqual(tam.valores.map((v) => [v.valor, v.vezes]), [['M', 2], ['40', 1]], 'conta por compra do item; setembro (G) fora do período');
  assert.deepEqual(r.preferencias.find((p) => p.campo === 'cor').valores.map((v) => [v.valor, v.vezes]), [['Azul', 2], ['Preta', 1]]);
});

test('material de construção: garantia conta do dia da compra (fim de mês sem pular) e diz se ainda vale; orçamentos do cliente', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('material_construcao');
  const ana = cliente(ctx.db);
  const furadeira = produtoOtica(ctx.db, 'Furadeira', { garantia_meses: 12 }, 300);
  const torneira = produtoOtica(ctx.db, 'Torneira', { garantia_meses: 1 }, 80);
  const cimento = createProduct(ctx.db, { nome: 'Cimento', preco: 40 });
  // 31/01/2026 local (UTC 01/02 01:00).
  venda(ctx, ana, '2026-02-01 01:00:00', [{ productId: furadeira, quantidade: 1, preco: 300 }, { productId: torneira, quantidade: 1, preco: 80 }, { productId: cimento, quantidade: 5, preco: 40 }]);
  const q1 = randomUUID();
  ctx.db.prepare(`INSERT INTO quotes (id, location_id, customer_id, status, validade_ate, criado_em) VALUES (?, ?, ?, 'aberto', '2026-10-30', '2026-10-20 15:00:00')`).run(q1, ctx.locationId, ana);
  ctx.db.prepare('INSERT INTO quote_items (id, quote_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, 10, 40), (?, ?, ?, 1, 300)')
    .run(randomUUID(), q1, cimento, randomUUID(), q1, furadeira);
  ctx.db.prepare(`INSERT INTO quotes (id, location_id, customer_id, status, criado_em) VALUES (?, ?, ?, 'convertido', '2026-01-20 15:00:00')`).run(randomUUID(), ctx.locationId, ana);

  const r = comRelogio('2026-11-05T13:00:00Z', () => ficha.getFicha({ customerId: ana }));
  const [fur, tor, cim] = r.vendas[0].itens;
  assert.equal(fur.garantiaAte, '2027-01-31');
  assert.equal(fur.garantiaVigente, true);
  assert.equal(tor.garantiaAte, '2026-02-28', '31/01 + 1 mês = 28/02');
  assert.equal(tor.garantiaVigente, false);
  assert.equal(cim.garantiaAte, null);
  assert.deepEqual(r.orcamentos.map((o) => [o.status, o.total, o.itens, o.vencido]), [['aberto', 700, 2, true], ['convertido', 0, 0, false]]);
  const out = ficha.getFicha({ customerId: ana, dataInicio: '2026-10-01', dataFim: '2026-10-31' });
  assert.equal(out.orcamentos.length, 1, 'orçamento entra no filtro de período');
  assert.equal(ficha.somarMeses('2024-01-31', 1), '2024-02-29', 'ano bissexto');
  assert.equal(ficha.somarMeses('2026-12-15', 2), '2027-02-15');
});

test('salão: próximos horários sempre; histórico, faltas e cancelamentos no período; serviço marcado no item', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('salao_beleza');
  const ana = cliente(ctx.db);
  const prof = randomUUID();
  ctx.db.prepare(`INSERT INTO appointment_professionals (id, nome) VALUES (?, 'Carla')`).run(prof);
  const ag = ctx.db.prepare(`INSERT INTO appointments (id, location_id, professional_id, customer_id, servico, data_hora_inicio, duracao_minutos, status) VALUES (?, ?, ?, ?, ?, ?, 60, ?)`);
  ag.run(randomUUID(), ctx.locationId, prof, ana, 'Corte', '2026-11-12 14:00:00', 'agendado');
  ag.run(randomUUID(), ctx.locationId, prof, ana, 'Escova', '2026-11-05 11:00:00', 'confirmado'); // hoje, daqui a 1 h
  ag.run(randomUUID(), ctx.locationId, prof, ana, 'Coloração', '2026-10-15 10:00:00', 'concluido');
  ag.run(randomUUID(), ctx.locationId, prof, ana, 'Corte', '2026-10-01 10:00:00', 'faltou');
  ag.run(randomUUID(), ctx.locationId, prof, ana, 'Corte', '2026-09-01 10:00:00', 'cancelado');
  ag.run(randomUUID(), ctx.locationId, prof, ana, 'Corte', '2026-12-01 10:00:00', 'cancelado');
  const corte = createProduct(ctx.db, { nome: 'Corte feminino', preco: 70, tipo: 'servico' });
  venda(ctx, ana, '2026-10-15 14:00:00', [{ productId: corte, quantidade: 1, preco: 70 }]);

  const r = comRelogio('2026-11-05T13:00:00Z', () => ficha.getFicha({ customerId: ana, dataInicio: '2026-10-01', dataFim: '2026-10-31' }));
  assert.deepEqual(r.agenda.proximos.map((a) => [a.servico, a.inicio, a.profissional]), [
    ['Escova', '2026-11-05 11:00:00', 'Carla'], ['Corte', '2026-11-12 14:00:00', 'Carla'],
  ], 'próximo = fora do filtro de período; cancelado não entra');
  assert.deepEqual(r.agenda.historico.map((a) => a.status), ['concluido', 'faltou']);
  assert.equal(r.agenda.faltas, 1);
  assert.equal(r.agenda.concluidos, 1);
  assert.equal(r.vendas[0].itens[0].servico, true);
});

test('fiado, entregas e reservas (pelo telefone) entram na ficha; anexos contados por compra', () => {
  const ctx = freshTestDb();
  profileService.setActiveProfile('restaurante');
  const ana = cliente(ctx.db); // telefone 81999990000
  const mov = ctx.db.prepare('INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, motivo, criado_em) VALUES (?, ?, ?, ?, ?, ?)');
  mov.run(randomUUID(), ana, 'divida', 50, null, '2026-10-02 15:00:00');
  mov.run(randomUUID(), ana, 'pagamento', 20, null, '2026-10-10 15:00:00');
  const ent = ctx.db.prepare(`INSERT INTO deliveries (id, location_id, customer_id, endereco, status, taxa_entrega, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ent.run(randomUUID(), ctx.locationId, ana, 'Rua A, 10', 'entregue', 5, '2026-10-03 15:00:00');
  ent.run(randomUUID(), ctx.locationId, ana, 'rua a, 10 ', 'entregue', 5, '2026-10-04 15:00:00');
  ent.run(randomUUID(), ctx.locationId, ana, 'Av. B, 200', 'pendente', 7, '2026-10-05 15:00:00');
  const res = ctx.db.prepare(`INSERT INTO reservations (id, location_id, cliente_nome, cliente_telefone, pessoas, data_hora, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  res.run(randomUUID(), ctx.locationId, 'Ana', '+55 (81) 99999-0000', 4, '2026-10-20 20:00:00', 'concluida');
  res.run(randomUUID(), ctx.locationId, 'Outra', '(81) 98888-0000', 2, '2026-10-21 20:00:00', 'confirmada');
  const prato = createProduct(ctx.db, { nome: 'Prato', preco: 40 });
  const saleId = venda(ctx, ana, '2026-10-20 23:00:00', [{ productId: prato, quantidade: 1, preco: 40 }]);
  ctx.db.prepare(`INSERT INTO sale_attachments (id, sale_id, nome_arquivo, caminho, tipo) VALUES (?, ?, 'nota.pdf', '/x/nota.pdf', 'pdf')`).run(randomUUID(), saleId);

  const r = ficha.getFicha({ customerId: ana, dataInicio: '2026-10-01', dataFim: '2026-10-31' });
  assert.deepEqual(r.fiado.map((m) => [m.tipo, m.valor]), [['pagamento', 20], ['divida', 50]]);
  assert.equal(r.entregas.lista.length, 3);
  assert.deepEqual(r.entregas.enderecos, ['Av. B, 200', 'rua a, 10'], 'mais recente primeiro; o mesmo endereço escrito diferente conta uma vez (fica a escrita mais recente)');
  assert.deepEqual(r.reservas.map((x) => [x.pessoas, x.status]), [[4, 'concluida']], 'só a reserva com o telefone dela (com DDI e máscara)');
  assert.equal(r.vendas[0].anexos, 1);
  const nov = ficha.getFicha({ customerId: ana, dataInicio: '2026-11-01', dataFim: '2026-11-30' });
  assert.equal(nov.fiado.length + nov.entregas.lista.length + nov.reservas.length, 0, 'tudo isso respeita o período');
});
