const syncStateService = require('./syncStateService');

/**
 * Cache do catálogo do grupo em MEMÓRIA, só para as buscas "no grupo"
 * (POS, mesa, re-vinculação de códigos). Desde nov/2026 os produtos do
 * grupo também entram no banco de cada caixa (grupoReplicaService, com
 * casamento por código de barras para não duplicar) -- este cache é o
 * mesmo dado, alimentado pela réplica.
 */
let catalogoDoGrupoEmMemoria = new Map();

async function pushProduct() {
  // Desde a réplica completa (grupoReplicaService) quem manda é a fila
  // dos triggers -- pega qualquer caminho que mexa no produto. Aqui só
  // adianta o envio, para a outra máquina ver logo.
  try { await require('./grupoReplicaService').enviarPendentes(); } catch (err) {
    console.error('[productSyncService] falha ao enviar produto (vai na próxima):', err.message);
  }
}

/** Manda TODOS os produtos ativos locais pro grupo de uma vez — chamado
 * quando essa instalação entra num grupo pela primeira vez, pra levar
 * o catálogo que já existia antes de configurar a sincronização. */
/** Entrada num grupo: a réplica lê o grupo inteiro e manda o que falta. */
async function pushTodosOsProdutos() {
  try { await require('./grupoReplicaService').sincronizarTudo(); } catch (err) {
    console.error('[productSyncService] falha ao mandar o catálogo pro grupo:', err.message);
  }
}

/**
 * Liga a réplica do grupo (produtos, clientes e fiado iguais em todos os
 * caixas -- grupoReplicaService). O cache em memória abaixo continua só
 * para as buscas "no grupo" que já existiam; quem o enche agora é a
 * réplica (uma escuta só por coleção).
 */
function iniciarEscutaProdutos() {
  catalogoDoGrupoEmMemoria = new Map();
  try { return require('./grupoReplicaService').iniciar(); } catch (err) {
    console.error('[productSyncService] não foi possível ligar a réplica do grupo:', err);
    return Promise.resolve();
  }
}

/** Chamado pela réplica a cada leva de produtos do grupo. */
function atualizarCacheDoGrupo(mudancas) {
  for (const [id, dados] of mudancas) {
    if (!dados || dados.excluido === true) { catalogoDoGrupoEmMemoria.delete(id); continue; }
    catalogoDoGrupoEmMemoria.set(id, { id, ...dados });
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
async function marcarProdutoExcluidoNoGrupo() {
  // A exclusão/mesclagem já entrou na fila pelos triggers (o produto sumiu
  // ou ficou inativo): a réplica grava a lápide. Aqui só adianta o envio.
  try { await require('./grupoReplicaService').enviarPendentes(); } catch (err) {
    console.error('[productSyncService] falha ao avisar o grupo sobre produto excluído:', err.message);
  }
}

/** O catálogo do grupo inteiro (cache em memória, só leitura) — usado
 * pela re-vinculação em massa de códigos de barras, que precisa olhar
 * TUDO que o grupo tem, não só um resultado de busca pontual. */
function listarCatalogoCompletoDoGrupo() {
  return [...catalogoDoGrupoEmMemoria.values()];
}

/**
 * Mesma re-vinculação por nome da importação de planilha, mas a fonte
 * é o catálogo do grupo (outra máquina sincronizada que já tem os
 * códigos certos) em vez de um arquivo — útil quando duas instalações
 * já sincronizaram antes e uma delas manteve os códigos de barras
 * intactos. Só monta o relatório pra revisão, não aplica nada sozinho.
 */
function prepararRevinculacaoViaGrupo() {
  const catalogoDoGrupo = listarCatalogoCompletoDoGrupo();
  if (catalogoDoGrupo.length === 0) {
    return { ok: false, error: 'Não há catálogo do grupo disponível ainda — confira se essa instalação está mesmo num grupo de sincronização e conectada à internet.' };
  }
  const candidatos = catalogoDoGrupo.map((p) => ({ nome: p.nome, codigoBarras: p.codigoBarras }));
  const productService = require('./productService');
  const resultado = productService.casarCandidatosPorNome(candidatos);
  return { ok: true, ...resultado, totalLinhas: catalogoDoGrupo.length };
}

module.exports = {
  pushProduct, pushTodosOsProdutos, iniciarEscutaProdutos, marcarProdutoExcluidoNoGrupo, atualizarCacheDoGrupo,
  buscarNoCatalogoDoGrupo, buscarNoCatalogoDoGrupoPorCodigoBarras, listarCatalogoCompletoDoGrupo,
  prepararRevinculacaoViaGrupo,
};
