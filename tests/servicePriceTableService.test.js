const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const productService = require('../electron/services/productService');
const servicePriceTableService = require('../electron/services/servicePriceTableService');
const serviceMaterialService = require('../electron/services/serviceMaterialService');
const profileService = require('../electron/services/profileService');
const { garantirCampoExtraNoPerfil } = require('../electron/db/database');

function setCustomFields(db, productId, fields) {
  db.prepare('UPDATE products SET custom_fields = ? WHERE id = ?').run(JSON.stringify(fields), productId);
}

test('productService.listServicePriceTable só traz serviço ativo com tipo_servico preenchido', () => {
  const ctx = freshTestDb();
  const corte = createProduct(ctx.db, { nome: 'Corte Masculino', preco: 40, tipo: 'servico' });
  setCustomFields(ctx.db, corte, { tipo_servico: 'Cabelo' });

  const semTipo = createProduct(ctx.db, { nome: 'Serviço Sem Tipo', preco: 20, tipo: 'servico' });
  setCustomFields(ctx.db, semTipo, {});

  const produtoComum = createProduct(ctx.db, { nome: 'Xampu', preco: 30, tipo: 'produto' });
  setCustomFields(ctx.db, produtoComum, { tipo_servico: 'Cabelo' }); // não é serviço, não deve entrar

  const inativo = createProduct(ctx.db, { nome: 'Coloração Antiga', preco: 100, tipo: 'servico' });
  setCustomFields(ctx.db, inativo, { tipo_servico: 'Cabelo' });
  ctx.db.prepare('UPDATE products SET ativo = 0 WHERE id = ?').run(inativo);

  const lista = productService.listServicePriceTable();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, corte);
  assert.equal(lista[0].nome, 'Corte Masculino');
  assert.equal(lista[0].tipo, 'Cabelo');
  assert.equal(lista[0].precoVariavel, false);
});

test('productService.listServicePriceTable marca precoVariavel quando há material que soma custo', () => {
  const ctx = freshTestDb();
  const coloracao = createProduct(ctx.db, { nome: 'Coloração', preco: 80, tipo: 'servico' });
  setCustomFields(ctx.db, coloracao, { tipo_servico: 'Coloração' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });

  let lista = productService.listServicePriceTable();
  assert.equal(lista[0].precoVariavel, false);

  serviceMaterialService.setMateriais(coloracao, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);
  lista = productService.listServicePriceTable();
  assert.equal(lista[0].precoVariavel, true);

  // Material cadastrado mas SEM cobrar no preço -- não deveria marcar como variável.
  serviceMaterialService.setMateriais(coloracao, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: false }]);
  lista = productService.listServicePriceTable();
  assert.equal(lista[0].precoVariavel, false);
});

test('servicePriceTableService.getConfig traz os valores padrão já semeados', () => {
  freshTestDb();
  const config = servicePriceTableService.getConfig();
  assert.equal(config.id, 'default');
  assert.equal(config.titulo, 'Tabela de Preços');
  assert.equal(config.cor_tema, '#0f6e63');
});

test('servicePriceTableService.updateConfig salva e preserva campo não enviado', () => {
  freshTestDb();
  servicePriceTableService.updateConfig({ titulo: 'Preços do Salão', subtitulo: 'Cortes e coloração', corTema: '#ab47bc', rodapeTexto: '(11) 99999-0000' });
  let config = servicePriceTableService.getConfig();
  assert.equal(config.titulo, 'Preços do Salão');
  assert.equal(config.subtitulo, 'Cortes e coloração');
  assert.equal(config.cor_tema, '#ab47bc');
  assert.equal(config.rodape_texto, '(11) 99999-0000');

  // Update parcial (sem titulo) preserva o que já tinha.
  servicePriceTableService.updateConfig({ corTema: '#000000' });
  config = servicePriceTableService.getConfig();
  assert.equal(config.titulo, 'Preços do Salão');
  assert.equal(config.cor_tema, '#000000');
});

test('servicePriceTableService.generateHtml agrupa por tipo, mostra preço e "a partir de" quando variável', () => {
  const ctx = freshTestDb();
  const corte = createProduct(ctx.db, { nome: 'Corte Masculino', preco: 40, tipo: 'servico' });
  setCustomFields(ctx.db, corte, { tipo_servico: 'Cabelo' });
  const coloracao = createProduct(ctx.db, { nome: 'Coloração', preco: 80, tipo: 'servico' });
  setCustomFields(ctx.db, coloracao, { tipo_servico: 'Coloração' });
  const tintura = createProduct(ctx.db, { nome: 'Tintura X', preco: 30, custo: 12 });
  serviceMaterialService.setMateriais(coloracao, [{ materialId: tintura, quantidade: 0.5, cobraNoPreco: true }]);

  servicePriceTableService.updateConfig({ titulo: 'Preços do Salão' });
  const html = servicePriceTableService.generateHtml();

  assert.match(html, /Preços do Salão/);
  assert.match(html, /Cabelo/);
  assert.match(html, /Corte Masculino/);
  assert.match(html, /R\$ 40\.00/);
  assert.match(html, /Coloração/);
  assert.match(html, /a partir de/);
  assert.match(html, /R\$ 80\.00/);
});

test('servicePriceTableService.generateHtml mostra mensagem de vazio sem nenhum serviço cadastrado', () => {
  freshTestDb();
  const html = servicePriceTableService.generateHtml();
  assert.match(html, /Nenhum serviço cadastrado ainda/);
});

test('garantirCampoExtraNoPerfil adiciona o campo uma única vez, sem duplicar nem apagar os existentes', () => {
  const ctx = freshTestDb();

  // Simula uma instalação já existente, de antes do campo tipo_servico
  // ter sido criado -- remove o campo do perfil salão de beleza semeado
  // por schema.sql/seedIfEmpty (que já vem com ele numa instalação nova).
  const antes = JSON.parse(ctx.db.prepare(`SELECT campos_extras_json FROM custom_profiles WHERE id = 'salao_beleza'`).get().campos_extras_json);
  const semTipoServico = antes.filter((c) => c.campo !== 'tipo_servico');
  assert.ok(semTipoServico.length < antes.length, 'pré-condição: o perfil semeado já tinha tipo_servico antes de remover');
  ctx.db.prepare(`UPDATE custom_profiles SET campos_extras_json = ? WHERE id = 'salao_beleza'`).run(JSON.stringify(semTipoServico));

  const novoCampo = { campo: 'tipo_servico', label: 'Tipo de serviço', tipo: 'texto', obrigatorio: false, aplicaA: 'servico' };
  garantirCampoExtraNoPerfil(ctx.db, 'salao_beleza', novoCampo);

  let campos = JSON.parse(ctx.db.prepare(`SELECT campos_extras_json FROM custom_profiles WHERE id = 'salao_beleza'`).get().campos_extras_json);
  assert.equal(campos.filter((c) => c.campo === 'tipo_servico').length, 1);
  // Campos antigos (validade, uso_profissional) continuam lá.
  assert.ok(campos.some((c) => c.campo === 'validade'));
  assert.ok(campos.some((c) => c.campo === 'uso_profissional'));

  // Rodar de novo é no-op -- não duplica.
  garantirCampoExtraNoPerfil(ctx.db, 'salao_beleza', novoCampo);
  campos = JSON.parse(ctx.db.prepare(`SELECT campos_extras_json FROM custom_profiles WHERE id = 'salao_beleza'`).get().campos_extras_json);
  assert.equal(campos.filter((c) => c.campo === 'tipo_servico').length, 1);
  assert.equal(campos.length, antes.length);
});

test('garantirCampoExtraNoPerfil não faz nada se o perfil não existir', () => {
  const ctx = freshTestDb();
  assert.doesNotThrow(() => {
    garantirCampoExtraNoPerfil(ctx.db, 'perfil_que_nao_existe', { campo: 'x', label: 'X', tipo: 'texto' });
  });
});

test('profileService.validateCamposExtras aceita aplicaA válido e rejeita valor inválido', () => {
  const semAplicaA = profileService.validateCamposExtras([{ campo: 'a', label: 'A', tipo: 'texto' }]);
  assert.equal(semAplicaA, null);

  const comAplicaAValido = profileService.validateCamposExtras([{ campo: 'a', label: 'A', tipo: 'texto', aplicaA: 'servico' }]);
  assert.equal(comAplicaAValido, null);

  const comAplicaAInvalido = profileService.validateCamposExtras([{ campo: 'a', label: 'A', tipo: 'texto', aplicaA: 'qualquer_coisa' }]);
  assert.match(comAplicaAInvalido, /aplica a/i);
});
