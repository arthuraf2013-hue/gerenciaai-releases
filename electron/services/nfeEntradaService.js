const fs = require('fs');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');
const { parseNFeXml, TAMANHO_MAXIMO } = require('./nfeXmlParser');

/**
 * Entrada de mercadoria pelo XML da NF-e de compra (ERP, Fase 1).
 *
 * 1. importarXml   -- lê o XML e grava a nota em RASCUNHO, com cada item já
 *                     casado quando dá (código do fornecedor memorizado ->
 *                     código de barras), sem mexer em estoque nem custo.
 * 2. atualizarItem -- a pessoa confere: produto, conversão de unidade
 *                     (caixa com 12 -> fator 12), lote, validade, ignorar.
 * 3. confirmar     -- numa transação só: estoque (lote + movimento), custo
 *                     médio, contas a pagar (uma por duplicata), pedido de
 *                     compra vinculado e o vínculo código -> produto.
 * 4. estornar      -- desfaz por lançamentos novos (nada é apagado do
 *                     ledger): saída do estoque, custo médio de volta,
 *                     contas a pagar ainda abertas canceladas.
 *
 * A mesma chave não entra duas vezes (índice único parcial), a não ser que
 * a entrada anterior tenha sido estornada.
 */

function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function formatarCnpjCpf(doc) {
  const d = soDigitos(doc);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
}

/** Lê o arquivo escolhido no diálogo (o caminho nunca vem do renderer). */
function lerArquivoXml(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > TAMANHO_MAXIMO) return { ok: false, error: 'Arquivo grande demais para ser um XML de NF-e.' };
  return { ok: true, xml: fs.readFileSync(filePath, 'utf-8') };
}

function acharFornecedorPorDocumento(db, documento) {
  const alvo = soDigitos(documento);
  if (!alvo) return null;
  // Tabela pequena; cnpj_cpf é texto livre (com ou sem pontuação), então
  // a comparação é por dígitos, aqui.
  return db.prepare('SELECT id, nome, cnpj_cpf, ativo FROM suppliers WHERE cnpj_cpf IS NOT NULL').all()
    .filter((s) => soDigitos(s.cnpj_cpf) === alvo)
    .sort((a, b) => b.ativo - a.ativo)[0] || null;
}

/** Palpite de produto pra um item da nota, em ordem de confiança. */
function casarItem(db, fornecedorId, item) {
  if (fornecedorId && item.codigo) {
    const memorizado = db.prepare(
      `SELECT sp.product_id, sp.fator FROM supplier_products sp JOIN products p ON p.id = sp.product_id
       WHERE sp.supplier_id = ? AND sp.codigo_fornecedor = ? AND p.ativo = 1`
    ).get(fornecedorId, item.codigo);
    if (memorizado) return { productId: memorizado.product_id, fator: memorizado.fator, como: 'codigo_fornecedor' };
  }
  const porEan = (ean) => (ean ? db.prepare(`SELECT id FROM products WHERE codigo_barras = ? AND ativo = 1`).get(ean) : null);
  // O EAN "tributável" é o da unidade de venda ao consumidor; quando a
  // nota vende em caixa (uCom) e tributa por unidade (uTrib), a razão
  // qTrib/qCom é quantas unidades vêm em cada caixa. Vale também quando o
  // fornecedor repete o EAN da unidade no campo comercial.
  const fatorTributavel = item.quantidadeTributavel > 0 && item.quantidade > 0
    ? arred(item.quantidadeTributavel / item.quantidade, 4) : 1;
  const comercial = porEan(item.ean);
  if (comercial) {
    const fator = item.ean === item.eanTributavel && fatorTributavel > 0 ? fatorTributavel : 1;
    return { productId: comercial.id, fator, como: 'ean' };
  }
  const tributavel = porEan(item.eanTributavel);
  if (tributavel) return { productId: tributavel.id, fator: fatorTributavel > 0 ? fatorTributavel : 1, como: 'ean_tributavel' };
  return { productId: null, fator: 1, como: null };
}

/**
 * Custo de entrada de um item: o que efetivamente se pagou por ele,
 * dividido pela quantidade que entra no estoque (já convertida).
 * ICMS próprio não é descontado (Simples/MEI não aproveita crédito; quem
 * é do regime normal ajusta com o contador -- ver doc da arquitetura).
 */
function calcularItem(item) {
  const fator = Number(item.fator) > 0 ? Number(item.fator) : 1;
  const quantidadeEntrada = arred(Number(item.quantidade_nota) * fator, 4);
  const custoTotal = arred(
    Number(item.valor_produto) + Number(item.valor_frete) + Number(item.valor_seguro) + Number(item.valor_outros)
    + Number(item.valor_ipi) + Number(item.valor_icms_st) - Number(item.valor_desconto),
  );
  const custoUnitario = quantidadeEntrada > 0 ? arred(custoTotal / quantidadeEntrada, 4) : 0;
  return { quantidadeEntrada, custoTotal, custoUnitario };
}

function importarXml({ xml, locationId, operadorId }) {
  const lido = parseNFeXml(xml);
  if (!lido.ok) return lido;
  const { nota } = lido;
  const avisos = [...lido.avisos];
  const db = getDb();

  const existente = db.prepare(`SELECT id, status, numero FROM nfe_entradas WHERE chave = ? AND status != 'estornada'`).get(nota.chave);
  if (existente) {
    return {
      ok: false, jaImportada: true, entradaId: existente.id,
      error: existente.status === 'confirmada'
        ? `A NF-e ${nota.numero} já foi lançada no estoque. Para lançar de novo, estorne a entrada anterior.`
        : `A NF-e ${nota.numero} já está em conferência. Abra a nota que está na lista.`,
    };
  }

  const fiscal = db.prepare('SELECT cnpj FROM fiscal_config WHERE id = ?').get('default');
  const docDest = soDigitos(nota.destinatario?.cnpj || nota.destinatario?.cpf);
  if (fiscal?.cnpj && docDest && soDigitos(fiscal.cnpj) !== docDest) {
    avisos.push(`Esta nota foi emitida para ${formatarCnpjCpf(docDest)}, que não é o CNPJ da loja (${formatarCnpjCpf(fiscal.cnpj)}).`);
  }

  const docEmit = nota.emitente.cnpj || nota.emitente.cpf;
  const fornecedor = acharFornecedorPorDocumento(db, docEmit);
  if (fornecedor && !fornecedor.ativo) avisos.push(`O fornecedor ${fornecedor.nome} está desativado no cadastro.`);

  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO nfe_entradas (id, chave, numero, serie, emissao, fornecedor_id, emitente_cnpj, emitente_nome, destinatario_doc,
         valor_produtos, valor_frete, valor_desconto, valor_total, xml, location_id, operador_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, nota.chave, nota.numero, nota.serie, nota.emissao, fornecedor?.id || null, soDigitos(docEmit),
      nota.emitente.nome || nota.emitente.fantasia, docDest || null, nota.totais.produtos, nota.totais.frete,
      nota.totais.desconto, nota.totais.total, String(xml), locationId, operadorId);

    const insItem = db.prepare(
      `INSERT INTO nfe_entrada_itens (id, entrada_id, n_item, codigo_fornecedor, ean, descricao, ncm, cfop, unidade_nota,
         quantidade_nota, valor_unitario_nota, valor_produto, valor_frete, valor_seguro, valor_desconto, valor_outros,
         valor_ipi, valor_icms_st, lotes_json, product_id, fator, lote, validade)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of nota.itens) {
      const palpite = casarItem(db, fornecedor?.id, item);
      // Lote/validade da própria nota (grupo <rastro>, comum em farmácia e
      // alimento). Com mais de um lote no item, sugere o que vence antes.
      const lotes = [...item.lotes].sort((a, b) => String(a.validade).localeCompare(String(b.validade)));
      insItem.run(randomUUID(), id, item.nItem, item.codigo || null, item.ean || item.eanTributavel || null, item.descricao,
        item.ncm || null, item.cfop || null, item.unidade || null, item.quantidade, item.valorUnitario, item.valorProduto,
        item.frete, item.seguro, item.desconto, item.outros, item.ipi, item.icmsSt, JSON.stringify(item.lotes),
        palpite.productId, palpite.fator, lotes[0]?.lote || null, /^\d{4}-\d{2}-\d{2}$/.test(lotes[0]?.validade || '') ? lotes[0].validade : null);
    }
    const insDup = db.prepare('INSERT INTO nfe_entrada_duplicatas (id, entrada_id, numero, vencimento, valor) VALUES (?, ?, ?, ?, ?)');
    for (const d of nota.duplicatas) insDup.run(randomUUID(), id, d.numero, d.vencimento, d.valor);
  })();

  return { ok: true, id, avisos };
}

function listar({ status } = {}) {
  const db = getDb();
  const params = [];
  let filtro = '';
  if (status) { filtro = 'WHERE e.status = ?'; params.push(status); }
  return db.prepare(
    `SELECT e.id, e.chave, e.numero, e.serie, e.emissao, e.status, e.valor_total, e.criado_em, e.confirmada_em, e.estornada_em,
       e.purchase_order_id, COALESCE(s.nome, e.emitente_nome) AS fornecedor_nome,
       (SELECT COUNT(*) FROM nfe_entrada_itens i WHERE i.entrada_id = e.id) AS qtd_itens,
       (SELECT COUNT(*) FROM nfe_entrada_itens i WHERE i.entrada_id = e.id AND i.ignorar = 0 AND i.product_id IS NULL) AS itens_sem_produto
     FROM nfe_entradas e LEFT JOIN suppliers s ON s.id = e.fornecedor_id
     ${filtro}
     ORDER BY CASE e.status WHEN 'rascunho' THEN 0 ELSE 1 END, e.criado_em DESC LIMIT 300`
  ).all(...params);
}

function obter(id) {
  const db = getDb();
  const entrada = db.prepare(
    `SELECT e.*, s.nome AS fornecedor_nome, o.numero AS pedido_numero
     FROM nfe_entradas e LEFT JOIN suppliers s ON s.id = e.fornecedor_id
     LEFT JOIN purchase_orders o ON o.id = e.purchase_order_id
     WHERE e.id = ?`
  ).get(id);
  if (!entrada) return null;
  const { xml, ...semXml } = entrada; // o XML não vai pra tela (só pesa)
  const itens = db.prepare(
    `SELECT i.*, p.nome AS produto_nome, p.unidade AS produto_unidade, p.custo AS produto_custo, p.tipo AS produto_tipo
     FROM nfe_entrada_itens i LEFT JOIN products p ON p.id = i.product_id
     WHERE i.entrada_id = ? ORDER BY i.n_item`
  ).all(id).map((i) => {
    const calc = calcularItem(i);
    return {
      ...i,
      lotes: JSON.parse(i.lotes_json || '[]'),
      quantidade_entrada_prevista: calc.quantidadeEntrada,
      custo_total_previsto: calc.custoTotal,
      custo_unitario_previsto: calc.custoUnitario,
    };
  });
  const duplicatas = db.prepare('SELECT * FROM nfe_entrada_duplicatas WHERE entrada_id = ? ORDER BY vencimento').all(id);
  const contas = db.prepare('SELECT id, descricao, valor, data_vencimento, data_pagamento FROM expenses WHERE nfe_entrada_id = ? ORDER BY data_vencimento').all(id);
  const pendencias = itens.filter((i) => !i.ignorar && !i.product_id).length;
  return { ...semXml, itens, duplicatas, contas, pendencias };
}

function exigirRascunho(db, entradaId) {
  const e = db.prepare('SELECT id, status, fornecedor_id FROM nfe_entradas WHERE id = ?').get(entradaId);
  if (!e) return { erro: 'Nota não encontrada.' };
  if (e.status !== 'rascunho') return { erro: 'Esta nota já foi confirmada ou estornada — não dá mais para editar.' };
  return { entrada: e };
}

/** Conferência de um item (só em rascunho). Campos ausentes não mudam. */
function atualizarItem({ entradaId, itemId, productId, fator, lote, validade, ignorar }) {
  const db = getDb();
  const { erro } = exigirRascunho(db, entradaId);
  if (erro) return { ok: false, error: erro };
  const item = db.prepare('SELECT * FROM nfe_entrada_itens WHERE id = ? AND entrada_id = ?').get(itemId, entradaId);
  if (!item) return { ok: false, error: 'Item não encontrado nesta nota.' };

  const novo = { ...item };
  if (productId !== undefined) {
    if (productId) {
      const p = db.prepare('SELECT id, nome, tipo, ativo FROM products WHERE id = ?').get(productId);
      if (!p) return { ok: false, error: 'Produto não encontrado.' };
      if (p.tipo === 'servico') return { ok: false, error: `"${p.nome}" é serviço — não tem estoque para dar entrada.` };
      if (!p.ativo) return { ok: false, error: `"${p.nome}" está desativado.` };
    }
    novo.product_id = productId || null;
  }
  if (fator !== undefined) {
    const f = Number(fator);
    if (!(f > 0) || f > 100000) return { ok: false, error: 'A conversão precisa ser um número maior que zero (ex.: caixa com 12 = 12).' };
    novo.fator = arred(f, 4);
  }
  if (lote !== undefined) novo.lote = String(lote || '').trim().slice(0, 60) || null;
  if (validade !== undefined) {
    if (validade && !/^\d{4}-\d{2}-\d{2}$/.test(validade)) return { ok: false, error: 'Data de validade inválida.' };
    novo.validade = validade || null;
  }
  if (ignorar !== undefined) novo.ignorar = ignorar ? 1 : 0;

  db.prepare('UPDATE nfe_entrada_itens SET product_id = ?, fator = ?, lote = ?, validade = ?, ignorar = ? WHERE id = ?')
    .run(novo.product_id, novo.fator, novo.lote, novo.validade, novo.ignorar, itemId);
  return { ok: true, item: { ...novo, ...calcularItem(novo) } };
}

function vincularPedido({ entradaId, purchaseOrderId }) {
  const db = getDb();
  const { erro, entrada } = exigirRascunho(db, entradaId);
  if (erro) return { ok: false, error: erro };
  if (purchaseOrderId) {
    const pedido = db.prepare('SELECT id, status, fornecedor_id, numero FROM purchase_orders WHERE id = ?').get(purchaseOrderId);
    if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
    if (!['rascunho', 'enviado', 'parcial'].includes(pedido.status)) return { ok: false, error: `O pedido nº ${pedido.numero} está ${pedido.status}.` };
    if (entrada.fornecedor_id && pedido.fornecedor_id !== entrada.fornecedor_id) return { ok: false, error: 'O pedido é de outro fornecedor.' };
  }
  db.prepare('UPDATE nfe_entradas SET purchase_order_id = ? WHERE id = ?').run(purchaseOrderId || null, entradaId);
  return { ok: true };
}

/** Joga fora uma nota em conferência (nada foi lançado ainda). */
function descartar({ entradaId }) {
  const db = getDb();
  const { erro } = exigirRascunho(db, entradaId);
  if (erro) return { ok: false, error: erro };
  db.transaction(() => {
    db.prepare('DELETE FROM nfe_entrada_itens WHERE entrada_id = ?').run(entradaId);
    db.prepare('DELETE FROM nfe_entrada_duplicatas WHERE entrada_id = ?').run(entradaId);
    db.prepare('DELETE FROM nfe_entradas WHERE id = ?').run(entradaId);
  })();
  return { ok: true };
}

function agoraUtcSql() {
  return timeService.nowSyncedUTCString();
}

/**
 * Lança a nota. `contaAPagar` decide o financeiro:
 *  - { modo: 'duplicatas' }               uma conta por duplicata da nota (padrão quando a nota tem)
 *  - { modo: 'vencimento', vencimento }   uma conta só, com o total, vencendo nessa data
 *  - { modo: 'paga' }                     uma conta já paga (compra à vista)
 *  - { modo: 'nenhuma' }                  não lança nada no financeiro
 */
function confirmar({ entradaId, locationId, operadorId, deviceId, contaAPagar }) {
  const db = getDb();
  const { erro } = exigirRascunho(db, entradaId);
  if (erro) return { ok: false, error: erro };
  const entrada = db.prepare('SELECT * FROM nfe_entradas WHERE id = ?').get(entradaId);
  const itens = db.prepare('SELECT * FROM nfe_entrada_itens WHERE entrada_id = ? ORDER BY n_item').all(entradaId);
  const duplicatas = db.prepare('SELECT * FROM nfe_entrada_duplicatas WHERE entrada_id = ? ORDER BY vencimento').all(entradaId);

  const validos = itens.filter((i) => !i.ignorar);
  if (validos.length === 0) return { ok: false, error: 'Todos os itens estão marcados para ignorar — não há nada para dar entrada.' };
  const semProduto = validos.filter((i) => !i.product_id);
  if (semProduto.length > 0) {
    return { ok: false, error: `Falta escolher o produto de ${semProduto.length} item(ns): ${semProduto.slice(0, 3).map((i) => `"${i.descricao}"`).join(', ')}${semProduto.length > 3 ? '...' : ''}.` };
  }
  for (const i of validos) {
    const p = db.prepare('SELECT nome, tipo, ativo FROM products WHERE id = ?').get(i.product_id);
    if (!p) return { ok: false, error: `O produto do item "${i.descricao}" não existe mais.` };
    if (p.tipo === 'servico') return { ok: false, error: `"${p.nome}" é serviço — não tem estoque para dar entrada.` };
    if (!p.ativo) return { ok: false, error: `"${p.nome}" está desativado.` };
    if (calcularItem(i).custoTotal < 0) return { ok: false, error: `O desconto do item "${i.descricao}" é maior que o valor dele — confira a nota.` };
  }

  const modo = contaAPagar?.modo || (duplicatas.length > 0 ? 'duplicatas' : null);
  if (!['duplicatas', 'vencimento', 'paga', 'nenhuma'].includes(modo)) {
    return { ok: false, error: 'Esta nota não tem duplicatas. Escolha como fica o pagamento: com vencimento, já paga ou sem lançar no financeiro.' };
  }
  if (modo === 'duplicatas' && duplicatas.length === 0) return { ok: false, error: 'Esta nota não tem duplicatas.' };
  if (modo === 'vencimento' && !/^\d{4}-\d{2}-\d{2}$/.test(contaAPagar?.vencimento || '')) return { ok: false, error: 'Informe a data de vencimento.' };

  if (entrada.purchase_order_id) {
    const pedido = db.prepare('SELECT status, numero FROM purchase_orders WHERE id = ?').get(entrada.purchase_order_id);
    if (!pedido || !['rascunho', 'enviado', 'parcial'].includes(pedido.status)) {
      return { ok: false, error: `O pedido vinculado (nº ${pedido?.numero ?? '?'}) não pode mais receber mercadoria. Desvincule para continuar.` };
    }
  }

  const custoMedioService = require('./custoMedioService');
  const batchService = require('./batchService');
  const purchaseOrderService = require('./purchaseOrderService');
  let resumo;
  try {
    db.transaction(() => {
      // Fornecedor: o que já casou, o que aparecer agora pelo CNPJ, ou um
      // cadastro novo com os dados da própria nota.
      let fornecedorId = entrada.fornecedor_id;
      if (!fornecedorId) fornecedorId = acharFornecedorPorDocumento(db, entrada.emitente_cnpj)?.id || null;
      if (!fornecedorId) {
        fornecedorId = randomUUID();
        const lido = parseNFeXml(entrada.xml);
        const emit = lido.ok ? lido.nota.emitente : {};
        db.prepare('INSERT INTO suppliers (id, nome, cnpj_cpf, telefone) VALUES (?, ?, ?, ?)')
          .run(fornecedorId, (emit.fantasia || entrada.emitente_nome || 'Fornecedor').slice(0, 120),
            formatarCnpjCpf(entrada.emitente_cnpj), emit.endereco?.telefone || null);
      }
      const fornecedorNome = db.prepare('SELECT nome FROM suppliers WHERE id = ?').get(fornecedorId).nome;
      const motivo = `NF-e ${entrada.numero}${entrada.serie ? `/${entrada.serie}` : ''} — ${fornecedorNome}`;

      for (const item of validos) {
        const { quantidadeEntrada, custoUnitario } = calcularItem(item);
        // Custo antes do movimento (a ponderação usa o estoque de antes).
        custoMedioService.registrarEntrada(db, {
          productId: item.product_id, quantidade: quantidadeEntrada, custoUnitario,
          origem: 'nfe', origemId: entradaId, operadorId,
        });
        const r = batchService.createBatch({
          productId: item.product_id, locationId, lote: item.lote, validade: item.validade,
          quantidade: quantidadeEntrada, fornecedorId, operadorId, deviceId, motivo,
        });
        if (!r.ok) throw new Error(`Item "${item.descricao}": ${r.error}`);
        db.prepare('UPDATE nfe_entrada_itens SET quantidade_entrada = ?, custo_unitario = ?, stock_movement_id = ?, batch_id = ? WHERE id = ?')
          .run(quantidadeEntrada, custoUnitario, r.movementId, r.batchId, item.id);
        if (item.codigo_fornecedor) {
          db.prepare(
            `INSERT INTO supplier_products (supplier_id, codigo_fornecedor, product_id, fator, atualizado_em)
             VALUES (?, ?, ?, ?, NOW_SYNCED())
             ON CONFLICT(supplier_id, codigo_fornecedor) DO UPDATE SET product_id = excluded.product_id, fator = excluded.fator, atualizado_em = excluded.atualizado_em`
          ).run(fornecedorId, item.codigo_fornecedor, item.product_id, item.fator);
        }
        if (entrada.purchase_order_id) {
          purchaseOrderService.aplicarRecebimento(db, entrada.purchase_order_id, item.product_id, quantidadeEntrada);
        }
      }
      if (entrada.purchase_order_id) purchaseOrderService.recalcularStatus(db, entrada.purchase_order_id);

      // Financeiro -- contas a pagar (tabela expenses, a mesma da tela Financeiro).
      const insConta = db.prepare(
        `INSERT INTO expenses (id, categoria, descricao, valor, fornecedor_id, data_vencimento, data_pagamento, location_id, operador_id, nfe_entrada_id)
         VALUES (?, 'fornecedor', ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let contas = 0;
      if (modo === 'duplicatas') {
        duplicatas.forEach((d, i) => {
          insConta.run(randomUUID(), `${motivo} — parcela ${i + 1}/${duplicatas.length} (dup. ${d.numero})`, d.valor,
            fornecedorId, d.vencimento, null, locationId, operadorId, entradaId);
          contas += 1;
        });
      } else if (modo === 'vencimento' || modo === 'paga') {
        if (entrada.valor_total > 0) {
          insConta.run(randomUUID(), motivo, entrada.valor_total, fornecedorId,
            modo === 'vencimento' ? contaAPagar.vencimento : null, modo === 'paga' ? agoraUtcSql() : null,
            locationId, operadorId, entradaId);
          contas = 1;
        }
      }

      db.prepare(`UPDATE nfe_entradas SET status = 'confirmada', fornecedor_id = ?, confirmada_em = NOW_SYNCED(), confirmada_por_id = ? WHERE id = ?`)
        .run(fornecedorId, operadorId, entradaId);
      purchaseOrderService.registrarAuditoria(db, 'nfe_entrada_confirmada', operadorId,
        `${motivo}: ${validos.length} item(ns) no estoque, R$ ${Number(entrada.valor_total).toFixed(2)}, ${contas} conta(s) a pagar.`);
      resumo = { itens: validos.length, contas, fornecedorId };
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, ...resumo };
}

/**
 * Desfaz uma entrada confirmada. Conta a pagar já paga trava o estorno: o
 * dinheiro saiu, e isso precisa ser resolvido (e a conta excluída no
 * Financeiro, que fica na Auditoria) antes.
 */
function estornar({ entradaId, motivo, operadorId, deviceId }) {
  const db = getDb();
  const entrada = db.prepare('SELECT * FROM nfe_entradas WHERE id = ?').get(entradaId);
  if (!entrada) return { ok: false, error: 'Nota não encontrada.' };
  if (entrada.status !== 'confirmada') return { ok: false, error: 'Só nota confirmada pode ser estornada.' };
  const justificativa = String(motivo || '').trim();
  if (justificativa.length < 5) return { ok: false, error: 'Escreva o motivo do estorno.' };

  const pagas = db.prepare('SELECT descricao FROM expenses WHERE nfe_entrada_id = ? AND data_pagamento IS NOT NULL').all(entradaId);
  if (pagas.length > 0) {
    return { ok: false, error: `Esta nota tem ${pagas.length} conta(s) a pagar já paga(s). Resolva a devolução do dinheiro com o fornecedor e exclua essa(s) conta(s) em Financeiro antes de estornar.` };
  }

  const itens = db.prepare('SELECT * FROM nfe_entrada_itens WHERE entrada_id = ? AND stock_movement_id IS NOT NULL').all(entradaId);
  const custoMedioService = require('./custoMedioService');
  const purchaseOrderService = require('./purchaseOrderService');
  const stockSyncService = require('./stockSyncService');
  try {
    db.transaction(() => {
      for (const item of itens) {
        const original = db.prepare('SELECT location_id FROM stock_movements WHERE id = ?').get(item.stock_movement_id);
        custoMedioService.registrarEstorno(db, {
          productId: item.product_id, quantidade: item.quantidade_entrada, custoUnitario: item.custo_unitario,
          origem: 'nfe', origemId: entradaId, operadorId,
        });
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id)
           VALUES (?, ?, ?, 'ajuste', ?, ?, ?, ?)`
        ).run(randomUUID(), item.product_id, original.location_id, -item.quantidade_entrada,
          `Estorno da NF-e ${entrada.numero}: ${justificativa}`.slice(0, 250), operadorId, deviceId);
        stockSyncService.registrarMovimentoDoServidor(item.product_id, -item.quantidade_entrada, `estorno NF-e ${entrada.numero}`);
        // O lote some da recomendação por validade -- a mercadoria voltou.
        if (item.batch_id) db.prepare('DELETE FROM product_batches WHERE id = ?').run(item.batch_id);
        if (entrada.purchase_order_id) {
          purchaseOrderService.aplicarRecebimento(db, entrada.purchase_order_id, item.product_id, -item.quantidade_entrada);
        }
      }
      if (entrada.purchase_order_id) purchaseOrderService.recalcularStatus(db, entrada.purchase_order_id);
      const canceladas = db.prepare('DELETE FROM expenses WHERE nfe_entrada_id = ? AND data_pagamento IS NULL').run(entradaId).changes;
      db.prepare(`UPDATE nfe_entradas SET status = 'estornada', estornada_em = NOW_SYNCED(), estornada_por_id = ?, estorno_motivo = ? WHERE id = ?`)
        .run(operadorId, justificativa, entradaId);
      purchaseOrderService.registrarAuditoria(db, 'nfe_entrada_estornada', operadorId,
        `Estorno da NF-e ${entrada.numero} (${entrada.emitente_nome}): ${itens.length} item(ns) devolvido(s) do estoque, ${canceladas} conta(s) a pagar cancelada(s). Motivo: ${justificativa}`);
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

module.exports = {
  lerArquivoXml, importarXml, listar, obter, atualizarItem, vincularPedido, descartar, confirmar, estornar,
  calcularItem, casarItem,
};
