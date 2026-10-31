const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Inventário (contagem de estoque) e movimentação por produto (ERP, Fase 3).
 *
 * Abrir tira uma foto do saldo de cada produto no local e guarda o maior
 * rowid do ledger naquele instante. A loja continua vendendo durante a
 * contagem: no fechamento, o esperado de cada produto é
 *   saldo na abertura + movimentos com rowid posterior à foto
 * e a diferença (contado − esperado) vira um movimento 'ajuste'. Nada é
 * editado no ledger. Ajuste não muda o custo médio; a diferença é
 * valorizada pelo custo atual (perda/sobra em R$).
 *
 * Contagem cega: enquanto aberta, o saldo do sistema não sai pela API.
 */

function arred(v, casas = 3) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

function auditoria(db, tipo, operadorId, motivo) {
  db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
    .run(randomUUID(), tipo, operadorId || null, motivo);
}

function abrir({ locationId, operadorId, cega = true, categoria = null, observacao = null }) {
  const db = getDb();
  const aberta = db.prepare(`SELECT numero FROM inventory_counts WHERE location_id = ? AND status = 'aberta'`).get(locationId);
  if (aberta) return { ok: false, error: `Já existe a contagem nº ${aberta.numero} aberta. Feche ou cancele antes de abrir outra.` };
  const id = randomUUID();
  let total = 0;
  try {
    db.transaction(() => {
      const numero = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM inventory_counts').get().n;
      const ultimoRowid = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS r FROM stock_movements').get().r;
      db.prepare(
        `INSERT INTO inventory_counts (id, numero, location_id, cega, categoria, ultimo_rowid, observacao, aberta_por_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, numero, locationId, cega ? 1 : 0, categoria || null, ultimoRowid, observacao?.trim() || null, operadorId);
      const produtos = db.prepare(
        `SELECT p.id, COALESCE(SUM(sm.quantidade), 0) AS saldo FROM products p
         LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
         WHERE p.ativo = 1 AND COALESCE(p.tipo, 'produto') = 'produto' ${categoria ? 'AND p.categoria = ?' : ''}
         GROUP BY p.id`
      ).all(...(categoria ? [locationId, categoria] : [locationId]));
      const ins = db.prepare('INSERT INTO inventory_count_items (id, count_id, product_id, qtd_sistema) VALUES (?, ?, ?, ?)');
      for (const p of produtos) ins.run(randomUUID(), id, p.id, arred(p.saldo));
      total = produtos.length;
      if (total === 0) throw new Error(categoria ? 'Nenhum produto ativo nesta categoria.' : 'Nenhum produto ativo para contar.');
      auditoria(db, 'inventario_aberto', operadorId, `Contagem nº ${numero} aberta (${total} produto(s)${categoria ? `, categoria ${categoria}` : ''}${cega ? ', cega' : ''}).`);
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, id, produtos: total };
}

function listar({ locationId }) {
  return getDb().prepare(
    `SELECT c.*, u.nome AS aberta_por_nome,
       (SELECT COUNT(*) FROM inventory_count_items i WHERE i.count_id = c.id) AS itens,
       (SELECT COUNT(*) FROM inventory_count_items i WHERE i.count_id = c.id AND i.qtd_contada IS NOT NULL) AS contados,
       (SELECT COALESCE(SUM(i.diferenca * i.custo_unitario), 0) FROM inventory_count_items i WHERE i.count_id = c.id) AS valor_diferenca
     FROM inventory_counts c LEFT JOIN users u ON u.id = c.aberta_por_id
     WHERE c.location_id = ? ORDER BY c.numero DESC LIMIT 100`
  ).all(locationId);
}

/** Itens da contagem. Cega e aberta: sem saldo do sistema na resposta. */
function obter({ id, filtro = 'todos', busca = '' }) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(id);
  if (!c) return null;
  const esconder = c.cega && c.status === 'aberta';
  const params = [id];
  let where = 'i.count_id = ?';
  if (filtro === 'pendentes') where += ' AND i.qtd_contada IS NULL';
  if (filtro === 'contados') where += ' AND i.qtd_contada IS NOT NULL';
  if (filtro === 'diferencas') where += ' AND i.diferenca IS NOT NULL AND ABS(i.diferenca) > 0.0005';
  if (busca && busca.trim()) {
    where += ' AND (p.nome LIKE ? OR p.codigo_barras = ? OR p.sku = ?)';
    params.push(`%${busca.trim()}%`, busca.trim(), busca.trim());
  }
  const itens = db.prepare(
    `SELECT i.*, p.nome, p.unidade, p.codigo_barras, p.sku, p.custo AS custo_atual FROM inventory_count_items i
     JOIN products p ON p.id = i.product_id WHERE ${where} ORDER BY p.nome LIMIT 2000`
  ).all(...params).map((i) => (esconder ? { ...i, qtd_sistema: null } : i));
  const resumo = db.prepare(
    `SELECT COUNT(*) AS itens, SUM(CASE WHEN qtd_contada IS NOT NULL THEN 1 ELSE 0 END) AS contados,
       COALESCE(SUM(CASE WHEN diferenca < 0 THEN diferenca * custo_unitario END), 0) AS perdas,
       COALESCE(SUM(CASE WHEN diferenca > 0 THEN diferenca * custo_unitario END), 0) AS sobras
     FROM inventory_count_items WHERE count_id = ?`
  ).get(id);
  return { ...c, itens, resumo: { ...resumo, perdas: arred(resumo.perdas, 2), sobras: arred(resumo.sobras, 2) } };
}

/**
 * Registra a contagem de um produto, por id ou pelo código lido no leitor.
 * modo 'somar' acumula (bipar caixa por caixa); 'definir' substitui.
 */
function registrarContagem({ countId, productId, codigo, quantidade, modo = 'definir', operadorId }) {
  const db = getDb();
  const c = db.prepare('SELECT status FROM inventory_counts WHERE id = ?').get(countId);
  if (!c) return { ok: false, error: 'Contagem não encontrada.' };
  if (c.status !== 'aberta') return { ok: false, error: 'Esta contagem já foi fechada ou cancelada.' };
  const q = Number(quantidade);
  if (!Number.isFinite(q) || q < 0) return { ok: false, error: 'Quantidade inválida.' };
  let pid = productId;
  if (!pid && codigo) {
    const p = db.prepare('SELECT id FROM products WHERE (codigo_barras = ? OR sku = ?) AND ativo = 1').get(String(codigo).trim(), String(codigo).trim());
    if (!p) return { ok: false, error: `Nenhum produto com o código ${codigo}.` };
    pid = p.id;
  }
  const item = db.prepare(
    `SELECT i.id, i.qtd_contada, p.nome FROM inventory_count_items i JOIN products p ON p.id = i.product_id WHERE i.count_id = ? AND i.product_id = ?`
  ).get(countId, pid);
  if (!item) return { ok: false, error: 'Este produto não faz parte desta contagem (outra categoria, inativo ou serviço).' };
  const nova = modo === 'somar' ? arred((item.qtd_contada || 0) + q) : arred(q);
  db.prepare(`UPDATE inventory_count_items SET qtd_contada = ?, contado_em = NOW_SYNCED(), contado_por_id = ? WHERE id = ?`)
    .run(nova, operadorId || null, item.id);
  return { ok: true, itemId: item.id, nome: item.nome, qtdContada: nova };
}

function limparContagem({ countId, itemId }) {
  const db = getDb();
  const c = db.prepare('SELECT status FROM inventory_counts WHERE id = ?').get(countId);
  if (c?.status !== 'aberta') return { ok: false, error: 'Contagem não está aberta.' };
  db.prepare('UPDATE inventory_count_items SET qtd_contada = NULL, contado_em = NULL, contado_por_id = NULL WHERE id = ? AND count_id = ?').run(itemId, countId);
  return { ok: true };
}

/**
 * Fecha a contagem: cada item contado vira ajuste da diferença. Item não
 * contado fica como está -- a menos que `zerarNaoContados` (o que não foi
 * achado na loja não existe mais).
 */
function fechar({ countId, operadorId, deviceId, zerarNaoContados = false }) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(countId);
  if (!c) return { ok: false, error: 'Contagem não encontrada.' };
  if (c.status !== 'aberta') return { ok: false, error: 'Esta contagem já foi fechada ou cancelada.' };
  const itens = db.prepare('SELECT i.*, p.custo FROM inventory_count_items i JOIN products p ON p.id = i.product_id WHERE i.count_id = ?').all(countId);
  if (!zerarNaoContados && itens.every((i) => i.qtd_contada === null)) return { ok: false, error: 'Nenhum produto foi contado ainda.' };

  const stockSyncService = require('./stockSyncService');
  const movDurante = db.prepare(
    'SELECT COALESCE(SUM(quantidade), 0) AS q FROM stock_movements WHERE product_id = ? AND location_id = ? AND rowid > ?'
  );
  let ajustes = 0;
  let perdas = 0;
  let sobras = 0;
  db.transaction(() => {
    for (const i of itens) {
      const contada = i.qtd_contada === null ? (zerarNaoContados ? 0 : null) : i.qtd_contada;
      if (contada === null) continue;
      const esperada = arred(i.qtd_sistema + movDurante.get(i.product_id, c.location_id, c.ultimo_rowid).q);
      const diferenca = arred(contada - esperada);
      const custo = Number(i.custo) || 0;
      let movId = null;
      if (Math.abs(diferenca) > 0.0005) {
        movId = randomUUID();
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id)
           VALUES (?, ?, ?, 'ajuste', ?, ?, ?, ?)`
        ).run(movId, i.product_id, c.location_id, diferenca, `Inventário nº ${c.numero}${i.qtd_contada === null ? ' (não encontrado)' : ''}`, operadorId, deviceId);
        stockSyncService.registrarMovimentoDoServidor(i.product_id, diferenca, `inventário nº ${c.numero}`);
        ajustes += 1;
        if (diferenca < 0) perdas += diferenca * custo; else sobras += diferenca * custo;
      }
      db.prepare(
        `UPDATE inventory_count_items SET qtd_contada = ?, qtd_esperada = ?, diferenca = ?, custo_unitario = ?, ajuste_movement_id = ? WHERE id = ?`
      ).run(contada, esperada, diferenca, custo, movId, i.id);
    }
    db.prepare(`UPDATE inventory_counts SET status = 'fechada', fechada_em = NOW_SYNCED(), fechada_por_id = ? WHERE id = ?`).run(operadorId, countId);
    auditoria(db, 'inventario_fechado', operadorId,
      `Contagem nº ${c.numero} fechada: ${ajustes} ajuste(s), perdas R$ ${Math.abs(perdas).toFixed(2)}, sobras R$ ${sobras.toFixed(2)}.`);
  })();
  return { ok: true, ajustes, perdas: arred(perdas, 2), sobras: arred(sobras, 2) };
}

function cancelar({ countId, operadorId }) {
  const db = getDb();
  const c = db.prepare('SELECT numero, status FROM inventory_counts WHERE id = ?').get(countId);
  if (!c || c.status !== 'aberta') return { ok: false, error: 'Só contagem aberta pode ser cancelada.' };
  db.transaction(() => {
    db.prepare(`UPDATE inventory_counts SET status = 'cancelada', fechada_em = NOW_SYNCED(), fechada_por_id = ? WHERE id = ?`).run(operadorId, countId);
    auditoria(db, 'inventario_cancelado', operadorId, `Contagem nº ${c.numero} cancelada sem ajustar o estoque.`);
  })();
  return { ok: true };
}

const TIPOS_ROTULO = { venda: 'Venda', entrada: 'Entrada', ajuste: 'Ajuste', perda: 'Perda', estorno: 'Estorno/devolução' };

/**
 * Movimentação de um produto (kardex): cada movimento com o saldo depois
 * dele, mais o histórico de custo. Período opcional; o saldo anterior ao
 * período vem somado.
 */
function kardex({ productId, locationId, dataInicio, dataFim, limite = 500 }) {
  const db = getDb();
  const produto = db.prepare('SELECT id, nome, unidade, custo, codigo_barras FROM products WHERE id = ?').get(productId);
  if (!produto) return { ok: false, error: 'Produto não encontrado.' };
  const timeService = require('./timeService');
  let inicioUtc = null;
  let fimUtc = null;
  if (dataInicio && dataFim) ({ inicioUtc, fimUtcExclusivo: fimUtc } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim));
  const saldoAnterior = inicioUtc
    ? db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS q FROM stock_movements WHERE product_id = ? AND location_id = ? AND criado_em < ?').get(productId, locationId, inicioUtc).q
    : 0;
  const movs = db.prepare(
    `SELECT sm.id, sm.tipo, sm.quantidade, sm.motivo, sm.criado_em, sm.sale_id, u.nome AS operador_nome
     FROM stock_movements sm LEFT JOIN users u ON u.id = sm.operador_id
     WHERE sm.product_id = ? AND sm.location_id = ? ${inicioUtc ? 'AND sm.criado_em >= ? AND sm.criado_em < ?' : ''}
     ORDER BY sm.criado_em, sm.rowid`
  ).all(...(inicioUtc ? [productId, locationId, inicioUtc, fimUtc] : [productId, locationId]));
  let saldo = saldoAnterior;
  const linhas = movs.map((m) => {
    saldo = arred(saldo + m.quantidade);
    return { ...m, tipoRotulo: TIPOS_ROTULO[m.tipo] || m.tipo, saldo };
  });
  const custos = db.prepare(
    `SELECT tipo, qtd_movimento, custo_movimento, custo_antes, custo_depois, origem, criado_em FROM product_cost_history
     WHERE product_id = ? ORDER BY criado_em DESC, rowid DESC LIMIT 50`
  ).all(productId);
  const entradas = arred(linhas.filter((l) => l.quantidade > 0).reduce((s, l) => s + l.quantidade, 0));
  const saidas = arred(linhas.filter((l) => l.quantidade < 0).reduce((s, l) => s - l.quantidade, 0));
  return {
    ok: true, produto, saldoAnterior: arred(saldoAnterior), saldoFinal: arred(saldo), entradas, saidas,
    movimentos: linhas.length > limite ? linhas.slice(-limite) : linhas, cortado: linhas.length > limite, custos,
  };
}

module.exports = { abrir, listar, obter, registrarContagem, limparContagem, fechar, cancelar, kardex };
