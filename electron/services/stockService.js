const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');
const batchService = require('./batchService');

/** Estoque atual = soma de todos os movimentos daquele produto/local. */
function getCurrentStock(productId, locationId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(quantidade), 0) as total FROM stock_movements WHERE product_id = ? AND location_id = ?`
  ).get(productId, locationId);
  return row.total;
}

function getStockForLocation(locationId) {
  const db = getDb();
  return db.prepare(
    `SELECT p.id, p.sku, p.nome, p.estoque_minimo,
            COALESCE(SUM(sm.quantidade), 0) as estoque_atual
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     WHERE p.ativo = 1
     GROUP BY p.id`
  ).all(locationId);
}

/** Produtos cujo estoque atual está no ou abaixo do mínimo configurado. */
function listLowStock(locationId) {
  return getStockForLocation(locationId).filter((p) => p.estoque_atual <= p.estoque_minimo);
}

const TIPOS_VALIDOS = ['entrada', 'ajuste', 'perda', 'estorno'];

/**
 * Ajuste manual de estoque (entrada de mercadoria, perda, correção de inventário).
 * Sempre cria um novo movimento — nunca edita um movimento existente.
 */
function adjustStock({ productId, locationId, quantidade, tipo, motivo, operadorId, deviceId }) {
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return { ok: false, error: `Tipo de movimento inválido. Use: ${TIPOS_VALIDOS.join(', ')}.` };
  }
  const qtd = Number(quantidade);
  if (!qtd || qtd === 0 || Number.isNaN(qtd)) {
    return { ok: false, error: 'Informe uma quantidade diferente de zero.' };
  }

  const db = getDb();
  const id = randomUUID();
  // entrada/estorno somam ao estoque; perda/ajuste-negativo subtraem — o
  // sinal vem de quem chama (positivo para entrada, negativo para perda).
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, productId, locationId, tipo, qtd, motivo || null, operadorId, deviceId);

  require('./stockSyncService').pushEstoqueProduto(productId).catch(() => {});

  return { ok: true, id, estoqueAtual: getCurrentStock(productId, locationId) };
}

/**
 * Calcula o nível de alerta (crítico/aviso) de um produto, combinando
 * estoque e validade — usado para colorir o ícone de alerta no carrinho
 * do PDV assim que o produto é adicionado. Os limiares (dias de validade
 * e % do estoque mínimo) vêm do perfil ativo, configuráveis pelo gerente
 * em Configurações → Perfis de negócio.
 */
function computeProductAlert({ product, estoqueAtual, profile }) {
  const motivosCriticos = [];
  const motivosAviso = [];

  // --- Estoque ---
  if (product.estoque_minimo > 0) {
    const limiarCritico = product.estoque_minimo * ((profile?.estoqueCriticoPercentual ?? 50) / 100);
    if (estoqueAtual <= limiarCritico) {
      motivosCriticos.push(`Estoque crítico: ${estoqueAtual} restante(s) (mínimo: ${product.estoque_minimo})`);
    } else if (estoqueAtual <= product.estoque_minimo) {
      motivosAviso.push(`Estoque baixo: ${estoqueAtual} restante(s) (mínimo: ${product.estoque_minimo})`);
    }
  }

  // --- Validade (só se o perfil ativo tiver esse alerta ligado) ---
  if (profile?.regrasAlerta?.includes('validade_proxima')) {
    const customFields = JSON.parse(product.custom_fields || '{}');
    // Prioriza o lote com vencimento mais próximo (módulo de
    // abastecimento); sem lote registrado, cai pro campo antigo do
    // cadastro manual/importação de planilha.
    const validade = batchService.resolveValidadeEfetiva(product.id, customFields.validade);
    if (validade) {
      const hoje = new Date(timeService.nowMs());
      const dataValidade = new Date(`${validade}T00:00:00`);
      const diasRestantes = Math.ceil((dataValidade - hoje) / (1000 * 60 * 60 * 24));
      const dataFormatada = dataValidade.toLocaleDateString('pt-BR');

      if (diasRestantes <= 0) {
        motivosCriticos.push(`Vencido em ${dataFormatada}`);
      } else if (diasRestantes <= (profile.diasAlertaValidadeCritico ?? 7)) {
        motivosCriticos.push(`Vence em ${diasRestantes} dia(s) (${dataFormatada})`);
      } else if (diasRestantes <= (profile.diasAlertaValidade ?? 60)) {
        motivosAviso.push(`Validade próxima: vence em ${diasRestantes} dia(s) (${dataFormatada})`);
      }
    }
  }

  if (motivosCriticos.length > 0) return { nivel: 'critico', motivos: motivosCriticos };
  if (motivosAviso.length > 0) return { nivel: 'aviso', motivos: motivosAviso };
  return { nivel: null, motivos: [] };
}

/** Todos os produtos com algum nível de alerta (crítico ou aviso), usando
 * exatamente a mesma lógica do ícone no carrinho do PDV — antes a tela de
 * Alertas calculava isso de um jeito diferente e podia discordar. */
function listAlerts(locationId, profile) {
  const db = getDb();
  const products = db.prepare(
    `SELECT p.*, COALESCE(SUM(sm.quantidade), 0) as estoque_atual
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     WHERE p.ativo = 1
     GROUP BY p.id`
  ).all(locationId);

  return products
    .map((p) => ({ ...p, alerta: computeProductAlert({ product: p, estoqueAtual: p.estoque_atual, profile }) }))
    .filter((p) => p.alerta.nivel)
    .sort((a, b) => (a.alerta.nivel === 'critico' ? 0 : 1) - (b.alerta.nivel === 'critico' ? 0 : 1));
}

/**
 * Previsão de ruptura — em vez de só avisar quando o estoque JÁ bateu
 * no mínimo (reativo, e o mínimo é um número que alguém digitou uma
 * vez e pode estar desatualizado), calcula quantos dias faltam pra
 * acabar de verdade, baseado no ritmo de venda dos últimos 30 dias.
 * Isso pega produto de venda rápida que ainda não bateu o mínimo, mas
 * vai bater em breve — dando mais tempo de reação do que o alerta
 * estático. Só mostra quem NÃO está no alerta reativo (senão duplica
 * o mesmo aviso de dois jeitos diferentes).
 */
function previsaoDeRuptura(locationId, { diasLimiar = 7 } = {}) {
  const db = getDb();
  const produtos = db.prepare(
    `SELECT p.id, p.nome, p.estoque_minimo, COALESCE(SUM(sm.quantidade), 0) as estoque_atual
     FROM products p
     LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
     WHERE p.ativo = 1
     GROUP BY p.id
     HAVING estoque_atual > 0`
  ).all(locationId);

  const resultado = [];
  for (const p of produtos) {
    // Já está no alerta reativo (bateu ou passou do mínimo)? Não
    // duplica o aviso aqui — a pessoa já vê ele na lista de cima.
    if (p.estoque_atual <= p.estoque_minimo) continue;

    const vendidoUltimos30Dias = db.prepare(
      `SELECT COALESCE(SUM(-quantidade), 0) as total FROM stock_movements
       WHERE product_id = ? AND location_id = ? AND tipo = 'venda' AND criado_em >= datetime(NOW_SYNCED(), '-30 days')`
    ).get(p.id, locationId).total;

    if (vendidoUltimos30Dias <= 0) continue; // sem venda recente, não dá pra prever nada

    const velocidadeDiaria = vendidoUltimos30Dias / 30;
    const diasRestantes = p.estoque_atual / velocidadeDiaria;

    if (diasRestantes <= diasLimiar) {
      resultado.push({
        id: p.id, nome: p.nome, estoqueAtual: p.estoque_atual,
        velocidadeDiaria: Number(velocidadeDiaria.toFixed(2)),
        diasRestantes: Math.floor(diasRestantes),
      });
    }
  }

  return resultado.sort((a, b) => a.diasRestantes - b.diasRestantes);
}

module.exports = { getCurrentStock, getStockForLocation, listLowStock, adjustStock, computeProductAlert, listAlerts, previsaoDeRuptura };
