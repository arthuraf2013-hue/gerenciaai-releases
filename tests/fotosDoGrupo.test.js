// Foto do produto igual em todos os caixas do grupo (grupoFotoService),
// com o grupo trocado por um falso. As fotos só andam pela rede local
// (servidor da loja): `usarGrupo` liga o mesmo falso como nuvem E como
// servidor da loja; sem servidor, a foto não passa pela nuvem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');
const { setDbForTesting } = require('../electron/db/database');
const { freshTestDb } = require('./helpers/testDb');
const replica = require('../electron/services/grupoReplicaService');
const fotos = require('../electron/services/grupoFotoService');
const productService = require('../electron/services/productService');

function grupoFalso() {
  const colecoes = { produtos: new Map(), clientes: new Map(), fiado: new Map(), fotos: new Map() };
  const g = {
    colecoes,
    recusarFotos: false,
    pedidosDeFoto: 0,
    async lerTodos(_g, c) { if (c === 'fotos') g.pedidosDeFoto++; return new Map([...colecoes[c]].map(([k, v]) => [k, { ...v }])); },
    async lerAlguns(_g, c, ids) { if (c === 'fotos') g.pedidosDeFoto++; return new Map(ids.filter((id) => colecoes[c].has(id)).map((id) => [id, { ...colecoes[c].get(id) }])); },
    async gravarLote(_g, c, itens) {
      if (c === 'fotos') g.pedidosDeFoto++;
      if (c === 'fotos' && g.recusarFotos) throw new Error('servidor da loja fora do ar');
      for (const { docId, dados } of itens) colecoes[c].set(docId, { ...dados });
    },
    escutar() { return () => {}; },
  };
  return g;
}

/** O grupo falso vale como nuvem e como servidor da loja (rede local ligada). */
function usarGrupo(g, { redeLocal = true } = {}) {
  replica._definirBackendParaTeste(g);
  replica._definirBackendDasFotosParaTeste(() => (redeLocal ? g : null));
}

/** Imagem JPEG "de mentira" (cabeçalho certo, conteúdo aleatório). */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);

function caixa() {
  replica.parar(); // cada caixa é um processo
  const ctx = freshTestDb();
  ctx.db.prepare(`UPDATE sync_state SET grupo_sincronizacao_id = 'g-1' WHERE id = 'default'`).run();
  ctx.pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-'));
  ctx.usar = () => { setDbForTesting(ctx.db); fotos._definirPastaParaTeste(ctx.pasta); };
  ctx.usar();
  return ctx;
}

/** Foto escolhida na tela (setFoto copia para a pasta e grava o caminho). */
function porFoto(ctx, productId, bytes, ext = '.jpg') {
  const destino = path.join(ctx.pasta, `${productId}${ext}`);
  fs.writeFileSync(destino, bytes);
  ctx.db.prepare('UPDATE products SET foto_path = ? WHERE id = ?').run(destino, productId);
}

const linha = (ctx, id) => ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const receberProdutos = (g) => replica.receber('produtos', 'g-1', new Map(g.colecoes.produtos));

/** Um ciclo do relógio: fila de produtos, fotos, fila de produtos de novo. */
async function ciclo() {
  await replica.enviarPendentes();
  await replica.trabalharFotos('g-1');
  await replica.enviarPendentes();
}

test.beforeEach(() => fotos._definirCompressorParaTeste((arquivo) => ({ bytes: fs.readFileSync(arquivo), tipo: 'image/jpeg' })));
test.after(() => { fotos._definirCompressorParaTeste(null); fotos._definirPastaParaTeste(null); replica._definirBackendDasFotosParaTeste(null); });

test('foto posta num caixa aparece no outro; trocar e tirar também', async () => {
  const g = grupoFalso();
  usarGrupo(g);
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Coxinha', preco: 6 });
  await replica.sincronizarTudo();
  const b = caixa();
  await replica.sincronizarTudo();
  assert.equal(linha(b, id).foto_path, null);

  // A põe a foto
  a.usar();
  const foto1 = jpeg();
  porFoto(a, id, foto1);
  await ciclo();
  assert.equal(g.colecoes.fotos.size, 1, 'a foto subiu');
  const docFoto = g.colecoes.fotos.get(id);
  assert.equal(docFoto.tipo, 'image/jpeg');
  assert.equal(g.colecoes.produtos.get(id).fotoHash, docFoto.hash, 'o produto leva o fotoHash');

  // B recebe o produto e baixa a foto
  b.usar();
  receberProdutos(g);
  await replica.trabalharFotos('g-1');
  const fotoB = linha(b, id).foto_path;
  assert.ok(fotoB && fotoB.startsWith(b.pasta), 'foto na pasta do caixa B');
  assert.deepEqual(fs.readFileSync(fotoB), foto1);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM grupo_replica_foto_enviar').get().n, 0, 'foto baixada não volta para o grupo');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM grupo_replica_pendente').get().n, 0, 'nem reenvia o produto');
  assert.equal(g.colecoes.fotos.size, 1);

  // A troca a foto
  a.usar();
  const foto2 = jpeg();
  porFoto(a, id, foto2);
  await ciclo();
  b.usar();
  receberProdutos(g);
  await replica.trabalharFotos('g-1');
  assert.deepEqual(fs.readFileSync(linha(b, id).foto_path), foto2, 'B ficou com a foto nova');

  // A tira a foto
  a.usar();
  productService.removeFoto(id);
  await ciclo();
  assert.equal(g.colecoes.produtos.get(id).fotoHash, null);
  b.usar();
  receberProdutos(g);
  assert.equal(linha(b, id).foto_path, null, 'B tirou a foto');
  assert.equal(fs.existsSync(fotoB), false, 'e apagou o arquivo');
});

test('foto de um caixa que ainda não subiu não é apagada por quem não tem foto, e caixa antigo não mexe em foto', async () => {
  const g = grupoFalso();
  usarGrupo(g);
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Pastel', preco: 8 });
  await replica.sincronizarTudo();
  const b = caixa();
  await replica.sincronizarTudo();

  // B põe uma foto e, antes de ela subir, chega do A uma mudança de preço (sem foto)
  const fotoB = jpeg();
  porFoto(b, id, fotoB);
  a.usar();
  a.db.prepare('UPDATE products SET preco = 9 WHERE id = ?').run(id);
  await replica.enviarPendentes();
  assert.equal(g.colecoes.produtos.get(id).fotoHash, null);
  b.usar();
  receberProdutos(g);
  assert.ok(linha(b, id).foto_path, 'a foto do B continua');
  assert.equal(linha(b, id).preco, 9, 'o preço chegou');
  await ciclo();
  a.usar();
  receberProdutos(g);
  await replica.trabalharFotos('g-1');
  assert.deepEqual(fs.readFileSync(linha(a, id).foto_path), fotoB, 'e foi para o A');

  // Caixa de versão antiga manda o produto sem o campo fotoHash: ninguém perde a foto
  const docAntigo = { ...g.colecoes.produtos.get(id), preco: 10, versaoMs: Date.now() + 60000 };
  delete docAntigo.fotoHash;
  g.colecoes.produtos.set(id, docAntigo);
  receberProdutos(g);
  assert.equal(linha(a, id).preco, 10);
  assert.deepEqual(fs.readFileSync(linha(a, id).foto_path), fotoB);
});

test('servidor da loja recusando as fotos não segura o cadastro; a foto sobe depois', async () => {
  const g = grupoFalso();
  g.recusarFotos = true;
  usarGrupo(g);
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Bolo', preco: 30 });
  await replica.sincronizarTudo();
  porFoto(a, id, jpeg());
  a.db.prepare('UPDATE products SET preco = 32 WHERE id = ?').run(id);
  await ciclo();
  assert.equal(g.colecoes.produtos.get(id).preco, 32, 'o preço subiu');
  assert.equal(Object.prototype.hasOwnProperty.call(g.colecoes.produtos.get(id), 'fotoHash'), false, 'sem fotoHash enquanto a foto não sobe');
  assert.equal(g.colecoes.fotos.size, 0);
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM grupo_replica_foto_enviar').get().n, 1, 'a foto espera na fila');

  g.recusarFotos = false;
  fotos._definirCompressorParaTeste((arquivo) => ({ bytes: fs.readFileSync(arquivo), tipo: 'image/jpeg' })); // zera a espera de 5 min
  await ciclo();
  assert.equal(g.colecoes.fotos.size, 1);
  assert.ok(g.colecoes.produtos.get(id).fotoHash);
});

test('sem rede local a foto não passa pela nuvem: espera na fila e vai quando o servidor da loja responde', async () => {
  const g = grupoFalso();
  usarGrupo(g, { redeLocal: false });
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Empada', preco: 7 });
  await replica.sincronizarTudo();
  const b = caixa();
  await replica.sincronizarTudo();

  a.usar();
  porFoto(a, id, jpeg());
  a.db.prepare('UPDATE products SET preco = 8 WHERE id = ?').run(id);
  await ciclo(); await ciclo();
  assert.equal(g.colecoes.produtos.get(id).preco, 8, 'o cadastro continua indo pela nuvem');
  assert.equal(g.pedidosDeFoto, 0, 'nenhuma leitura ou gravação de foto na nuvem');
  assert.equal(g.colecoes.fotos.size, 0);
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM grupo_replica_foto_enviar').get().n, 1, 'a foto espera na fila');

  // Servidor da loja respondeu: a foto sobe e o B baixa por ele.
  usarGrupo(g, { redeLocal: true });
  fotos._definirCompressorParaTeste((arquivo) => ({ bytes: fs.readFileSync(arquivo), tipo: 'image/jpeg' }));
  await ciclo();
  assert.equal(g.colecoes.fotos.size, 1);
  b.usar();
  receberProdutos(g);
  await replica.trabalharFotos('g-1');
  assert.ok(linha(b, id).foto_path, 'o B ficou com a foto');

  // B sem rede local de novo, foto nova no A: o B não busca na nuvem, espera.
  a.usar();
  porFoto(a, id, jpeg());
  await ciclo();
  b.usar();
  usarGrupo(g, { redeLocal: false });
  const antes = g.pedidosDeFoto;
  receberProdutos(g);
  await replica.trabalharFotos('g-1');
  assert.equal(g.pedidosDeFoto, antes, 'B sem servidor da loja não pede foto à nuvem');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM grupo_replica_foto_baixar').get().n, 1, 'a foto nova espera para baixar');
});

test('foto adulterada ou que não é imagem não é gravada; tenta de novo mais tarde', async () => {
  const g = grupoFalso();
  usarGrupo(g);
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Torta', preco: 40 });
  await replica.sincronizarTudo();
  porFoto(a, id, jpeg());
  await ciclo();
  const b = caixa();
  // Alguém troca o conteúdo da foto no grupo sem trocar o hash
  const doc = g.colecoes.fotos.get(id);
  g.colecoes.fotos.set(id, { ...doc, dados: Buffer.from('<script>alert(1)</script>').toString('base64') });
  await replica.sincronizarTudo();
  await replica.trabalharFotos('g-1');
  assert.equal(linha(b, id).foto_path, null);
  const fila = b.db.prepare('SELECT tentativas, proxima_em FROM grupo_replica_foto_baixar').get();
  assert.equal(fila.tentativas, 1);
  assert.ok(fila.proxima_em > Date.now());
  assert.equal(fs.readdirSync(b.pasta).length, 0, 'nenhum arquivo gravado');
});

test('foto grande demais fica só no caixa dela, sem travar a fila', async () => {
  const g = grupoFalso();
  usarGrupo(g);
  const a = caixa();
  const { id } = productService.upsert({ nome: 'Pizza', preco: 50 });
  await replica.sincronizarTudo();
  fotos._definirCompressorParaTeste(() => null);
  porFoto(a, id, jpeg());
  await ciclo();
  assert.equal(g.colecoes.fotos.size, 0);
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM grupo_replica_foto_enviar').get().n, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(g.colecoes.produtos.get(id), 'fotoHash'), false);
});

test('reconhece imagem pelo começo do arquivo', () => {
  assert.equal(fotos.pareceImagem(jpeg(), 'image/jpeg'), true);
  assert.equal(fotos.pareceImagem(jpeg(), 'image/png'), false);
  assert.equal(fotos.pareceImagem(Buffer.from('<svg onload=alert(1)>aaaaaaaa'), 'image/jpeg'), false);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(20)]);
  assert.equal(fotos.pareceImagem(png, 'image/png'), true);
});
