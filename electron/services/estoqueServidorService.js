// Estoque no servidor (caixa com "Mesas e estoque no servidor" ligado em
// Configurações -> Sincronização; é o mesmo interruptor das mesas do servidor,
// mesaCompartilhadaService.ativa()).
//
// Neste caixa o estoque que vale é o do SERVIDOR do grupo: a consulta (lançar
// item, + do carrinho, estoque mostrado na busca e na tela de estoque) pergunta
// a ele pela rede local, e a baixa já vai para ele ao finalizar a venda
// (stockSyncService.verificarEDebitarEstoqueRemoto). Entradas, ajustes e
// inventário só no servidor (`bloqueio`).
//
// Servidor sem responder: a venda segue (vende e acerta depois) -- a baixa fica
// na fila e vai quando ele voltar; nada trava pelo estoque local deste caixa,
// que aqui não é o estoque da loja.

const { getDb } = require('../db/database');

const CACHE_MS = 3000;
let cache = { grupoId: null, em: 0, saldos: null };

function grupoAtual() {
  try { return require('./syncStateService').getGrupoSincronizacaoId() || null; } catch { return null; }
}

/** Este caixa usa o estoque do servidor? */
function apontado() {
  try { return require('./mesaCompartilhadaService').ativa(); } catch { return false; }
}

function invalidar() { cache = { grupoId: null, em: 0, saldos: null }; }

/** Saldos do servidor (id do produto no grupo -> saldo), ou null se ele não respondeu. */
async function saldosDoServidor({ fresco = false } = {}) {
  const grupoId = grupoAtual();
  if (!grupoId) return null;
  if (!fresco && cache.saldos && cache.grupoId === grupoId && Date.now() - cache.em < CACHE_MS) return cache.saldos;
  try {
    const r = await require('./lanClienteService').saldosDeEstoque();
    const saldos = new Map(Object.entries(r?.saldos || {}).map(([k, v]) => [k, Number(v)]));
    cache = { grupoId, em: Date.now(), saldos };
    return saldos;
  } catch (err) {
    console.error('[estoqueServidor] o servidor não informou o estoque:', err?.message || err);
    return null;
  }
}

function docDoProduto(grupoId, productId) {
  return getDb().prepare(`SELECT doc_id FROM grupo_replica WHERE entidade = 'produtos' AND grupo_id = ? AND local_id = ?`)
    .get(grupoId, productId)?.doc_id || productId;
}

/** Quanto de cada produto já está em vendas abertas AQUI (o servidor não sabe delas até finalizar). */
function reservadoAqui(ids) {
  if (!ids.length) return new Map();
  const marcas = ids.map(() => '?').join(',');
  return new Map(getDb().prepare(
    `SELECT si.product_id, SUM(si.quantidade) AS q FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.status = 'aberta' AND si.cancelado = 0 AND si.product_id IN (${marcas}) GROUP BY si.product_id`
  ).all(...ids).map((l) => [l.product_id, l.q]));
}

/**
 * Disponível para vender, por produto DAQUI: Map id -> número, ou id -> null
 * (o grupo não controla esse produto). null no lugar do Map: servidor sem resposta.
 */
async function disponivel(ids, opcoes) {
  const grupoId = grupoAtual();
  const saldos = await saldosDoServidor(opcoes);
  if (!saldos || !grupoId) return null;
  const unicos = [...new Set(ids.filter(Boolean))];
  const reservado = reservadoAqui(unicos);
  const r = new Map();
  for (const id of unicos) {
    const doc = docDoProduto(grupoId, id);
    r.set(id, saldos.has(doc) ? Math.round((saldos.get(doc) - (reservado.get(id) || 0)) * 1000) / 1000 : null);
  }
  return r;
}

/** Saldo de um produto para lançar agora (sempre fresco). null = não trava. */
async function saldoParaLancar(productId) {
  const m = await disponivel([productId], { fresco: true });
  return m ? m.get(productId) ?? null : null;
}

/**
 * Lista com `estoque_atual` (busca do PDV, tela de estoque): troca pelo do
 * servidor. Sem resposta dele ou produto sem contador: estoque_atual = null
 * (a tela não mostra número, em vez de mostrar o estoque local, que aqui não vale).
 */
async function sobreporEstoque(lista) {
  if (!Array.isArray(lista) || !lista.length || !apontado()) return lista;
  const ids = lista.filter((p) => p && p.tipo !== 'servico' && 'estoque_atual' in p).map((p) => p.id);
  if (!ids.length) return lista;
  const m = await disponivel(ids);
  return lista.map((p) => (p && p.tipo !== 'servico' && 'estoque_atual' in p
    ? { ...p, estoque_atual: m ? m.get(p.id) ?? null : null }
    : p));
}

/**
 * Alertas de estoque (crítico/aviso) deste caixa. Com o estoque no servidor, o saldo
 * local daqui é só o que este caixa vendeu (zero ou negativo): o alerta usa o saldo
 * do servidor. Servidor sem resposta: cai para o saldo local, como antes.
 */
async function alertas(locationId, profile) {
  const stockService = require('./stockService');
  if (!apontado()) return stockService.listAlerts(locationId, profile);
  const ids = getDb().prepare('SELECT id FROM products WHERE ativo = 1').all().map((p) => p.id);
  const saldos = await disponivel(ids);
  return stockService.listAlerts(locationId, profile, saldos ? { saldos } : {});
}

/** Produtos no ou abaixo do mínimo, pelo estoque que vale neste caixa. */
async function estoqueBaixo(locationId) {
  const lista = await sobreporEstoque(require('./stockService').getStockForLocation(locationId));
  return lista.filter((p) => p.estoque_atual !== null && p.estoque_atual !== undefined && p.estoque_atual <= p.estoque_minimo);
}

/** Entrada/ajuste/inventário neste caixa: recusa (o estoque é do servidor). */
function bloqueio() {
  if (!apontado()) return null;
  return { ok: false, error: 'Este caixa usa o estoque do servidor: entradas, ajustes e inventário são feitos no computador servidor do grupo.' };
}

module.exports = { apontado, invalidar, saldosDoServidor, disponivel, saldoParaLancar, sobreporEstoque, alertas, estoqueBaixo, bloqueio, reservadoAqui };
