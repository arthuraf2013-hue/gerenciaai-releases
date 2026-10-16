const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const saleService = require('./saleService');
const pdvMobileConfigService = require('./pdvMobileConfigService');

/**
 * PDV móvel: o celular (PWA em pwa-mobile/, pareado com tipo 'pdv') monta
 * a venda inteira -- itens, desconto, cliente, pagamentos -- e grava UM
 * documento em installations/{installId}/vendas_mobile/{id}. Este serviço
 * (o desktop é o "servidor" da loja) escuta esses documentos, revalida
 * tudo e cria a venda local PELOS MESMOS CAMINHOS do PDV de balcão
 * (saleService.openSale/addItem/addPayment/finalizeSaleComVerificacaoDeGrupo)
 * -- estoque baixado, ficha técnica, caixa, fiado, fidelidade, espelho do
 * grupo de sincronização: tudo igual a uma venda feita no computador.
 * O resultado volta pro mesmo documento (status 'finalizada' | 'pendente'
 * | 'erro') e o celular mostra na hora.
 *
 * Nada do que vem do celular é confiado cegamente:
 *   - preço: sempre o do catálogo local (addItem); se o subtotal que o
 *     celular mostrou pro cliente não bater, a venda é recusada com os
 *     preços atuais (codigoErro 'precos_alterados') -- o celular atualiza
 *     o carrinho e o operador cobra de novo. Nunca cobra um valor
 *     diferente do que o cliente viu.
 *   - desconto: limitado pela política de pdv_mobile_config (ver
 *     aplicarDesconto).
 *   - pagamento: mesmos tetos do addPayment; dinheiro acima do que falta
 *     vira troco (valorRecebido), nunca entra como dinheiro no caixa.
 *   - caixa: precisa haver caixa aberto no computador, igual ao balcão.
 *
 * Idempotência: `mobile_sales` (id = id do documento) -- reentrega do
 * listener, ou o app fechando no meio, nunca duplica venda; o
 * processamento continua de onde parou.
 */

const TOLERANCIA_CENTAVO = 0.009;
const LIMITE_ITENS = 300;
const LIMITE_PAGAMENTOS = 10;
const PAPEIS_QUE_VENDEM = ['operador', 'gerente', 'admin', 'suporte'];

class ErroVendaMobile extends Error {
  constructor(codigo, mensagem, extra = {}) {
    super(mensagem);
    this.codigo = codigo;
    this.extra = extra;
  }
}

function arred2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/** Celular pareado como PDV móvel, ativo, junto do usuário do vínculo
 * (em nome de quem a venda sai). */
function buscarDispositivoPdv(uid) {
  if (!uid || typeof uid !== 'string') return undefined;
  const db = getDb();
  return db.prepare(
    `SELECT pd.*, u.nome as vinculo_nome, u.role as vinculo_role, u.ativo as vinculo_ativo
     FROM paired_devices pd JOIN users u ON u.id = pd.vinculo_user_id
     WHERE pd.id = ? AND pd.tipo = 'pdv' AND pd.ativo = 1`
  ).get(uid);
}

function getLocationId() {
  const location = getDb().prepare('SELECT id FROM locations LIMIT 1').get();
  if (!location) throw new ErroVendaMobile('sem_local', 'Nenhum local cadastrado nesta instalação.');
  return location.id;
}

/** Valida o FORMATO do que veio do celular (não a regra de negócio --
 * essa fica em criarVendaLocal). Devolve uma cópia limpa, só com os
 * campos conhecidos. */
function normalizarPayload(dados) {
  const itensBrutos = Array.isArray(dados?.itens) ? dados.itens : [];
  if (itensBrutos.length === 0) throw new ErroVendaMobile('carrinho_vazio', 'A venda chegou sem nenhum item.');
  if (itensBrutos.length > LIMITE_ITENS) throw new ErroVendaMobile('carrinho_grande', `Venda com itens demais (máximo ${LIMITE_ITENS}).`);

  const porProduto = new Map();
  for (const item of itensBrutos) {
    const productId = typeof item?.productId === 'string' ? item.productId : null;
    const quantidade = Number(item?.quantidade);
    if (!productId) throw new ErroVendaMobile('item_invalido', 'Item sem produto identificado.');
    if (!Number.isFinite(quantidade) || quantidade <= 0 || quantidade > 100000) {
      throw new ErroVendaMobile('item_invalido', `Quantidade inválida para "${item?.nome || 'item'}".`);
    }
    // Mesmo produto em duas linhas (não deveria acontecer, o celular já
    // agrupa) soma numa só -- igual addItem faria de qualquer jeito.
    const atual = porProduto.get(productId);
    porProduto.set(productId, {
      productId, nome: String(item?.nome || '').slice(0, 120), quantidade: (atual?.quantidade || 0) + quantidade,
    });
  }

  const pagamentosBrutos = Array.isArray(dados?.pagamentos) ? dados.pagamentos : [];
  if (pagamentosBrutos.length === 0) throw new ErroVendaMobile('sem_pagamento', 'A venda chegou sem nenhum pagamento.');
  if (pagamentosBrutos.length > LIMITE_PAGAMENTOS) throw new ErroVendaMobile('pagamentos_demais', `Pagamentos demais (máximo ${LIMITE_PAGAMENTOS}).`);
  const pagamentos = pagamentosBrutos.map((p) => {
    const metodo = String(p?.metodo || '');
    const valor = Number(p?.valor);
    const valorRecebido = p?.valorRecebido != null ? Number(p.valorRecebido) : null;
    if (!pdvMobileConfigService.METODOS_PAGAMENTO_VALIDOS.includes(metodo)) {
      throw new ErroVendaMobile('pagamento_invalido', `Forma de pagamento desconhecida: ${metodo || '(vazia)'}.`);
    }
    if (!Number.isFinite(valor) || valor <= 0) throw new ErroVendaMobile('pagamento_invalido', 'Pagamento com valor inválido.');
    if (valorRecebido != null && (!Number.isFinite(valorRecebido) || valorRecebido < valor)) {
      throw new ErroVendaMobile('pagamento_invalido', 'Valor recebido inválido.');
    }
    return { metodo, valor: arred2(valor), valorRecebido: valorRecebido != null ? arred2(valorRecebido) : null };
  });

  const descontoValor = Number(dados?.desconto?.valor) || 0;
  if (descontoValor < 0) throw new ErroVendaMobile('desconto_invalido', 'Desconto inválido.');

  const subtotalEsperado = Number(dados?.subtotalEsperado);
  if (!Number.isFinite(subtotalEsperado) || subtotalEsperado < 0) {
    throw new ErroVendaMobile('payload_invalido', 'Venda sem o subtotal mostrado no celular -- atualize o app.');
  }

  return {
    itens: [...porProduto.values()],
    pagamentos,
    desconto: { valor: arred2(descontoValor), motivo: dados?.desconto?.motivo ? String(dados.desconto.motivo).slice(0, 200) : null },
    clienteId: typeof dados?.clienteId === 'string' && dados.clienteId ? dados.clienteId : null,
    subtotalEsperado,
  };
}

/** Desconto da venda do celular -- mesma coluna do desconto manual do
 * balcão (sales.desconto_gerente), mas o celular não tem como pedir o PIN
 * de um segundo gerente na hora. Então:
 *   - security_config.exigir_autorizacao_desconto DESLIGADO: igual ao
 *     balcão -- desconto livre (até o valor da venda), com rastro.
 *   - LIGADO: só até o percentual que um gerente/admin deixou
 *     pré-autorizado em Configurações → Celular; quem salvou essa
 *     política fica como `desconto_autorizado_por_id`. 0% = celular não
 *     dá desconto nenhum. */
function aplicarDesconto({ db, saleId, desconto, operadorId, config }) {
  if (!(desconto.valor > 0)) return;
  const sale = db.prepare('SELECT total, desconto FROM sales WHERE id = ?').get(saleId);
  const totalDisponivel = sale.total - sale.desconto;
  if (desconto.valor > totalDisponivel + TOLERANCIA_CENTAVO) {
    throw new ErroVendaMobile('desconto_invalido', `Desconto maior que o valor da venda (R$ ${totalDisponivel.toFixed(2)}).`);
  }

  const exigeAutorizacao = require('./authService').getSecurityConfig()?.exigir_autorizacao_desconto === 1;
  let autorizadoPorId = null;
  if (exigeAutorizacao) {
    const pct = config.descontoMaximoPercentual;
    if (!(pct > 0)) {
      throw new ErroVendaMobile('desconto_nao_permitido', 'Desconto pelo celular não está liberado nesta loja. Peça pra um gerente aplicar no computador.');
    }
    const limite = arred2(totalDisponivel * (pct / 100));
    if (desconto.valor > limite + TOLERANCIA_CENTAVO) {
      throw new ErroVendaMobile('desconto_acima_do_limite', `Desconto máximo pelo celular: ${pct}% (R$ ${limite.toFixed(2)} nesta venda).`);
    }
    autorizadoPorId = config.atualizadoPorId;
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, autorizado_por_id, motivo, sucesso)
       VALUES (?, 'desconto_pdv_movel', ?, ?, ?, ?, 1)`
    ).run(
      randomUUID(), saleId, operadorId, autorizadoPorId,
      `R$ ${desconto.valor.toFixed(2)} (até ${pct}% pela política do PDV móvel)${desconto.motivo ? ' — ' + desconto.motivo : ''}`,
    );
  } else {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, motivo, sucesso)
       VALUES (?, 'desconto_manual_sem_autorizacao_configurada', ?, ?, ?, 1)`
    ).run(randomUUID(), saleId, operadorId, `PDV móvel: R$ ${desconto.valor.toFixed(2)}${desconto.motivo ? ' — ' + desconto.motivo : ''}`);
  }

  db.prepare(
    `UPDATE sales SET desconto_gerente = ?, desconto_gerente_motivo = ?, desconto_autorizado_por_id = ? WHERE id = ?`
  ).run(desconto.valor, desconto.motivo || 'Desconto no PDV móvel', autorizadoPorId, saleId);
}

/**
 * Parte SÍNCRONA: valida tudo e cria a venda local ABERTA (itens +
 * desconto + cliente + pagamentos) numa transação só -- qualquer recusa
 * no meio do caminho (estoque, preço, pagamento...) desfaz tudo, inclusive
 * a baixa de estoque dos itens anteriores (as transações internas de
 * addItem viram savepoints da transação de fora, ver better-sqlite3).
 * Finalizar fica pra finalizarVendaMobile (assíncrona, por causa da
 * checagem de estoque do grupo).
 */
function criarVendaLocal({ vendaId, dados, dispositivo, locationId }) {
  const db = getDb();
  const config = pdvMobileConfigService.getConfig();

  if (!config.permitirVenda) {
    throw new ErroVendaMobile('venda_desligada', 'Vender pelo celular está desligado nesta loja (Configurações → Celular).');
  }
  if (!dispositivo.vinculo_ativo || !PAPEIS_QUE_VENDEM.includes(dispositivo.vinculo_role)) {
    throw new ErroVendaMobile('operador_invalido', `O usuário vinculado a este celular (${dispositivo.vinculo_nome}) não pode mais vender. Peça um código novo pro gerente.`);
  }
  if (!require('./cashService').getOpenSession(locationId)) {
    throw new ErroVendaMobile('caixa_fechado', 'O caixa está fechado no computador da loja. Abra o caixa lá antes de vender pelo celular.');
  }

  const payload = normalizarPayload(dados);

  for (const p of payload.pagamentos) {
    if (!config.metodosPagamento.includes(p.metodo)) {
      throw new ErroVendaMobile('metodo_nao_permitido', `A forma de pagamento "${p.metodo}" não está liberada pro celular nesta loja.`);
    }
  }
  if (payload.clienteId) {
    if (!config.permitirCliente) throw new ErroVendaMobile('cliente_nao_permitido', 'Vincular cliente pelo celular não está liberado nesta loja.');
    const cliente = db.prepare('SELECT id FROM customers WHERE id = ? AND ativo = 1').get(payload.clienteId);
    if (!cliente) throw new ErroVendaMobile('cliente_invalido', 'Cliente não encontrado (pode ter sido removido). Escolha o cliente de novo.');
  }
  if (payload.pagamentos.some((p) => p.metodo === 'fiado') && !payload.clienteId) {
    throw new ErroVendaMobile('fiado_sem_cliente', 'Pagamento em fiado exige um cliente vinculado à venda.');
  }

  const operadorId = dispositivo.vinculo_user_id;
  const deviceId = dispositivo.id;
  let saleId;

  db.transaction(() => {
    ({ id: saleId } = saleService.openSale({ locationId, operadorId }));

    for (const item of payload.itens) {
      const r = saleService.addItem({ saleId, productId: item.productId, locationId, quantidade: item.quantidade, operadorId, deviceId });
      if (!r.ok) throw new ErroVendaMobile('item_recusado', `${item.nome || 'Item'}: ${r.error}`, { productId: item.productId });
    }

    // Preço: o desktop é a fonte da verdade. Se o subtotal que o
    // cliente viu no celular não bate com o de agora (promoção venceu,
    // preço mudou entre uma publicação do catálogo e outra), recusa com
    // os preços atuais em vez de cobrar diferente do que foi mostrado.
    const { total } = db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId);
    if (Math.abs(total - payload.subtotalEsperado) > TOLERANCIA_CENTAVO) {
      const precosAtuais = {};
      for (const linha of db.prepare('SELECT product_id, preco_unitario FROM sale_items WHERE sale_id = ? AND cancelado = 0').all(saleId)) {
        precosAtuais[linha.product_id] = linha.preco_unitario;
      }
      throw new ErroVendaMobile(
        'precos_alterados',
        `Os preços mudaram desde que o carrinho foi montado (total agora: R$ ${total.toFixed(2)}). Confira o carrinho e cobre de novo.`,
        { precosAtuais },
      );
    }

    aplicarDesconto({ db, saleId, desconto: payload.desconto, operadorId, config });
    if (payload.clienteId) saleService.setCustomer(saleId, payload.clienteId);

    const sale = db.prepare('SELECT total, desconto, desconto_gerente FROM sales WHERE id = ?').get(saleId);
    const totalAPagar = sale.total - sale.desconto - sale.desconto_gerente;
    let pago = 0;
    for (const p of payload.pagamentos) {
      const restante = arred2(totalAPagar - pago);
      if (restante <= 0.005) {
        throw new ErroVendaMobile('pagamento_excedente', 'Tem pagamento a mais na venda -- remova o pagamento que sobrou e finalize de novo.');
      }
      let valor = p.valor;
      const detalhes = { origem: 'pdv_movel' };
      if (p.metodo === 'dinheiro') {
        // Só o que falta entra como dinheiro no caixa; o resto é troco.
        // Sem isso, o fechamento de caixa esperaria encontrar o valor
        // CHEIO entregue pelo cliente, troco incluso.
        const recebido = Math.max(p.valorRecebido ?? valor, valor);
        valor = Math.min(valor, restante);
        if (recebido > valor + 0.005) {
          detalhes.valorRecebido = recebido;
          detalhes.troco = arred2(recebido - valor);
        }
      } else if (p.valorRecebido != null && p.valorRecebido > valor + 0.005) {
        detalhes.valorRecebido = p.valorRecebido;
      }
      const r = saleService.addPayment({ saleId, metodo: p.metodo, valor, detalhes });
      if (!r.ok) throw new ErroVendaMobile('pagamento_recusado', r.error);
      pago = arred2(pago + (r.valor ?? valor));
    }
    if (pago + 0.005 < totalAPagar) {
      throw new ErroVendaMobile('pagamento_incompleto', `Pagamento incompleto. Faltam R$ ${(totalAPagar - pago).toFixed(2)}.`);
    }

    db.prepare(
      `INSERT INTO mobile_sales (id, device_id, sale_id, status, atualizado_em) VALUES (?, ?, ?, 'criada', NOW_SYNCED())`
    ).run(vendaId, deviceId, saleId);
  })();

  return { saleId };
}

function registrarErroLocal({ vendaId, deviceId, erro, codigo }) {
  getDb().prepare(
    `INSERT INTO mobile_sales (id, device_id, sale_id, status, erro, codigo_erro, atualizado_em)
     VALUES (?, ?, NULL, 'erro', ?, ?, NOW_SYNCED())
     ON CONFLICT(id) DO UPDATE SET status = 'erro', erro = excluded.erro, codigo_erro = excluded.codigo_erro, atualizado_em = NOW_SYNCED()`
  ).run(vendaId, deviceId || 'desconhecido', erro, codigo || null);
}

function atualizarStatusLocal(vendaId, status, { erro = null, codigo = null } = {}) {
  getDb().prepare(
    `UPDATE mobile_sales SET status = ?, erro = ?, codigo_erro = ?, atualizado_em = NOW_SYNCED() WHERE id = ?`
  ).run(status, erro, codigo, vendaId);
}

/** Resumo da venda já gravada -- o que o celular mostra na tela de
 * sucesso e no histórico (recibo). Só lê o banco. */
function montarResumo(saleId) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return null;
  const itens = db.prepare(
    `SELECT COALESCE(si.nome_personalizado, p.nome) as nome, si.quantidade, si.preco_unitario
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em`
  ).all(saleId);
  const pagamentos = db.prepare('SELECT metodo, valor, detalhes FROM payments WHERE sale_id = ? ORDER BY rowid').all(saleId);
  let troco = 0;
  for (const p of pagamentos) {
    try { troco += Number(JSON.parse(p.detalhes || '{}').troco) || 0; } catch { /* detalhes legado sem JSON válido */ }
  }
  const cliente = sale.customer_id ? db.prepare('SELECT nome FROM customers WHERE id = ?').get(sale.customer_id) : null;
  const operador = db.prepare('SELECT nome FROM users WHERE id = ?').get(sale.operador_id);

  return {
    saleId,
    numero: saleId.slice(0, 8).toUpperCase(),
    subtotal: arred2(itens.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0)),
    desconto: arred2((sale.desconto || 0) + (sale.desconto_gerente || 0)),
    total: arred2(sale.total - sale.desconto - sale.desconto_gerente),
    troco: arred2(troco),
    itens: itens.map((i) => ({ nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario })),
    pagamentos: pagamentos.map((p) => ({ metodo: p.metodo, valor: p.valor })),
    clienteNome: cliente?.nome || null,
    operadorNome: operador?.nome || null,
    finalizadaEm: sale.finalizada_em || null, // UTC "naive" (NOW_SYNCED)
  };
}

function linkReciboWhatsapp(saleId) {
  try {
    const r = require('./printService').buildReceiptWhatsappLink(saleId);
    return r.ok ? r.url : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Firestore (rede) -- tudo daqui pra baixo depende de conexão.
// ------------------------------------------------------------------

function firestoreCtx() {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  return { firestore: licenseService.getLicenseFirestore(), installId: pdvRegistryService.getOrCreateDeviceUid() };
}

/** Escreve o resultado no documento do celular e marca localmente que
 * ele foi entregue (status_notificado). Falha de rede só deixa pra
 * próxima reconciliação. */
async function notificarCelular(vendaId, status, campos) {
  const { doc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const { firestore, installId } = firestoreCtx();
  const statusRemoto = status === 'pendente_estoque' ? 'pendente' : status;
  await updateDoc(doc(firestore, 'installations', installId, 'vendas_mobile', vendaId), {
    status: statusRemoto,
    erro: campos.erro ?? null,
    codigoErro: campos.codigoErro ?? null,
    precosAtuais: campos.precosAtuais ?? null,
    saleId: campos.saleId ?? null,
    resumo: campos.resumo ?? null,
    reciboWhatsappUrl: campos.reciboWhatsappUrl ?? null,
    processadoEm: serverTimestamp(),
  });
  getDb().prepare('UPDATE mobile_sales SET status_notificado = ? WHERE id = ?').run(status, vendaId);
}

function camposDoRegistro(row) {
  if (row.status === 'finalizada') {
    return { saleId: row.sale_id, resumo: montarResumo(row.sale_id), reciboWhatsappUrl: linkReciboWhatsapp(row.sale_id) };
  }
  if (row.status === 'erro') return { erro: row.erro, codigoErro: row.codigo_erro };
  if (row.status === 'pendente_estoque') {
    return { saleId: row.sale_id, erro: 'Aguardando confirmar o estoque com as outras máquinas da loja -- a venda finaliza sozinha assim que a conexão voltar.' };
  }
  return {};
}

/**
 * Leva uma venda já criada localmente (mobile_sales.status 'criada' ou
 * 'pendente_estoque') até um estado final, olhando sempre o estado REAL
 * da venda no banco -- seguro de chamar de novo a qualquer momento
 * (reentrega, reconciliação, reinício do app).
 */
async function avancarVendaCriada(row) {
  const db = getDb();
  const sale = db.prepare('SELECT id, status, location_id, operador_id, pendente_estoque_grupo FROM sales WHERE id = ?').get(row.sale_id);
  if (!sale) {
    atualizarStatusLocal(row.id, 'erro', { erro: 'Venda local não encontrada.', codigo: 'venda_sumiu' });
    return;
  }
  if (sale.status === 'finalizada') { atualizarStatusLocal(row.id, 'finalizada'); return; }
  if (sale.status === 'cancelada') {
    atualizarStatusLocal(row.id, 'erro', { erro: row.erro || 'A venda foi cancelada no computador.', codigo: row.codigo_erro || 'cancelada' });
    return;
  }

  // Aberta. Já marcada como pendente do estoque do grupo: o ciclo
  // automático de saleService (main.js) é quem tenta de novo, na ordem
  // certa (uma por vez) -- aqui só esperamos.
  if (sale.pendente_estoque_grupo === 1) {
    if (row.status !== 'pendente_estoque') atualizarStatusLocal(row.id, 'pendente_estoque');
    return;
  }
  // Estava pendente e a marca sumiu sem finalizar = o ciclo automático
  // achou falta de estoque DE VERDADE em outra máquina. Não tem quem mexa
  // no carrinho aqui -- desfaz e devolve o erro pro celular.
  const resultado = row.status === 'pendente_estoque'
    ? { ok: false, error: 'Estoque insuficiente em outra máquina da loja para algum item.' }
    : await saleService.finalizeSaleComVerificacaoDeGrupo(sale.id);

  if (resultado.ok) {
    atualizarStatusLocal(row.id, 'finalizada');
    if (pdvMobileConfigService.getConfig().imprimirReciboNoComputador) {
      require('./printService').printReceipt(sale.id).catch((err) => console.error('[pdvMobileSyncService] impressão do recibo falhou:', err));
    }
    return;
  }
  if (resultado.pendente) { atualizarStatusLocal(row.id, 'pendente_estoque'); return; }

  saleService.cancelarVendaAbertaPeloSistema({
    saleId: sale.id, locationId: sale.location_id, operadorId: sale.operador_id,
    motivo: `PDV móvel: ${resultado.error || 'não foi possível finalizar'}`, deviceId: row.device_id,
  });
  atualizarStatusLocal(row.id, 'erro', { erro: resultado.error || 'Não foi possível finalizar a venda.', codigo: 'estoque_grupo' });
}

/** Processa (ou retoma) UMA venda do celular. Nunca lança -- todo erro
 * vira status 'erro' no documento. */
async function processarVenda(vendaId, dados) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get(vendaId);

  if (!row) {
    const dispositivo = buscarDispositivoPdv(dados?.dispositivoUid);
    if (!dispositivo) {
      registrarErroLocal({ vendaId, deviceId: dados?.dispositivoUid, erro: 'Celular não reconhecido ou desconectado desta loja.', codigo: 'dispositivo_invalido' });
    } else if (!require('./modulosPagosService').moduloAtivo('pdvMobile')) {
      registrarErroLocal({ vendaId, deviceId: dispositivo.id, erro: 'O módulo PDV móvel não está ativo pra esta loja.', codigo: 'modulo_inativo' });
    } else {
      try {
        criarVendaLocal({ vendaId, dados, dispositivo, locationId: getLocationId() });
      } catch (err) {
        if (!(err instanceof ErroVendaMobile)) console.error('[pdvMobileSyncService] erro inesperado ao criar venda do celular:', err);
        registrarErroLocal({
          vendaId, deviceId: dispositivo.id,
          erro: err instanceof ErroVendaMobile ? err.message : 'Erro inesperado ao registrar a venda no computador.',
          codigo: err instanceof ErroVendaMobile ? err.codigo : 'erro_interno',
        });
        // precos_alterados precisa levar os preços novos pro celular --
        // não ficam no banco (a transação foi desfeita), só neste envio.
        if (err instanceof ErroVendaMobile && err.extra?.precosAtuais) {
          await notificarCelular(vendaId, 'erro', { erro: err.message, codigoErro: err.codigo, precosAtuais: err.extra.precosAtuais }).catch(() => {});
          return;
        }
      }
    }
    row = db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get(vendaId);
  }

  if (row.status === 'criada' || row.status === 'pendente_estoque') {
    try {
      await avancarVendaCriada(row);
    } catch (err) {
      console.error('[pdvMobileSyncService] falha ao finalizar venda do celular:', err);
      // Fica como está ('criada'): a reconciliação tenta de novo.
    }
    row = db.prepare('SELECT * FROM mobile_sales WHERE id = ?').get(vendaId);
  }

  if (row.status_notificado !== row.status && row.status !== 'criada') {
    await notificarCelular(vendaId, row.status, camposDoRegistro(row)).catch((err) => {
      console.error('[pdvMobileSyncService] não consegui avisar o celular (tenta de novo na reconciliação):', err.message);
    });
  }
}

// Fila serial: uma venda por vez, na ordem de chegada. Mesmo motivo de
// saleService.tentarFinalizarVendasPendentesDeEstoque -- duas vendas
// confirmando estoque do grupo ao mesmo tempo poderiam disputar a mesma
// última unidade.
let fila = Promise.resolve();
function enfileirar(tarefa) {
  fila = fila.then(tarefa).catch((err) => console.error('[pdvMobileSyncService] tarefa da fila falhou:', err));
  return fila;
}

/** Retoma o que ficou no meio do caminho: venda criada e não finalizada
 * (app fechou), pendente de estoque do grupo, ou resultado que não
 * chegou no celular por falta de internet. */
async function reconciliar() {
  const pendentes = getDb().prepare(
    `SELECT id FROM mobile_sales
     WHERE status IN ('criada', 'pendente_estoque') OR status_notificado IS NULL OR status_notificado != status
     ORDER BY criado_em ASC LIMIT 50`
  ).all();
  for (const { id } of pendentes) {
    await enfileirar(() => processarVenda(id, null));
  }
}

// ------------------------------------------------------------------
// Escutas e ciclos (chamado uma vez em main.js)
// ------------------------------------------------------------------

let pararEscutaVendas = null;
let intervaloReconciliacao = null;
let intervaloConfig = null;

function temPdvMovelPareado() {
  return !!getDb().prepare(`SELECT 1 FROM paired_devices WHERE tipo = 'pdv' AND ativo = 1 LIMIT 1`).get();
}

function iniciarPdvMobile() {
  try {
    if (pararEscutaVendas) { pararEscutaVendas(); pararEscutaVendas = null; }
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const { firestore, installId } = firestoreCtx();

    pararEscutaVendas = onSnapshot(
      query(collection(firestore, 'installations', installId, 'vendas_mobile'), where('status', '==', 'novo')),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          const id = change.doc.id;
          const dados = change.doc.data();
          enfileirar(() => processarVenda(id, dados));
        });
      },
      (err) => console.error('[pdvMobileSyncService] escuta de vendas do celular falhou:', err)
    );
  } catch (err) {
    console.error('[pdvMobileSyncService] não foi possível iniciar a escuta de vendas:', err);
  }

  require('./pdvMobileConsultaService').iniciarEscutaConsultas();

  if (intervaloReconciliacao) clearInterval(intervaloReconciliacao);
  intervaloReconciliacao = setInterval(() => { reconciliar().catch(() => {}); }, 15 * 1000);
  reconciliar().catch(() => {});

  // Config + "sinal de vida" pro celular -- só gasta escrita no
  // Firestore se existe PDV móvel pareado de fato.
  const publicar = () => { if (temPdvMovelPareado()) pdvMobileConfigService.publicarConfig().catch(() => {}); };
  if (intervaloConfig) clearInterval(intervaloConfig);
  intervaloConfig = setInterval(publicar, 25 * 1000);
  publicar();
}

/** Últimas vendas recebidas do celular -- pra tela de Configurações →
 * Celular mostrar o que chegou (e o que deu erro, e por quê). */
function listarVendasRecentes({ limit = 30 } = {}) {
  return getDb().prepare(
    `SELECT ms.id, ms.status, ms.erro, ms.codigo_erro, ms.criado_em, ms.sale_id,
            pd.nome_dispositivo, u.nome as operador_nome,
            CASE WHEN s.id IS NULL THEN NULL ELSE s.total - s.desconto - s.desconto_gerente END as total
     FROM mobile_sales ms
     LEFT JOIN paired_devices pd ON pd.id = ms.device_id
     LEFT JOIN users u ON u.id = pd.vinculo_user_id
     LEFT JOIN sales s ON s.id = ms.sale_id
     ORDER BY ms.criado_em DESC LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 30, 1), 200));
}

module.exports = {
  iniciarPdvMobile, listarVendasRecentes,
  // Exportados pra teste (parte local, sem rede).
  ErroVendaMobile, buscarDispositivoPdv, normalizarPayload, criarVendaLocal, avancarVendaCriada,
  montarResumo, registrarErroLocal,
};
