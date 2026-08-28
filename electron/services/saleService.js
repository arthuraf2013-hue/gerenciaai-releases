const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');
const { getCurrentStock, computeProductAlert } = require('./stockService');
const { authorizeManagerOverride, getSecurityConfig } = require('./authService');
const customerService = require('./customerService');
const { precoEfetivo } = require('./productService');
const profileService = require('./profileService');
const salesSyncService = require('./salesSyncService');
const ingredientService = require('./ingredientService');
const customItemService = require('./customItemService');

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
    `SELECT si.*, COALESCE(si.nome_personalizado, p.nome) as nome FROM sale_items si JOIN products p ON p.id = si.product_id
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
/**
 * @param {{ locationId: string, limit?: number, modo?: 'recente'|'frequente' }} opts
 * modo 'recente' (padrão de sempre): ordena por última venda — reordena
 * a CADA venda, então a posição dos botões muda toda hora.
 * modo 'frequente': ordena por quantidade total vendida nos últimos 30
 * dias — muito mais estável, uma venda isolada quase nunca muda a
 * posição relativa dos produtos, então o botão fica sempre no mesmo
 * lugar (memória muscular de quem opera o caixa).
 */
function listRecentlySold({ locationId, limit = 12, modo = 'recente' }) {
  const db = getDb();
  // Item personalizado NUNCA entra nos atalhos rápidos: todos compartilham
  // o mesmo product_id âncora (sem sentido clicar de novo pra "repetir"
  // um combo que foi montado na hora), e si.eh_personalizado já marca isso.
  if (modo === 'frequente') {
    // Sargable: compara direto com o limite UTC de "30 dias atrás" em
    // vez de embrulhar a coluna em date(...) -- deixa o índice de
    // expressão idx_sales_location_data_efetiva fazer o trabalho, em
    // vez de escanear o histórico inteiro de vendas toda vez que o PDV
    // abre (esta é a query dos atalhos rápidos, chamada com frequência).
    const trintaDiasAtrasUtc = new Date(timeService.nowMs() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    return db.prepare(
      `SELECT p.*, SUM(si.quantidade) as total_vendido
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE s.location_id = ? AND si.cancelado = 0 AND si.eh_personalizado = 0
         AND COALESCE(s.finalizada_em, s.criado_em) >= ?
       GROUP BY p.id
       ORDER BY total_vendido DESC, p.nome
       LIMIT ?`
    ).all(locationId, trintaDiasAtrasUtc, limit);
  }
  return db.prepare(
    `SELECT p.*, MAX(si.criado_em) as ultima_venda_em
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND si.cancelado = 0 AND si.eh_personalizado = 0
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
  // Sargable: compara direto com os limites UTC do intervalo local pedido
  // em vez de embrulhar a coluna em date(col, '-3 hours') — isso deixava
  // o SQLite escanear TODO o histórico de vendas do local toda vez que a
  // tela de Histórico abria, porque nenhum índice consegue ser usado
  // quando a coluna some dentro de uma função. Com o filtro sargable,
  // idx_sales_location_data_efetiva (índice de expressão sobre
  // COALESCE(finalizada_em, criado_em)) resolve isso direto.
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
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
       AND COALESCE(s.finalizada_em, s.criado_em) >= ? AND COALESCE(s.finalizada_em, s.criado_em) < ?
       -- Não mostra carrinho aberto que nunca teve nenhum item — é só o
       -- rascunho que o sistema cria sozinho ao entrar no PDV, nunca foi
       -- uma venda de verdade. Carrinho aberto COM item ainda aparece
       -- (o estoque já foi debitado nele, vale saber que ficou pendente).
       AND NOT (s.status = 'aberta' AND (SELECT COUNT(*) FROM sale_items si2 WHERE si2.sale_id = s.id AND si2.cancelado = 0) = 0)
       ${incluirOcultas ? '' : 'AND s.oculta_historico = 0'}
     ORDER BY data_efetiva DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
}

/**
 * "Excluir do histórico" — some da LISTA (só gerente/admin tem essa
 * opção na tela), mas nunca é um DELETE de verdade. Estoque, pagamento
 * e qualquer NFC-e já emitida continuam intactos por baixo — é só uma
 * questão de visualização, pra não poluir a lista com teste/engano.
 */
function excluirDoHistorico({ saleId, operadorId, motivo }) {
  const db = getDb();

  const operador = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(operadorId);
  if (!operador || !['gerente', 'admin', 'suporte'].includes(operador.role)) {
    return { ok: false, error: 'Só gerente ou admin pode excluir uma venda do histórico.' };
  }

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

  const operador = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(operadorId);
  if (!operador || !['gerente', 'admin', 'suporte'].includes(operador.role)) {
    return { ok: false, error: 'Só gerente ou admin pode reexibir uma venda no histórico.' };
  }

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

  // Serviço (mão de obra, taxa, consulta...) não tem estoque físico —
  // sempre "disponível", nunca gera stock_movements nem desconta
  // insumo/ficha técnica (ver dentro da transação abaixo).
  const ehServico = product.tipo === 'servico';
  const disponivel = ehServico ? null : getCurrentStock(productId, locationId);
  if (!ehServico && quantidade > disponivel) {
    return { ok: false, error: `Estoque insuficiente. Disponível: ${disponivel} ${product.unidade}.` };
  }

  const custom = JSON.parse(product.custom_fields || '{}');
  const avisoReceita = !!(custom.controlado && custom.exige_receita);
  const precoDeVenda = precoEfetivo(product); // usa o promocional (desconto por validade) se ainda estiver válido

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
      ).run(itemId, saleId, productId, quantidade, precoDeVenda);
    }

    if (!ehServico) {
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, sale_id, sale_item_id, operador_id, device_id)
         VALUES (?, ?, ?, 'venda', ?, ?, ?, ?, ?)`
      ).run(movId, productId, locationId, -Math.abs(quantidade), saleId, itemId, operadorId, deviceId);

      // Se o produto tiver ficha técnica (prato com insumos cadastrados),
      // já desconta os insumos na mesma transação — mesma ideia do
      // estoque do produto em si, "vendas diminuem estoque diretamente".
      // Produto sem ficha técnica: não faz nada (ver ingredientService).
      // Serviço nunca tem ficha técnica (não existe "produção" pra
      // consumir insumo).
      ingredientService.descontarPorVenda(productId, quantidade);
    }

    db.prepare(
      `UPDATE sales SET total = total + ? WHERE id = ?`
    ).run(precoDeVenda * quantidade, saleId);
  });
  tx();

  // Sem estoque físico, serviço nunca dispara alerta de validade/estoque
  // baixo — não há "estoqueAtual" que faça sentido calcular.
  let alerta = null;
  if (!ehServico) {
    const estoqueAposVenda = disponivel - quantidade;
    const profile = profileService.getActiveProfile();
    alerta = computeProductAlert({ product, estoqueAtual: estoqueAposVenda, profile });
  }

  // avisoReceita é só um sinalizador para a UI sugerir anexar a receita —
  // nunca impede a venda, já que o estoque pode ter itens não farmacêuticos.
  return { ok: true, itemId, precoUnitario: precoDeVenda, avisoReceita, alerta, quantidadeTotal };
}

/**
 * Adiciona um item PERSONALIZADO (prato/produto montado na hora a
 * partir de insumos e/ou produtos escolhidos ali, ex: pizza meio-a-meio)
 * — deliberadamente uma função separada de addItem: cada personalizado
 * é sempre uma linha NOVA (nunca soma na linha existente pelo mesmo
 * product_id, já que todo item personalizado compartilha o mesmo
 * product_id "âncora" — somar quebraria dois combos diferentes na
 * mesma venda em uma linha só). Preço já vem definido pela tela (a
 * sugestão de custo é só um ponto de partida, o operador confirma).
 */
function addCustomItem({ saleId, locationId, nome, preco, linhas, operadorId, deviceId }) {
  const db = getDb();

  const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta — não é possível adicionar itens.' };

  const nomeLimpo = (nome || '').trim();
  if (!nomeLimpo) return { ok: false, error: 'Informe um nome para o item personalizado.' };

  const precoNumerico = Number(preco);
  if (!(precoNumerico >= 0)) return { ok: false, error: 'Preço inválido.' };

  const linhasValidas = (linhas || []).filter((l) => {
    if (l.tipo === 'insumo' && !l.insumoId) return false;
    if (l.tipo === 'produto' && !l.produtoId) return false;
    if (!['insumo', 'produto'].includes(l.tipo)) return false;
    const qtd = l.modo === 'percentual' ? Number(l.percentual) : Number(l.quantidade);
    return qtd > 0;
  });
  if (linhasValidas.length === 0) return { ok: false, error: 'Adicione ao menos um insumo ou produto ao item personalizado.' };

  const anchorId = customItemService.garantirProdutoPersonalizado();
  const itemId = randomUUID();
  const movId = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, nome_personalizado, eh_personalizado)
       VALUES (?, ?, ?, 1, ?, ?, 1)`
    ).run(itemId, saleId, anchorId, precoNumerico, nomeLimpo);

    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, sale_id, sale_item_id, operador_id, device_id)
       VALUES (?, ?, ?, 'venda', -1, ?, ?, ?, ?)`
    ).run(movId, anchorId, locationId, saleId, itemId, operadorId, deviceId);

    customItemService.gravarEDescontarLinhas(itemId, linhasValidas, { locationId, saleId, saleItemId: itemId, operadorId, deviceId });

    db.prepare(`UPDATE sales SET total = total + ? WHERE id = ?`).run(precoNumerico, saleId);
  });
  tx();

  return { ok: true, itemId, precoUnitario: precoNumerico };
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

/**
 * Altera o preço unitário de um item já no carrinho — restrito a
 * gerente/admin, verificado aqui no backend (não só escondido no
 * frontend, pra não dar pra contornar). Usado tanto pra dar um valor
 * de cortesia (cobrar menos) quanto pra cobrar um valor diferente do
 * catálogo por algum motivo — sempre registrado, com o preço
 * original preservado e o motivo opcional.
 */
function setItemPrice({ saleId, saleItemId, novoPreco, motivo, currentOperatorId }) {
  const db = getDb();

  const operador = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(currentOperatorId);
  if (!operador || !['gerente', 'admin', 'suporte'].includes(operador.role)) {
    return { ok: false, error: 'Só gerente ou admin pode alterar o preço de um item.' };
  }

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta.' };

  const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(saleItemId, saleId);
  if (!item) return { ok: false, error: 'Item não encontrado nessa venda.' };
  if (item.cancelado) return { ok: false, error: 'Este item já foi cancelado.' };

  const preco = Number(novoPreco);
  if (!(preco >= 0)) return { ok: false, error: 'Informe um preço válido (maior ou igual a zero).' };

  const precoAntigo = item.preco_unitario;
  const diferenca = (preco - precoAntigo) * item.quantidade;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sale_items SET preco_unitario = ?, preco_original = COALESCE(preco_original, ?), preco_alterado_por_id = ?, preco_alterado_motivo = ? WHERE id = ?`
    ).run(preco, precoAntigo, currentOperatorId, motivo || null, saleItemId);
    db.prepare('UPDATE sales SET total = total + ? WHERE id = ?').run(diferenca, saleId);
  });
  tx();

  db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, sale_id, sale_item_id, solicitante_id, motivo, sucesso)
     VALUES (?, 'preco_item_alterado', ?, ?, ?, ?, 1)`
  ).run(randomUUID(), saleId, saleItemId, currentOperatorId, `De R$ ${precoAntigo.toFixed(2)} para R$ ${preco.toFixed(2)}${motivo ? ' — ' + motivo : ''}`);

  return { ok: true, novoPreco: preco };
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
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  // Sem isso, uma segunda chamada pro mesmo saleId (duplo clique que
  // escapou do guard da tela, retry de IPC) reprocessava registrarDivida
  // e acumularPontos de novo -- cliente ficava devendo em dobro e
  // ganhando pontos em dobro pela MESMA venda.
  if (sale.status !== 'aberta') return { ok: false, error: 'Esta venda não está mais aberta.' };

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
  // por causa disso. Um espelho pra relatório consolidado E pro
  // histórico compartilhado entre PDVs do mesmo grupo.
  const itensDetalhados = db.prepare(
    `SELECT COALESCE(si.nome_personalizado, p.nome) as nome, si.quantidade, si.preco_unitario FROM sale_items si
     JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? AND si.cancelado = 0`
  ).all(saleId);
  const metodosPagamento = db.prepare('SELECT DISTINCT metodo FROM payments WHERE sale_id = ?').all(saleId).map((p) => p.metodo);
  const totalItens = itensDetalhados.length;
  const operador = db.prepare('SELECT nome FROM users WHERE id = ?').get(sale.operador_id);
  const location = db.prepare('SELECT nome FROM locations WHERE id = ?').get(sale.location_id);
  const saleAtualizada = db.prepare('SELECT finalizada_em FROM sales WHERE id = ?').get(saleId);
  salesSyncService.pushSale({
    saleId,
    total: sale.total - sale.desconto - sale.desconto_gerente,
    totalItens,
    itens: itensDetalhados.map((i) => ({ nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
    metodosPagamento,
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
  // Serviço nunca gerou stock_movements no addItem original (ver lá) —
  // cancelar não pode estornar um estoque que nunca existiu, ou o
  // produto-serviço fica com saldo fantasma na tabela de movimentos.
  const ehServico = product?.tipo === 'servico';

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sale_items SET cancelado = 1, cancelado_por_id = ?, cancelado_em = NOW_SYNCED(), motivo_cancelamento = ? WHERE id = ?`
    ).run(autorizadoPorId || currentOperatorId, motivo || null, saleItemId);

    if (!ehServico) {
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, sale_item_id, operador_id, autorizado_por_id, device_id)
         VALUES (?, ?, ?, 'estorno', ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), item.product_id, locationId, Math.abs(item.quantidade), motivo || 'Cancelamento de item', saleId, saleItemId, currentOperatorId, autorizadoPorId, deviceId);

      // Espelha o estorno de estoque do produto pros insumos da ficha
      // técnica (se tiver) — devolve exatamente o que foi descontado
      // no addItem original.
      ingredientService.reverterPorVenda(item.product_id, item.quantidade);
    }

    // Item personalizado: devolve o estoque de cada insumo/produto usado
    // na composição dele (ver customItemService) — o item.product_id
    // acima é só o produto-âncora compartilhado, sem ficha técnica
    // própria, então reverterPorVenda não faz nada por si só.
    if (item.eh_personalizado) {
      customItemService.reverterLinhasDoItem(saleItemId, { locationId, saleId, saleItemId, operadorId: currentOperatorId, deviceId });
    }

    db.prepare(`UPDATE sales SET total = total - ? WHERE id = ?`).run(item.preco_unitario * item.quantidade, saleId);
  });
  tx();

  if (!ehServico) {
    require('./stockSyncService').pushEstoqueProduto(item.product_id).catch(() => {});
  }

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
      // Mesmo raciocínio de cancelSaleItem: serviço nunca gerou
      // stock_movements no addItem original, então cancelar a venda não
      // pode estornar um estoque que nunca existiu pra ele.
      const produtoDoItem = db.prepare('SELECT tipo FROM products WHERE id = ?').get(item.product_id);
      if (produtoDoItem?.tipo !== 'servico') {
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, sale_item_id, operador_id, autorizado_por_id, device_id)
           VALUES (?, ?, ?, 'estorno', ?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), item.product_id, locationId, Math.abs(item.quantidade), motivo || 'Cancelamento de venda', saleId, item.id, currentOperatorId, autorizadoPor?.id || null, deviceId);

        ingredientService.reverterPorVenda(item.product_id, item.quantidade);
      }

      if (item.eh_personalizado) {
        customItemService.reverterLinhasDoItem(item.id, { locationId, saleId, saleItemId: item.id, operadorId: autorizadoPor?.id || currentOperatorId, deviceId });
      }

      db.prepare(`UPDATE sale_items SET cancelado = 1, cancelado_por_id = ?, cancelado_em = NOW_SYNCED() WHERE id = ?`)
        .run(autorizadoPor?.id || currentOperatorId, item.id);
    }
    db.prepare(
      `UPDATE sales SET status = 'cancelada', cancelada_em = NOW_SYNCED(), cancelada_por_id = ?, motivo_cancelamento = ? WHERE id = ?`
    ).run(autorizadoPor?.id || currentOperatorId, motivo || null, saleId);
  });
  tx();

  const stockSyncService = require('./stockSyncService');
  const produtosUnicos = [...new Set(items.map((item) => item.product_id))];
  for (const productId of produtosUnicos) {
    stockSyncService.pushEstoqueProduto(productId).catch(() => {});
  }

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
    `SELECT si.id, COALESCE(si.nome_personalizado, p.nome) as nome, si.quantidade, si.preco_unitario, si.cancelado, si.observacao
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? ORDER BY si.criado_em`
  ).all(saleId);
}

/**
 * Finaliza a venda, mas antes — se essa instalação estiver num grupo
 * de sincronização — confere e debita o estoque compartilhado numa
 * transação atômica contra o Firestore. Pedido explícito: prefere
 * atrasar um pouco a finalização a arriscar vender a mesma última
 * unidade em duas máquinas ao mesmo tempo.
 *
 * Sem grupo configurado, se comporta exatamente como antes — sem
 * nenhum atraso nem chamada de rede.
 */
async function finalizeSaleComVerificacaoDeGrupo(saleId) {
  const db = getDb();
  // Itens personalizados ficam FORA dessa checagem: o estoque de verdade
  // deles já foi debitado localmente por insumo/produto no momento do
  // addCustomItem, e o product_id que aparece aqui é só o produto-âncora
  // compartilhado (sem estoque próprio de verdade) — incluí-lo bloquearia
  // a venda por falta de "estoque remoto" de um produto que não existe
  // de verdade no grupo de sincronização.
  const itens = db.prepare(
    `SELECT si.product_id as productId, si.quantidade, COALESCE(si.nome_personalizado, p.nome) as nome
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 AND si.eh_personalizado = 0`
  ).all(saleId);

  const stockSyncService = require('./stockSyncService');
  const checagem = await stockSyncService.verificarEDebitarEstoqueRemoto(itens);
  if (!checagem.ok) return checagem;

  return finalizeSale(saleId);
}

/**
 * Corrige diretamente uma venda já no histórico — data/hora e/ou
 * valor total. Restrito a admin (checado aqui no backend, não só
 * escondido na tela). Pensado como válvula de escape manual pra
 * quando algo ficou errado (ex: fuso horário de uma sincronização
 * antiga) e não dá pra esperar uma correção automática — ou pra
 * simplesmente corrigir um erro de digitação/registro.
 *
 * Sempre registrado na auditoria com o valor antigo e o novo. Se a
 * venda fizer parte de um grupo de sincronização, reenvia ela
 * corrigida pro Firestore na mesma hora — é exatamente isso que
 * resolve "aparece no dia errado pros outros PDVs do grupo": o
 * diaISO é recalculado a partir da data nova.
 */
async function editarHistoricoVenda({ saleId, novaDataHora, novoTotal, motivo, currentOperatorId }) {
  const db = getDb();

  const operador = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(currentOperatorId);
  if (!operador || !['admin', 'suporte'].includes(operador.role)) {
    return { ok: false, error: 'Só admin pode editar o histórico de uma venda.' };
  }

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status !== 'finalizada') {
    return { ok: false, error: 'Só é possível editar vendas já finalizadas (não vendas canceladas ou em aberto).' };
  }

  const dataAntiga = sale.finalizada_em;
  const totalAntigo = sale.total - sale.desconto - sale.desconto_gerente;

  const campos = [];
  const valores = [];
  let novaDataHoraUTC = null;

  if (novaDataHora) {
    // O admin digita horário de Brasília (é o que ele vê na tela e no
    // relógio da parede) — o banco guarda tudo em UTC, então converte
    // aqui antes de gravar. Brasil não tem mais horário de verão desde
    // 2019, então a diferença é sempre exatamente 3 horas — soma 3h no
    // horário local digitado pra chegar no instante UTC certo.
    const match = novaDataHora.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return { ok: false, error: 'Data/hora inválida.' };
    const [, ano, mes, dia, hora, minuto, segundo] = match;
    const dataLocalComoSeUTC = new Date(Date.UTC(+ano, +mes - 1, +dia, +hora, +minuto, +(segundo || 0)));
    if (isNaN(dataLocalComoSeUTC.getTime())) return { ok: false, error: 'Data/hora inválida.' };
    const dataUTCReal = new Date(dataLocalComoSeUTC.getTime() + 3 * 60 * 60 * 1000);
    novaDataHoraUTC = dataUTCReal.toISOString().slice(0, 19).replace('T', ' ');
    campos.push('finalizada_em = ?');
    valores.push(novaDataHoraUTC);
  }

  if (novoTotal !== undefined && novoTotal !== null && novoTotal !== '') {
    const totalNumerico = Number(novoTotal);
    if (!(totalNumerico >= 0)) return { ok: false, error: 'Valor inválido (precisa ser maior ou igual a zero).' };
    // Zera os descontos ao ajustar o total manualmente — editar o
    // histórico já é uma correção direta; manter descontos antigos
    // junto de um total substituído na mão só criaria confusão sobre
    // qual número é "de verdade".
    campos.push('total = ?', 'desconto = 0', 'desconto_gerente = 0');
    valores.push(totalNumerico);
  }

  if (campos.length === 0) return { ok: false, error: 'Informe uma data/hora nova ou um valor novo pra alterar.' };

  db.prepare(`UPDATE sales SET ${campos.join(', ')} WHERE id = ?`).run(...valores, saleId);

  const saleAtualizada = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  const totalNovo = saleAtualizada.total - saleAtualizada.desconto - saleAtualizada.desconto_gerente;

  const formatarLocal = (utcString) => utcString ? new Date(utcString + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';

  db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, motivo, sucesso)
     VALUES (?, 'historico_venda_editado', ?, ?, ?, 1)`
  ).run(
    randomUUID(), saleId, currentOperatorId,
    `Data: ${formatarLocal(dataAntiga)} -> ${formatarLocal(saleAtualizada.finalizada_em)} | Total: R$ ${totalAntigo.toFixed(2)} -> R$ ${totalNovo.toFixed(2)}${motivo ? ' — ' + motivo : ''}`
  );

  // Reenvia a venda corrigida pro grupo (se essa instalação estiver
  // sincronizada) — o diaISO é recalculado a partir da data nova, o
  // que resolve a venda aparecer no dia errado pra quem mais está no
  // grupo, na mesma hora que você corrige aqui.
  try {
    const itensDetalhados = db.prepare(
      `SELECT COALESCE(si.nome_personalizado, p.nome) as nome, si.quantidade, si.preco_unitario FROM sale_items si
       JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? AND si.cancelado = 0`
    ).all(saleId);
    const metodosPagamento = db.prepare('SELECT DISTINCT metodo FROM payments WHERE sale_id = ?').all(saleId).map((p) => p.metodo);
    const operadorDaVenda = db.prepare('SELECT nome FROM users WHERE id = ?').get(saleAtualizada.operador_id);
    const location = db.prepare('SELECT nome FROM locations WHERE id = ?').get(saleAtualizada.location_id);
    require('./salesSyncService').pushSale({
      saleId, total: totalNovo, totalItens: itensDetalhados.length,
      itens: itensDetalhados.map((i) => ({ nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
      metodosPagamento, finalizadaEm: saleAtualizada.finalizada_em,
      operadorNome: operadorDaVenda?.nome, locationNome: location?.nome,
    }).catch(() => {});
  } catch (err) {
    console.error('[saleService] falha ao reenviar venda editada pro grupo (não afeta a edição local):', err);
  }

  return { ok: true, dataAntiga, dataNova: saleAtualizada.finalizada_em, totalAntigo, totalNovo };
}

module.exports = {
  openSale, getOrOpenCurrentSale, listSalesByRange, listRecentlySold, setCustomer, redeemLoyaltyPoints,
  applyManagerDiscount, removeManagerDiscount, setServiceCharge,
  addItem, addCustomItem, addPayment, removePayment, finalizeSale, finalizeSaleComVerificacaoDeGrupo, cancelSaleItem, cancelSale, needsManagerAuthForCancel, setItemNote, setItemPerson, setItemPrice,
  getSaleItemsDetail, excluirDoHistorico, reexibirNoHistorico, editarHistoricoVenda,
};
