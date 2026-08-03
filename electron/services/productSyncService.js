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
          productService.aplicarProdutoSincronizado(docSnap.id, docSnap.data());
        }
      },
      (err) => console.error('[productSyncService] escuta de produtos falhou:', err)
    );
  } catch (err) {
    console.error('[productSyncService] não foi possível iniciar a escuta de produtos:', err);
  }
}

module.exports = { pushProduct, pushTodosOsProdutos, iniciarEscutaProdutos };
