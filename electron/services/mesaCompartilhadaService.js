/**
 * Mesa compartilhada entre os caixas do grupo, pela rede local.
 *
 * As mesas moram no servidor do grupo. Um caixa ligado a ele pela rede
 * local (lanClienteService) mostra as mesmas mesas e mexe nelas no
 * servidor: abre, lança, junta, transfere, cancela item... -- cada pedido
 * vira a mesma chamada de serviço que a tela do servidor faria
 * (`chamar`, canais em CANAIS). Ids de usuário, produto e cliente são
 * diferentes em cada computador: vão pela rede como o id do grupo
 * (user_group_sync / grupo_replica) e cada lado traduz para o seu.
 *
 * Fechar a conta num caixa ("puxar a mesa"):
 *   1. o servidor trava a mesa (fechando_caixa_*) e manda a conta;
 *   2. o caixa cria a venda dele com os mesmos itens (sem mexer no
 *      estoque: o servidor já baixou o estoque local quando lançou) e
 *      recebe ali -- pagamento, maquininha, NFC-e e gaveta são do caixa;
 *   3. venda finalizada no caixa: o servidor marca a venda dele como
 *      'transferida' (fora de todo relatório, que só conta 'finalizada') e
 *      libera a mesa. O estoque do grupo é baixado uma vez só, pelo caixa,
 *      ao finalizar.
 *   Desistiu sem receber nada: o caixa apaga a cópia e o servidor destrava.
 *   Item que entrou no servidor durante o pagamento (pedido pelo QR, que
 *   não passa pela trava) não se perde: fica numa comanda nova na mesa.
 *   Conclusão e devolução ficam na fila (mesa_remota_fechamentos) até o
 *   servidor confirmar.
 *
 * Mesa travada: nenhuma tela, celular ou outro caixa mexe nela
 * (`recusaPorTrava`, `travaDoComandoCelular`).
 */

const { randomUUID, createHash } = require('crypto');
const { getDb } = require('../db/database');

const ESPERA_MAX_MUDANCA_MS = 20000;
const CHECAR_MUDANCA_MS = 700;
const REPETIR_FILA_MS = 15000;

// ------------------------------------------------------------------ ids entre computadores

function grupoAtual() {
  try { return require('./syncStateService').getGrupoSincronizacaoId() || null; } catch { return null; }
}

function meuId() {
  return require('./pdvRegistryService').getOrCreateDeviceUid();
}

function docDoUsuario(db, grupoId, userId) {
  if (!userId) return null;
  return db.prepare('SELECT doc_id FROM user_group_sync WHERE user_id = ? AND grupo_id = ?').get(userId, grupoId)?.doc_id || null;
}

function usuarioDoDoc(db, grupoId, docId) {
  if (!docId) return null;
  const v = db.prepare(
    `SELECT u.id FROM user_group_sync g JOIN users u ON u.id = g.user_id WHERE g.grupo_id = ? AND g.doc_id = ? AND u.ativo = 1`
  ).get(grupoId, docId);
  if (v) return v.id;
  return db.prepare('SELECT id FROM users WHERE id = ? AND ativo = 1').get(docId)?.id || null;
}

const TABELA_DA_ENTIDADE = { produtos: 'products', clientes: 'customers' };

/** Id do grupo de um produto/cliente daqui (sem vínculo: o próprio id, igual grupoReplicaService.paraGrupo). */
function docDe(db, grupoId, entidade, localId) {
  if (!localId) return null;
  return db.prepare('SELECT doc_id FROM grupo_replica WHERE entidade = ? AND grupo_id = ? AND local_id = ?')
    .get(entidade, grupoId, localId)?.doc_id || localId;
}

/** Id daqui de um produto/cliente do grupo; null se ainda não chegou. */
function localDe(db, grupoId, entidade, docId) {
  if (!docId) return null;
  const v = db.prepare('SELECT local_id FROM grupo_replica WHERE entidade = ? AND grupo_id = ? AND doc_id = ?').get(entidade, grupoId, docId);
  if (v) return v.local_id;
  return db.prepare(`SELECT id FROM ${TABELA_DA_ENTIDADE[entidade]} WHERE id = ?`).get(docId)?.id || null;
}

// ------------------------------------------------------------------ trava (servidor)

function rotuloMesa(t) {
  return t?.nome || `Mesa ${t?.numero}`;
}

function principalDe(db, mesa) {
  if (!mesa?.unida_a_mesa_id) return mesa;
  return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesa.unida_a_mesa_id) || mesa;
}

/** Mesas (principais) que um pedido toca: por mesa, venda ou item da venda. */
function mesasDoPedido(db, a = {}) {
  const ids = new Set();
  for (const k of ['tableId', 'fromTableId', 'toTableId', 'mesaId', 'destinoId']) if (typeof a[k] === 'string') ids.add(a[k]);
  for (const k of ['mesaIds']) if (Array.isArray(a[k])) for (const x of a[k]) if (typeof x === 'string') ids.add(x);
  const mesas = [];
  for (const id of ids) {
    const m = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(id);
    if (m) mesas.push(principalDe(db, m));
  }
  let saleId = typeof a.saleId === 'string' ? a.saleId : null;
  if (!saleId && typeof a.saleItemId === 'string') saleId = db.prepare('SELECT sale_id FROM sale_items WHERE id = ?').get(a.saleItemId)?.sale_id || null;
  if (saleId) {
    const m = db.prepare('SELECT * FROM restaurant_tables WHERE sale_id = ? ORDER BY unida_a_mesa_id IS NOT NULL LIMIT 1').get(saleId);
    if (m) mesas.push(principalDe(db, m));
  }
  return mesas;
}

function mensagemDeTrava(m) {
  return `${rotuloMesa(m)} está sendo paga no ${m.fechando_caixa_nome || 'outro caixa'}. Espere terminar o pagamento lá.`;
}

/** Primeira mesa travada entre as que o pedido toca (ou null). */
function travaDe(db, args) {
  return mesasDoPedido(db, args).find((m) => m && m.fechando_caixa_id) || null;
}

// Canais das telas deste computador que um caixa não pede pela rede, mas
// que também não podem mexer numa mesa travada (receber aqui a conta que o
// outro caixa está recebendo cobraria duas vezes).
const TAMBEM_TRAVADOS = new Set([
  'table:release', 'sale:addCustomItem', 'sale:addPayment', 'sale:removePayment', 'sale:finalize', 'sale:marcarPagamentoPessoa',
  'sale:applyManagerDiscount', 'sale:removeManagerDiscount', 'sale:setServiceCharge', 'sale:setCustomer', 'sale:redeemLoyaltyPoints',
  'sale:cancel',
]);

/**
 * Para as telas deste computador (handlers.js): pedido que muda uma mesa
 * travada é recusado.
 */
function recusaPorTrava(canal, payload) {
  const c = CANAIS[canal];
  if (!TAMBEM_TRAVADOS.has(canal) && (!c || c.ler)) return null;
  try {
    const m = travaDe(getDb(), payload || {});
    return m ? { ok: false, error: mensagemDeTrava(m) } : null;
  } catch { return null; }
}

/** Para o celular (mesaCelularService): mensagem de erro se a mesa está travada. */
function travaDoComandoCelular(dados) {
  try {
    const m = travaDe(getDb(), dados || {});
    return m ? mensagemDeTrava(m) : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ mudanças (servidor)

let versao = 0;
let ultimaImpressao = null;

function impressaoDasMesas(db) {
  const l = db.prepare(
    `SELECT
       (SELECT group_concat(id || '|' || status || '|' || IFNULL(sale_id, '') || '|' || IFNULL(unida_a_mesa_id, '') || '|' || IFNULL(pessoas, '')
          || '|' || IFNULL(fechando_caixa_id, '') || '|' || IFNULL(nome, '') || '|' || numero || '|' || IFNULL(reservado_para, ''), ';')
        FROM restaurant_tables) AS m,
       (SELECT COUNT(*) || '|' || IFNULL(MAX(si.rowid), 0) || '|' || TOTAL(si.quantidade) || '|' || TOTAL(si.cancelado) || '|'
          || TOTAL(si.preco_unitario * si.quantidade) || '|' || TOTAL(IFNULL(si.pessoa_numero, 0) * si.rowid) || '|'
          || TOTAL(LENGTH(IFNULL(si.observacao, '')) * si.rowid) || '|' || TOTAL(si.enviado_cozinha)
        FROM sale_items si WHERE si.sale_id IN (SELECT sale_id FROM restaurant_tables WHERE sale_id IS NOT NULL)) AS i,
       (SELECT COUNT(*) || '|' || IFNULL(group_concat(sp.sale_id || sp.numero || IFNULL(sp.nome, '') || IFNULL(sp.customer_id, ''), ';'), '')
        FROM sale_people sp WHERE sp.sale_id IN (SELECT sale_id FROM restaurant_tables WHERE sale_id IS NOT NULL)) AS p,
       (SELECT COUNT(*) || '|' || TOTAL(valor) FROM payments WHERE sale_id IN (SELECT sale_id FROM restaurant_tables WHERE sale_id IS NOT NULL)) AS g,
       (SELECT IFNULL(group_concat(id || desconto || desconto_gerente || taxa_servico_percentual || status, ';'), '')
        FROM sales WHERE id IN (SELECT sale_id FROM restaurant_tables WHERE sale_id IS NOT NULL)) AS s`
  ).get();
  return createHash('sha1').update(JSON.stringify(l)).digest('hex');
}

/** Versão das mesas: muda quando qualquer coisa nelas muda (tela, celular, caixa, QR). */
function versaoAtual() {
  const h = impressaoDasMesas(getDb());
  if (h !== ultimaImpressao) { ultimaImpressao = h; versao += 1; }
  return versao;
}

async function esperarMudanca(desde, esperaMs) {
  const limite = Date.now() + Math.min(Math.max(Number(esperaMs) || 0, 0), ESPERA_MAX_MUDANCA_MS);
  let v = versaoAtual();
  while (v === Number(desde) && Date.now() < limite) {
    await new Promise((ok) => setTimeout(ok, CHECAR_MUDANCA_MS));
    v = versaoAtual();
  }
  return v;
}

function avisarTelas(evento) {
  try { require('./mesaCelularService').avisarTelas(evento); } catch { /* sem telas */ }
}

// ------------------------------------------------------------------ canais (servidor executa)

const T = () => require('./tableService');
const S = () => require('./saleService');

/**
 * O que um caixa pode pedir. `fn(args, ctx)` com os ids já traduzidos
 * para os daqui; ctx = { usuarioId, locationId }. `ler`: não muda nada
 * (passa mesmo com a mesa travada). `gestao`: só gerente/admin/suporte.
 * `venda`: o pedido tem que ser de uma comanda de mesa deste servidor.
 */
const CANAIS = {
  'table:list': { ler: true, fn: (a, c) => T().listTables(c.locationId) },
  'table:getCart': { ler: true, venda: true, fn: (a) => T().getTableCart(a.saleId) },
  'table:open': { fn: (a, c) => T().openTable({ tableId: a.tableId, locationId: c.locationId, operadorId: c.usuarioId, pessoas: a.pessoas }) },
  'table:markCleaned': { fn: (a) => T().markCleaned(a.tableId) },
  'table:markReserved': { fn: (a) => T().markReserved(a.tableId, a.reservadoPara) },
  'table:cancelReservation': { fn: (a) => T().cancelReservation(a.tableId) },
  'table:transfer': { fn: (a) => T().transferTable({ fromTableId: a.fromTableId, toTableId: a.toTableId }) },
  'table:updatePeople': { fn: (a) => T().updateTablePeople({ tableId: a.tableId, pessoas: a.pessoas }) },
  'table:desocupar': {
    fn: (a, c) => T().desocuparMesa({
      tableId: a.tableId, locationId: c.locationId, currentOperatorId: c.usuarioId,
      candidateManagerId: a.candidateManagerId, pin: a.pin, motivo: a.motivo, deviceId: a.deviceId,
    }),
  },
  'table:montarLinkPedido': { ler: true, fn: (a) => T().montarLinkPedidoMesa({ tableId: a.tableId }) },
  'table:juntar': { fn: (a, c) => T().juntarMesas({ tableId: a.tableId, mesaIds: a.mesaIds, currentOperatorId: c.usuarioId }) },
  'table:separar': { fn: (a, c) => T().separarMesa({ tableId: a.tableId, currentOperatorId: c.usuarioId }) },
  'table:adicionarPessoa': { fn: (a) => T().adicionarPessoa({ tableId: a.tableId, nome: a.nome }) },
  'table:renomearPessoa': { fn: (a) => T().renomearPessoa({ tableId: a.tableId, numero: a.numero, nome: a.nome }) },
  'table:removerPessoa': { fn: (a) => T().removerPessoa({ tableId: a.tableId, numero: a.numero }) },
  'table:vincularCliente': { fn: (a) => T().vincularClientePessoa({ tableId: a.tableId, numero: a.numero, customerId: a.customerId }) },
  'table:create': { gestao: true, fn: (a, c) => T().createTable({ locationId: c.locationId, numero: a.numero, nome: a.nome }) },
  'table:createLote': { gestao: true, fn: (a, c) => T().createTablesEmLote({ locationId: c.locationId, quantidade: a.quantidade, inicio: a.inicio }) },
  'table:reordenar': { gestao: true, fn: (a, c) => T().reorderTables({ locationId: c.locationId, ids: a.ids }) },
  'table:proximoNumero': { ler: true, gestao: true, fn: (a, c) => ({ ok: true, ...T().proximaFaixaLivre(c.locationId) }) },
  'table:delete': { gestao: true, fn: (a) => T().deleteTable(a.tableId) },
  'sale:addItem': {
    venda: true,
    fn: (a, c) => S().addItem({
      saleId: a.saleId, productId: a.productId, locationId: c.locationId, quantidade: a.quantidade,
      operadorId: c.usuarioId, deviceId: a.deviceId, pessoaNumero: a.pessoaNumero, observacao: a.observacao,
    }),
  },
  'sale:ajustarQuantidade': {
    venda: true,
    fn: (a, c) => S().ajustarQuantidadeItem({
      saleId: a.saleId, saleItemId: a.saleItemId, delta: a.delta, locationId: c.locationId, operadorId: c.usuarioId, deviceId: a.deviceId,
    }),
  },
  'sale:cancelItem': {
    venda: true,
    fn: (a, c) => S().cancelSaleItem({
      saleId: a.saleId, saleItemId: a.saleItemId, locationId: c.locationId, currentOperatorId: c.usuarioId,
      candidateManagerId: a.candidateManagerId, pin: a.pin, motivo: a.motivo, deviceId: a.deviceId,
    }),
  },
  'sale:needsManagerAuthForCancel': { ler: true, venda: true, fn: (a) => S().needsManagerAuthForCancel(a.saleId) },
  'sale:setItemNote': { venda: true, fn: (a) => S().setItemNote({ saleItemId: a.saleItemId, observacao: a.observacao }) },
  'sale:setItemPerson': { venda: true, fn: (a) => S().setItemPerson({ saleItemId: a.saleItemId, pessoaNumero: a.pessoaNumero }) },
  'sale:setItemPrice': {
    venda: true,
    fn: (a, c) => S().setItemPrice({ saleId: a.saleId, saleItemId: a.saleItemId, novoPreco: a.novoPreco, motivo: a.motivo, currentOperatorId: c.usuarioId }),
  },
  // Comanda da cozinha: sai na impressora da cozinha configurada no servidor
  // (ele é quem sabe o que já foi para a cozinha).
  'print:kitchenTicket': { venda: true, fn: (a) => require('./printService').printKitchenTicket(a.saleId, a.mesaLabel) },
  // Pré-nota: o servidor monta, o caixa imprime na impressora dele.
  'print:preNota': { ler: true, venda: true, fn: (a) => require('./estudioImpressaoService').htmlDaPreNota({ saleId: a.saleId, pessoaNumero: a.pessoaNumero }) },
  'auth:getSecurityConfig': { ler: true, fn: () => require('./authService').getSecurityConfig() },
  'reservation:listVinculadasAtivas': { ler: true, fn: (a, c) => require('./reservationService').listVinculadasAtivas(c.locationId) },
};

const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];

function locationDoServidor(db) {
  const l = db.prepare('SELECT id FROM locations LIMIT 1').get();
  if (!l) throw new Error('Nenhum local cadastrado no servidor.');
  return l.id;
}

function vendaEhDeMesa(db, a) {
  let saleId = typeof a.saleId === 'string' ? a.saleId : null;
  if (typeof a.saleItemId === 'string') {
    const doItem = db.prepare('SELECT sale_id FROM sale_items WHERE id = ?').get(a.saleItemId)?.sale_id || null;
    if (!doItem || (saleId && doItem !== saleId)) return false;
    saleId = doItem;
  }
  if (!saleId) return false;
  return !!db.prepare('SELECT 1 FROM restaurant_tables WHERE sale_id = ?').get(saleId);
}

/** Clientes das pessoas da comanda vão como id do grupo. */
function pessoasParaOGrupo(db, grupoId, r) {
  if (r && Array.isArray(r.pessoas)) {
    r.pessoas = r.pessoas.map((p) => (p && p.clienteId ? { ...p, clienteId: docDe(db, grupoId, 'clientes', p.clienteId) } : p));
  }
  return r;
}

/**
 * Pedido de um caixa ligado (lanHubService, /v1/mesas/chamar).
 * corpo = { canal, args, usuarioDoc }; caixa = { id, nome }.
 */
async function atenderChamada(corpo, caixa) {
  const db = getDb();
  const grupoId = grupoAtual();
  const c = CANAIS[corpo?.canal];
  if (!c) return { ok: false, error: 'Pedido de mesa desconhecido (atualize o GerenciaAI nos dois computadores).' };
  const a = corpo.args && typeof corpo.args === 'object' && !Array.isArray(corpo.args) ? { ...corpo.args } : {};

  const usuarioId = usuarioDoDoc(db, grupoId, corpo.usuarioDoc);
  if (!usuarioId) return { ok: false, error: 'O usuário deste caixa ainda não chegou no servidor. Espere a sincronização de usuários e tente de novo.' };
  if (c.gestao && !require('./authService').requireRole(usuarioId, PAPEIS_GESTAO).ok) return { ok: false, error: 'Você não tem permissão para fazer isso.' };
  if (c.venda && !vendaEhDeMesa(db, a)) return { ok: false, error: 'Essa comanda não é de uma mesa do servidor (pode ter sido fechada).' };

  // Ids do grupo -> ids daqui.
  if ('productDoc' in a) {
    a.productId = localDe(db, grupoId, 'produtos', a.productDoc);
    if (!a.productId) return { ok: false, error: 'Esse produto ainda não chegou no servidor. Espere a sincronização de produtos e tente de novo.' };
    delete a.productDoc;
  }
  if ('customerDoc' in a) {
    a.customerId = a.customerDoc ? localDe(db, grupoId, 'clientes', a.customerDoc) : null;
    if (a.customerDoc && !a.customerId) return { ok: false, error: 'Esse cliente ainda não chegou no servidor. Espere a sincronização e tente de novo.' };
    delete a.customerDoc;
  }
  if ('candidateManagerDoc' in a) {
    a.candidateManagerId = a.candidateManagerDoc ? usuarioDoDoc(db, grupoId, a.candidateManagerDoc) : null;
    if (a.candidateManagerDoc && !a.candidateManagerId) return { ok: false, error: 'Esse gerente ainda não chegou no servidor.' };
    delete a.candidateManagerDoc;
  }

  if (!a.deviceId) a.deviceId = caixa?.id || 'caixa';
  if (!c.ler) {
    const m = travaDe(db, a);
    if (m) return { ok: false, error: mensagemDeTrava(m) };
  }

  const r = await c.fn(a, { usuarioId, locationId: locationDoServidor(db) });
  if (!c.ler && !(r && r.ok === false)) {
    versaoAtual();
    avisarTelas({ origem: 'caixa', caixa: caixa?.nome || null, canal: corpo.canal });
  }
  return pessoasParaOGrupo(db, grupoId, r);
}

// ------------------------------------------------------------------ puxar / concluir / devolver (servidor)

function auditar(db, tipo, saleId, usuarioId, motivo) {
  try {
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, autorizado_por_id, motivo, sucesso) VALUES (?, ?, ?, ?, NULL, ?, 1)`
    ).run(randomUUID(), tipo, saleId, usuarioId || null, motivo || null);
  } catch (err) { console.error('[mesaCompartilhada] auditoria:', err?.message || err); }
}

/** Caixa quer receber a conta da mesa: trava e manda a conta. */
function puxar(corpo, caixa) {
  const db = getDb();
  const grupoId = grupoAtual();
  const usuarioId = usuarioDoDoc(db, grupoId, corpo?.usuarioDoc);
  if (!usuarioId) return { ok: false, error: 'O usuário deste caixa ainda não chegou no servidor. Espere a sincronização de usuários e tente de novo.' };
  const mesa = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(String(corpo?.mesaId || ''));
  if (!mesa) return { ok: false, error: 'Mesa não encontrada no servidor.' };
  return db.transaction(() => {
    const principal = principalDe(db, db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesa.id));
    if (principal.status !== 'ocupada' || !principal.sale_id) return { ok: false, error: `${rotuloMesa(principal)} não está ocupada.` };
    if (principal.fechando_caixa_id && principal.fechando_caixa_id !== caixa.id) return { ok: false, error: mensagemDeTrava(principal) };
    const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(principal.sale_id);
    if (!venda || venda.status !== 'aberta') return { ok: false, error: `A comanda de ${rotuloMesa(principal)} não está mais aberta.` };
    if (db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(venda.id).c > 0) {
      return { ok: false, error: `${rotuloMesa(principal)} já tem pagamento recebido no servidor. Feche essa conta lá, para o dinheiro bater com o caixa que recebeu.` };
    }
    const itens = db.prepare(
      `SELECT si.*, p.nome AS produto_nome FROM sale_items si JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em, si.rowid`
    ).all(venda.id);
    if (!itens.length) return { ok: false, error: `${rotuloMesa(principal)} não tem nenhum item para cobrar.` };

    db.prepare(`UPDATE restaurant_tables SET fechando_caixa_id = ?, fechando_caixa_nome = ?, fechando_desde = NOW_SYNCED() WHERE id = ?`)
      .run(caixa.id, caixa.nome || 'outro caixa', principal.id);
    if (principal.fechando_caixa_id !== caixa.id) auditar(db, 'mesa_puxada_por_outro_caixa', venda.id, usuarioId, `${rotuloMesa(principal)} -> ${caixa.nome || caixa.id}`);

    const unidas = db.prepare('SELECT id, numero, nome FROM restaurant_tables WHERE unida_a_mesa_id = ? ORDER BY CAST(numero AS INTEGER), numero').all(principal.id);
    const pessoas = db.prepare('SELECT numero, nome, customer_id FROM sale_people WHERE sale_id = ? ORDER BY numero').all(venda.id);
    versaoAtual();
    return {
      ok: true,
      vendaServidorId: venda.id,
      mesa: { id: principal.id, numero: principal.numero, nome: principal.nome || null, pessoas: principal.pessoas || null },
      unidas: unidas.map((u) => ({ id: u.id, numero: u.numero, nome: u.nome || null })),
      venda: {
        criadoEm: venda.criado_em,
        operadorDoc: docDoUsuario(db, grupoId, venda.operador_id),
        clienteDoc: venda.customer_id ? docDe(db, grupoId, 'clientes', venda.customer_id) : null,
        desconto: venda.desconto || 0,
        pontosResgatados: venda.pontos_resgatados || 0,
        descontoGerente: venda.desconto_gerente || 0,
        descontoGerenteMotivo: venda.desconto_gerente_motivo || null,
        descontoAutorizadoPorDoc: docDoUsuario(db, grupoId, venda.desconto_autorizado_por_id),
        taxaServicoPercentual: venda.taxa_servico_percentual || 0,
      },
      itens: itens.map((i) => ({
        id: i.id,
        produtoDoc: i.eh_personalizado ? null : docDe(db, grupoId, 'produtos', i.product_id),
        produtoNome: i.produto_nome,
        ehPersonalizado: !!i.eh_personalizado,
        nomePersonalizado: i.nome_personalizado || null,
        quantidade: i.quantidade,
        precoUnitario: i.preco_unitario,
        precoOriginal: i.preco_original ?? null,
        precoAlteradoMotivo: i.preco_alterado_motivo || null,
        custoUnitario: i.custo_unitario ?? null,
        pessoaNumero: i.pessoa_numero || null,
        observacao: i.observacao || null,
        statusPreparo: i.status_preparo || 'pendente',
        especificacoesJson: i.especificacoes_json || null,
        criadoEm: i.criado_em,
      })),
      pessoas: pessoas.map((p) => ({ numero: p.numero, nome: p.nome || null, clienteDoc: p.customer_id ? docDe(db, grupoId, 'clientes', p.customer_id) : null })),
    };
  })();
}

function soltarTrava(db, caixaId, ...mesaIds) {
  for (const id of mesaIds.filter(Boolean)) {
    db.prepare(`UPDATE restaurant_tables SET fechando_caixa_id = NULL, fechando_caixa_nome = NULL, fechando_desde = NULL WHERE id = ? AND fechando_caixa_id = ?`).run(id, caixaId);
  }
}

/**
 * A conta foi recebida no caixa: a venda daqui vira 'transferida' e a mesa
 * é liberada. Repetir não faz nada de novo.
 */
function concluir(corpo, caixa) {
  const db = getDb();
  const vendaId = String(corpo?.vendaServidorId || '');
  const ids = new Set(Array.isArray(corpo?.itens) ? corpo.itens.map(String) : []);
  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(vendaId);
  if (!venda) return { ok: true, aviso: 'Venda não encontrada no servidor.' };
  if (venda.status === 'transferida') return { ok: true, repetido: true };

  const r = db.transaction(() => {
    const principal = db.prepare('SELECT * FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(vendaId);
    const rotulo = principal ? rotuloMesa(principal) : 'A mesa';
    if (venda.status !== 'aberta') {
      // Fechada também aqui (alguém destravou e cobrou no servidor).
      auditar(db, 'mesa_fechada_em_dois_caixas', vendaId, venda.operador_id, `${caixa.nome || caixa.id} recebeu a venda ${corpo?.vendaCaixaId || ''}`);
      if (principal) soltarTrava(db, caixa.id, principal.id);
      return { ok: true, conflito: `${rotulo} também foi ${venda.status === 'finalizada' ? 'paga' : 'cancelada'} no servidor. Confira se o cliente não pagou duas vezes.` };
    }

    // Item que entrou aqui depois de o caixa levar a conta (pedido pelo QR...)
    // fica numa comanda nova na mesma mesa.
    const sobras = db.prepare('SELECT id FROM sale_items WHERE sale_id = ? AND cancelado = 0').all(vendaId).filter((i) => !ids.has(i.id)).map((i) => i.id);
    let novaVenda = null;
    if (sobras.length && principal) {
      novaVenda = S().openSale({ locationId: venda.location_id, operadorId: venda.operador_id }).id;
      const marcas = sobras.map(() => '?').join(',');
      db.prepare(`UPDATE sale_items SET sale_id = ? WHERE id IN (${marcas})`).run(novaVenda, ...sobras);
      db.prepare(`UPDATE stock_movements SET sale_id = ? WHERE sale_item_id IN (${marcas})`).run(novaVenda, ...sobras);
      db.prepare(
        `INSERT INTO sale_people (id, sale_id, numero, nome, customer_id) SELECT lower(hex(randomblob(16))), ?, numero, nome, customer_id FROM sale_people WHERE sale_id = ?`
      ).run(novaVenda, vendaId);
      db.prepare('UPDATE restaurant_tables SET sale_id = ? WHERE sale_id = ?').run(novaVenda, vendaId);
      for (const id of [vendaId, novaVenda]) {
        const { t } = db.prepare('SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS t FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(id);
        db.prepare('UPDATE sales SET total = ? WHERE id = ?').run(t, id);
      }
    }

    db.prepare(
      `UPDATE sales SET status = 'transferida', transferida_para_caixa = ?, transferida_para_venda_id = ?, transferida_em = NOW_SYNCED() WHERE id = ?`
    ).run(caixa.nome || caixa.id, String(corpo?.vendaCaixaId || '') || null, vendaId);
    if (principal) {
      soltarTrava(db, caixa.id, principal.id);
      if (!novaVenda) {
        db.prepare(
          `UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL, unida_a_mesa_id = NULL WHERE id = ? OR unida_a_mesa_id = ?`
        ).run(principal.id, principal.id);
      }
    }
    auditar(db, 'mesa_fechada_em_outro_caixa', vendaId, venda.operador_id, `${rotulo} paga no ${caixa.nome || caixa.id}${novaVenda ? ` (${sobras.length} item(ns) lançado(s) durante o pagamento ficaram numa comanda nova)` : ''}`);
    return { ok: true, itensQueFicaram: sobras.length && principal ? sobras.length : 0 };
  })();
  versaoAtual();
  avisarTelas({ origem: 'caixa', caixa: caixa?.nome || null, canal: 'concluir' });
  return r;
}

/** Caixa desistiu de receber (não recebeu nada): destrava. */
function devolver(corpo, caixa) {
  const db = getDb();
  const vendaId = String(corpo?.vendaServidorId || '');
  const principal = db.prepare('SELECT * FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(vendaId);
  if (principal) soltarTrava(db, caixa.id, principal.id);
  versaoAtual();
  avisarTelas({ origem: 'caixa', caixa: caixa?.nome || null, canal: 'devolver' });
  return { ok: true };
}

/** Gerente do servidor destrava uma mesa que ficou presa (caixa desligou no meio). */
function destravar({ tableId, operadorId }) {
  const db = getDb();
  const guarda = require('./authService').requireRole(operadorId, PAPEIS_GESTAO);
  if (!guarda.ok) return { ok: false, error: 'Só gerente ou admin pode destravar uma mesa.' };
  const mesa = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!mesa) return { ok: false, error: 'Mesa não encontrada.' };
  const principal = principalDe(db, mesa);
  if (!principal.fechando_caixa_id) return { ok: true };
  db.prepare(`UPDATE restaurant_tables SET fechando_caixa_id = NULL, fechando_caixa_nome = NULL, fechando_desde = NULL WHERE id = ?`).run(principal.id);
  auditar(db, 'mesa_destravada', principal.sale_id, operadorId, `${rotuloMesa(principal)} estava sendo paga no ${principal.fechando_caixa_nome || 'outro caixa'}`);
  versaoAtual();
  return { ok: true };
}

// ------------------------------------------------------------------ caixa

function cliente() { return require('./lanClienteService'); }

/** Este computador usa as mesas do servidor? (caixa ligado pela rede local e não escolheu "só deste caixa") */
function ativa() {
  try {
    const grupoId = grupoAtual();
    if (!grupoId || require('./syncStateService').ehServidorDoGrupo()) return false;
    const cfg = cliente().config();
    if (!cfg || cfg.grupoId !== grupoId) return false;
    return require('./lanArmazemService').lerMeta('mesas_modo') !== 'local';
  } catch { return false; }
}

function podeUsar() {
  try {
    const grupoId = grupoAtual();
    if (!grupoId || require('./syncStateService').ehServidorDoGrupo()) return false;
    const cfg = cliente().config();
    return !!cfg && cfg.grupoId === grupoId;
  } catch { return false; }
}

function definirModo(modo) {
  require('./lanArmazemService').gravarMeta('mesas_modo', modo === 'local' ? 'local' : 'servidor');
  avisarTelas({ origem: 'modo' });
  if (modo !== 'local') iniciarEscuta();
  return { ok: true, ativa: ativa() };
}

let ultimoContato = { ok: null, em: 0, erro: null };

function anotarContato(err) {
  ultimoContato = err ? { ok: false, em: Date.now(), erro: err.message || String(err) } : { ok: true, em: Date.now(), erro: null };
}

async function pedir(caminho, corpo, opcoes) {
  try {
    const r = await cliente().pedido(caminho, corpo, opcoes);
    anotarContato(null);
    return r;
  } catch (err) {
    anotarContato(err);
    try { require('./grupoTransporteService').avisarFalha(err); } catch { /* sem transporte */ }
    if (err.status === 404) throw Object.assign(new Error('O servidor está com uma versão antiga do GerenciaAI, sem mesa compartilhada. Atualize o servidor.'), { status: 404 });
    if (err.rede) throw Object.assign(new Error('O servidor das mesas não respondeu pela rede. Confira se ele está ligado, com o GerenciaAI aberto.'), { rede: true });
    throw err;
  }
}

async function status() {
  const cfg = podeUsar() ? cliente().config() : null;
  const base = { podeUsar: !!cfg, ativa: ativa(), servidor: cfg?.hubNome || null, caixaId: cfg ? meuId() : null };
  if (!base.ativa) return { ...base, online: false };
  try {
    await pedir('/v1/mesas/versao', { desde: -1, esperarMs: 0 }, { timeoutMs: 4000 });
    iniciarEscuta();
    return { ...base, online: true };
  } catch (err) {
    return { ...base, online: false, erro: err.message };
  }
}

function usuarioDoc(db, usuarioId) {
  const doc = docDoUsuario(db, grupoAtual(), usuarioId);
  if (!doc) throw Object.assign(new Error('Seu usuário ainda não foi sincronizado com o grupo. Espere um pouco e tente de novo.'), { usuario: true });
  return doc;
}

// Campos com o operador: sempre quem está logado aqui (vai como usuarioDoc).
const CAMPOS_DE_OPERADOR = ['operadorId', 'currentOperatorId'];

/** Pedido da tela deste caixa para as mesas do servidor. */
async function chamar(canal, args, usuarioId) {
  const c = CANAIS[canal];
  if (!c) return { ok: false, error: 'Pedido de mesa desconhecido.' };
  if (!ativa()) return { ok: false, error: 'Este caixa não está usando as mesas do servidor.' };
  const db = getDb();
  const grupoId = grupoAtual();
  if (c.gestao && !require('./authService').requireRole(usuarioId, PAPEIS_GESTAO).ok) return { ok: false, error: 'Você não tem permissão para fazer isso.' };
  let doc;
  try { doc = usuarioDoc(db, usuarioId); } catch (err) { return { ok: false, error: err.message }; }

  const a = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  for (const k of [...CAMPOS_DE_OPERADOR, 'locationId']) delete a[k];
  if ('productId' in a) { a.productDoc = docDe(db, grupoId, 'produtos', a.productId); delete a.productId; }
  if ('customerId' in a) { a.customerDoc = a.customerId ? docDe(db, grupoId, 'clientes', a.customerId) : null; delete a.customerId; }
  if ('candidateManagerId' in a) {
    a.candidateManagerDoc = a.candidateManagerId ? docDoUsuario(db, grupoId, a.candidateManagerId) : null;
    if (a.candidateManagerId && !a.candidateManagerDoc) return { ok: false, error: 'Esse gerente ainda não foi sincronizado com o grupo.' };
    delete a.candidateManagerId;
  }

  let r;
  try {
    r = await pedir('/v1/mesas/chamar', { canal, args: a, usuarioDoc: doc }, { timeoutMs: canal === 'table:montarLinkPedido' ? 20000 : 10000 });
  } catch (err) {
    return { ok: false, error: err.message, rede: !!err.rede };
  }

  // Ids do grupo -> daqui.
  if (r && Array.isArray(r.pessoas)) {
    r.pessoas = r.pessoas.map((p) => (p && p.clienteId ? { ...p, clienteId: localDe(db, grupoId, 'clientes', p.clienteId) } : p));
  }
  if (canal === 'table:list' && Array.isArray(r)) return anotarTravas(db, r);
  if (canal === 'print:preNota' && r?.ok) {
    require('./printService').imprimirNoRolo(r.html, r.larguraMm);
    return { ok: true };
  }
  return r;
}

function anotarTravas(db, mesas) {
  const eu = meuId();
  const minhas = new Map(db.prepare(`SELECT mesa_id, sale_id FROM mesa_remota_fechamentos WHERE estado = 'pagando'`).all().map((f) => [f.mesa_id, f.sale_id]));
  return mesas.map((m) => ({
    ...m,
    fechando_aqui: !!m.fechando_caixa_id && m.fechando_caixa_id === eu,
    venda_local_id: m.fechando_caixa_id === eu ? minhas.get(m.id) || null : null,
  }));
}

/** Cria aqui a venda com a conta que veio do servidor. Devolve o id dela. */
function importarConta(db, conta, hubId) {
  const grupoId = grupoAtual();
  const locationId = db.prepare('SELECT id FROM locations LIMIT 1').get()?.id;
  if (!locationId) throw new Error('Nenhum local cadastrado neste computador.');
  const operadorId = usuarioDoDoc(db, grupoId, conta.venda.operadorDoc) || conta.usuarioIdAqui;
  const ancora = conta.itens.some((i) => i.ehPersonalizado) ? require('./customItemService').garantirProdutoPersonalizado() : null;
  const itens = conta.itens.map((i) => {
    const productId = i.ehPersonalizado ? ancora : localDe(db, grupoId, 'produtos', i.produtoDoc);
    if (!productId) throw new Error(`O produto "${i.produtoNome}" ainda não chegou neste caixa. Espere a sincronização de produtos e tente de novo.`);
    return { ...i, productId };
  });
  const saleId = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sales (id, location_id, operador_id, customer_id, desconto, pontos_resgatados, desconto_gerente, desconto_gerente_motivo,
                          desconto_autorizado_por_id, status, total, criado_em, taxa_servico_percentual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?, ?, ?)`
    ).run(
      saleId, locationId, operadorId, localDe(db, grupoId, 'clientes', conta.venda.clienteDoc),
      conta.venda.desconto || 0, conta.venda.pontosResgatados || 0, conta.venda.descontoGerente || 0, conta.venda.descontoGerenteMotivo,
      usuarioDoDoc(db, grupoId, conta.venda.descontoAutorizadoPorDoc), 0, conta.venda.criadoEm || new Date().toISOString().replace('T', ' ').slice(0, 19),
      conta.venda.taxaServicoPercentual || 0,
    );
    const inserirItem = db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, criado_em, enviado_cozinha, observacao, pessoa_numero,
                               preco_original, preco_alterado_motivo, nome_personalizado, eh_personalizado, status_preparo, custo_unitario, especificacoes_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const i of itens) {
      inserirItem.run(
        randomUUID(), saleId, i.productId, i.quantidade, i.precoUnitario, i.criadoEm || new Date().toISOString().replace('T', ' ').slice(0, 19),
        i.observacao, i.pessoaNumero, i.precoOriginal, i.precoAlteradoMotivo, i.ehPersonalizado ? (i.nomePersonalizado || i.produtoNome) : i.nomePersonalizado,
        i.ehPersonalizado ? 1 : 0, i.statusPreparo || 'pendente', i.custoUnitario, i.especificacoesJson,
      );
    }
    const inserirPessoa = db.prepare('INSERT INTO sale_people (id, sale_id, numero, nome, customer_id) VALUES (?, ?, ?, ?, ?)');
    for (const p of conta.pessoas || []) inserirPessoa.run(randomUUID(), saleId, p.numero, p.nome, localDe(db, grupoId, 'clientes', p.clienteDoc));
    const inserirMesa = db.prepare('INSERT INTO sale_mesas (id, sale_id, table_id, numero, nome, principal) VALUES (?, ?, ?, ?, ?, ?)');
    inserirMesa.run(randomUUID(), saleId, conta.mesa.id, conta.mesa.numero, conta.mesa.nome, 1);
    for (const u of conta.unidas || []) inserirMesa.run(randomUUID(), saleId, u.id, u.numero, u.nome, 0);
    const { t } = db.prepare('SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS t FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId);
    db.prepare('UPDATE sales SET total = ? WHERE id = ?').run(t, saleId);
    db.prepare(
      `INSERT INTO mesa_remota_fechamentos (sale_id, hub_id, mesa_id, mesa_rotulo, venda_servidor_id, itens_servidor, estado)
       VALUES (?, ?, ?, ?, ?, ?, 'pagando')`
    ).run(saleId, hubId, conta.mesa.id, rotuloDaConta(conta), conta.vendaServidorId, JSON.stringify(conta.itens.map((i) => i.id)));
  })();
  return saleId;
}

function rotuloDaConta(conta) {
  const principal = conta.mesa.nome || `Mesa ${conta.mesa.numero}`;
  const unidas = (conta.unidas || []).map((u) => u.nome || u.numero);
  return unidas.length ? `${principal} + ${unidas.join(' + ')}` : principal;
}

/**
 * Leva a conta da mesa do servidor para receber aqui. Se este caixa já
 * estava com ela (voltou à tela), devolve a mesma venda.
 */
async function puxarParaPagar({ tableId, usuarioId }) {
  if (!ativa()) return { ok: false, error: 'Este caixa não está usando as mesas do servidor.' };
  const db = getDb();
  let doc;
  try { doc = usuarioDoc(db, usuarioId); } catch (err) { return { ok: false, error: err.message }; }
  let conta;
  try {
    conta = await pedir('/v1/mesas/puxar', { mesaId: tableId, usuarioDoc: doc }, { timeoutMs: 10000 });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!conta?.ok) return conta || { ok: false, error: 'O servidor não mandou a conta.' };

  const ja = db.prepare(`SELECT sale_id FROM mesa_remota_fechamentos WHERE venda_servidor_id = ? AND estado = 'pagando'`).get(conta.vendaServidorId);
  if (ja) {
    const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(ja.sale_id);
    if (venda?.status === 'aberta') return { ok: true, saleId: ja.sale_id, rotulo: rotuloDaConta(conta), retomada: true };
  }
  try {
    const saleId = importarConta(db, { ...conta, usuarioIdAqui: usuarioId }, cliente().config()?.hubId || null);
    return { ok: true, saleId, rotulo: rotuloDaConta(conta) };
  } catch (err) {
    // Não deu para montar aqui: a mesa volta a ficar livre para os outros.
    pedir('/v1/mesas/devolver', { vendaServidorId: conta.vendaServidorId }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

/** Desistiu de receber aqui: apaga a cópia (se não tem pagamento) e destrava no servidor. */
async function devolverMesa({ saleId }) {
  const db = getDb();
  const f = db.prepare('SELECT * FROM mesa_remota_fechamentos WHERE sale_id = ?').get(saleId);
  if (!f) return { ok: false, error: 'Essa conta não veio do servidor.' };
  if (f.estado !== 'pagando') return { ok: true };
  const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (venda && venda.status !== 'aberta') return { ok: false, error: 'Essa conta já foi fechada aqui.' };
  const tem = (sql) => db.prepare(sql).get(saleId).c > 0;
  if (tem('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?')) {
    return { ok: false, error: 'Já tem pagamento recebido nesta conta. Termine de receber aqui (ou estorne o pagamento antes de devolver a mesa).' };
  }
  for (const t of ['pix_cobrancas', 'maquininha_cobrancas']) {
    if (tem(`SELECT COUNT(*) AS c FROM ${t} WHERE sale_id = ?`)) {
      return { ok: false, error: 'Tem cobrança de Pix ou maquininha aberta nesta conta. Cancele a cobrança antes de devolver a mesa.' };
    }
  }
  try {
    db.transaction(() => {
      db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'devolver', atualizado_em = datetime('now') WHERE sale_id = ?`).run(saleId);
      if (venda) {
        for (const t of ['sale_mesas', 'sale_people', 'sale_person_payments', 'stock_movements', 'sale_items']) db.prepare(`DELETE FROM ${t} WHERE sale_id = ?`).run(saleId);
        db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
      }
    })();
  } catch (err) {
    console.error('[mesaCompartilhada] não deu para apagar a cópia da conta:', err?.message || err);
    return { ok: false, error: 'Não deu para devolver a mesa agora. Termine de receber aqui.' };
  }
  await processarFila();
  return { ok: true };
}

/** Venda finalizada aqui (sale:finalize): avisa o servidor. */
function aoFinalizarVenda(saleId) {
  try {
    const db = getDb();
    const f = db.prepare(`SELECT estado FROM mesa_remota_fechamentos WHERE sale_id = ?`).get(saleId);
    if (!f || f.estado !== 'pagando') return;
    const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
    if (venda?.status !== 'finalizada') return;
    db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'concluir', atualizado_em = datetime('now') WHERE sale_id = ?`).run(saleId);
    processarFila().catch(() => {});
  } catch (err) { console.error('[mesaCompartilhada] após finalizar:', err?.message || err); }
}

let processando = null;

/** Manda ao servidor o que ficou na fila (conclusão, devolução). */
function processarFila() {
  if (processando) return processando;
  processando = (async () => {
    const db = getDb();
    // Venda paga (ou cancelada) aqui sem a fila saber -- ex.: ficou esperando o estoque do grupo.
    for (const f of db.prepare(`SELECT f.sale_id, s.status FROM mesa_remota_fechamentos f LEFT JOIN sales s ON s.id = f.sale_id WHERE f.estado = 'pagando'`).all()) {
      if (f.status === 'finalizada') db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'concluir' WHERE sale_id = ?`).run(f.sale_id);
      else if (f.status === 'cancelada' || f.status == null) db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'devolver' WHERE sale_id = ?`).run(f.sale_id);
    }
    const fila = db.prepare(`SELECT * FROM mesa_remota_fechamentos WHERE estado IN ('concluir', 'devolver') ORDER BY criado_em`).all();
    if (!fila.length) return { ok: true, pendentes: 0 };
    const cfg = cliente().config();
    let pendentes = 0;
    for (const f of fila) {
      if (!cfg || (f.hub_id && cfg.hubId !== f.hub_id)) { pendentes += 1; continue; } // ligado a outro servidor agora: espera
      try {
        const r = f.estado === 'concluir'
          ? await pedir('/v1/mesas/concluir', { vendaServidorId: f.venda_servidor_id, vendaCaixaId: f.sale_id, itens: JSON.parse(f.itens_servidor || '[]') }, { timeoutMs: 10000 })
          : await pedir('/v1/mesas/devolver', { vendaServidorId: f.venda_servidor_id }, { timeoutMs: 8000 });
        if (!r?.ok) throw new Error(r?.error || 'servidor recusou');
        db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'feito', aviso = ?, erro = NULL, atualizado_em = datetime('now') WHERE sale_id = ?`)
          .run(r.conflito || (r.itensQueFicaram ? `${r.itensQueFicaram} item(ns) lançado(s) durante o pagamento ficaram numa comanda nova na ${f.mesa_rotulo}.` : null), f.sale_id);
        if (r.conflito || r.itensQueFicaram) avisarTelas({ origem: 'aviso', mensagem: r.conflito || `${r.itensQueFicaram} item(ns) lançado(s) na ${f.mesa_rotulo} durante o pagamento ficaram numa comanda nova.` });
      } catch (err) {
        pendentes += 1;
        db.prepare(`UPDATE mesa_remota_fechamentos SET tentativas = tentativas + 1, erro = ?, atualizado_em = datetime('now') WHERE sale_id = ?`).run(err.message, f.sale_id);
      }
    }
    // Registro concluído fica 30 dias (consulta), depois sai.
    db.prepare(`DELETE FROM mesa_remota_fechamentos WHERE estado = 'feito' AND atualizado_em < datetime('now', '-30 days')`).run();
    return { ok: true, pendentes };
  })().finally(() => { processando = null; });
  return processando;
}

function pendenciasDaFila() {
  return getDb().prepare(`SELECT sale_id, mesa_rotulo, estado, tentativas, erro FROM mesa_remota_fechamentos WHERE estado IN ('concluir', 'devolver')`).all();
}

// ------------------------------------------------------------------ escuta (caixa)

let escutando = false;
let relogioFila = null;

/** Fica perguntando ao servidor se as mesas mudaram; avisa as telas daqui. */
function iniciarEscuta() {
  if (!relogioFila) {
    relogioFila = setInterval(() => { if (podeUsar()) processarFila().catch(() => {}); }, REPETIR_FILA_MS);
    relogioFila.unref?.();
  }
  if (escutando || !ativa()) return;
  escutando = true;
  (async () => {
    let desde = -1;
    let semConexao = false;
    while (ativa()) {
      try {
        const r = await pedir('/v1/mesas/versao', { desde, esperarMs: desde < 0 ? 0 : ESPERA_MAX_MUDANCA_MS }, { timeoutMs: ESPERA_MAX_MUDANCA_MS + 10000 });
        // Voltou a conexão, ou mudou alguma mesa: as telas recarregam.
        if (semConexao || (desde >= 0 && r.versao !== desde)) avisarTelas({ origem: 'servidor' });
        semConexao = false;
        desde = r.versao;
      } catch (err) {
        if (err.status === 404) break; // servidor antigo
        if (!semConexao) avisarTelas({ origem: 'servidor', semConexao: true });
        semConexao = true;
        desde = -1;
        await new Promise((ok) => { const t = setTimeout(ok, 5000); t.unref?.(); });
      }
    }
    escutando = false;
  })();
}

function pararEscuta() {
  if (relogioFila) clearInterval(relogioFila);
  relogioFila = null;
}

module.exports = {
  // servidor
  CANAIS, atenderChamada, puxar, concluir, devolver, destravar, versaoAtual, esperarMudanca,
  recusaPorTrava, travaDoComandoCelular,
  // caixa
  ativa, podeUsar, status, definirModo, chamar, puxarParaPagar, devolverMesa, aoFinalizarVenda, processarFila,
  pendenciasDaFila, iniciarEscuta, pararEscuta,
  // testes
  _ultimoContato: () => ultimoContato,
};
