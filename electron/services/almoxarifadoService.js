const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Perfil Almoxarifado, primeira entrega: endereço físico dos itens
 * (rua-prateleira-posição), setores, saldo por lote em ordem FEFO,
 * ficha de movimentação (kardex) com custo médio e dados de etiqueta.
 *
 * Saldo por lote: o movimento que dá entrada num lote leva `lote_id`
 * (migração 24, batchService.createBatch). Lote antigo, sem nenhum
 * movimento ligado, usa a quantidade de entrada como saldo e sai marcado
 * como `estimado` (o sistema antigo não dava baixa por lote).
 *
 * Nada aqui apaga movimento: endereço e setor só são desativados.
 */

const DIAS_ALERTA_LOTE = 30;

function arred(v, casas = 3) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}
function texto(v, max = 60) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s.slice(0, max);
}
function auditoria(db, tipo, operadorId, motivo) {
  db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
    .run(randomUUID(), tipo, operadorId || null, motivo);
}
function hoje() { return require('./timeService').hojeLocalISO(); }
function emDias(n) { return require('./timeService').diasAPartirDeHojeLocalISO(n); }

/** Código do endereço: partes não vazias, em maiúsculas, ligadas por hífen (ex.: A-03-02). */
function montarCodigo({ rua, prateleira, posicao }) {
  return [rua, prateleira, posicao].map((p) => texto(p, 12).toUpperCase().replace(/[^0-9A-Z]/g, '')).filter(Boolean).join('-');
}

function situacaoValidade(validade, { hojeIso = hoje(), limiteIso = emDias(DIAS_ALERTA_LOTE) } = {}) {
  if (!validade) return 'sem_validade';
  if (validade < hojeIso) return 'vencido';
  if (validade <= limiteIso) return 'vencendo';
  return 'ok';
}

// --- Endereços ---------------------------------------------------------

function listarEnderecos({ incluirInativos = false } = {}) {
  const db = getDb();
  return db.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM almox_item_endereco ie JOIN products p ON p.id = ie.product_id
                  WHERE ie.endereco_id = e.id AND p.ativo = 1) AS itens
     FROM almox_enderecos e ${incluirInativos ? '' : 'WHERE e.ativo = 1'}
     ORDER BY e.codigo COLLATE NOCASE`
  ).all();
}

function salvarEndereco({ id, rua, prateleira, posicao, descricao, operadorId }) {
  const db = getDb();
  const codigo = montarCodigo({ rua, prateleira, posicao });
  if (!texto(rua)) return { ok: false, error: 'Informe ao menos a rua (ou área) do endereço.' };
  if (!codigo) return { ok: false, error: 'Use letras ou números no endereço.' };
  const outro = db.prepare('SELECT id FROM almox_enderecos WHERE codigo = ? COLLATE NOCASE AND id <> ?').get(codigo, id || '');
  if (outro) return { ok: false, error: `Já existe o endereço ${codigo}.` };
  const campos = [codigo, texto(rua, 12), texto(prateleira, 12) || null, texto(posicao, 12) || null, texto(descricao, 120) || null];
  if (id) {
    const r = db.prepare('UPDATE almox_enderecos SET codigo = ?, rua = ?, prateleira = ?, posicao = ?, descricao = ? WHERE id = ?').run(...campos, id);
    if (r.changes === 0) return { ok: false, error: 'Endereço não encontrado.' };
    auditoria(db, 'almox_endereco_alterado', operadorId, `Endereço ${codigo} alterado.`);
    return { ok: true, id, codigo };
  }
  const novoId = randomUUID();
  db.prepare('INSERT INTO almox_enderecos (id, codigo, rua, prateleira, posicao, descricao) VALUES (?, ?, ?, ?, ?, ?)').run(novoId, ...campos);
  auditoria(db, 'almox_endereco_criado', operadorId, `Endereço ${codigo} criado.`);
  return { ok: true, id: novoId, codigo };
}

function ativarEndereco({ id, ativo, operadorId }) {
  const db = getDb();
  const e = db.prepare('SELECT codigo FROM almox_enderecos WHERE id = ?').get(id);
  if (!e) return { ok: false, error: 'Endereço não encontrado.' };
  if (!ativo) {
    const itens = db.prepare('SELECT COUNT(*) AS n FROM almox_item_endereco WHERE endereco_id = ?').get(id).n;
    if (itens > 0) return { ok: false, error: `Tire os ${itens} item(ns) do endereço ${e.codigo} antes de desativá-lo.` };
  }
  db.prepare('UPDATE almox_enderecos SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
  auditoria(db, ativo ? 'almox_endereco_reativado' : 'almox_endereco_desativado', operadorId, `Endereço ${e.codigo} ${ativo ? 'reativado' : 'desativado'}.`);
  return { ok: true };
}

function enderecosDoItem({ productId }) {
  return getDb().prepare(
    `SELECT e.id, e.codigo, e.descricao, ie.principal FROM almox_item_endereco ie
     JOIN almox_enderecos e ON e.id = ie.endereco_id
     WHERE ie.product_id = ? ORDER BY ie.principal DESC, e.codigo COLLATE NOCASE`
  ).all(productId);
}

function itensDoEndereco({ enderecoId, locationId }) {
  return getDb().prepare(
    `SELECT p.id, p.nome, p.unidade, p.codigo_barras, p.sku, ie.principal,
            (SELECT COALESCE(SUM(quantidade), 0) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.location_id = ?) AS saldo
     FROM almox_item_endereco ie JOIN products p ON p.id = ie.product_id
     WHERE ie.endereco_id = ? AND p.ativo = 1 ORDER BY p.nome COLLATE NOCASE`
  ).all(locationId, enderecoId).map((r) => ({ ...r, saldo: arred(r.saldo) }));
}

/** Liga o item ao endereço. O primeiro endereço do item vira o principal;
 * `principal: true` troca o principal (só um por item). */
function vincularEndereco({ productId, enderecoId, principal = false, operadorId }) {
  const db = getDb();
  const p = db.prepare(`SELECT nome FROM products WHERE id = ? AND ativo = 1`).get(productId);
  if (!p) return { ok: false, error: 'Item não encontrado.' };
  const e = db.prepare('SELECT codigo FROM almox_enderecos WHERE id = ? AND ativo = 1').get(enderecoId);
  if (!e) return { ok: false, error: 'Endereço não encontrado ou desativado.' };
  db.transaction(() => {
    const temPrincipal = db.prepare('SELECT 1 FROM almox_item_endereco WHERE product_id = ? AND principal = 1 AND endereco_id <> ?').get(productId, enderecoId);
    const viraPrincipal = principal || !temPrincipal;
    if (viraPrincipal) db.prepare('UPDATE almox_item_endereco SET principal = 0 WHERE product_id = ?').run(productId);
    db.prepare(
      `INSERT INTO almox_item_endereco (product_id, endereco_id, principal) VALUES (?, ?, ?)
       ON CONFLICT (product_id, endereco_id) DO UPDATE SET principal = excluded.principal`
    ).run(productId, enderecoId, viraPrincipal ? 1 : 0);
    auditoria(db, 'almox_item_endereco', operadorId, `${p.nome} guardado em ${e.codigo}${viraPrincipal ? ' (principal)' : ''}.`);
  })();
  return { ok: true };
}

function desvincularEndereco({ productId, enderecoId, operadorId }) {
  const db = getDb();
  const atual = db.prepare('SELECT principal FROM almox_item_endereco WHERE product_id = ? AND endereco_id = ?').get(productId, enderecoId);
  if (!atual) return { ok: false, error: 'O item não está nesse endereço.' };
  db.transaction(() => {
    db.prepare('DELETE FROM almox_item_endereco WHERE product_id = ? AND endereco_id = ?').run(productId, enderecoId);
    // Tirou o principal: o próximo endereço do item (por código) assume.
    if (atual.principal) {
      const prox = db.prepare(
        `SELECT ie.endereco_id FROM almox_item_endereco ie JOIN almox_enderecos e ON e.id = ie.endereco_id
         WHERE ie.product_id = ? ORDER BY e.codigo COLLATE NOCASE LIMIT 1`
      ).get(productId);
      if (prox) db.prepare('UPDATE almox_item_endereco SET principal = 1 WHERE product_id = ? AND endereco_id = ?').run(productId, prox.endereco_id);
    }
    const nomes = db.prepare('SELECT p.nome, e.codigo FROM products p, almox_enderecos e WHERE p.id = ? AND e.id = ?').get(productId, enderecoId);
    auditoria(db, 'almox_item_endereco_removido', operadorId, `${nomes?.nome} retirado de ${nomes?.codigo}.`);
  })();
  return { ok: true };
}

// --- Setores -------------------------------------------------------------

function listarSetores({ incluirInativos = false } = {}) {
  return getDb().prepare(`SELECT * FROM almox_setores ${incluirInativos ? '' : 'WHERE ativo = 1'} ORDER BY nome COLLATE NOCASE`).all();
}

function salvarSetor({ id, nome, responsavel, limiteMensal, operadorId }) {
  const db = getDb();
  const n = texto(nome, 60);
  if (!n) return { ok: false, error: 'Informe o nome do setor.' };
  const limite = limiteMensal === '' || limiteMensal === null || limiteMensal === undefined ? null : Number(limiteMensal);
  if (limite !== null && !(limite >= 0)) return { ok: false, error: 'Limite mensal inválido.' };
  const outro = db.prepare('SELECT id FROM almox_setores WHERE nome = ? COLLATE NOCASE AND id <> ?').get(n, id || '');
  if (outro) return { ok: false, error: `Já existe o setor ${n}.` };
  const valores = [n, texto(responsavel, 80) || null, limite === null ? null : Math.round(limite * 100) / 100];
  if (id) {
    const r = db.prepare('UPDATE almox_setores SET nome = ?, responsavel = ?, limite_mensal = ? WHERE id = ?').run(...valores, id);
    if (r.changes === 0) return { ok: false, error: 'Setor não encontrado.' };
    auditoria(db, 'almox_setor_alterado', operadorId, `Setor ${n} alterado.`);
    return { ok: true, id };
  }
  const novoId = randomUUID();
  db.prepare('INSERT INTO almox_setores (id, nome, responsavel, limite_mensal) VALUES (?, ?, ?, ?)').run(novoId, ...valores);
  auditoria(db, 'almox_setor_criado', operadorId, `Setor ${n} criado.`);
  return { ok: true, id: novoId };
}

function ativarSetor({ id, ativo, operadorId }) {
  const db = getDb();
  const s = db.prepare('SELECT nome FROM almox_setores WHERE id = ?').get(id);
  if (!s) return { ok: false, error: 'Setor não encontrado.' };
  db.prepare('UPDATE almox_setores SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
  auditoria(db, ativo ? 'almox_setor_reativado' : 'almox_setor_desativado', operadorId, `Setor ${s.nome} ${ativo ? 'reativado' : 'desativado'}.`);
  return { ok: true };
}

// --- Lotes (FEFO) ----------------------------------------------------------

const SQL_SALDO_LOTE = `CASE WHEN EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.lote_id = b.id)
  THEN (SELECT SUM(sm.quantidade) FROM stock_movements sm WHERE sm.lote_id = b.id) ELSE b.quantidade END`;

/**
 * Lotes com saldo, na ordem em que devem sair (FEFO): o que vence primeiro
 * vem antes; sem validade vai para o fim, por ordem de entrada.
 */
function lotes({ locationId, productId = null, situacao = 'todos', busca = '', limite = 500 } = {}) {
  const db = getDb();
  const params = [locationId];
  let filtro = '';
  if (productId) { filtro += ' AND b.product_id = ?'; params.push(productId); }
  const termo = texto(busca, 60);
  if (termo) { filtro += ' AND (p.nome LIKE ? OR b.lote LIKE ? OR p.codigo_barras = ?)'; params.push(`%${termo}%`, `%${termo}%`, termo); }
  const linhas = db.prepare(
    `SELECT b.id, b.product_id, b.lote, b.validade, b.quantidade AS qtd_entrada, b.criado_em,
            p.nome AS produto_nome, p.unidade, s.nome AS fornecedor_nome,
            ${SQL_SALDO_LOTE} AS saldo,
            NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.lote_id = b.id) AS estimado
     FROM product_batches b JOIN products p ON p.id = b.product_id
     LEFT JOIN suppliers s ON s.id = b.fornecedor_id
     WHERE b.location_id = ? AND p.ativo = 1 ${filtro}
     ORDER BY b.validade IS NULL, b.validade, b.criado_em, b.rowid`
  ).all(...params);
  const hojeIso = hoje();
  const limiteIso = emDias(DIAS_ALERTA_LOTE);
  const ordemPorProduto = new Map();
  const resultado = [];
  for (const l of linhas) {
    const saldo = arred(l.saldo);
    if (saldo <= 0) continue;
    const ordem = (ordemPorProduto.get(l.product_id) || 0) + 1;
    ordemPorProduto.set(l.product_id, ordem);
    const sit = situacaoValidade(l.validade, { hojeIso, limiteIso });
    if (situacao !== 'todos' && sit !== situacao) continue;
    resultado.push({ ...l, saldo, estimado: !!l.estimado, situacao: sit, ordemFefo: ordem, diasParaVencer: l.validade ? diasEntre(hojeIso, l.validade) : null });
    if (resultado.length >= limite) break;
  }
  return resultado;
}

function diasEntre(deIso, ateIso) {
  return Math.round((Date.parse(`${ateIso}T12:00:00Z`) - Date.parse(`${deIso}T12:00:00Z`)) / 86400000);
}

/** Primeiro lote com saldo do item, na ordem FEFO (o que deve sair agora). */
function proximoLoteFefo({ productId, locationId }) {
  return lotes({ locationId, productId, limite: 1 })[0] || null;
}

// --- Itens -------------------------------------------------------------------

/**
 * Lista de itens do almoxarifado com saldo, endereço principal e próxima
 * validade. Filtros: todos | sem_endereco | abaixo_minimo | vencendo.
 */
function listarItens({ locationId, busca = '', filtro = 'todos', limite = 300 } = {}) {
  const db = getDb();
  const termo = texto(busca, 60);
  const params = [locationId, locationId];
  let where = `p.ativo = 1 AND p.tipo = 'produto'`;
  if (termo) {
    where += ' AND (p.nome LIKE ? OR p.sku = ? OR p.codigo_barras = ? OR p.id IN (SELECT ie.product_id FROM almox_item_endereco ie JOIN almox_enderecos e ON e.id = ie.endereco_id WHERE e.codigo LIKE ?))';
    params.push(`%${termo}%`, termo, termo, `${termo.toUpperCase()}%`);
  }
  const linhas = db.prepare(
    `SELECT p.id, p.nome, p.sku, p.codigo_barras, p.unidade, p.categoria, p.estoque_minimo,
            (SELECT COALESCE(SUM(sm.quantidade), 0) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.location_id = ?) AS saldo,
            (SELECT e.codigo FROM almox_item_endereco ie JOIN almox_enderecos e ON e.id = ie.endereco_id
              WHERE ie.product_id = p.id ORDER BY ie.principal DESC, e.codigo LIMIT 1) AS endereco,
            (SELECT COUNT(*) FROM almox_item_endereco ie WHERE ie.product_id = p.id) AS qtd_enderecos,
            (SELECT MIN(b.validade) FROM product_batches b WHERE b.product_id = p.id AND b.location_id = ? AND b.validade IS NOT NULL
               AND (${SQL_SALDO_LOTE}) > 0) AS proxima_validade
     FROM products p WHERE ${where}
     ORDER BY p.nome COLLATE NOCASE`
  ).all(...params);
  const hojeIso = hoje();
  const limiteIso = emDias(DIAS_ALERTA_LOTE);
  const itens = [];
  for (const l of linhas) {
    const item = {
      ...l,
      saldo: arred(l.saldo),
      abaixoMinimo: Number(l.estoque_minimo) > 0 && arred(l.saldo) < Number(l.estoque_minimo),
      situacaoValidade: situacaoValidade(l.proxima_validade, { hojeIso, limiteIso }),
    };
    if (filtro === 'sem_endereco' && item.qtd_enderecos > 0) continue;
    if (filtro === 'abaixo_minimo' && !item.abaixoMinimo) continue;
    if (filtro === 'vencendo' && !['vencido', 'vencendo'].includes(item.situacaoValidade)) continue;
    itens.push(item);
    if (itens.length >= limite) break;
  }
  return itens;
}

function painel({ locationId }) {
  const todos = listarItens({ locationId, limite: 100000 });
  const lotesAlerta = lotes({ locationId, limite: 100000 }).filter((l) => l.situacao === 'vencido' || l.situacao === 'vencendo');
  return {
    itens: todos.length,
    semEndereco: todos.filter((i) => i.qtd_enderecos === 0).length,
    abaixoMinimo: todos.filter((i) => i.abaixoMinimo).length,
    lotesVencidos: lotesAlerta.filter((l) => l.situacao === 'vencido').length,
    lotesVencendo: lotesAlerta.filter((l) => l.situacao === 'vencendo').length,
    enderecos: getDb().prepare('SELECT COUNT(*) AS n FROM almox_enderecos WHERE ativo = 1').get().n,
    diasAlerta: DIAS_ALERTA_LOTE,
  };
}

// --- Kardex com custo médio --------------------------------------------------

/**
 * Ficha de movimentação do item (kardex do inventário) com o custo médio
 * vigente em cada movimento: o custo_depois da última alteração de custo
 * até aquele instante; antes da primeira alteração, o custo_antes dela;
 * sem histórico nenhum, o custo atual do cadastro.
 */
function kardex({ productId, locationId, dataInicio, dataFim, limite = 500 }) {
  const base = require('./inventarioService').kardex({ productId, locationId, dataInicio, dataFim, limite });
  if (!base.ok) return base;
  const db = getDb();
  const historicoCusto = db.prepare(
    'SELECT custo_antes, custo_depois, criado_em FROM product_cost_history WHERE product_id = ? ORDER BY criado_em, rowid'
  ).all(productId);
  const custoEm = (instante) => {
    let vigente = historicoCusto.length ? historicoCusto[0].custo_antes : Number(base.produto.custo) || 0;
    for (const h of historicoCusto) {
      if (h.criado_em <= instante) vigente = h.custo_depois; else break;
    }
    return Number(vigente) || 0;
  };
  const movimentos = base.movimentos.map((m) => {
    const custoMedio = custoEm(m.criado_em);
    return { ...m, custoMedio, valor: arred(m.quantidade * custoMedio, 2), saldoValor: arred(m.saldo * custoMedio, 2) };
  });
  const custoAtual = Number(base.produto.custo) || 0;
  return {
    ...base,
    movimentos,
    custoAtual,
    valorEntradas: arred(movimentos.filter((m) => m.quantidade > 0).reduce((s, m) => s + m.valor, 0), 2),
    valorSaidas: arred(movimentos.filter((m) => m.quantidade < 0).reduce((s, m) => s - m.valor, 0), 2),
    saldoValor: arred(base.saldoFinal * custoAtual, 2),
  };
}

// --- Etiquetas -----------------------------------------------------------------

/** Dados para etiqueta de item: o código lido é o de barras, senão o SKU. */
function dadosEtiquetas({ productIds = [] }) {
  const db = getDb();
  const ids = [...new Set(productIds)].slice(0, 200);
  return ids.map((id) => {
    const p = db.prepare('SELECT id, nome, sku, codigo_barras, unidade FROM products WHERE id = ?').get(id);
    if (!p) return null;
    const end = db.prepare(
      `SELECT e.codigo FROM almox_item_endereco ie JOIN almox_enderecos e ON e.id = ie.endereco_id
       WHERE ie.product_id = ? ORDER BY ie.principal DESC, e.codigo LIMIT 1`
    ).get(id);
    return { productId: p.id, nome: p.nome, codigo: p.codigo_barras || p.sku || null, unidade: p.unidade, endereco: end?.codigo || null };
  }).filter(Boolean);
}

module.exports = {
  DIAS_ALERTA_LOTE, montarCodigo, situacaoValidade,
  listarEnderecos, salvarEndereco, ativarEndereco, enderecosDoItem, itensDoEndereco, vincularEndereco, desvincularEndereco,
  listarSetores, salvarSetor, ativarSetor,
  lotes, proximoLoteFefo, listarItens, painel, kardex, dadosEtiquetas,
};
