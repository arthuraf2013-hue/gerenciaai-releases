// Política de estoque na venda (Configurações -> Estoque na venda).
//
// "Vender mesmo sem estoque": o item entra sempre; o estoque fica negativo,
// o caixa vê um aviso dizendo ONDE falta (neste PC, no servidor, no grupo,
// quanto está preso em comandas abertas) e o item fica marcado para o
// relatório "Vendido sem estoque" (acertar a entrada depois). Desligado: trava
// como antes, mas com a mesma explicação.
//
// Padrão: ligado no perfil Restaurante (a venda nunca pode parar; prato feito
// na hora e estoque que ficou em outro computador não podem travar o salão);
// desligado nos outros (farmácia, ótica, varejo podem precisar travar).
// Fica em business_profile.config_json.venderSemEstoque.

const { getDb } = require('../db/database');

const PERFIS_QUE_VENDEM_SEM_ESTOQUE = ['restaurante'];

function lerConfig(db) {
  const r = db.prepare("SELECT perfil_ativo, config_json FROM business_profile WHERE id = 'default'").get();
  let cfg = {};
  try { cfg = JSON.parse(r?.config_json || '{}') || {}; } catch { cfg = {}; }
  return { perfil: r?.perfil_ativo || 'generico', cfg };
}

/** { venderSemEstoque, padrao, escolhido } */
function getPolitica() {
  const { perfil, cfg } = lerConfig(getDb());
  const padrao = PERFIS_QUE_VENDEM_SEM_ESTOQUE.includes(perfil);
  const escolhido = typeof cfg.venderSemEstoque === 'boolean';
  return { venderSemEstoque: escolhido ? cfg.venderSemEstoque : padrao, padrao, escolhido, perfil };
}

function venderSemEstoque() {
  try { return getPolitica().venderSemEstoque; } catch { return false; }
}

function setPolitica({ venderSemEstoque: vender, requestingUserId } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) return { ok: false, error: 'Apenas gerente ou administrador muda a política de estoque.' };
  const { cfg } = lerConfig(db);
  cfg.venderSemEstoque = !!vender;
  db.prepare("INSERT OR IGNORE INTO business_profile (id) VALUES ('default')").run();
  db.prepare("UPDATE business_profile SET config_json = ? WHERE id = 'default'").run(JSON.stringify(cfg));
  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'politica_estoque_alterada', solicitanteId: requestingUserId,
      motivo: vender ? 'Vender mesmo sem estoque: LIGADO' : 'Vender mesmo sem estoque: DESLIGADO (trava sem estoque)',
    });
  } catch { /* auditoria é extra */ }
  return { ok: true, ...getPolitica() };
}

/** Itens vendidos sem estoque (marcados na venda), para acertar a entrada. */
function vendidosSemEstoque({ dias = 30 } = {}) {
  const db = getDb();
  const n = Math.min(365, Math.max(1, Number(dias) || 30));
  const linhas = db.prepare(`
    SELECT p.id AS productId, p.nome, p.unidade, SUM(si.quantidade) AS quantidade, COUNT(DISTINCT si.sale_id) AS vendas,
           MAX(si.criado_em) AS ultima, MAX(si.aviso_estoque) AS aviso
    FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id
    WHERE si.vendido_sem_estoque = 1 AND si.cancelado = 0 AND s.status <> 'cancelada'
      AND si.criado_em >= datetime('now', ?)
    GROUP BY p.id ORDER BY ultima DESC`).all(`-${n} days`);
  const stock = require('./stockService');
  const loc = db.prepare('SELECT id FROM locations LIMIT 1').get();
  return linhas.map((l) => ({ ...l, estoqueAtual: loc ? stock.getCurrentStock(l.productId, loc.id) : null }));
}

/**
 * Comandas/vendas abertas há mais de `horas` (seguram estoque reservado e
 * confundem o caixa). Para revisar e cancelar/fechar.
 */
function comandasEsquecidas({ horas = 12 } = {}) {
  const db = getDb();
  const h = Math.min(24 * 30, Math.max(1, Number(horas) || 12));
  return db.prepare(`
    SELECT s.id AS saleId, s.criado_em AS abertaEm, u.nome AS operador,
           (SELECT COALESCE(t.nome, 'Mesa ' || t.numero) FROM restaurant_tables t WHERE t.sale_id = s.id AND t.unida_a_mesa_id IS NULL) AS mesa,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.cancelado = 0) AS itens,
           (SELECT COALESCE(SUM(si.quantidade * si.preco_unitario), 0) FROM sale_items si WHERE si.sale_id = s.id AND si.cancelado = 0) AS total,
           (SELECT COALESCE(SUM(valor), 0) FROM payments pg WHERE pg.sale_id = s.id) AS pago
    FROM sales s LEFT JOIN users u ON u.id = s.operador_id
    WHERE s.status = 'aberta' AND s.criado_em <= datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM mesa_remota_fechamentos f WHERE f.sale_id = s.id)
      AND (EXISTS (SELECT 1 FROM restaurant_tables t WHERE t.sale_id = s.id)
           OR EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.cancelado = 0))
    ORDER BY s.criado_em`).all(`-${h} hours`);
}

function exigirGestao(db, userId) {
  const u = db.prepare('SELECT id, role, pin_hash FROM users WHERE id = ? AND ativo = 1').get(userId);
  if (!u || !['gerente', 'admin', 'suporte'].includes(u.role)) return { erro: 'Apenas gerente ou administrador faz isso.' };
  return { u };
}

/**
 * Cancela uma comanda esquecida (aberta há horas, sem pagamento): o
 * estoque volta e a mesa fica livre. Pede o PIN de quem está fazendo
 * (gerente/admin/suporte). Com pagamento, não: abra a mesa e conclua.
 */
function cancelarComandaEsquecida({ saleId, requestingUserId, pin, motivo, locationId, deviceId } = {}) {
  const db = getDb();
  const { u, erro } = exigirGestao(db, requestingUserId);
  if (erro) return { ok: false, error: erro };
  if (!pin || !require('bcryptjs').compareSync(String(pin), u.pin_hash)) return { ok: false, error: 'PIN incorreto.' };
  const venda = db.prepare('SELECT id, status, criado_em FROM sales WHERE id = ?').get(saleId);
  if (!venda) return { ok: false, error: 'Comanda não encontrada.' };
  if (venda.status !== 'aberta') return { ok: false, error: 'Essa comanda já foi fechada.' };
  if (db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(saleId).c > 0) {
    return { ok: false, error: 'Essa comanda já tem pagamento: abra a mesa e conclua a conta (ou devolva o pagamento antes).' };
  }
  try {
    if (db.prepare("SELECT 1 FROM restaurant_tables WHERE sale_id = ? AND fechando_caixa_id IS NOT NULL").get(saleId)) {
      return { ok: false, error: 'Essa mesa está sendo paga em outro caixa agora.' };
    }
  } catch { /* banco sem a coluna */ }
  const loc = locationId || db.prepare('SELECT id FROM locations LIMIT 1').get()?.id;
  const texto = `Comanda esquecida (aberta em ${venda.criado_em})${motivo ? `: ${String(motivo).slice(0, 200)}` : ''}`;
  const r = require('./saleService').cancelarVendaAbertaPeloSistema({
    saleId, locationId: loc, operadorId: u.id, motivo: texto, deviceId: deviceId || 'gestao',
  });
  if (!r.ok) return r;
  require('./tableService').repararMesasComVendaFechada(db); // a mesa fica livre
  try {
    require('./authService').registrarEventoAuditoria({ tipoEvento: 'comanda_esquecida_cancelada', solicitanteId: u.id, motivo: texto });
  } catch { /* extra */ }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Unificar estoque no servidor (caixa de um grupo, não o servidor).
//
// Entradas, ajustes e perdas lançados NESTE caixa ficam só no estoque local:
// o estoque do grupo (no servidor) não sabe delas, e aí o servidor diz "0".
// Isto leva ao servidor, como variação (soma no contador), cada movimento
// que não é de venda e ainda não foi levado; depois zera esse saldo aqui
// (ajuste "Levado ao servidor"), para não contar duas vezes.
// As vendas deste caixa já baixam no servidor ao finalizar: não entram.
// ---------------------------------------------------------------------------

function movimentosParaUnificar(db) {
  return db.prepare(`
    SELECT m.product_id AS productId, p.nome, p.unidade, SUM(m.quantidade) AS quantidade, COUNT(*) AS movimentos
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.sale_id IS NULL AND m.tipo IN ('entrada','ajuste','perda') AND p.tipo <> 'servico'
      AND NOT EXISTS (SELECT 1 FROM estoque_unificacao u WHERE u.movement_id = m.id)
    GROUP BY m.product_id HAVING ABS(SUM(m.quantidade)) > 0.0005
    ORDER BY p.nome`).all();
}

function situacaoParaUnificar() {
  const sync = require('./syncStateService');
  if (!sync.getGrupoSincronizacaoId()) return { pode: false, motivo: 'Este computador não está num grupo.' };
  if (sync.ehServidorDoGrupo()) return { pode: false, motivo: 'Este computador é o servidor: o estoque dele já é o do grupo.' };
  return { pode: true };
}

function previaUnificacao() {
  const sit = situacaoParaUnificar();
  if (!sit.pode) return { ok: true, pode: false, motivo: sit.motivo, produtos: [] };
  return { ok: true, pode: true, produtos: movimentosParaUnificar(getDb()) };
}

function unificarNoServidor({ requestingUserId, productIds = null, locationId, deviceId } = {}) {
  const db = getDb();
  const { u, erro } = exigirGestao(db, requestingUserId);
  if (erro) return { ok: false, error: erro };
  const sit = situacaoParaUnificar();
  if (!sit.pode) return { ok: false, error: sit.motivo };
  const filtro = Array.isArray(productIds) && productIds.length ? new Set(productIds) : null;
  const loc = locationId || db.prepare('SELECT id FROM locations LIMIT 1').get()?.id;
  if (!loc) return { ok: false, error: 'Nenhum local cadastrado neste computador.' };
  const { randomUUID } = require('crypto');
  const stockSync = require('./stockSyncService');
  const lote = randomUUID();
  const enviados = [];
  const tx = db.transaction(() => {
    for (const prod of movimentosParaUnificar(db)) {
      if (filtro && !filtro.has(prod.productId)) continue;
      const movs = db.prepare(`
        SELECT m.id, m.quantidade FROM stock_movements m
        WHERE m.product_id = ? AND m.sale_id IS NULL AND m.tipo IN ('entrada','ajuste','perda')
          AND NOT EXISTS (SELECT 1 FROM estoque_unificacao u WHERE u.movement_id = m.id)`).all(prod.productId);
      const total = Math.round(movs.reduce((acc, m) => acc + m.quantidade, 0) * 1000) / 1000;
      if (!total) continue;
      const marcar = db.prepare('INSERT INTO estoque_unificacao (movement_id, product_id, quantidade, lote) VALUES (?, ?, ?, ?)');
      for (const m of movs) marcar.run(m.id, prod.productId, m.quantidade, lote);
      // Zera aqui o que foi levado (e marca o ajuste para não ir de novo).
      const ajusteId = randomUUID();
      db.prepare(`INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id)
                  VALUES (?, ?, ?, 'ajuste', ?, 'Levado ao estoque do servidor (Unificar estoque)', ?, ?)`)
        .run(ajusteId, prod.productId, loc, -total, u.id, deviceId || 'gestao');
      marcar.run(ajusteId, prod.productId, -total, lote);
      // Vai para a fila do grupo (sai sozinha quando o servidor responder).
      if (!stockSync.enfileirarVariacao(prod.productId, total, 'unificar estoque de um caixa')) throw new Error('SEM_GRUPO');
      enviados.push({ productId: prod.productId, nome: prod.nome, quantidade: total });
    }
  });
  try { tx(); } catch (err) {
    if (err.message === 'SEM_GRUPO') return { ok: false, error: 'Este computador saiu do grupo. Nada foi alterado.' };
    throw err;
  }
  if (enviados.length) {
    try {
      require('./authService').registrarEventoAuditoria({
        tipoEvento: 'estoque_unificado_no_servidor', solicitanteId: u.id,
        motivo: enviados.map((e) => `${e.nome}: ${e.quantidade > 0 ? '+' : ''}${e.quantidade}`).join('; ').slice(0, 480),
      });
    } catch { /* extra */ }
  }
  return { ok: true, lote, enviados };
}

module.exports = {
  getPolitica, setPolitica, venderSemEstoque, vendidosSemEstoque, comandasEsquecidas, cancelarComandaEsquecida,
  previaUnificacao, unificarNoServidor, PERFIS_QUE_VENDEM_SEM_ESTOQUE,
};
