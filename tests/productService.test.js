const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const productService = require('../electron/services/productService');

function inserirProduto(db, nome, extras = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO products (id, nome, preco, codigo_barras, ativo) VALUES (?, ?, ?, ?, 1)`
  ).run(id, nome, extras.preco ?? 10, extras.codigoBarras ?? null);
  return id;
}

test('paginação por cursor é imune a produto novo entrando no meio da rolagem', () => {
  const { db } = freshTestDb();
  for (let i = 0; i < 40; i++) inserirProduto(db, 'PRODUTO ' + String(i).padStart(3, '0'));

  // Simula a rolagem infinita: pega a primeira página, depois — ENQUANTO
  // a pessoa ainda está olhando ela — um produto novo é cadastrado (por
  // essa máquina ou por outra sincronizada), só então busca a segunda
  // página. Sem o cursor, isso repetia o último produto da página 1.
  const pagina1 = productService.list({ limit: 20 });
  inserirProduto(db, 'PRODUTO NOVO NO MEIO');
  const ultimo = pagina1[pagina1.length - 1];
  const pagina2 = productService.list({ limit: 20, cursorNome: ultimo.nome, cursorId: ultimo.id });

  const todosOsIds = [...pagina1, ...pagina2].map((p) => p.id);
  const idsUnicos = new Set(todosOsIds);
  assert.equal(todosOsIds.length, idsUnicos.size, 'nenhum produto deveria se repetir entre as duas páginas');
});

test('busca com paginação também é imune, mesmo recalculando a lista inteira a cada chamada', () => {
  const { db } = freshTestDb();
  for (let i = 0; i < 30; i++) inserirProduto(db, 'DIPIRONA ' + String(i).padStart(3, '0'));

  const pagina1 = productService.list({ query: 'dipirona', limit: 15 });
  inserirProduto(db, 'DIPIRONA NOVA NO MEIO');
  const ultimo = pagina1[pagina1.length - 1];
  const pagina2 = productService.list({ query: 'dipirona', limit: 15, cursorId: ultimo.id });

  const todosOsIds = [...pagina1, ...pagina2].map((p) => p.id);
  assert.equal(todosOsIds.length, new Set(todosOsIds).size, 'nenhum produto deveria se repetir entre as páginas da busca');
});

test('busca prioriza nome que COMEÇA com o termo, sem misturar com correspondências mais fracas', () => {
  const { db } = freshTestDb();
  const comecaCom = inserirProduto(db, 'IRONA COMPRIMIDO FICTICIO'); // começa com 'irona'
  inserirProduto(db, 'DIPIRONA GOTAS'); // 'irona' está só no meio de 'Dipirona' — não deveria aparecer

  const resultado = productService.list({ query: 'irona' });
  assert.equal(resultado.length, 1, 'só quem começa com o termo deveria aparecer, sem misturar com match fraco');
  assert.equal(resultado[0].id, comecaCom);
});

test('busca cai pra correspondência mais solta só quando NENHUM produto começa com o termo', () => {
  const { db } = freshTestDb();
  const meioDaPalavra = inserirProduto(db, 'DIPIRONA GOTAS'); // 'irona' só no meio — sem ninguém começando com o termo

  const resultado = productService.list({ query: 'irona' });
  assert.equal(resultado.length, 1, 'sem nenhum match de início, a correspondência mais fraca deveria aparecer mesmo assim');
  assert.equal(resultado[0].id, meioDaPalavra);
});

test('busca prioriza início de PALAVRA no meio do nome sobre meio de palavra solto', () => {
  const { db } = freshTestDb();
  const inicioDePalavra = inserirProduto(db, 'PARACETAMOL 500MG GENERICO'); // 'generico' começa uma palavra
  const semRelacao = inserirProduto(db, 'ZZZ PRODUTO SEM RELACAO NENHUMA');

  const resultado = productService.list({ query: 'generico' });
  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].id, inicioDePalavra);
});

test('upsert recusa código de barras que já pertence a outro produto ativo, com mensagem clara', () => {
  const { db } = freshTestDb();
  inserirProduto(db, 'Produto A', { codigoBarras: '7891234567890' });

  const resultado = productService.upsert({ nome: 'Produto B', preco: 5, codigoBarras: '7891234567890' });
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /Produto A/);
});

/**
 * upsert nunca gravava fornecedor_id -- "Lista de compra sugerida"
 * (supplierService.suggestPurchases) ficava sempre vazia pra qualquer
 * produto cadastrado/editado manualmente, já que essa função filtra por
 * p.fornecedor_id (auditoria, seção 3).
 */
test('upsert grava fornecedorId, e uma edição posterior sem o campo não apaga o vínculo por acidente', () => {
  const { db } = freshTestDb();
  const fornecedorId = randomUUID();
  db.prepare(`INSERT INTO suppliers (id, nome) VALUES (?, 'Fornecedor Teste')`).run(fornecedorId);

  const criado = productService.upsert({ nome: 'Produto com fornecedor', preco: 10, fornecedorId });
  assert.equal(criado.ok, true);
  assert.equal(db.prepare('SELECT fornecedor_id FROM products WHERE id = ?').get(criado.id).fornecedor_id, fornecedorId);

  // Reenviar o mesmo produto SEM fornecedorId (ex: tela que não manda o
  // campo de volta) deve limpar o vínculo -- upsert é sempre "o estado
  // completo do produto", igual todo outro campo aqui, não um patch
  // parcial.
  productService.upsert({ id: criado.id, nome: 'Produto com fornecedor', preco: 10 });
  assert.equal(db.prepare('SELECT fornecedor_id FROM products WHERE id = ?').get(criado.id).fornecedor_id, null);
});

test('deactivate libera o código de barras na hora, pra outro produto poder usar', () => {
  const { db } = freshTestDb();
  const idAntigo = inserirProduto(db, 'Produto Antigo', { codigoBarras: '7891234567890' });

  productService.deactivate(idAntigo);
  const resultado = productService.upsert({ nome: 'Produto Novo', preco: 5, codigoBarras: '7891234567890' });
  assert.equal(resultado.ok, true, 'deveria conseguir usar o código depois do produto antigo ser excluído');
});

// ---------------------------------------------------------------------
// clearAllProducts — apaga o catálogo inteiro, por isso precisa checar
// permissão no backend (mesmo nível de acesso da tela de Produtos:
// gerente ou admin), não só confiar que a UI escondeu o botão.
// ---------------------------------------------------------------------

test('clearAllProducts recusa operador (não tem acesso à tela de Produtos)', () => {
  const { db, operadorId } = freshTestDb();
  inserirProduto(db, 'Produto Qualquer');

  const resultado = productService.clearAllProducts(operadorId);
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /permissão/i);

  const aindaExiste = db.prepare('SELECT COUNT(*) as c FROM products WHERE ativo = 1').get().c;
  assert.equal(aindaExiste, 1, 'nada deveria ter sido apagado quando a permissão é recusada');
});

test('clearAllProducts funciona pra gerente, mesmo nível de acesso da tela de Produtos', () => {
  const { db, gerenteId } = freshTestDb();
  inserirProduto(db, 'Produto Qualquer');

  const resultado = productService.clearAllProducts(gerenteId);
  assert.equal(resultado.ok, true);
  assert.equal(resultado.apagados, 1);
});

test('clearAllProducts funciona pra suporte, igual admin', () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  inserirProduto(db, 'Produto Qualquer');

  const resultado = productService.clearAllProducts(suporteId);
  assert.equal(resultado.ok, true);
  assert.equal(resultado.apagados, 1);
});

// ---------------------------------------------------------------------
// tipo ('produto' | 'servico') — permite vender serviço (mão de obra,
// consulta, taxa) sem gerar estoque. list/count precisam filtrar por
// aba (Todos/Produtos/Serviços) igual a tela de catálogo faz.
// ---------------------------------------------------------------------

test('upsert sem tipo assume "produto" por padrão', () => {
  const { db } = freshTestDb();
  const resultado = productService.upsert({ nome: 'Item sem tipo', preco: 10 });
  assert.equal(resultado.ok, true);
  const row = db.prepare('SELECT tipo FROM products WHERE id = ?').get(resultado.id);
  assert.equal(row.tipo, 'produto');
});

test('upsert com tipo="servico" grava corretamente', () => {
  const { db } = freshTestDb();
  const resultado = productService.upsert({ nome: 'Corte de cabelo', preco: 50, tipo: 'servico' });
  assert.equal(resultado.ok, true);
  const row = db.prepare('SELECT tipo FROM products WHERE id = ?').get(resultado.id);
  assert.equal(row.tipo, 'servico');
});

test('list filtra por tipo quando informado', () => {
  const { db } = freshTestDb();
  inserirProduto(db, 'Produto A');
  inserirProduto(db, 'Produto B');
  productService.upsert({ nome: 'Serviço A', preco: 30, tipo: 'servico' });

  const soProdutos = productService.list({ tipo: 'produto' });
  const soServicos = productService.list({ tipo: 'servico' });
  const todos = productService.list({});

  assert.equal(soProdutos.length, 2);
  assert.ok(soProdutos.every((p) => p.tipo === 'produto'));
  assert.equal(soServicos.length, 1);
  assert.equal(soServicos[0].nome, 'Serviço A');
  assert.equal(todos.length, 3);
});

test('list filtra por tipo também na busca por nome (query + tipo juntos)', () => {
  const { db } = freshTestDb();
  inserirProduto(db, 'Consulta Veterinaria'); // produto (default), nome parecido de propósito
  productService.upsert({ nome: 'Consulta Veterinaria Servico', preco: 80, tipo: 'servico' });

  const resultado = productService.list({ query: 'consulta', tipo: 'servico' });
  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].tipo, 'servico');
});

test('count respeita o filtro de tipo', () => {
  const { db } = freshTestDb();
  inserirProduto(db, 'Produto A');
  productService.upsert({ nome: 'Serviço A', preco: 30, tipo: 'servico' });
  productService.upsert({ nome: 'Serviço B', preco: 40, tipo: 'servico' });

  assert.equal(productService.count({ tipo: 'servico' }), 2);
  assert.equal(productService.count({ tipo: 'produto' }), 1);
  assert.equal(productService.count({}), 3);
});

// ---------------------------------------------------------------------
// findDuplicateProducts comparava o nome só em maiúscula/minúscula --
// "Café" e "Cafe" (erro de digitação comum, ou produto reimportado sem
// acentuação) não batiam como duplicado nenhum, mesmo sendo claramente
// o mesmo produto cadastrado duas vezes (auditoria, seção 3).
// ---------------------------------------------------------------------

test('findDuplicateProducts detecta nomes iguais mesmo com acentuação diferente', () => {
  const { db } = freshTestDb();
  inserirProduto(db, 'Café');
  inserirProduto(db, 'Cafe');
  inserirProduto(db, 'Água Mineral');
  inserirProduto(db, 'Agua Mineral');
  inserirProduto(db, 'Produto Único'); // sem duplicata, não deveria aparecer

  const duplicados = productService.findDuplicateProducts();
  assert.equal(duplicados.length, 2, 'café/cafe e água/agua deveriam formar dois grupos de duplicados');
  const tamanhos = duplicados.map((g) => g.length).sort();
  assert.deepEqual(tamanhos, [2, 2]);
});

test('findDuplicateProducts continua detectando duplicata exata (mesmo sem diferença de acento)', () => {
  const { db } = freshTestDb();
  inserirProduto(db, 'Arroz 5kg');
  inserirProduto(db, 'arroz 5kg');

  const duplicados = productService.findDuplicateProducts();
  assert.equal(duplicados.length, 1);
  assert.equal(duplicados[0].length, 2);
});

// ---------------------------------------------------------------------
// A tela de Produtos filtrava "só com conflito de código de barras"
// DEPOIS de já ter carregado uma página inteira pela rolagem infinita
// -- então list()/count() precisam aceitar o filtro de verdade (em
// SQL), senão a tela não tem como pedir só os produtos com conflito
// (auditoria, seção 5 / ProductList.jsx).
// ---------------------------------------------------------------------

test('list com comConflito devolve só produtos com conflito de código de barras pendente', () => {
  const { db } = freshTestDb();
  const semConflito = inserirProduto(db, 'Produto Normal');
  const comConflitoId = inserirProduto(db, 'Produto Conflitante');
  db.prepare('UPDATE products SET conflito_codigo_barras_pendente = ? WHERE id = ?').run('7891234567890', comConflitoId);

  const todos = productService.list({});
  assert.equal(todos.length, 2);

  const soConflito = productService.list({ comConflito: true });
  assert.equal(soConflito.length, 1);
  assert.equal(soConflito[0].id, comConflitoId);
  assert.notEqual(soConflito[0].id, semConflito);
});

test('list com comConflito também funciona junto de uma busca por nome', () => {
  const { db } = freshTestDb();
  const comConflitoId = inserirProduto(db, 'Dipirona Conflitante');
  inserirProduto(db, 'Dipirona Normal');
  db.prepare('UPDATE products SET conflito_codigo_barras_pendente = ? WHERE id = ?').run('123', comConflitoId);

  const resultado = productService.list({ query: 'dipirona', comConflito: true });
  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].id, comConflitoId);
});

test('count com comConflito bate com o tamanho de list com o mesmo filtro', () => {
  const { db } = freshTestDb();
  const comConflitoId = inserirProduto(db, 'Produto A');
  inserirProduto(db, 'Produto B');
  inserirProduto(db, 'Produto C');
  db.prepare('UPDATE products SET conflito_codigo_barras_pendente = ? WHERE id = ?').run('999', comConflitoId);

  assert.equal(productService.count({ comConflito: true }), 1);
  assert.equal(productService.count({}), 3);
});
