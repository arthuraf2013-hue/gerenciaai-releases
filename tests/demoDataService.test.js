const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const demo = require('../electron/services/demoDataService');
const { CATALOGOS_DEMONSTRACAO } = require('../electron/services/demoDataCatalogos');

// 02/11/2026 12:00 em Brasília -- fixo, para as datas serem reproduzíveis.
const AGORA = Date.UTC(2026, 10, 2, 15, 0, 0);

function ambiente() {
  const ctx = freshTestDb();
  const suporteId = createSuporteUser(ctx.db);
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gerenciaai-demo-'));
  const dbPath = path.join(raiz, 'gerenciaai.sqlite3');
  const pasta = path.join(raiz, 'demonstracao');
  demo.configurarParaTeste({ dbPath, pasta });
  return { ...ctx, suporteId, raiz, dbPath, pasta };
}

function lerEstadoJson(pasta) {
  const arquivo = path.join(pasta, 'estado.json');
  return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : null;
}

for (const perfil of Object.keys(CATALOGOS_DEMONSTRACAO)) {
  test(`semear (${perfil}): loja coerente, sem estoque negativo e com pagamento fechando o total`, () => {
    const { db, suporteId } = ambiente();
    const resumo = demo.semear(db, { perfil, solicitanteId: suporteId, agoraMs: AGORA });

    assert.equal(db.prepare(`SELECT perfil_ativo FROM business_profile WHERE id = 'default'`).get().perfil_ativo, perfil);
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM products WHERE sku LIKE 'APRES-%'`).get().c, CATALOGOS_DEMONSTRACAO[perfil].itens.length);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM customers').get().c, 40);
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM sales WHERE status = 'finalizada'`).get().c, resumo.vendas);
    assert.ok(resumo.vendas > 400, '400 sorteadas + as compras da vitrine da ficha e do fiado');

    const negativos = db.prepare(
      `SELECT product_id, SUM(quantidade) s FROM stock_movements GROUP BY product_id HAVING s < -0.0001`
    ).all();
    assert.deepEqual(negativos, [], 'nenhum produto pode terminar com estoque negativo');

    const servicoComEstoque = db.prepare(
      `SELECT COUNT(*) c FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE p.tipo = 'servico'`
    ).get().c;
    assert.equal(servicoComEstoque, 0, 'serviço nunca movimenta estoque');

    const divergentes = db.prepare(
      `SELECT s.id FROM sales s
       WHERE (s.status = 'finalizada' AND ABS(s.total - (SELECT COALESCE(SUM(valor), 0) FROM payments p WHERE p.sale_id = s.id)) > 0.005)
          OR ABS(s.total - (SELECT SUM(quantidade * preco_unitario) FROM sale_items i WHERE i.sale_id = s.id)) > 0.005`
    ).all();
    assert.deepEqual(divergentes, [], 'total da venda = itens = pagamentos');

    const agoraUtc = new Date(AGORA).toISOString().slice(0, 19).replace('T', ' ');
    const limites = db.prepare('SELECT MIN(finalizada_em) minimo, MAX(finalizada_em) maximo FROM sales').get();
    assert.ok(limites.maximo <= agoraUtc, 'nenhuma venda no futuro');
    const inicio = new Date(AGORA - 125 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    assert.ok(limites.minimo >= inicio, 'histórico dentro dos últimos ~120 dias');

    // Comanda aberta (restaurante) não tem pagamento; venda finalizada tem.
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM sales s WHERE s.status = 'aberta' AND EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)`).get().c, 0);
    // Especificações guardadas no item (gatilho da migração 6) e fiado batendo com os pagamentos "fiado".
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_items WHERE especificacoes_json IS NULL').get().c, 0);
    const fiadoPago = db.prepare(`SELECT ROUND(COALESCE(SUM(valor), 0), 2) v FROM payments WHERE metodo = 'fiado'`).get().v;
    const dividas = db.prepare(`SELECT ROUND(COALESCE(SUM(valor), 0), 2) v FROM customer_credit_movements WHERE tipo = 'divida'`).get().v;
    assert.equal(dividas, fiadoPago, 'cada venda no fiado vira dívida do cliente');
    assert.ok(dividas > 0, 'tem fiado para mostrar');

    // Custo gravado pelo gatilho do ERP em todo item.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sale_items WHERE custo_unitario IS NULL').get().c, 0);

    const telefonesReais = db.prepare(`SELECT COUNT(*) c FROM customers WHERE telefone NOT LIKE '(00)%'`).get().c;
    assert.equal(telefonesReais, 0, 'telefones com DDD 00, nunca um número real');

    const auditoria = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE tipo_evento = 'demonstracao_carregada'`).get().c;
    assert.equal(auditoria, 1);
  });
}

test('semear: os 8 últimos clientes ficam sumidos e os demais compraram nos últimos 20 dias', () => {
  const { db, suporteId } = ambiente();
  demo.semear(db, { perfil: 'armazem', solicitanteId: suporteId, agoraMs: AGORA });
  const ultimas = db.prepare(
    `SELECT c.telefone, MAX(s.finalizada_em) ultima FROM customers c JOIN sales s ON s.customer_id = c.id
     GROUP BY c.id ORDER BY c.telefone`
  ).all();
  assert.equal(ultimas.length, 40);
  const limiteAtivo = new Date(AGORA - 21 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const limiteSumido = new Date(AGORA - 80 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  ultimas.slice(0, 32).forEach((c) => assert.ok(c.ultima >= limiteAtivo, `${c.telefone} deveria estar ativo`));
  ultimas.slice(32).forEach((c) => assert.ok(c.ultima < limiteSumido, `${c.telefone} deveria estar sumido`));
});

test('semear: perfis com validade obrigatória recebem validade (e lote na farmácia)', () => {
  const { db, suporteId } = ambiente();
  demo.semear(db, { perfil: 'farmacia', solicitanteId: suporteId, agoraMs: AGORA });
  const produtos = db.prepare(`SELECT custom_fields FROM products WHERE sku LIKE 'APRES-%'`).all().map((p) => JSON.parse(p.custom_fields));
  produtos.forEach((c) => {
    assert.match(c.validade, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(c.lote);
  });
  assert.ok(produtos.some((c) => c.controlado === true), 'a farmácia precisa de controlado para o livro de controlados');
});

test('semear: extras de cada perfil', () => {
  const casos = [
    ['petshop', 'SELECT COUNT(*) c FROM pets', 12],
    ['material_construcao', `SELECT COUNT(*) c FROM quotes WHERE status = 'aberto'`, 4],
    ['otica', 'SELECT COUNT(*) c FROM eyewear_prescriptions', 12],
    ['restaurante', 'SELECT COUNT(*) c FROM restaurant_tables', 8],
  ];
  for (const [perfil, sql, esperado] of casos) {
    const { db, suporteId } = ambiente();
    demo.semear(db, { perfil, solicitanteId: suporteId, agoraMs: AGORA });
    assert.equal(db.prepare(sql).get().c, esperado, perfil);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM deliveries').get().c, 8, `${perfil}: entregas`);
  }
  const { db, suporteId } = ambiente();
  const resumo = demo.semear(db, { perfil: 'salao_beleza', solicitanteId: suporteId, agoraMs: AGORA });
  assert.ok(resumo.extras.agendamentos > 0);
  const sobrepostos = db.prepare(
    `SELECT professional_id, data_hora_inicio, COUNT(*) c FROM appointments GROUP BY 1, 2 HAVING c > 1`
  ).all();
  assert.deepEqual(sobrepostos, [], 'um profissional não tem dois horários iguais');
});

test('semear: o 1º cliente é a vitrine da ficha em cada perfil, e o 2º deve no fiado', () => {
  const ficha = require('../electron/services/fichaClienteService');
  const casos = {
    otica: (f) => {
      assert.ok(f.receitas.length >= 2, 'duas receitas');
      const lente = f.vendas.flatMap((v) => v.itens).find((i) => /multifocal/i.test(i.nome));
      assert.deepEqual(lente.especificacoes.map((e) => e.label), ['Tipo de lente', 'Grau da lente']);
    },
    petshop: (f) => {
      assert.equal(f.pets[0].nome, 'Thor');
      assert.ok(f.preferencias.find((p) => p.campo === 'especie_animal').valores[0].valor === 'Cão');
    },
    farmacia: (f) => assert.ok(f.vendas.flatMap((v) => v.itens).some((i) => i.especificacoes.some((e) => e.campo === 'controlado' && e.valor === true))),
    material_construcao: (f) => {
      assert.ok(f.vendas.flatMap((v) => v.itens).some((i) => i.garantiaAte && i.garantiaVigente));
      assert.ok(f.orcamentos.length >= 1);
    },
    vestuario: (f) => assert.equal(f.preferencias.find((p) => p.campo === 'tamanho').valores[0].valor, 'M', 'costuma levar M'),
    salao_beleza: (f) => {
      assert.ok(f.agenda.proximos.length >= 1, 'tem próximo horário');
      assert.ok(f.agenda.faltas >= 1);
      assert.ok(f.vendas.some((v) => v.itens.some((i) => i.servico)));
    },
    restaurante: (f) => {
      const comoPessoa = f.vendas.find((v) => v.comoPessoa);
      assert.ok(comoPessoa, 'jantou na mesa de outro cliente');
      assert.equal(comoPessoa.comoPessoa.nome, 'Bia');
      assert.ok(f.reservas.length >= 2, 'reservas pelo telefone dela');
    },
    armazem: (f) => assert.ok(f.fiado.length >= 2),
    padaria: (f) => assert.ok(f.vendas.length > 0),
  };
  for (const [perfil, conferir] of Object.entries(casos)) {
    const { db, suporteId } = ambiente();
    const resumo = demo.semear(db, { perfil, solicitanteId: suporteId, agoraMs: AGORA });
    const original = Date.now;
    Date.now = () => AGORA;
    try {
      const primeiro = db.prepare('SELECT id, nome FROM customers WHERE nome = ?').get(resumo.clienteDaFicha);
      const f = ficha.getFicha({ customerId: primeiro.id });
      assert.equal(f.ok, true, perfil);
      assert.ok(f.fiado.some((m) => m.tipo === 'pagamento'), `${perfil}: pagou parte do fiado`);
      conferir(f);
      const segundo = db.prepare('SELECT id FROM customers WHERE nome = ?').get(resumo.clienteDevendo);
      const saldo = require('../electron/services/customerService').getSaldoFiado(segundo.id);
      assert.ok(saldo > 0, `${perfil}: o 2º cliente deve no fiado`);
    } finally {
      Date.now = original;
    }
  }
});

test('semear (restaurante): salão funcionando agora -- comandas abertas com pessoas, mesas unidas, cozinha, limpeza e reserva', () => {
  const { db, suporteId } = ambiente();
  const resumo = demo.semear(db, { perfil: 'restaurante', solicitanteId: suporteId, agoraMs: AGORA });
  assert.equal(resumo.comandasAbertas, 2);
  const mesas = Object.fromEntries(db.prepare('SELECT numero, status, sale_id, unida_a_mesa_id, pessoas, id FROM restaurant_tables').all().map((m) => [m.numero, m]));
  assert.equal(mesas['1'].status, 'ocupada');
  assert.equal(mesas['1'].pessoas, 3);
  assert.equal(mesas['3'].unida_a_mesa_id, mesas['2'].id);
  assert.equal(mesas['3'].sale_id, mesas['2'].sale_id);
  assert.equal(mesas['5'].status, 'aguardando_limpeza');
  assert.equal(mesas['6'].status, 'reservada');
  // Pessoa da mesa 1 ligada a um cliente do cadastro; cozinha com item preparando e pendente.
  const ligada = db.prepare('SELECT sp.nome, c.nome AS cliente FROM sale_people sp JOIN customers c ON c.id = sp.customer_id WHERE sp.sale_id = ?').get(mesas['1'].sale_id);
  assert.ok(ligada && ligada.cliente.startsWith(ligada.nome));
  const preparo = db.prepare('SELECT status_preparo, COUNT(*) c FROM sale_items WHERE sale_id IN (?, ?) GROUP BY 1').all(mesas['1'].sale_id, mesas['2'].sale_id);
  assert.deepEqual(preparo.map((p) => p.status_preparo).sort(), ['pendente', 'preparando', 'pronto']);
  // O conserto de mesa unida não mexe nesse grupo (está certo).
  assert.equal(require('../electron/services/tableService').repararMesasUnidas(db), 0);
  // Histórico: contas de mesa com a mesa gravada e pessoas.
  assert.ok(db.prepare('SELECT COUNT(*) c FROM sale_mesas').get().c > 50);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM sale_people WHERE customer_id IS NOT NULL').get().c > 10);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM reservations WHERE status = 'confirmada' AND mesa_id = ?`).get(mesas['6'].id).c, 1);
});

test('semear: mesma semente gera a mesma loja', () => {
  const a = ambiente();
  demo.semear(a.db, { perfil: 'papelaria', solicitanteId: a.suporteId, agoraMs: AGORA });
  const totalA = a.db.prepare('SELECT ROUND(SUM(total), 2) t FROM sales').get().t;
  const b = ambiente();
  demo.semear(b.db, { perfil: 'papelaria', solicitanteId: b.suporteId, agoraMs: AGORA });
  assert.equal(b.db.prepare('SELECT ROUND(SUM(total), 2) t FROM sales').get().t, totalA);
});

test('carregar: só o papel suporte (admin não)', async () => {
  const { adminId, gerenteId } = ambiente();
  for (const id of [adminId, gerenteId]) {
    const r = await demo.carregar({ perfil: 'armazem', solicitanteId: id });
    assert.equal(r.ok, false);
    assert.match(r.error, /suporte/);
  }
});

test('carregar: recusa máquina com venda, perfil inválido e caixa aberto', async () => {
  const { db, suporteId, locationId, operadorId } = ambiente();
  assert.equal((await demo.carregar({ perfil: 'inexistente', solicitanteId: suporteId })).ok, false);

  db.prepare(`INSERT INTO cash_sessions (id, location_id, operador_abertura_id) VALUES ('cx', ?, ?)`).run(locationId, operadorId);
  const comCaixa = await demo.carregar({ perfil: 'armazem', solicitanteId: suporteId });
  assert.equal(comCaixa.ok, false);
  assert.match(comCaixa.error, /caixa/);
  db.prepare(`UPDATE cash_sessions SET status = 'fechada'`).run();

  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status) VALUES ('v1', ?, ?, 'aberta')`).run(locationId, operadorId);
  const comVenda = await demo.carregar({ perfil: 'armazem', solicitanteId: suporteId });
  assert.equal(comVenda.ok, false);
  assert.match(comVenda.error, /venda/);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM products WHERE sku LIKE 'APRES-%'`).get().c, 0, 'nada foi gravado');
});

test('carregar: guarda o ponto de restauração ANTES e marca a demonstração como ativa', async () => {
  const { db, suporteId, pasta } = ambiente();
  const r = await demo.carregar({ perfil: 'petshop', solicitanteId: suporteId });
  assert.equal(r.ok, true, r.error);

  const estado = demo.estado();
  assert.equal(estado.ativa, true);
  assert.equal(estado.perfil, 'petshop');
  assert.deepEqual(estado.impedimentos, []);

  const salvo = lerEstadoJson(pasta);
  const ponto = new Database(salvo.pontoRestauracao, { readonly: true });
  try {
    assert.equal(ponto.prepare('SELECT COUNT(*) c FROM sales').get().c, 0, 'a cópia é de antes da carga');
    assert.ok(ponto.prepare('SELECT id FROM users WHERE id = ?').get(suporteId), 'o usuário de suporte está na cópia');
  } finally {
    ponto.close();
  }
  assert.ok(db.prepare('SELECT COUNT(*) c FROM sales').get().c > 0);

  const deNovo = await demo.carregar({ perfil: 'armazem', solicitanteId: suporteId });
  assert.equal(deNovo.ok, false, 'não carrega duas vezes por cima');
});

test('limpar: devolve exatamente o banco de antes (mesma identidade da máquina) e registra na auditoria', async () => {
  const { db, suporteId, adminId, dbPath, pasta } = ambiente();
  db.prepare(`UPDATE locations SET device_uid = 'uid-da-maquina'`).run();
  assert.equal((await demo.carregar({ perfil: 'otica', solicitanteId: suporteId })).ok, true);

  const negado = demo.limpar({ solicitanteId: adminId });
  assert.equal(negado.ok, false, 'admin não limpa');

  const r = demo.limpar({ solicitanteId: suporteId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reiniciar, true);
  assert.equal(lerEstadoJson(pasta), null, 'estado apagado');
  assert.equal(fs.readdirSync(pasta).filter((f) => f.endsWith('.sqlite3')).length, 0, 'cópia removida depois de usada');

  const restaurado = new Database(dbPath, { readonly: true });
  try {
    assert.equal(restaurado.prepare('SELECT COUNT(*) c FROM sales').get().c, 0);
    assert.equal(restaurado.prepare(`SELECT COUNT(*) c FROM products WHERE sku LIKE 'APRES-%'`).get().c, 0);
    assert.equal(restaurado.prepare('SELECT device_uid FROM locations').get().device_uid, 'uid-da-maquina');
    assert.equal(restaurado.prepare(`SELECT COUNT(*) c FROM audit_log WHERE tipo_evento = 'demonstracao_limpa'`).get().c, 1);
  } finally {
    restaurado.close();
  }
});

test('limpar: sem demonstração carregada, recusa sem mexer em nada', () => {
  const { suporteId } = ambiente();
  const r = demo.limpar({ solicitanteId: suporteId });
  assert.equal(r.ok, false);
});

test('trocarPerfil: volta ao banco de antes e carrega o novo perfil, mantendo o mesmo ponto de restauração', async () => {
  const { suporteId, dbPath, pasta } = ambiente();
  assert.equal((await demo.carregar({ perfil: 'farmacia', solicitanteId: suporteId })).ok, true);
  const pontoOriginal = lerEstadoJson(pasta).pontoRestauracao;

  const r = demo.trocarPerfil({ perfil: 'salao_beleza', solicitanteId: suporteId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reiniciar, true);

  const salvo = lerEstadoJson(pasta);
  assert.equal(salvo.perfil, 'salao_beleza');
  assert.equal(salvo.pontoRestauracao, pontoOriginal);

  const banco = new Database(dbPath, { readonly: true });
  try {
    assert.equal(banco.prepare(`SELECT perfil_ativo FROM business_profile WHERE id = 'default'`).get().perfil_ativo, 'salao_beleza');
    assert.equal(banco.prepare(`SELECT COUNT(*) c FROM products WHERE sku LIKE 'APRES-F%'`).get().c, 0, 'nada da farmácia sobrou');
    assert.equal(banco.prepare(`SELECT COUNT(*) c FROM products WHERE sku LIKE 'APRES-S%'`).get().c, CATALOGOS_DEMONSTRACAO.salao_beleza.itens.length);
    assert.equal(banco.prepare('SELECT COUNT(*) c FROM customers').get().c, 40, 'clientes não duplicam');
  } finally {
    banco.close();
  }
});

test('máquina de demonstração da Central: carrega mesmo com vendas, e limpar devolve essas vendas', async () => {
  const vitrine = require('../electron/services/vitrineDemoService');
  const original = vitrine.ehMaquinaDemo;
  vitrine.ehMaquinaDemo = () => true;
  try {
    const { db, suporteId, locationId, operadorId, dbPath } = ambiente();
    db.prepare(`INSERT INTO sales (id, location_id, operador_id, status, total) VALUES ('venda-de-teste', ?, ?, 'finalizada', 10)`)
      .run(locationId, operadorId);

    const estado = demo.estado();
    assert.deepEqual(estado.impedimentos, []);
    assert.equal(estado.maquinaDemo, true);
    assert.equal(estado.vendasExistentes, 1);

    const r = await demo.carregar({ perfil: 'padaria', solicitanteId: suporteId });
    assert.equal(r.ok, true, r.error);
    assert.ok(db.prepare(`SELECT id FROM sales WHERE id = 'venda-de-teste'`).get(), 'a venda antiga continua durante a demonstração');

    assert.equal(demo.limpar({ solicitanteId: suporteId }).ok, true);
    const restaurado = new Database(dbPath, { readonly: true });
    try {
      assert.equal(restaurado.prepare('SELECT COUNT(*) c FROM sales').get().c, 1, 'só a venda de antes volta');
      assert.ok(restaurado.prepare(`SELECT id FROM sales WHERE id = 'venda-de-teste'`).get());
    } finally {
      restaurado.close();
    }
  } finally {
    vitrine.ehMaquinaDemo = original;
  }
});

test('máquina comum com vendas: continua bloqueada, e a mensagem aponta a marcação da Central', async () => {
  const { db, suporteId, locationId, operadorId } = ambiente();
  db.prepare(`INSERT INTO sales (id, location_id, operador_id, status) VALUES ('v1', ?, ?, 'finalizada')`).run(locationId, operadorId);
  assert.equal(demo.estado().maquinaDemo, false);
  const r = await demo.carregar({ perfil: 'armazem', solicitanteId: suporteId });
  assert.equal(r.ok, false);
  assert.match(r.error, /Central/);
});
