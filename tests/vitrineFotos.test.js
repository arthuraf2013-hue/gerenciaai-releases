// Fotos dos produtos nas vitrines e a ilustração de quem não tem foto (nov/2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { freshTestDb, createProduct, addStock } = require('./helpers/testDb');
const vitrine = require('../electron/services/vitrineService');
const fotosSvc = require('../electron/services/vitrineFotoService');
const visual = require('../electron/services/vitrineVisual');
const productService = require('../electron/services/productService');
const licenseService = require('../electron/services/licenseService');

licenseService.getLicenseFirestore = () => ({});

// Miniatura falsa: o conteúdo do arquivo vira o "JPEG" (sem Electron no teste).
fotosSvc._definirGeradorParaTeste((arquivo) => {
  const bytes = fs.readFileSync(arquivo);
  return bytes.toString().startsWith('ruim') ? null : { bytes, tipo: 'image/jpeg' };
});

function gravarFoto(db, productId, conteudo) {
  const arquivo = path.join(productService.fotosDir(), `teste-vitrine-${productId}.jpg`);
  fs.writeFileSync(arquivo, conteudo);
  db.prepare('UPDATE products SET foto_path = ? WHERE id = ?').run(arquivo, productId);
  return arquivo;
}

function loja() {
  const ctx = freshTestDb();
  const ids = {};
  for (const [nome, cat] of [['Amstel latão', 'Bebidas'], ['Água sem gás', 'Bebidas'], ['Charque', 'Pratos'], ['Baião', 'Pratos']]) {
    ids[nome] = createProduct(ctx.db, { nome, preco: 10, categoria: cat });
    addStock(ctx.db, { productId: ids[nome], locationId: ctx.locationId, quantidade: 5, operadorId: ctx.adminId });
  }
  vitrine.getConfig();
  ctx.db.prepare("UPDATE vitrine_config SET slug = 'bar-teste', ativa = 1 WHERE id = 'default'").run();
  return { ...ctx, ids };
}

function nuvemFalsa() {
  const n = { docs: new Map(), escritas: [], apagados: [], falharFoto: false };
  n.api = {
    doc: (_fs, ...p) => p.join('/'),
    serverTimestamp: () => 0,
    setDoc: async (ref, dados) => { if (n.falharFoto && ref.includes('/fotos_')) throw new Error('rede'); n.docs.set(ref, dados); n.escritas.push(ref); },
    deleteDoc: async (ref) => { n.docs.delete(ref); n.apagados.push(ref); },
    writeBatch: () => { const l = []; return { set: (ref, d) => l.push([ref, d]), commit: async () => { for (const [r, d] of l) { n.docs.set(r, d); n.escritas.push(r); } } }; },
  };
  return n;
}

const catalogo = (n) => [...n.docs.entries()].find(([k]) => k.endsWith('/vitrine/catalogo'))?.[1];
const docFotos = (n, i) => [...n.docs.entries()].find(([k]) => k.endsWith(`/vitrine/fotos_${i}`))?.[1];

test('publica as miniaturas, o item leva a chave e só reenvia o que mudou', async (t) => {
  const { db, ids } = loja();
  const n = nuvemFalsa();
  vitrine._definirNuvemParaTeste(n.api);
  t.after(() => vitrine._definirNuvemParaTeste(null));
  const a1 = gravarFoto(db, ids['Amstel latão'], 'foto-amstel');
  const a2 = gravarFoto(db, ids.Charque, 'foto-charque');
  const a3 = gravarFoto(db, ids.Baião, 'ruim'); // o Electron não abriu: fica sem foto
  t.after(() => [a1, a2, a3].forEach((a) => fs.rmSync(a, { force: true })));

  const r = await vitrine.publicarSeMudou();
  assert.equal(r.publicado, true);
  assert.equal(r.fotos, 2);
  const itens = catalogo(n).itens;
  const amstel = itens.find((i) => i.id === ids['Amstel latão']);
  assert.match(amstel.foto, /^[a-f0-9]{16}$/);
  assert.equal(itens.find((i) => i.id === ids['Água sem gás']).foto, undefined);
  assert.equal(itens.find((i) => i.id === ids.Baião).foto, undefined);
  assert.equal(catalogo(n).fotosDocs, 1);
  assert.equal(docFotos(n, 0).fotos[amstel.foto], `data:image/jpeg;base64,${Buffer.from('foto-amstel').toString('base64')}`);

  // Nada mudou: não escreve nada.
  n.escritas.length = 0;
  assert.equal((await vitrine.publicarSeMudou()).motivo, 'sem_mudanca');
  assert.deepEqual(n.escritas, []);

  // Trocou uma foto: reenvia o documento de fotos e o catálogo (chave nova).
  fs.writeFileSync(a1, 'foto-amstel-nova');
  fs.utimesSync(a1, new Date(), new Date(Date.now() + 5000));
  await vitrine.publicarSeMudou();
  assert.ok(n.escritas.some((e) => e.endsWith('/fotos_0')));
  assert.notEqual(catalogo(n).itens.find((i) => i.id === ids['Amstel latão']).foto, amstel.foto);

  // Fechou a vitrine: as fotos saem da nuvem também.
  db.prepare("UPDATE vitrine_config SET ativa = 0 WHERE id = 'default'").run();
  await vitrine.publicarSeMudou();
  assert.ok(n.apagados.some((e) => e.endsWith('/fotos_0')));
  assert.deepEqual(catalogo(n).itens, []);
});

test('foto que não subiu não segura o catálogo e sobe na próxima rodada', async (t) => {
  const { db, ids } = loja();
  const n = nuvemFalsa();
  vitrine._definirNuvemParaTeste(n.api);
  t.after(() => vitrine._definirNuvemParaTeste(null));
  const a = gravarFoto(db, ids.Charque, 'foto-charque-2');
  t.after(() => fs.rmSync(a, { force: true }));
  n.falharFoto = true;
  const r = await vitrine.publicarSeMudou();
  assert.equal(r.publicado, true);
  assert.ok(catalogo(n), 'catálogo publicado mesmo assim');
  assert.equal(vitrine.getConfig().falhaPublicacao.motivo, 'erro');
  n.falharFoto = false;
  const r2 = await vitrine.publicarSeMudou();
  assert.equal(r2.publicado, true);
  assert.ok(docFotos(n, 0));
  assert.equal(vitrine.getConfig().falhaPublicacao, null);
});

test('muitas fotos: divide em documentos de até ~850 KB e para no limite', () => {
  const { db } = freshTestDb();
  const itens = [];
  const arquivos = [];
  for (let i = 0; i < 30; i++) {
    const id = createProduct(db, { nome: `Produto ${i}`, preco: 5 });
    arquivos.push(gravarFoto(db, id, `x${i}`.padEnd(400 * 1024, String(i % 10))));
    itens.push({ id, nome: `Produto ${i}`, preco: 5 });
  }
  try {
    const { itens: comFoto, docs } = fotosSvc.prepararFotos(itens);
    assert.equal(docs.length, fotosSvc.MAX_DOCS);
    for (const d of docs) assert.ok(JSON.stringify(d.fotos).length <= fotosSvc.LIMITE_DOC + 100);
    const publicadas = new Set(docs.flatMap((d) => Object.keys(d.fotos)));
    assert.equal(comFoto.filter((i) => i.foto).length, publicadas.size);
    assert.ok(comFoto.every((i) => !i.foto || publicadas.has(i.foto)), 'item só aponta para foto que foi publicada');
  } finally {
    arquivos.forEach((a) => fs.rmSync(a, { force: true }));
  }
});

test('ilustração: emoji pelo nome/categoria e a vitrine online usa a mesma tabela', async () => {
  const casos = [
    ['AMSTEL LATÃO', 'BEBIDAS', '🍺'], ['AGUA COM GÁS', 'BEBIDAS', '💧'], ['ALCATRÃO DOSE', 'BEBIDAS', '🥃'],
    ['Coca-Cola lata', 'Bebidas', '🥤'], ['Caipirinha', 'Drinks', '🍹'], ['Charque acebolada', 'Pratos', '🥩'],
    ['Baião de dois', 'Pratos', '🍛'], ['X-Tudo', 'Lanches', '🍔'], ['Xícara', 'Utilidades', '🛍️'],
    ['Ração 15kg', 'Pet', '🐾'], ['Dipirona 500mg', 'Farmácia', '💊'], ['Produto qualquer', 'Comidas', '🍽️'],
  ];
  const web = await import(pathToFileURL(path.join(__dirname, '../pwa-mobile/loja-visual.js')).href);
  assert.deepEqual(web.REGRAS_EMOJI, visual.REGRAS_EMOJI);
  assert.deepEqual(web.CORES_CATEGORIA, visual.CORES_CATEGORIA);
  for (const [nome, cat, emoji] of casos) {
    assert.equal(visual.emojiDoProduto(nome, cat), emoji, nome);
    assert.equal(web.emojiDoProduto(nome, cat), emoji, nome);
    assert.equal(web.corDaCategoria(cat), visual.corDaCategoria(cat));
  }
  // A página do QR da mesa leva as mesmas funções no <script>.
  const f = new Function(`${visual.fonteParaPagina()}; return { emojiDoProduto, corDaCategoria };`)();
  for (const [nome, cat, emoji] of casos) {
    assert.equal(f.emojiDoProduto(nome, cat), emoji, nome);
    assert.equal(f.corDaCategoria(cat), visual.corDaCategoria(cat));
  }
});
