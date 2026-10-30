const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Pedido de compra (ERP, Fase 1).
 *
 * rascunho -> enviado -> parcial -> recebido, ou cancelado.
 * Só o rascunho é editável. O recebimento acontece por uma entrada de
 * NF-e vinculada ao pedido (nfeEntradaService) ou por "receber sem nota"
 * (aqui) -- os dois somam em purchase_order_items.quantidade_recebida e o
 * status é sempre RECALCULADO a partir dessas quantidades
 * (recalcularStatus), nunca escrito à mão.
 */

const STATUS_RECEBIVEIS = ['rascunho', 'enviado', 'parcial'];

function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

function totalDoPedido(itens) {
  return arred(itens.reduce((s, i) => s + Number(i.quantidade) * Number(i.custo_unitario ?? i.custoUnitario ?? 0), 0));
}

function listar({ status, fornecedorId } = {}) {
  const db = getDb();
  const filtros = [];
  const params = [];
  if (status) { filtros.push('o.status = ?'); params.push(status); }
  if (fornecedorId) { filtros.push('o.fornecedor_id = ?'); params.push(fornecedorId); }
  const pedidos = db.prepare(
    `SELECT o.*, s.nome AS fornecedor_nome,
       (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = o.id) AS qtd_itens,
       (SELECT COALESCE(SUM(i.quantidade * i.custo_unitario), 0) FROM purchase_order_items i WHERE i.order_id = o.id) AS total
     FROM purchase_orders o JOIN suppliers s ON s.id = o.fornecedor_id
     ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
     ORDER BY o.numero DESC LIMIT 300`
  ).all(...params);
  return pedidos.map((p) => ({ ...p, total: arred(p.total) }));
}

/** Pedidos que ainda podem receber mercadoria, de um fornecedor -- usado
 * pra vincular uma nota de entrada ao pedido. */
function listarAbertosDoFornecedor(fornecedorId) {
  if (!fornecedorId) return [];
  return listar({ fornecedorId }).filter((p) => STATUS_RECEBIVEIS.includes(p.status));
}

function obter(id) {
  const db = getDb();
  const pedido = db.prepare(
    `SELECT o.*, s.nome AS fornecedor_nome, s.telefone AS fornecedor_telefone, s.cnpj_cpf AS fornecedor_cnpj
     FROM purchase_orders o JOIN suppliers s ON s.id = o.fornecedor_id WHERE o.id = ?`
  ).get(id);
  if (!pedido) return null;
  const itens = db.prepare(
    `SELECT i.*, p.nome AS produto_nome, p.unidade, p.codigo_barras, p.sku
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.order_id = ? ORDER BY p.nome`
  ).all(id);
  return { ...pedido, itens, total: totalDoPedido(itens) };
}

function validarItens(db, itens) {
  if (!Array.isArray(itens) || itens.length === 0) return 'Inclua pelo menos um produto no pedido.';
  const vistos = new Set();
  for (const item of itens) {
    const produto = db.prepare('SELECT id, nome, tipo, ativo FROM products WHERE id = ?').get(item.productId);
    if (!produto) return 'Um dos produtos do pedido não existe mais.';
    if (produto.tipo === 'servico') return `"${produto.nome}" é serviço — não entra em pedido de compra.`;
    if (vistos.has(item.productId)) return `"${produto.nome}" aparece duas vezes no pedido — junte numa linha só.`;
    vistos.add(item.productId);
    if (!(Number(item.quantidade) > 0)) return `Informe a quantidade de "${produto.nome}".`;
    if (Number(item.custoUnitario) < 0 || !Number.isFinite(Number(item.custoUnitario ?? 0))) return `Custo inválido em "${produto.nome}".`;
  }
  return null;
}

/** Cria (sem id) ou edita (com id, só rascunho) um pedido. */
function salvar({ id, fornecedorId, previsaoEntrega, observacoes, itens, locationId, operadorId }) {
  const db = getDb();
  const fornecedor = fornecedorId ? db.prepare('SELECT id, ativo FROM suppliers WHERE id = ?').get(fornecedorId) : null;
  if (!fornecedor) return { ok: false, error: 'Escolha o fornecedor do pedido.' };
  if (previsaoEntrega && !/^\d{4}-\d{2}-\d{2}$/.test(previsaoEntrega)) return { ok: false, error: 'Data de previsão inválida.' };
  const erro = validarItens(db, itens);
  if (erro) return { ok: false, error: erro };

  let pedidoId = id;
  try {
    db.transaction(() => {
      if (id) {
        const atual = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id);
        if (!atual) throw new Error('Pedido não encontrado.');
        if (atual.status !== 'rascunho') throw new Error('Só dá para editar pedido em rascunho. Cancele e faça outro, se precisar.');
        db.prepare('UPDATE purchase_orders SET fornecedor_id = ?, previsao_entrega = ?, observacoes = ? WHERE id = ?')
          .run(fornecedorId, previsaoEntrega || null, observacoes?.trim() || null, id);
        db.prepare('DELETE FROM purchase_order_items WHERE order_id = ?').run(id);
      } else {
        pedidoId = randomUUID();
        const numero = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM purchase_orders').get().n;
        db.prepare(
          `INSERT INTO purchase_orders (id, numero, fornecedor_id, previsao_entrega, observacoes, location_id, operador_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(pedidoId, numero, fornecedorId, previsaoEntrega || null, observacoes?.trim() || null, locationId, operadorId);
      }
      const ins = db.prepare(
        'INSERT INTO purchase_order_items (id, order_id, product_id, quantidade, custo_unitario) VALUES (?, ?, ?, ?, ?)'
      );
      for (const item of itens) {
        ins.run(randomUUID(), pedidoId, item.productId, Number(item.quantidade), arred(Number(item.custoUnitario) || 0, 4));
      }
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, id: pedidoId };
}

/**
 * Um pedido em rascunho por fornecedor, a partir da sugestão de compra
 * (supplierService.suggestPurchases), com o custo atual de cada produto.
 * Produto sem fornecedor no cadastro não tem pra quem pedir: volta na
 * contagem `semFornecedor` pra tela avisar.
 */
function criarDaSugestao({ locationId, operadorId }) {
  const db = getDb();
  const sugestoes = require('./supplierService').suggestPurchases({ locationId })
    .filter((s) => s.quantidadeSugerida > 0);
  const porFornecedor = new Map();
  let semFornecedor = 0;
  for (const s of sugestoes) {
    if (!s.fornecedor_id) { semFornecedor += 1; continue; }
    if (!porFornecedor.has(s.fornecedor_id)) porFornecedor.set(s.fornecedor_id, []);
    porFornecedor.get(s.fornecedor_id).push(s);
  }
  const criados = [];
  for (const [fornecedorId, lista] of porFornecedor) {
    const ativo = db.prepare('SELECT 1 FROM suppliers WHERE id = ? AND ativo = 1').get(fornecedorId);
    if (!ativo) { semFornecedor += lista.length; continue; }
    const itens = lista.map((s) => ({
      productId: s.id,
      quantidade: s.quantidadeSugerida,
      custoUnitario: db.prepare('SELECT custo FROM products WHERE id = ?').get(s.id)?.custo || 0,
    }));
    const r = salvar({ fornecedorId, itens, locationId, operadorId, observacoes: 'Gerado pela sugestão de compra' });
    if (r.ok) criados.push(r.id);
  }
  return { ok: true, criados, semFornecedor, totalSugestoes: sugestoes.length };
}

function marcarEnviado({ id }) {
  const db = getDb();
  const r = db.prepare(`UPDATE purchase_orders SET status = 'enviado', enviado_em = NOW_SYNCED() WHERE id = ? AND status = 'rascunho'`).run(id);
  if (r.changes === 0) return { ok: false, error: 'Só pedido em rascunho pode ser marcado como enviado.' };
  return { ok: true };
}

function cancelar({ id, operadorId }) {
  const db = getDb();
  const pedido = db.prepare('SELECT status, numero FROM purchase_orders WHERE id = ?').get(id);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  if (pedido.status === 'recebido' || pedido.status === 'cancelado') return { ok: false, error: `Pedido ${pedido.status} não pode ser cancelado.` };
  const notaAberta = db.prepare(`SELECT numero FROM nfe_entradas WHERE purchase_order_id = ? AND status = 'rascunho'`).get(id);
  if (notaAberta) return { ok: false, error: `A nota ${notaAberta.numero || ''} em conferência está vinculada a este pedido. Desvincule ou descarte a nota antes.` };
  db.transaction(() => {
    db.prepare(`UPDATE purchase_orders SET status = 'cancelado', cancelado_em = NOW_SYNCED(), cancelado_por_id = ? WHERE id = ?`).run(operadorId || null, id);
    registrarAuditoria(db, 'pedido_compra_cancelado', operadorId, `Pedido de compra nº ${pedido.numero} cancelado (estava ${pedido.status}).`);
  })();
  return { ok: true };
}

/**
 * Status a partir das quantidades recebidas. Cancelado fica cancelado.
 * Sem nada recebido volta pra enviado (ou rascunho, se nunca saiu) --
 * acontece quando a única nota do pedido é estornada.
 */
function recalcularStatus(db, orderId) {
  const pedido = db.prepare('SELECT status, enviado_em FROM purchase_orders WHERE id = ?').get(orderId);
  if (!pedido || pedido.status === 'cancelado') return pedido?.status || null;
  const itens = db.prepare('SELECT quantidade, quantidade_recebida FROM purchase_order_items WHERE order_id = ?').all(orderId);
  const tudo = itens.length > 0 && itens.every((i) => i.quantidade_recebida >= i.quantidade - 1e-9);
  const algum = itens.some((i) => i.quantidade_recebida > 1e-9);
  const novo = tudo ? 'recebido' : algum ? 'parcial' : (pedido.enviado_em ? 'enviado' : 'rascunho');
  if (novo !== pedido.status) db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(novo, orderId);
  return novo;
}

/**
 * Soma (ou, com quantidade negativa, devolve) recebimento de um produto no
 * pedido -- uma linha por produto (validarItens garante). Produto que não
 * está no pedido não é erro: a nota pode trazer item a mais, que entra no
 * estoque normalmente, só não abate pedido.
 */
function aplicarRecebimento(db, orderId, productId, quantidade) {
  const item = db.prepare('SELECT id, quantidade_recebida FROM purchase_order_items WHERE order_id = ? AND product_id = ?').get(orderId, productId);
  if (!item) return false;
  const novo = Math.max(0, arred(Number(item.quantidade_recebida) + Number(quantidade), 4));
  db.prepare('UPDATE purchase_order_items SET quantidade_recebida = ? WHERE id = ?').run(novo, item.id);
  return true;
}

/**
 * Recebe mercadoria do pedido sem nota fiscal (ou antes de a nota chegar).
 * Entra no estoque com o custo do pedido, que alimenta o custo médio.
 * Tudo numa transação: ou entram todas as linhas, ou nenhuma.
 */
function receberSemNota({ orderId, itens, locationId, operadorId, deviceId }) {
  const db = getDb();
  const pedido = obter(orderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  if (!STATUS_RECEBIVEIS.includes(pedido.status)) return { ok: false, error: `Pedido ${pedido.status} não recebe mais mercadoria.` };
  const linhas = (itens || []).filter((i) => Number(i.quantidade) > 0);
  if (linhas.length === 0) return { ok: false, error: 'Informe a quantidade recebida de pelo menos um item.' };
  for (const l of linhas) {
    if (l.validade && !/^\d{4}-\d{2}-\d{2}$/.test(l.validade)) return { ok: false, error: 'Data de validade inválida.' };
  }

  const custoMedioService = require('./custoMedioService');
  const batchService = require('./batchService');
  try {
    db.transaction(() => {
      for (const l of linhas) {
        const item = pedido.itens.find((i) => i.id === l.itemId);
        if (!item) throw new Error('Item não pertence a este pedido.');
        const qtd = Number(l.quantidade);
        if (item.custo_unitario > 0) {
          custoMedioService.registrarEntrada(db, {
            productId: item.product_id, quantidade: qtd, custoUnitario: item.custo_unitario,
            origem: 'pedido_compra', origemId: orderId, operadorId,
          });
        }
        const r = batchService.createBatch({
          productId: item.product_id, locationId, lote: l.lote || null, validade: l.validade || null,
          quantidade: qtd, fornecedorId: pedido.fornecedor_id, operadorId, deviceId,
          motivo: `Pedido de compra nº ${pedido.numero} — recebido sem nota`,
        });
        if (!r.ok) throw new Error(r.error);
        aplicarRecebimento(db, orderId, item.product_id, qtd);
      }
      recalcularStatus(db, orderId);
      registrarAuditoria(db, 'pedido_compra_recebido_sem_nota', operadorId,
        `Pedido de compra nº ${pedido.numero}: ${linhas.length} item(ns) recebido(s) sem nota.`);
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, status: getDb().prepare('SELECT status FROM purchase_orders WHERE id = ?').get(orderId).status };
}

function formatarQtd(q) {
  return Number.isInteger(Number(q)) ? String(q) : Number(q).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Texto do pedido pra mandar ao fornecedor (WhatsApp/e-mail). Sem custo:
 * quem fecha o preço é o fornecedor. */
function textoParaFornecedor(id) {
  const db = getDb();
  const pedido = obter(id);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  const loja = db.prepare('SELECT nome FROM locations WHERE id = ?').get(pedido.location_id)?.nome || '';
  const linhas = pedido.itens.map((i) => {
    const codigo = i.codigo_barras ? ` (EAN ${i.codigo_barras})` : '';
    return `• ${formatarQtd(i.quantidade)} ${i.unidade || 'un'} — ${i.produto_nome}${codigo}`;
  });
  const previsao = pedido.previsao_entrega
    ? `\nEntrega desejada até: ${pedido.previsao_entrega.split('-').reverse().join('/')}` : '';
  const obs = pedido.observacoes && pedido.observacoes !== 'Gerado pela sugestão de compra' ? `\nObs.: ${pedido.observacoes}` : '';
  const texto = `*Pedido de compra nº ${pedido.numero}*${loja ? ` — ${loja}` : ''}\n\n${linhas.join('\n')}${previsao}${obs}\n\nPor favor, confirme disponibilidade, preço e prazo.`;
  return { ok: true, texto };
}

/** wa.me do fornecedor com o pedido já escrito. Telefone sem DDI ganha 55. */
function linkWhatsapp(id) {
  const pedido = obter(id);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  const digitos = String(pedido.fornecedor_telefone || '').replace(/\D/g, '');
  if (digitos.length < 10) return { ok: false, error: 'O fornecedor não tem telefone com DDD cadastrado.' };
  const numero = digitos.length <= 11 ? `55${digitos}` : digitos;
  const { texto } = textoParaFornecedor(id);
  return { ok: true, url: `https://wa.me/${numero}?text=${encodeURIComponent(texto)}` };
}

function registrarAuditoria(db, tipoEvento, operadorId, motivo) {
  db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
    .run(randomUUID(), tipoEvento, operadorId || null, motivo);
}

module.exports = {
  listar, listarAbertosDoFornecedor, obter, salvar, criarDaSugestao, marcarEnviado, cancelar,
  receberSemNota, textoParaFornecedor, linkWhatsapp, recalcularStatus, aplicarRecebimento, registrarAuditoria,
  STATUS_RECEBIVEIS,
};
