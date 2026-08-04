const syncStateService = require('./syncStateService');

/** Campos do produto que fazem sentido "serem os mesmos" entre PDVs —
 * NUNCA inclui estoque (isso é físico, por máquina) nem preço de
 * custo interno sensível a decisão local... na verdade custo também
 * compartilha, já que é sobre o MESMO produto sendo vendido — só
 * estoque (quantidade física presente) é que nunca sincroniza. */
const CAMPOS_SINCRONIZADOS = [
  'nome', 'categoria', 'preco', 'custo', 'unidade', 'sku', 'codigoBarras',
  'ncm', 'cest', 'cfop', 'cstCsosn', 'origemMercadoria', 'estoqueMinimo', 'ativo',
];

/** Manda a versão atual de um produto pro grupo — best-effort,
 * silencioso se essa instalação não estiver em nenhum grupo ainda. */
async function pushProduct(product) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return;

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');

    const dados = {};
    for (const campo of CAMPOS_SINCRONIZADOS) {
      if (product[campo] !== undefined) dados[campo] = product[campo];
    }
    dados.atualizadoEm = serverTimestamp();

    const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'produtos', product.id);
    await setDoc(ref, dados, { merge: true });
  } catch (err) {
    console.error('[productSyncService] falha ao sincronizar produto (não afeta o produto local):', err.message);
  }
}

/** Manda TODOS os produtos ativos locais pro grupo de uma vez — chamado
 * quando essa instalação entra num grupo pela primeira vez, pra levar
 * o catálogo que já existia antes de configurar a sincronização. */
async function pushTodosOsProdutos() {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return;

    const { getDb } = require('../db/database');
    const db = getDb();
    const produtos = db.prepare('SELECT * FROM products WHERE ativo = 1').all();

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, writeBatch, serverTimestamp } = require('firebase/firestore');
    const batch = writeBatch(firestore);

    for (const p of produtos) {
      const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'produtos', p.id);
      batch.set(ref, {
        nome: p.nome, categoria: p.categoria, preco: p.preco, custo: p.custo, unidade: p.unidade,
        sku: p.sku, codigoBarras: p.codigo_barras, ncm: p.ncm, cest: p.cest, cfop: p.cfop,
        cstCsosn: p.cst_csosn, origemMercadoria: p.origem_mercadoria, estoqueMinimo: p.estoque_minimo,
        ativo: true, atualizadoEm: serverTimestamp(),
      }, { merge: true });
    }
    if (produtos.length > 0) await batch.commit();
  } catch (err) {
    console.error('[productSyncService] falha ao mandar o catálogo inteiro pro grupo:', err.message);
  }
}

let pararEscutaProdutos = null;

/** Escuta em tempo real o catálogo do grupo — aplica localmente
 * qualquer produto novo ou alterado em QUALQUER PDV do grupo (inclusive
 * o catálogo inteiro de uma vez, na primeira vez que a escuta liga). */
function iniciarEscutaProdutos() {
  try {
    if (pararEscutaProdutos) { pararEscutaProdutos(); pararEscutaProdutos = null; }
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return;

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { collection, onSnapshot } = require('firebase/firestore');
    const ref = collection(firestore, 'grupos_sincronizacao', grupoId, 'produtos');

    pararEscutaProdutos = onSnapshot(
      ref,
      (snap) => {
        const productService = require('./productService');
        for (const docSnap of snap.docs) {
          // Cada produto é aplicado isoladamente — se UM tiver problema
          // (ex: código de barras que já pertence a outro produto
          // cadastrado localmente antes da sincronização começar), os
          // OUTROS produtos do grupo continuam sincronizando
          // normalmente. Sem isso, um único conflito travava a escuta
          // inteira pra sempre (o Firestore reenvia a lista toda a
          // cada mudança, então o mesmo erro se repetia sem parar).
          try {
            productService.aplicarProdutoSincronizado(docSnap.id, docSnap.data());
          } catch (err) {
            aplicarComTratamentoDeConflito(docSnap.id, docSnap.data(), err);
          }
        }
      },
      (err) => console.error('[productSyncService] escuta de produtos falhou:', err)
    );
  } catch (err) {
    console.error('[productSyncService] não foi possível iniciar a escuta de produtos:', err);
  }
}

/**
 * Quando aplicar um produto sincronizado falha por causa de um
 * código de barras que já pertence a OUTRO produto cadastrado
 * localmente antes da sincronização começar — não dá pra simplesmente
 * ignorar o produto inteiro (perderia nome/preço atualizados), nem dá
 * pra forçar o código de barras (roubaria ele do produto local que já
 * usava). Tenta de novo sem o código de barras — o resto do produto
 * (nome, preço, categoria) sincroniza normalmente, e reporta o
 * conflito pra investigar depois.
 */
function aplicarComTratamentoDeConflito(productId, dados, erroOriginal) {
  const ehConflitoDeCodigoBarras = /UNIQUE constraint failed: products\.codigo_barras/.test(erroOriginal?.message || '');
  if (!ehConflitoDeCodigoBarras) {
    console.error('[productSyncService] falha ao aplicar produto sincronizado:', erroOriginal);
    try {
      require('./errorReportService').reportarErro({
        mensagem: erroOriginal?.message, stack: erroOriginal?.stack, contexto: 'aplicarProdutoSincronizado',
      });
    } catch (err) { /* reportarErro já trata os próprios erros internamente */ }
    return;
  }

  try {
    const productService = require('./productService');
    productService.aplicarProdutoSincronizado(productId, { ...dados, codigoBarras: null, conflitoCodigoBarrasPendente: dados.codigoBarras });
    console.error(
      `[productSyncService] produto ${productId} tem código de barras "${dados.codigoBarras}" que já pertence a outro produto local — ` +
      'sincronizou o resto (nome, preço) sem o código de barras. Precisa resolver manualmente qual dos dois deveria ter esse código.'
    );
    require('./errorReportService').reportarErro({
      mensagem: `Conflito de código de barras ao sincronizar produto: "${dados.codigoBarras}" já pertence a outro produto local. Aplicado sem o código de barras — resolver manualmente.`,
      contexto: 'aplicarProdutoSincronizado:conflito_codigo_barras',
    });
  } catch (err) {
    console.error('[productSyncService] falha até tentando aplicar sem o código de barras:', err);
  }
}

module.exports = { pushProduct, pushTodosOsProdutos, iniciarEscutaProdutos };
