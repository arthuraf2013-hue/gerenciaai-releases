const syncStateService = require('./syncStateService');

/**
 * Cache do catálogo do grupo — só em MEMÓRIA, nunca gravado na tabela
 * local `products`, e some quando o app fecha. Serve só pra consulta
 * (buscar o que existe no grupo, pra decidir se vale trazer pra loja
 * de propósito) — nunca vira parte do catálogo "de verdade" desta
 * máquina sozinho. Isso é deliberado: antes, um produto de outra
 * máquina virava uma linha nova na tabela local automaticamente, o
 * que causava duplicidade quando duas máquinas cadastravam "o mesmo"
 * produto de forma independente antes de nunca terem sincronizado.
 */
let catalogoDoGrupoEmMemoria = new Map();

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
 * silencioso se essa instalação não estiver em nenhum grupo ainda.
 * Isso continua funcionando normalmente: cada máquina PUBLICA o
 * próprio catálogo pro grupo poder consultar — o que mudou é que
 * ninguém mais IMPORTA automaticamente o que os outros publicam. */
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

/**
 * Escuta em tempo real o catálogo do grupo — mas SÓ atualiza o cache
 * em memória (pra consulta), nunca escreve na tabela local `products`.
 * Decisão de propósito, pra impedir a sincronização de catálogo clonar
 * produtos na base local sem ninguém pedir — cada máquina continua
 * dona do próprio catálogo, só pode ENXERGAR o que as outras têm.
 */
function iniciarEscutaProdutos() {
  try {
    if (pararEscutaProdutos) { pararEscutaProdutos(); pararEscutaProdutos = null; }
    catalogoDoGrupoEmMemoria = new Map();
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return;

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { collection, onSnapshot } = require('firebase/firestore');
    const ref = collection(firestore, 'grupos_sincronizacao', grupoId, 'produtos');

    pararEscutaProdutos = onSnapshot(
      ref,
      (snap) => {
        const novoCatalogo = new Map();
        for (const docSnap of snap.docs) {
          const dados = docSnap.data();
          if (dados.excluido === true) continue; // produto removido em outra máquina -- não mostra na consulta
          novoCatalogo.set(docSnap.id, { id: docSnap.id, ...dados });
        }
        catalogoDoGrupoEmMemoria = novoCatalogo;
      },
      (err) => console.error('[productSyncService] escuta de produtos falhou:', err)
    );
  } catch (err) {
    console.error('[productSyncService] não foi possível iniciar a escuta de produtos:', err);
  }
}

/**
 * Busca no catálogo do GRUPO (cache em memória, só leitura) por nome,
 * SKU ou código de barras — pra consultar o que outras máquinas têm
 * cadastrado, sem que isso crie nada na base local sozinho. Quem usa
 * isso decide, de propósito, se quer trazer o produto pra própria
 * loja (via cadastro manual normal) ou só estava conferindo.
 */
function buscarNoCatalogoDoGrupo(query) {
  const termo = (query || '').trim().toLowerCase();
  if (!termo) return [];
  return [...catalogoDoGrupoEmMemoria.values()].filter((p) =>
    (p.nome || '').toLowerCase().includes(termo) ||
    (p.codigoBarras || '') === query ||
    (p.sku || '').toLowerCase() === termo
  );
}

/** Mesma consulta, mas por código de barras exato — útil pro fluxo de
 * "escaneou e não achou local, será que já existe em outra máquina do
 * grupo?". Continua só leitura, não cria nada sozinho. */
function buscarNoCatalogoDoGrupoPorCodigoBarras(codigoBarras) {
  if (!codigoBarras) return null;
  for (const p of catalogoDoGrupoEmMemoria.values()) {
    if (p.codigoBarras === codigoBarras) return p;
  }
  return null;
}

/**
 * Marca um produto como excluído no grupo (mesclado com outro, ou
 * apagado de propósito) — grava uma "lápide" no Firestore, pra sumir
 * da consulta de quem olhar o catálogo do grupo depois. Continua sendo
 * enviado (mesmo que o efeito local de "aplicar automaticamente"
 * tenha sido desligado) porque outras instalações podem ainda estar
 * numa versão anterior do app, que ainda aplica automaticamente — a
 * lápide impede que ELAS tragam esse produto de volta sem querer.
 */
async function marcarProdutoExcluidoNoGrupo(productId) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return;

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'produtos', productId);
    await setDoc(ref, { excluido: true, atualizadoEm: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error('[productSyncService] falha ao marcar produto excluído no grupo:', err.message);
  }
}

module.exports = {
  pushProduct, pushTodosOsProdutos, iniciarEscutaProdutos, marcarProdutoExcluidoNoGrupo,
  buscarNoCatalogoDoGrupo, buscarNoCatalogoDoGrupoPorCodigoBarras,
};
