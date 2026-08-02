const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { getCurrentStock, computeProductAlert } = require('./stockService');
const { authorizeManagerOverride, getSecurityConfig } = require('./authService');
const customerService = require('./customerService');
const profileService = require('./profileService');
const salesSyncService = require('./salesSyncService');

function openSale({ locationId, operadorId }) {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, status, total) VALUES (?, ?, ?, 'aberta', 0)`
  ).run(id, locationId, operadorId);
  return { id };
}

/**
 * Reaproveita uma venda "aberta" já existente do mesmo operador/local
 * (ex: app fechado no meio de uma venda) em vez de criar uma nova e
 * deixar a antiga órfã. Devolve também os itens já lançados para a UI
 * conseguir reconstruir o carrinho.
 */
function getOrOpenCurrentSale({ locationId, operadorId }) {
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM sales WHERE location_id = ? AND operador_id = ? AND status = 'aberta' ORDER BY criado_em DESC LIMIT 1`
  ).get(locationId, operadorId);

  const sale = existing || (() => {
    const { id } = openSale({ locationId, operadorId });
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  })();

  const items = db.prepare(
    `SELECT si.*, p.nome FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em`
  ).all(sale.id);

  return {
    saleId: sale.id,
    total: sale.total,
    resumed: !!existing,
    items: items.map((i) => ({
      id: i.id, nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario, cancelado: false,
    })),
  };
}

/** Produtos vendidos recentemente no local — para o atalho rápido no PDV.
 * Cada produto aparece uma vez só (o mais recente), mesmo se vendido várias vezes. */
function listRecentlySold({ locationId, limit = 12 }) {
  const db = getDb();
  return db.prepare(
    `SELECT p.*, MAX(si.criado_em) as ultima_venda_em
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND si.cancelado = 0
     GROUP BY p.id
     ORDER BY ultima_venda_em DESC
     LIMIT ?`
  ).all(locationId, limit);
}

/**
 * Vendas de um intervalo de datas no local, para a tela de Histórico.
 * dataInicio/dataFim no formato 'YYYY-MM-DD' (inclusive nos dois lados).
 * Já traz os métodos de pagamento usados em cada venda.
 */
function listSalesByRange({ locationId, dataInicio, dataFim, incluirOcultas = false }) {
  const db = getDb();
  return db.prepare(
    `SELECT s.*, u.nome as operador_nome,
       COALESCE(s.finalizada_em, s.criado_em) as data_efetiva,
       (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.cancelado = 0) as total_itens,
       (SELECT GROUP_CONCAT(DISTINCT p.metodo) FROM payments p WHERE p.sale_id = s.id) as metodos_pagamento
     FROM sales s
     JOIN users u ON u.id = s.operador_id
     WHERE s.location_id = ?
       -- Usa a data de FINALIZAÇÃO como referência, não a de abertura do
       -- carrinho — um carrinho pode ficar aberto de um dia pro outro
       -- (retomar venda) e só virar venda de verdade quando finalizado.
       AND date(COALESCE(s.finalizada_em, s.criado_em)) BETWEEN date(?) AND date(?)
       -- Não mostra carrinho aberto que nunca teve nenhum item — é só o
       -- rascunho que o sistema cria sozinho ao entrar no PDV, nunca foi
       -- uma venda de verdade. Carrinho aberto COM item ainda aparece
       -- (o estoque já foi debitado nele, vale saber que ficou pendente).
       AND NOT (s.status = 'aberta' AND (SELECT COUNT(*) FROM sale_items si2 WHERE si2.sale_id = s.id AND si2.cancelado = 0) = 0)
       ${incluirOcultas ? '' : 'AND s.oculta_historico = 0'}
     ORDER BY data_efetiva DESC`
  ).all(locationId, dataInicio, dataFim);
}

/**
 * "Excluir do histórico" — some da LISTA (só gerente/admin tem essa
 * opção na tela), mas nunca é um DELETE de verdade. Estoque, pagamento
 * e qualquer NFC-e já emitida continuam intactos por baixo — é só uma
 * questão de visualização, pra não poluir a lista com teste/engano.
 */
function excluirDoHistorico({ saleId, operadorId, motivo }) {
  const db = getDb();
  const sale = db.prepare('SELECT id FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };

  db.prepare(
    `UPDATE sales SET oculta_historico = 1, oculta_historico_por_id = ?, oculta_historico_em = NOW_SYNCED(), oculta_historico_motivo = ? WHERE id = ?`
  ).run(operadorId, motivo || null, saleId);

  db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, autorizado_por_id, motivo, sucesso)
     VALUES (?, 'venda_excluida_do_historico', ?, ?, ?, ?, 1)`
  ).run(randomUUID(), saleId, operadorId, operadorId, motivo || null);

  return { ok: true };
}

/** Desfaz a exclusão — a venda volta a aparecer na lista normal. */
function reexibirNoHistorico({ saleId, operadorId }) {
  const db = getDb();
  db.prepare(
    `UPDATE sales SET oculta_historico = 0, oculta_historico_por_id = NULL, oculta_historico_em = NULL, oculta_historico_motivo = NULL WHERE id = ?`
  ).run(saleId);
  db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, autorizado_por_id, sucesso)
     VALUES (?, 'venda_reexibida_no_historico', ?, ?, ?, 1)`
  ).run(randomUUID(), saleId, operadorId, operadorId);
  return { ok: true };
}

/** Vincula (ou desvincula, passando null) um cliente à venda — usado
 * para fiado e fidelidade. */
function setCustomer(saleId, customerId) {
  const db = getDb();
  db.prepare('UPDATE sales SET customer_id = ? WHERE id = ?').run(customerId || null, saleId);
  return { ok: true };
}

/** Resgata pontos de fidelidade como desconto na venda. Só decide o
 * valor do desconto agora — o débito de fato dos pontos do cliente só
 * acontece se a venda for finalizada (ver finalizeSale). */
function redeemLoyaltyPoints({ saleId, pontos }) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (!sale.customer_id) return { ok: false, error: 'Vincule um cliente à venda antes de resgatar pontos.' };

  const pts = Number(pontos);
  if (!(pts > 0) || !Number.isInteger(pts)) return { ok: false, error: 'Informe uma quantidade de pontos válida.' };

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
  if (pts > customer.pontos) return { ok: false, error: `Cliente só tem ${customer.pontos} ponto(s).` };

  const valorDesconto = customerService.calcularValorResgate(pts);
  const maxDesconto = sale.total - sale.desconto_gerente; // nunca deixa o total dos dois descontos passar do valor da venda
  const descontoAplicado = Math.min(valorDesconto, maxDesconto);

  db.prepare('UPDATE sales SET desconto = ?, pontos_resgatados = ? WHERE id = ?').run(descontoAplicado, pts, saleId);
  return { ok: true, desconto: descontoAplicado };
}

/**
 * Desconto manual, a critério do gerente — para clientes específicos ou
 * negociações pontuais. Sempre exige autorização de um gerente/admin
 * diferente do operador (mesmo mecanismo do cancelamento), com motivo e
 * rastro em audit_log. Separado do desconto de fidelidade: os dois
 * convivem sem um sobrescrever o outro.
 */
function applyManagerDiscount({ saleId, valor, percentual, motivo, currentOperatorId, candidateManagerId, pin }) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta.' };

  const totalDisponivel = sale.total - sale.desconto; // não deixa passar do que sobra depois do desconto de fidelidade

  // Aceita ou um valor fixo em R$, ou uma porcentagem — a porcentagem é
  // calculada sobre o que resta da venda (depois do desconto de
  // fidelidade, se tiver), não sobre o total bruto original.
  let desc;
  if (percentual != null && Number(percentual) > 0) {
    const pct = Number(percentual);
    if (pct > 100) return { ok: false, error: 'Porcentagem de desconto não pode passar de 100%.' };
    desc = totalDisponivel * (pct / 100);
  } else {
    desc = Number(valor);
  }
  if (!(desc > 0)) return { ok: false, error: 'Informe um valor ou porcentagem de desconto maior que zero.' };

  if (desc > totalDisponivel) {
    return { ok: false, error: `Desconto não pode passar de R$ ${totalDisponivel.toFixed(2)} (valor restante da venda).` };
  }

  const exigeAutorizacao = getSecurityConfig().exigir_autorizacao_desconto === 1;

  let autorizadoPor = null;
  if (exigeAutorizacao) {
    const auth = authorizeManagerOverride({
      candidateUserId: candidateManagerId,
      pin,
      currentOperatorId,
      tipoEvento: 'desconto_manual',
      saleId,
      motivo,
    });
    if (!auth.ok) return auth;
    autorizadoPor = auth.autorizadoPor;
  } else {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, motivo, sucesso)
       VALUES (?, 'desconto_manual_sem_autorizacao_configurada', ?, ?, ?, 1)`
    ).run(randomUUID(), saleId, currentOperatorId, motivo || null);
  }

  db.prepare(
    `UPDATE sales SET desconto_gerente = ?, desconto_gerente_motivo = ?, desconto_autorizado_por_id = ? WHERE id = ?`
  ).run(desc, motivo || null, autorizadoPor?.id || null, saleId);

  return { ok: true, desconto: desc, autorizadoPor };
}

/** Remove o desconto manual antes de finalizar (ex: operador mudou de ideia). */
function removeManagerDiscount(saleId) {
  const db = getDb();
  db.prepare(
    `UPDATE sales SET desconto_gerente = 0, desconto_gerente_motivo = NULL, desconto_autorizado_por_id = NULL WHERE id = ?`
  ).run(saleId);
  return { ok: true };
}

/** Taxa de serviço opcional (restaurante) — percentual sobre o total,
 * sempre uma escolha de quem está atendendo, nunca automática. */
function setServiceCharge(saleId, percentual) {
  const valor = Number(percentual) || 0;
  if (valor < 0 || valor > 100) return { ok: false, error: 'Percentual inválido — use um valor entre 0 e 100.' };
  const db = getDb();
  db.prepare('UPDATE sales SET taxa_servico_percentual = ? WHERE id = ?').run(valor, saleId);
  return { ok: true };
}

/**
 * Adiciona um item à venda e JÁ baixa o estoque imediatamente
 * (requisito: vendas diminuem estoque diretamente, não só no fechamento).
 * Roda em transação: se o movimento de estoque falhar, o item não é gravado.
 */
function addItem({ saleId, productId, locationId, quantidade, operadorId, deviceId }) {
  const db = getDb();

  const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta — não é possível adicionar itens.' };

  if (!(quantidade > 0)) return { ok: false, error: 'Quantidade precisa ser maior que zero.' };

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND ativo = 1').get(productId);
  if (!product) return { ok: false, error: 'Produto não encontrado.' };

  const disponivel = getCurrentStock(productId, locationId);
  if (quantidade > disponivel) {
    return { ok: false, error: `Estoque insuficiente. Disponível: ${disponivel} ${product.unidade}.` };
  }

  const custom = JSON.parse(product.custom_fields || '{}');
  const avisoReceita = !!(custom.controlado && custom.exige_receita);

  // Se o mesmo produto já está no carrinho (ainda não cancelado), soma
  // na linha existente em vez de criar uma linha nova — bipar o mesmo
  // item duas vezes deve virar "produto x2", não duas linhas separadas.
  const itemExistente = db.prepare(
    `SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ? AND cancelado = 0`
  ).get(saleId, productId);

  const movId = randomUUID();
  let itemId;
  let quantidadeTotal;

  const tx = db.transaction(() => {
    if (itemExistente) {
      itemId = itemExistente.id;
      quantidadeTotal = itemExistente.quantidade + quantidade;
      db.prepare(`UPDATE sale_items SET quantidade = ? WHERE id = ?`).run(quantidadeTotal, itemId);
    } else {
      itemId = randomUUID();
      quantidadeTotal = quantidade;
      db.prepare(
        `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?, ?)`
      ).run(itemId, saleId, productId, quantidade, product.preco);
    }

    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, sale_id, sale_item_id, operador_id, device_id)
       VALUES (?, ?, ?, 'venda', ?, ?, ?, ?, ?)`
    ).run(movId, productId, locationId, -Math.abs(quantidade), saleId, itemId, operadorId, deviceId);

    db.prepare(
      `UPDATE sales SET total = total + ? WHERE id = ?`
    ).run(product.preco * quantidade, saleId);
  });
  tx();

  const estoqueAposVenda = disponivel - quantidade;

  const profile = profileService.getActiveProfile();
  const alerta = computeProductAlert({ product, estoqueAtual: estoqueAposVenda, profile });

  // avisoReceita é só um sinalizador para a UI sugerir anexar a receita —
  // nunca impede a venda, já que o estoque pode ter itens não farmacêuticos.
  return { ok: true, itemId, precoUnitario: product.preco, avisoReceita, alerta, quantidadeTotal };
}

/** Registra um ou mais pagamentos (suporta pagamento misto/split). */
function addPayment({ saleId, metodo, valor, detalhes }) {
  const db = getDb();

  const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta — não é possível registrar pagamento.' };

  if (!(valor > 0)) return { ok: false, error: 'Valor do pagamento precisa ser maior que zero.' };

  const id = randomUUID();
  db.prepare(
    `INSERT INTO payments (id, sale_id, metodo, valor, detalhes) VALUES (?, ?, ?, ?, ?)`
  ).run(id, saleId, metodo, valor, JSON.stringify(detalhes || {}));
  return { ok: true, id };
}

/** Remove um pagamento adicionado por engano — só antes de finalizar. */
/** Observação livre de um item (ex: "sem cebola") — some junto na
 * próxima impressão da comanda pra cozinha, mesmo que o item já tenha
 * sido enviado antes (a observação nova precisa chegar até a cozinha). */
function setItemNote({ saleItemId, observacao }) {
  const db = getDb();
  db.prepare('UPDATE sale_items SET observacao = ?, enviado_cozinha = 0 WHERE id = ?').run(observacao?.trim() || null, saleItemId);
  return { ok: true };
}

/** Marca qual pessoa da mesa pediu um item — pra dividir a conta por
 * item em vez de dividir o total igualmente entre todos. */
function setItemPerson({ saleItemId, pessoaNumero }) {
  const db = getDb();
  db.prepare('UPDATE sale_items SET pessoa_numero = ? WHERE id = ?').run(pessoaNumero || null, saleItemId);
  return { ok: true };
}

function removePayment({ paymentId, saleId }) {
  const db = getDb();
  const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta.' };

  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND sale_id = ?').get(paymentId, saleId);
  if (!payment) return { ok: false, error: 'Pagamento não encontrado.' };

  db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
  return { ok: true };
}

function finalizeSale(saleId) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  const pagamentos = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);
  const pago = pagamentos.reduce((acc, p) => acc + p.valor, 0);
  const totalAPagar = sale.total - sale.desconto - sale.desconto_gerente;

  if (pago + 0.005 < totalAPagar) {
    return { ok: false, error: `Pagamento incompleto. Faltam R$ ${(totalAPagar - pago).toFixed(2)}.` };
  }

  const valorFiado = pagamentos.filter((p) => p.metodo === 'fiado').reduce((acc, p) => acc + p.valor, 0);
  if (valorFiado > 0 && !sale.customer_id) {
    return { ok: false, error: 'Pagamento em fiado exige um cliente vinculado à venda.' };
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE sales SET status = 'finalizada', finalizada_em = NOW_SYNCED() WHERE id = ?`).run(saleId);

    if (valorFiado > 0) {
      customerService.registrarDivida({ customerId: sale.customer_id, valor: valorFiado, saleId, operadorId: sale.operador_id });
    }
    if (sale.pontos_resgatados > 0) {
      customerService.debitarPontos(sale.customer_id, sale.pontos_resgatados);
    }
    if (sale.customer_id) {
      customerService.acumularPontos(sale.customer_id, pago);
    }
  });
  tx();

  // Best-effort, em segundo plano — nunca atrasa nem falha a venda local
  // por causa disso. Só um espelho pra relatório consolidado entre PDVs.
  const totalItens = db.prepare('SELECT COUNT(*) as c FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).c;
  const operador = db.prepare('SELECT nome FROM users WHERE id = ?').get(sale.operador_id);
  const location = db.prepare('SELECT nome FROM locations WHERE id = ?').get(sale.location_id);
  const saleAtualizada = db.prepare('SELECT finalizada_em FROM sales WHERE id = ?').get(saleId);
  salesSyncService.pushSale({
    saleId,
    total: sale.total - sale.desconto - sale.desconto_gerente,
    totalItens,
    finalizadaEm: saleAtualizada.finalizada_em,
    operadorNome: operador?.nome,
    locationNome: location?.nome,
  }).catch(() => {}); // pushSale já trata os próprios erros; isso é só defesa extra

  return { ok: true };
}

/**
 * Cancelamento de item já lançado (ou da venda inteira).
 * EXIGE autorização de um gerente/admin diferente do operador do caixa
 * (ver authService.authorizeManagerOverride). Nunca apaga o movimento
 * de estoque original — cria um movimento de 'estorno' compensatório,
 * preservando o histórico completo para auditoria.
 */
function cancelSaleItem({ saleId, saleItemId, locationId, currentOperatorId, candidateManagerId, pin, motivo, deviceId }) {
  const db = getDb();

  const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(saleItemId, saleId);
  if (!item || item.cancelado) return { ok: false, error: 'Item não encontrado ou já cancelado.' };

  // Só exige autorização de gerente se a venda já tiver algum pagamento
  // registrado — antes disso, o cliente ainda pode pedir mais ou desistir
  // de algo, e isso é ajuste normal do carrinho, não precisa de aprovação.
  // Depois que dinheiro (ou qualquer método) já entrou na venda, mexer
  // no que foi vendido passa a ter risco de fraude de verdade — A NÃO SER
  // que a exigência esteja desligada nas configurações (opcional, pra
  // quem prefere não pedir senha pra isso).
  const jaTemPagamento = db.prepare('SELECT COUNT(*) as c FROM payments WHERE sale_id = ?').get(saleId).c > 0;
  const exigeAutorizacao = jaTemPagamento && getSecurityConfig().exigir_autorizacao_cancelamento === 1;

  let autorizadoPorId = null;
  let autorizadoPorNome = null;

  if (exigeAutorizacao) {
    const auth = authorizeManagerOverride({
      candidateUserId: candidateManagerId,
      pin,
      currentOperatorId,
      tipoEvento: 'cancelamento_item',
      saleId,
      saleItemId,
      motivo,
    });
    if (!auth.ok) return auth;
    autorizadoPorId = auth.autorizadoPor.id;
    autorizadoPorNome = auth.autorizadoPor.nome;
  } else {
    // Ainda registra na auditoria, só que sem exigir aprovação — mantém
    // o histórico completo de quem cancelou o quê, mesmo sem gerente.
    // O tipo de evento distingue os dois motivos de não ter exigido:
    // ou não tinha pagamento ainda, ou a exigência está desligada.
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, sale_item_id, solicitante_id, autorizado_por_id, motivo, sucesso)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 1)`
    ).run(randomUUID(), jaTemPagamento ? 'cancelamento_item_sem_autorizacao_configurada' : 'cancelamento_item_pre_pagamento', saleId, saleItemId, currentOperatorId, motivo || null);
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sale_items SET cancelado = 1, cancelado_por_id = ?, cancelado_em = NOW_SYNCED(), motivo_cancelamento = ? WHERE id = ?`
    ).run(autorizadoPorId || currentOperatorId, motivo || null, saleItemId);

    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, sale_item_id, operador_id, autorizado_por_id, device_id)
       VALUES (?, ?, ?, 'estorno', ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), item.product_id, locationId, Math.abs(item.quantidade), motivo || 'Cancelamento de item', saleId, saleItemId, currentOperatorId, autorizadoPorId, deviceId);

    db.prepare(`UPDATE sales SET total = total - ? WHERE id = ?`).run(item.preco_unitario * item.quantidade, saleId);
  });
  tx();

  return { ok: true, autorizadoPor: autorizadoPorNome ? { nome: autorizadoPorNome } : null, produto: product.nome, exigiuAutorizacao: exigeAutorizacao };
}

function cancelSale({ saleId, locationId, currentOperatorId, candidateManagerId, pin, motivo, deviceId }) {
  const db = getDb();

  const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') {
    return {
      ok: false,
      error: sale.status === 'cancelada'
        ? 'Esta venda já está cancelada.'
        : 'Esta venda já foi finalizada (paga) — cancelamento de venda só vale para vendas em aberto. Para uma venda já paga, use Devolução.',
    };
  }

  const exigeAutorizacao = getSecurityConfig().exigir_autorizacao_cancelamento === 1;

  let autorizadoPor = null;
  if (exigeAutorizacao) {
    const auth = authorizeManagerOverride({
      candidateUserId: candidateManagerId,
      pin,
      currentOperatorId,
      tipoEvento: 'cancelamento_venda',
      saleId,
      motivo,
    });
    if (!auth.ok) return auth;
    autorizadoPor = auth.autorizadoPor;
  } else {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, autorizado_por_id, motivo, sucesso)
       VALUES (?, 'cancelamento_venda_sem_autorizacao_configurada', ?, ?, NULL, ?, 1)`
    ).run(randomUUID(), saleId, currentOperatorId, motivo || null);
  }

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND cancelado = 0').all(saleId);

  const tx = db.transaction(() => {
    for (const item of items) {
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, sale_item_id, operador_id, autorizado_por_id, device_id)
         VALUES (?, ?, ?, 'estorno', ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), item.product_id, locationId, Math.abs(item.quantidade), motivo || 'Cancelamento de venda', saleId, item.id, currentOperatorId, autorizadoPor?.id || null, deviceId);

      db.prepare(`UPDATE sale_items SET cancelado = 1, cancelado_por_id = ?, cancelado_em = NOW_SYNCED() WHERE id = ?`)
        .run(autorizadoPor?.id || currentOperatorId, item.id);
    }
    db.prepare(
      `UPDATE sales SET status = 'cancelada', cancelada_em = NOW_SYNCED(), cancelada_por_id = ?, motivo_cancelamento = ? WHERE id = ?`
    ).run(autorizadoPor?.id || currentOperatorId, motivo || null, saleId);
  });
  tx();

  return { ok: true, autorizadoPor };
}

/** Checagem leve, sem efeito colateral — só pra decidir se a tela deve
 * pedir autorização de gerente antes de cancelar um item, ou deixar
 * cancelar direto (venda ainda sem nenhum pagamento registrado). */
function needsManagerAuthForCancel(saleId) {
  const db = getDb();
  const jaTemPagamento = db.prepare('SELECT COUNT(*) as c FROM payments WHERE sale_id = ?').get(saleId).c > 0;
  const exigeAutorizacao = jaTemPagamento && getSecurityConfig().exigir_autorizacao_cancelamento === 1;
  return { needsAuth: exigeAutorizacao };
}

/** Itens de uma venda específica — pra "mostrar produtos por venda" no
 * Histórico, sem precisar carregar isso pra toda venda da lista de
 * uma vez (só quando o usuário expande uma linha). */
function getSaleItemsDetail(saleId) {
  const db = getDb();
  return db.prepare(
    `SELECT si.id, p.nome, si.quantidade, si.preco_unitario, si.cancelado, si.observacao
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? ORDER BY si.criado_em`
  ).all(saleId);
}

module.exports = {
  openSale, getOrOpenCurrentSale, listSalesByRange, listRecentlySold, setCustomer, redeemLoyaltyPoints,
  applyManagerDiscount, removeManagerDiscount, setServiceCharge,
  addItem, addPayment, removePayment, finalizeSale, cancelSaleItem, cancelSale, needsManagerAuthForCancel, setItemNote, setItemPerson,
  getSaleItemsDetail, excluirDoHistorico, reexibirNoHistorico,
};
