const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const migracao = require('../electron/services/migracaoService');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'migracao-'));
function arquivo(nome, conteudo, encoding = 'utf8') {
  const caminho = path.join(pasta, nome);
  fs.writeFileSync(caminho, typeof conteudo === 'string' ? Buffer.from(conteudo, encoding) : conteudo);
  return caminho;
}

function estoque(ctx, produtoId) {
  return ctx.db.prepare('SELECT COALESCE(SUM(quantidade), 0) as t FROM stock_movements WHERE product_id = ? AND location_id = ?')
    .get(produtoId, ctx.locationId).t;
}

async function abrirEPrever(ctx, caminho, tipo, mapeamento) {
  const a = await migracao.abrir(caminho);
  assert.equal(a.ok, true, a.error);
  const mapa = mapeamento || a.mapeamentoSugerido[tipo];
  const p = migracao.previa({ token: a.token, tipo, mapeamento: mapa });
  assert.equal(p.ok, true, p.error);
  return { a, p, mapa };
}

function importar(ctx, a, tipo, mapa) {
  return migracao.importar({ token: a.token, tipo, mapeamento: mapa, operadorId: ctx.adminId, locationId: ctx.locationId, deviceId: 'pc-teste' });
}

// ---------------------------------------------------------------------
// Leitura e conversão
// ---------------------------------------------------------------------

test('números em formato brasileiro, americano e com R$', () => {
  assert.equal(migracao.lerNumero('1.234,56'), 1234.56);
  assert.equal(migracao.lerNumero('R$ 12,90'), 12.9);
  assert.equal(migracao.lerNumero('12.90'), 12.9);
  assert.equal(migracao.lerNumero('1,234.56'), 1234.56);
  assert.equal(migracao.lerNumero('1.250'), 1.25); // ponto sozinho = decimal (kg)
  assert.equal(migracao.lerNumero('1.234.567'), 1234567);
  assert.equal(migracao.lerNumero('(5,00)'), -5);
  assert.equal(migracao.lerNumero(7.5), 7.5);
  assert.ok(Number.isNaN(migracao.lerNumero('abc')));
  assert.ok(Number.isNaN(migracao.lerNumero('')));
});

test('código de barras: preserva zeros, recusa notação científica e número grande arredondado', () => {
  assert.equal(migracao.lerCodigo('0789123456789').valor, '0789123456789');
  assert.equal(migracao.lerCodigo(7891234567895).valor, '7891234567895');
  assert.match(migracao.lerCodigo('7,89123E+12').erro, /notação científica/);
  assert.match(migracao.lerCodigo(2 ** 60).erro, /grande demais/);
});

test('datas e unidades', () => {
  assert.equal(migracao.lerData('05/03/1990'), '1990-03-05');
  assert.equal(migracao.lerData('1990-03-05'), '1990-03-05');
  assert.equal(migracao.lerData('31/02/1990'), null);
  assert.equal(migracao.lerData('05/03/85'), '1985-03-05');
  assert.equal(migracao.lerUnidade('UND'), 'un');
  assert.equal(migracao.lerUnidade('Kg'), 'kg');
  assert.equal(migracao.lerUnidade('LT'), 'l');
  assert.equal(migracao.lerUnidade('xpto'), null);
});

test('CSV com ponto e vírgula, aspas e acentuação Windows-1252 (exportação de sistema antigo)', () => {
  const texto = migracao.decodificar(Buffer.from('Descrição;Preço\r\n"Pão; francês";"1,50"\r\nAçúcar;4,99\r\n', 'latin1'));
  const linhas = migracao.lerCsv(texto);
  assert.deepEqual(linhas[0], ['Descrição', 'Preço']);
  assert.deepEqual(linhas[1], ['Pão; francês', '1,50']);
  assert.deepEqual(linhas[2], ['Açúcar', '4,99']);
});

test('cabeçalho depois de linhas de título é encontrado', () => {
  const { colunas, dados } = migracao.separarCabecalho([
    ['RELATÓRIO DE PRODUTOS', '', ''],
    ['Emitido em 20/10/2026', '', ''],
    ['Código', 'Descrição', 'Pr. Venda'],
    ['10', 'Arroz', '27,90'],
  ]);
  assert.deepEqual(colunas, ['Código', 'Descrição', 'Pr. Venda']);
  assert.equal(dados.length, 1);
});

test('mapeamento por nome de coluna; "Código" com valores EAN vira código de barras', () => {
  const colunas = ['Código', 'Descrição', 'Preço Venda', 'Custo', 'Estoque', 'Und', 'Grupo'];
  const dados = [['7891000100103', 'Leite', '5,49', '3,10', '24', 'UN', 'Laticínios'], ['7894900011517', 'Refri', '9,90', '6,20', '4', 'UN', 'Bebidas']];
  const mapa = migracao.sugerirMapeamento('produtos', colunas, dados);
  assert.deepEqual(mapa, {
    codigoBarras: 'Código', nome: 'Descrição', preco: 'Preço Venda', custo: 'Custo', estoque: 'Estoque', unidade: 'Und', categoria: 'Grupo',
  });
  const mapaSku = migracao.sugerirMapeamento('produtos', colunas, [['10', 'Leite', '5,49', '', '', '', '']]);
  assert.equal(mapaSku.sku, 'Código');
  assert.equal(mapaSku.codigoBarras, undefined);
});

test('resposta da IA é validada: campo desconhecido, coluna inexistente e coluna repetida caem fora', () => {
  const limpo = migracao.validarMapeamento('produtos', {
    nome: 'Descrição', preco: 'Preço', custo: 'Preço', apagarTudo: 'Descrição', estoque: 'Coluna que não existe', sku: 42,
  }, ['Descrição', 'Preço']);
  assert.deepEqual(limpo, { nome: 'Descrição', preco: 'Preço' });
});

test('clientes: exemplos enviados à IA saem mascarados (formato, nunca o dado)', () => {
  assert.equal(migracao.mascarar('123.456.789-09'), '999.999.999-99');
  assert.equal(migracao.mascarar('Maria Souza'), 'xxxxx xxxxx');
  const amostras = migracao.amostrasPorColuna(['CPF'], [['123.456.789-09']], { mascarado: true });
  assert.deepEqual(amostras, [{ coluna: 'CPF', exemplos: ['999.999.999-99'] }]);
});

test('.xls antigo e arquivo vazio dão mensagem clara', async () => {
  assert.match((await migracao.abrir(arquivo('antigo.xls', 'x'))).error, /Salvar como/);
  assert.match((await migracao.abrir(arquivo('vazio.csv', '\n\n'))).error, /vazio/);
  assert.match((await migracao.abrir(arquivo('so-cabecalho.csv', 'Nome;Preço\n'))).error, /nenhuma linha/);
});

// ---------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------

test('produtos: prévia conta novos/atualizar/erros sem gravar nada', async () => {
  const ctx = freshTestDb();
  const existente = createProduct(ctx.db, { nome: 'Leite Integral 1L', preco: 5 });
  ctx.db.prepare(`UPDATE products SET codigo_barras = '7891000100103' WHERE id = ?`).run(existente);
  const csv = arquivo('p1.csv', [
    'EAN;Descrição;Preço Venda;Custo;Estoque;Und',
    '7891000100103;Leite Integral 1L;5,49;3,10;24;UN',
    '7894900011517;Refrigerante Cola 2L;9,90;6,20;10;UN',
    ';Pão Francês;16,90;;3,250;KG',
    ';;12,00;;;UN',
    '7894900011517;Refri repetido;9,90;;;UN',
  ].join('\n'));
  const { p } = await abrirEPrever(ctx, csv, 'produtos');
  assert.deepEqual([p.resumo.novos, p.resumo.atualizar, p.resumo.erros, p.resumo.estoqueInicial], [2, 1, 2, 2]);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
  const pao = p.linhas.find((l) => l.dados.nome === 'Pão Francês');
  assert.equal(pao.dados.estoque, 3.25);
  assert.equal(pao.dados.unidade, 'kg');
  assert.match(p.linhas.find((l) => l.linha === 6).erros[0], /repetido no arquivo/);
});

test('produtos: importa, atualiza preço do existente sem mexer no estoque dele, e reimportar não duplica', async () => {
  const ctx = freshTestDb();
  const existente = createProduct(ctx.db, { nome: 'Leite Integral 1L', preco: 5, custo: 3 });
  ctx.db.prepare(`UPDATE products SET codigo_barras = '7891000100103', ncm = '04012010' WHERE id = ?`).run(existente);
  addStock(ctx.db, { productId: existente, locationId: ctx.locationId, quantidade: 7, operadorId: ctx.adminId });
  const csv = arquivo('p2.csv', [
    'EAN;Descrição;Preço Venda;Custo;Estoque;Und;Fornecedor',
    '7891000100103;Leite Integral 1L;5,49;;24;UN;Laticínios Recife',
    '7894900011517;Refrigerante Cola 2L;9,90;6,20;10;UN;Distribuidora X',
  ].join('\n'));

  const { a, mapa } = await abrirEPrever(ctx, csv, 'produtos');
  const r = importar(ctx, a, 'produtos', mapa);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.novos, r.atualizados, r.comEstoque, r.totalErros], [1, 1, 1, 0]);

  const leite = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(existente);
  assert.equal(leite.preco, 5.49);
  assert.equal(leite.custo, 3); // coluna vazia não apaga o custo que já existia
  assert.equal(leite.ncm, '04012010');
  assert.equal(estoque(ctx, existente), 7); // estoque do existente não muda
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM product_price_history WHERE product_id = ?').get(existente).c, 1);

  const refri = ctx.db.prepare(`SELECT * FROM products WHERE codigo_barras = '7894900011517'`).get();
  assert.equal(estoque(ctx, refri.id), 10);
  assert.ok(refri.fornecedor_id);
  assert.equal(ctx.db.prepare(`SELECT tipo_evento FROM audit_log WHERE tipo_evento = 'migracao_sistema_anterior'`).all().length, 1);

  // Reimporta o mesmo arquivo: nada novo, estoque não soma de novo.
  const de = await abrirEPrever(ctx, csv, 'produtos');
  assert.deepEqual([de.p.resumo.novos, de.p.resumo.atualizar], [0, 2]);
  importar(ctx, de.a, 'produtos', de.mapa);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM products').get().c, 2);
  assert.equal(estoque(ctx, refri.id), 10);
});

test('produtos: código de produto excluído reativa o mesmo produto em vez de quebrar', async () => {
  const ctx = freshTestDb();
  const antigo = createProduct(ctx.db, { nome: 'Biscoito', preco: 3 });
  ctx.db.prepare(`UPDATE products SET codigo_barras = '7896000000017', ativo = 0 WHERE id = ?`).run(antigo);
  const csv = arquivo('p3.csv', 'EAN;Descrição;Preço\n7896000000017;Biscoito Maisena;3,50\n');
  const { a, p, mapa } = await abrirEPrever(ctx, csv, 'produtos');
  assert.equal(p.resumo.atualizar, 1);
  assert.match(p.linhas[0].avisos.join(' '), /reativado/);
  const r = importar(ctx, a, 'produtos', mapa);
  assert.equal(r.ok, true, r.error);
  const linha = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(antigo);
  assert.equal(linha.ativo, 1);
  assert.equal(linha.preco, 3.5);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
});

test('produtos: código interno já usado por outro produto fica de fora (com aviso) em vez de derrubar a importação', async () => {
  const ctx = freshTestDb();
  const outro = createProduct(ctx.db, { nome: 'Outro', preco: 1 });
  ctx.db.prepare(`UPDATE products SET sku = '10' WHERE id = ?`).run(outro);
  const csv = arquivo('p4.csv', 'Cod;EAN;Descrição;Preço\n10;7890000000011;Novo Item;2,00\n');
  const { a, p } = await abrirEPrever(ctx, csv, 'produtos', { sku: 'Cod', codigoBarras: 'EAN', nome: 'Descrição', preco: 'Preço' });
  assert.equal(p.resumo.novos, 1);
  assert.match(p.linhas[0].avisos.join(' '), /já é de "Outro"/);
  const r = importar(ctx, a, 'produtos', { sku: 'Cod', codigoBarras: 'EAN', nome: 'Descrição', preco: 'Preço' });
  assert.equal(r.novos, 1);
  assert.equal(ctx.db.prepare(`SELECT sku FROM products WHERE codigo_barras = '7890000000011'`).get().sku, null);
});

test('produtos: mesmo código interno e nome começando igual é o mesmo produto (reimportação de outro sistema)', async () => {
  const ctx = freshTestDb();
  const cafe = createProduct(ctx.db, { nome: 'Café Torrado 500g', preco: 15 });
  ctx.db.prepare(`UPDATE products SET sku = '77' WHERE id = ?`).run(cafe);
  const csv = arquivo('p4b.csv', 'Cod;Descrição;Preço\n77;Café Torrado e Moído 500g;18,50\n');
  const { p } = await abrirEPrever(ctx, csv, 'produtos', { sku: 'Cod', nome: 'Descrição', preco: 'Preço' });
  assert.equal(p.resumo.atualizar, 1);
  assert.equal(p.linhas[0].existenteNome, 'Café Torrado 500g');
});

test('produtos: sem a coluna obrigatória não deixa nem ver a prévia', async () => {
  const ctx = freshTestDb();
  const csv = arquivo('p5.csv', 'Descrição;Preço\nArroz;27,90\n');
  const a = await migracao.abrir(csv);
  const p = migracao.previa({ token: a.token, tipo: 'produtos', mapeamento: { nome: 'Descrição' } });
  assert.match(p.error, /Preço de venda/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM products').get().c, 0);
});

test('produtos: planilha .xlsx com título acima do cabeçalho e números como número', async () => {
  const ctx = freshTestDb();
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Produtos');
  ws.addRow(['Listagem de produtos']);
  ws.addRow(['Código de Barras', 'Nome do Produto', 'Valor Venda', 'Qtd']);
  ws.addRow(['7891234567895', 'Café 500g', 18.5, 12]);
  const caminho = path.join(pasta, 'p6.xlsx');
  await wb.xlsx.writeFile(caminho);
  const { a, p, mapa } = await abrirEPrever(ctx, caminho, 'produtos');
  assert.deepEqual(mapa, { codigoBarras: 'Código de Barras', nome: 'Nome do Produto', preco: 'Valor Venda', estoque: 'Qtd' });
  assert.equal(p.resumo.novos, 1);
  importar(ctx, a, 'produtos', mapa);
  const cafe = ctx.db.prepare(`SELECT * FROM products WHERE codigo_barras = '7891234567895'`).get();
  assert.equal(cafe.preco, 18.5);
  assert.equal(estoque(ctx, cafe.id), 12);
});

test('token velho ou de outra sessão é recusado', () => {
  const r = migracao.previa({ token: 'nao-existe', tipo: 'produtos', mapeamento: {} });
  assert.match(r.error, /expirou/);
});

// ---------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------

test('clientes: importa com saldo de fiado só para quem é novo; completa quem já existe', async () => {
  const ctx = freshTestDb();
  ctx.db.prepare(`INSERT INTO customers (id, nome, telefone, cpf) VALUES ('c-ana', 'Ana Lima', '(81) 99999-1234', NULL)`).run();
  const csv = arquivo('c1.csv', [
    'Nome;Celular;CPF/CNPJ;Nascimento;Saldo Devedor',
    'Ana Lima;81 99999-1234;123.456.789-09;10/05/1980;50,00',
    'Bruno Alves;(81) 98888-0000;987.654.321-00;;R$ 120,50',
    'Carla Dias;;;;0',
    'Bruno Alves Filho;(81) 98888-0000;;;10,00',
  ].join('\n'));
  const { a, p, mapa } = await abrirEPrever(ctx, csv, 'clientes');
  assert.deepEqual(mapa, { nome: 'Nome', telefone: 'Celular', documento: 'CPF/CNPJ', dataNascimento: 'Nascimento', saldoFiado: 'Saldo Devedor' });
  // Ana casa pelo telefone (mesmo primeiro nome; aqui ela não tinha CPF).
  // "Bruno Alves Filho" divide o telefone com o Bruno que tem CPF: são
  // duas pessoas (o documento do pai não é dele) -> dois cadastros.
  assert.equal(p.resumo.atualizar, 1);
  assert.equal(p.resumo.novos, 3);
  assert.equal(p.resumo.erros, 0);
  assert.equal(p.resumo.saldoFiadoTotal, 130.5);

  const r = importar(ctx, a, 'clientes', mapa);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.novos, r.atualizados, r.comSaldo, r.saldoTotal], [3, 1, 2, 130.5]);
  const ana = ctx.db.prepare(`SELECT * FROM customers WHERE id = 'c-ana'`).get();
  assert.equal(ana.cpf, '12345678909');
  assert.equal(ana.telefone, '(81) 99999-1234'); // não sobrescreve
  assert.equal(ana.data_nascimento, '1980-05-10');
  assert.equal(ctx.db.prepare(`SELECT COUNT(*) c FROM customer_credit_movements WHERE customer_id = 'c-ana'`).get().c, 0);
  const bruno = ctx.db.prepare(`SELECT * FROM customers WHERE cpf = '98765432100'`).get();
  assert.equal(require('../electron/services/customerService').getSaldoFiado(bruno.id), 120.5);

  // Reimportar não cria cliente nem fiado de novo.
  const de = await abrirEPrever(ctx, csv, 'clientes');
  importar(ctx, de.a, 'clientes', de.mapa);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM customers').get().c, 4);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM customer_credit_movements').get().c, 2);
});

test('clientes: mesmo final de telefone em DDD diferente, ou outro primeiro nome, é outra pessoa', async () => {
  const ctx = freshTestDb();
  ctx.db.prepare(`INSERT INTO customers (id, nome, telefone) VALUES ('c-1', 'José Silva', '81999991234')`).run();
  const csv = arquivo('c2.csv', [
    'Nome;Telefone',
    'José Silva;11999991234',
    'Maria Silva;81999991234',
    'José da Silva;+55 (81) 99999-1234',
  ].join('\n'));
  const { p } = await abrirEPrever(ctx, csv, 'clientes');
  const acoes = p.linhas.map((l) => [l.dados.nome, l.acao]);
  assert.deepEqual(acoes, [['José Silva', 'novo'], ['Maria Silva', 'novo'], ['José da Silva', 'atualizar']]);
});

test('clientes: saldo negativo (crédito do cliente) não vira dívida', async () => {
  const ctx = freshTestDb();
  const csv = arquivo('c3.csv', 'Nome;Saldo\nPedro;-30,00\n');
  const { a, p, mapa } = await abrirEPrever(ctx, csv, 'clientes');
  assert.match(p.linhas[0].avisos.join(' '), /não é migrado/);
  importar(ctx, a, 'clientes', mapa);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM customer_credit_movements').get().c, 0);
});

test('sugestão da IA: em clientes, a IA recebe só cabeçalho e exemplos mascarados; resposta é filtrada', async () => {
  freshTestDb();
  const aiService = require('../electron/services/aiService');
  const original = aiService.sugerirMapeamentoColunas;
  let recebido = null;
  aiService.sugerirMapeamentoColunas = async (args) => {
    recebido = args;
    return { ok: true, mapeamento: { nome: 'Nome', documento: 'CPF', saldoFiado: 'Inexistente', telefone: 'Nome' } };
  };
  try {
    const csv = arquivo('ia.csv', 'Nome;CPF\nMaria Souza;123.456.789-09\n');
    const a = await migracao.abrir(csv);
    const r = await migracao.sugerirComIA({ token: a.token, tipo: 'clientes' });
    assert.deepEqual(r.mapeamento, { nome: 'Nome', documento: 'CPF' });
    const enviado = JSON.stringify(recebido);
    assert.ok(!enviado.includes('Maria'), enviado);
    assert.ok(!enviado.includes('123.456'), enviado);
    assert.ok(enviado.includes('999.999.999-99'));

    // Produtos (sem dado pessoal): exemplos reais ajudam a IA.
    const csvP = arquivo('ia-p.csv', 'Descrição;Valor\nArroz;27,90\n');
    const b = await migracao.abrir(csvP);
    await migracao.sugerirComIA({ token: b.token, tipo: 'produtos' });
    assert.ok(JSON.stringify(recebido).includes('Arroz'));
  } finally {
    aiService.sugerirMapeamentoColunas = original;
  }
});
