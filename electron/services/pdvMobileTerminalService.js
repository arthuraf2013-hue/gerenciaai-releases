/**
 * PDV mobile autônomo como TERMINAL deste computador.
 *
 * Cenário: o cliente começou só com o celular (app em mobile/), comprou
 * este computador, migrou os dados (pdvMobileMigracaoService.js) e, na
 * Central, marcou o celular como "terminal" daqui (modoOperacao
 * 'terminal' + servidorInstallId = id deste computador). A partir daí:
 *
 * - O celular continua vendendo sozinho, com ou sem internet, no caixa
 *   DELE. Cada fato que interessa aqui vira um evento imutável em
 *   installations/{celular}/terminal_eventos (venda, venda cancelada,
 *   fiado recebido, cliente novo/editado) -- ver mobile/src/services/terminal.js.
 * - Este serviço escuta esses eventos, aplica cada um UMA vez
 *   (pdv_terminal_eventos), na ordem em que aconteceram, e devolve um
 *   recibo em terminal_acks (com a NFC-e, se configurado).
 * - Produtos, preços, estoque e clientes passam a ser daqui: o catálogo
 *   é publicado em installations/{celular}/terminal_catalogo e o celular
 *   aplica. O celular não cadastra produto nem mexe em estoque.
 *
 * Mesmas regras de conversão da migração (centavos -> reais, qtd_mil ->
 * quantidade, datas ISO -> formato do desktop, IDs do celular
 * preservados), então importar um backup depois de já ter recebido
 * eventos (ou o contrário) nunca conta nada duas vezes: venda,
 * movimento de estoque e lançamento de fiado têm o MESMO id nos dois
 * caminhos.
 *
 * O que NÃO entra no caixa deste computador: as vendas do terminal foram
 * recebidas no caixa do celular (cashService exclui a origem
 * 'pdv_mobile_terminal' do fechamento daqui).
 */
const { randomBytes, createHash } = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const migr = require('./pdvMobileMigracaoService');

const VERSAO_EVENTO_MAX = 1;
const ORIGEM = 'pdv_mobile_terminal';
const TIPOS = new Set(['venda', 'venda_cancelada', 'fiado_pagamento', 'cliente', 'estoque']);
const INTERVALO_CATALOGO_MS = 60 * 1000;
const ITENS_POR_PARTE_PRODUTOS = 1000; // mesmo valor de mobile/src/services/terminalMemoria.js
const ITENS_POR_PARTE_CLIENTES = 2000;
const DIAS_GUARDAR_EVENTOS_NA_NUVEM = 30;

class ErroTerminal extends Error {
  constructor(mensagem, { aguardar = false } = {}) {
    super(mensagem);
    this.aguardar = aguardar;
  }
}

const { reais, qtd, dataDesktop, METODO, PAPEL } = migr;

// ---------------------------------------------------------------------------
// Config

function getConfig() {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM pdv_terminal_config WHERE id = 'default'`).get();
  return { emitirNfce: !!r?.emitir_nfce, janelaNfceMin: r?.janela_nfce_min ?? 10 };
}

function salvarConfig({ emitirNfce, janelaNfceMin } = {}) {
  const janela = Math.round(Number(janelaNfceMin));
  if (!Number.isFinite(janela) || janela < 1 || janela > 1440) return { ok: false, error: 'A janela da NFC-e precisa ser de 1 a 1440 minutos.' };
  getDb().prepare(
    `INSERT INTO pdv_terminal_config (id, emitir_nfce, janela_nfce_min, atualizado_em) VALUES ('default', ?, ?, NOW_SYNCED())
     ON CONFLICT(id) DO UPDATE SET emitir_nfce = excluded.emitir_nfce, janela_nfce_min = excluded.janela_nfce_min, atualizado_em = excluded.atualizado_em`,
  ).run(emitirNfce ? 1 : 0, janela);
  return { ok: true, config: getConfig() };
}

// ---------------------------------------------------------------------------
// Aplicação dos eventos (local, síncrono, dentro de transação)

/** Só aceita evento de celular cujos dados foram migrados PRA ESTE computador. */
function migracaoDoCelular(db, installId) {
  migr.garantirTabela(db);
  return db.prepare(
    'SELECT install_id_mobile, nome_mobile, operador_id, MAX(gerado_em_ms) AS corte FROM pdv_mobile_migracoes WHERE install_id_mobile = ? GROUP BY install_id_mobile',
  ).get(installId) || null;
}

function contexto(db, installId) {
  const migracao = migracaoDoCelular(db, installId);
  if (!migracao) throw new ErroTerminal('Este celular não foi migrado para este computador -- importe os dados dele antes (Configurações → Migrar PDV mobile).');
  const location = db.prepare('SELECT id FROM locations ORDER BY criado_em LIMIT 1').get();
  if (!location) throw new ErroTerminal('Este computador ainda não tem loja configurada.');
  // Quem assina o que não tem autor no evento: o admin que fez a migração
  // (ou, se ele não existir mais, qualquer admin ativo).
  const padrao = (migracao.operador_id && db.prepare('SELECT id FROM users WHERE id = ?').get(migracao.operador_id)?.id)
    || db.prepare(`SELECT id FROM users WHERE role IN ('admin', 'suporte') ORDER BY ativo DESC, criado_em LIMIT 1`).get()?.id;
  if (!padrao) throw new ErroTerminal('Nenhum administrador cadastrado neste computador.');
  return { installId, locationId: location.id, deviceId: `pdv-mobile:${installId}`, operadorPadrao: padrao, corteMs: Number(migracao.corte) || 0 };
}

function garantirUsuario(db, ctx, snap) {
  if (!snap?.id) return ctx.operadorPadrao;
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(snap.id)) return snap.id;
  // Igual à migração: entra DESATIVADO (o PIN do celular não converte),
  // só pra manter o "quem vendeu" do histórico.
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash, pin_temporario, ativo, criado_em) VALUES (?, ?, ?, ?, 1, 0, ?)`)
    .run(snap.id, `${snap.nome || 'Operador'} (celular)`, PAPEL[snap.papel] || 'operador', bcrypt.hashSync(randomBytes(24).toString('hex'), 8),
      dataDesktop(snap.criado_em) || dataDesktop(new Date().toISOString()));
  return snap.id;
}

function mapear(db, ctx, tipo, idMobile, idLocal) {
  db.prepare('INSERT OR IGNORE INTO pdv_terminal_mapa (install_id, tipo, id_mobile, id_local) VALUES (?, ?, ?, ?)').run(ctx.installId, tipo, idMobile, idLocal);
}

/**
 * Produto do evento -> produto daqui. Ordem: mesmo id (veio do catálogo
 * daqui, ou da migração) -> ligação já registrada -> mesmo código de
 * barras (liga) -> cria (produto feito no celular entre a migração e
 * virar terminal). Produto que nasceu DEPOIS da migração é criado com
 * saldo zero: todo o estoque dele chega pelos eventos (entrada inicial,
 * vendas...). Só no caso raro de um produto antigo que não está aqui
 * (apagado depois da migração) entra um ajuste com `estoqueAntesMil`
 * (saldo do celular antes deste evento, aproximado).
 */
function resolverProduto(db, ctx, snap, estoqueAntesMil) {
  if (!snap?.id) throw new ErroTerminal('Evento sem os dados do produto.');
  if (db.prepare('SELECT 1 FROM products WHERE id = ?').get(snap.id)) return snap.id;
  const mapeado = db.prepare(`SELECT p.id FROM pdv_terminal_mapa m JOIN products p ON p.id = m.id_local
    WHERE m.install_id = ? AND m.tipo = 'produto' AND m.id_mobile = ?`).get(ctx.installId, snap.id);
  if (mapeado) return mapeado.id;
  const porCodigo = snap.codigo_barras ? db.prepare('SELECT id FROM products WHERE codigo_barras = ?').get(snap.codigo_barras) : null;
  if (porCodigo) { mapear(db, ctx, 'produto', snap.id, porCodigo.id); return porCodigo.id; }
  db.prepare(
    `INSERT INTO products (id, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, tipo, ativo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(snap.id, snap.codigo_barras || null, snap.nome || 'Produto do celular', snap.categoria || null, reais(snap.preco_centavos), reais(snap.custo_centavos),
    snap.unidade === 'kg' ? 'kg' : 'un', qtd(snap.estoque_minimo_mil), snap.controla_estoque ? 'produto' : 'servico');
  const nasceuDepoisDaMigracao = snap.criado_em && Date.parse(snap.criado_em) >= ctx.corteMs;
  if (snap.controla_estoque && estoqueAntesMil && !nasceuDepoisDaMigracao) {
    db.prepare(
      `INSERT OR IGNORE INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id, criado_em)
       VALUES (?, ?, ?, 'ajuste', ?, ?, ?, ?, NOW_SYNCED())`,
    ).run(`term-ini-${ctx.installId}-${snap.id}`, snap.id, ctx.locationId, qtd(estoqueAntesMil), 'Saldo do produto cadastrado no celular', ctx.operadorPadrao, ctx.deviceId);
  }
  return snap.id;
}

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

function clienteExistente(db, ctx, snap) {
  if (db.prepare('SELECT 1 FROM customers WHERE id = ?').get(snap.id)) return snap.id;
  const mapeado = db.prepare(`SELECT c.id FROM pdv_terminal_mapa m JOIN customers c ON c.id = m.id_local
    WHERE m.install_id = ? AND m.tipo = 'cliente' AND m.id_mobile = ?`).get(ctx.installId, snap.id);
  if (mapeado) return mapeado.id;
  const doc = soDigitos(snap.documento);
  const porDoc = doc.length === 11 ? db.prepare(`SELECT id FROM customers WHERE REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') = ?`).get(doc)
    : doc.length === 14 ? db.prepare(`SELECT id FROM customers WHERE REPLACE(REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '-', ''), '/', ''), ' ', '') = ?`).get(doc) : null;
  if (porDoc) { mapear(db, ctx, 'cliente', snap.id, porDoc.id); return porDoc.id; }
  return null;
}

function resolverCliente(db, ctx, snap) {
  if (!snap?.id) throw new ErroTerminal('Evento sem os dados do cliente.');
  const existente = clienteExistente(db, ctx, snap);
  if (existente) return existente;
  const doc = soDigitos(snap.documento);
  db.prepare('INSERT INTO customers (id, nome, telefone, cpf, cnpj, ativo, criado_em) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(snap.id, snap.nome || 'Cliente do celular', snap.telefone || null, doc.length === 11 ? doc : null, doc.length === 14 ? doc : null,
      dataDesktop(snap.criado_em) || dataDesktop(new Date().toISOString()));
  return snap.id;
}

function somaMovimentosPorProduto(movimentos) {
  const m = new Map();
  for (const mv of movimentos || []) m.set(mv.produto_id, (m.get(mv.produto_id) || 0) + mv.qtd_mil);
  return m;
}

function inserirMovimentoEstoque(db, ctx, { mv, productId, saleId, tipo, motivo, operadorId }) {
  if (db.prepare('SELECT 1 FROM stock_movements WHERE id = ?').get(mv.id)) return false;
  if (db.prepare('SELECT tipo FROM products WHERE id = ?').get(productId)?.tipo === 'servico') return false;
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, operador_id, device_id, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(mv.id, productId, ctx.locationId, tipo, qtd(mv.qtd_mil), motivo, saleId, operadorId, ctx.deviceId, dataDesktop(mv.criado_em));
  return true;
}

function aplicarVenda(db, ctx, d) {
  const v = d.venda;
  if (!v?.id || !Array.isArray(d.itens) || !Array.isArray(d.pagamentos)) throw new ErroTerminal('Evento de venda incompleto.');
  if (db.prepare('SELECT 1 FROM sales WHERE id = ?').get(v.id)) return { status: 'ignorado', motivo: 'A venda já estava no computador (veio na migração).', saleId: v.id };

  // Integridade do próprio evento: itens = subtotal, pagamentos = total.
  const somaItens = d.itens.reduce((s, i) => s + i.total_centavos, 0);
  const somaPag = d.pagamentos.reduce((s, p) => s + p.valor_centavos, 0);
  if (somaItens !== v.subtotal_centavos || somaPag !== v.total_centavos) {
    throw new ErroTerminal(`Venda ${v.numero} chegou inconsistente (itens ${reais(somaItens)} x subtotal ${reais(v.subtotal_centavos)}, pagamentos ${reais(somaPag)} x total ${reais(v.total_centavos)}).`);
  }

  const operador = garantirUsuario(db, ctx, d.operador);
  const autorizador = v.desconto_autorizado_por ? garantirUsuario(db, ctx, d.autorizador || { id: v.desconto_autorizado_por }) : null;
  const clienteId = v.cliente_id ? resolverCliente(db, ctx, d.cliente || { id: v.cliente_id }) : null;
  const somaMov = somaMovimentosPorProduto(d.movimentos);
  const snaps = new Map((d.produtos || []).map((p) => [p.id, p]));
  const produto = new Map();
  const resolver = (idMobile) => {
    if (!produto.has(idMobile)) {
      const snap = snaps.get(idMobile) || { id: idMobile };
      produto.set(idMobile, resolverProduto(db, ctx, snap, (snap.estoque_mil ?? 0) - (somaMov.get(idMobile) || 0)));
    }
    return produto.get(idMobile);
  };

  // Sempre entra FINALIZADA: se já tinha sido cancelada no celular quando
  // o evento foi montado, o evento de cancelamento vem logo atrás (com os
  // estornos de estoque/fiado dele).
  const criado = dataDesktop(v.criado_em);
  db.prepare(
    `INSERT INTO sales (id, location_id, operador_id, customer_id, desconto, desconto_gerente, desconto_gerente_motivo, desconto_autorizado_por_id,
       status, total, criado_em, finalizada_em)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'finalizada', ?, ?, ?)`,
  ).run(v.id, ctx.locationId, operador, clienteId, reais(v.desconto_centavos), v.desconto_centavos ? 'Desconto dado no celular (terminal)' : null,
    autorizador, reais(v.subtotal_centavos), criado, criado);

  for (const i of d.itens) {
    const productId = resolver(i.produto_id);
    const nomeAqui = db.prepare('SELECT nome FROM products WHERE id = ?').get(productId)?.nome;
    db.prepare('INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, criado_em, nome_personalizado) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(i.id, v.id, productId, qtd(i.qtd_mil), reais(i.preco_unit_centavos), criado, nomeAqui !== i.nome ? i.nome : null);
  }
  for (const p of d.pagamentos) {
    const detalhes = { origem: ORIGEM, numeroPdvMobile: v.numero, celular: ctx.installId };
    if (p.metodo === 'dinheiro' && p.recebido_centavos != null && p.recebido_centavos > p.valor_centavos) {
      detalhes.valorRecebido = reais(p.recebido_centavos);
      detalhes.troco = reais(p.recebido_centavos - p.valor_centavos);
    }
    db.prepare('INSERT INTO payments (id, sale_id, metodo, valor, detalhes, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, v.id, METODO[p.metodo] || 'outro', reais(p.valor_centavos), JSON.stringify(detalhes), criado);
  }
  for (const mv of d.movimentos || []) {
    inserirMovimentoEstoque(db, ctx, { mv, productId: resolver(mv.produto_id), saleId: v.id, tipo: 'venda', motivo: `Venda ${v.numero} no celular`, operadorId: operador });
  }
  for (const f of d.fiado || []) {
    if (db.prepare('SELECT 1 FROM customer_credit_movements WHERE id = ?').get(f.id)) continue;
    if (!clienteId) throw new ErroTerminal(`Venda ${v.numero} no fiado sem cliente.`);
    db.prepare('INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, motivo, operador_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, clienteId, 'divida', reais(f.valor_centavos), v.id, `Venda ${v.numero} no celular`, operador, dataDesktop(f.criado_em));
  }
  return { status: 'aplicado', saleId: v.id };
}

function aplicarCancelamento(db, ctx, d) {
  const sale = db.prepare('SELECT id, status, customer_id FROM sales WHERE id = ?').get(d.vendaId);
  if (!sale) throw new ErroTerminal(`A venda ${d.numero || ''} ainda não chegou neste computador -- o cancelamento entra assim que ela chegar.`, { aguardar: true });
  // Cancelada aqui no computador antes (com os estornos daqui): não estorna de novo.
  if (sale.status === 'cancelada') return { status: 'ignorado', motivo: 'A venda já estava cancelada no computador.', saleId: sale.id };
  const quem = garantirUsuario(db, ctx, d.cancelador);
  db.prepare(`UPDATE sales SET status = 'cancelada', cancelada_em = ?, cancelada_por_id = ?, motivo_cancelamento = ? WHERE id = ?`)
    .run(dataDesktop(d.canceladaEm), quem, `${d.motivo || 'Sem motivo'} (cancelada no celular)`, sale.id);
  const somaMov = somaMovimentosPorProduto(d.movimentos);
  const snaps = new Map((d.produtos || []).map((p) => [p.id, p]));
  for (const mv of d.movimentos || []) {
    const snap = snaps.get(mv.produto_id) || { id: mv.produto_id };
    const productId = resolverProduto(db, ctx, snap, (snap.estoque_mil ?? 0) - (somaMov.get(mv.produto_id) || 0));
    inserirMovimentoEstoque(db, ctx, { mv, productId, saleId: sale.id, tipo: 'estorno', motivo: `Venda ${d.numero} cancelada no celular`, operadorId: quem });
  }
  for (const f of d.fiado || []) {
    if (db.prepare('SELECT 1 FROM customer_credit_movements WHERE id = ?').get(f.id)) continue;
    const clienteId = sale.customer_id || (d.cliente ? resolverCliente(db, ctx, d.cliente) : null);
    if (!clienteId) throw new ErroTerminal(`Estorno de fiado da venda ${d.numero} sem cliente.`);
    db.prepare('INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, motivo, operador_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, clienteId, 'pagamento', reais(Math.abs(f.valor_centavos)), sale.id, `Estorno da venda ${d.numero} cancelada no celular`, quem, dataDesktop(f.criado_em));
  }
  const nota = db.prepare(`SELECT numero FROM nfce_emitidas WHERE sale_id = ? AND status IN ('autorizada', 'contingencia', 'pendente') ORDER BY criado_em DESC LIMIT 1`).get(sale.id);
  return {
    status: 'aplicado', saleId: sale.id,
    aviso: nota ? `A venda tem a NFC-e nº ${nota.numero}: cancele a nota no computador (Vendas → NFC-e).` : null,
  };
}

function aplicarFiadoPagamento(db, ctx, d) {
  const l = d.lancamento;
  if (!l?.id) throw new ErroTerminal('Evento de fiado incompleto.');
  if (db.prepare('SELECT 1 FROM customer_credit_movements WHERE id = ?').get(l.id)) return { status: 'ignorado', motivo: 'Lançamento já estava no computador.' };
  const clienteId = resolverCliente(db, ctx, d.cliente || { id: l.cliente_id });
  // Defesa extra enquanto a máquina não tem identidade no Firestore (fase
  // B): um "recebimento de fiado" maior do que a dívida que o computador
  // conhece não entra sozinho -- fica recusado pra alguém conferir e usar
  // "Tentar de novo". Sem isso, um evento forjado podia zerar a dívida de
  // um cliente.
  const valorPago = reais(Math.abs(Number(l.valor_centavos) || 0));
  if (!(valorPago > 0)) throw new ErroTerminal('Recebimento de fiado sem valor.');
  const saldo = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END), 0) AS s FROM customer_credit_movements WHERE customer_id = ?`
  ).get(clienteId).s;
  if (valorPago > saldo + 0.009 && !ctx.forcarRevisado) {
    throw new ErroTerminal(`Recebimento de ${valorPago.toFixed(2)} maior que a dívida do cliente aqui (${Math.max(0, saldo).toFixed(2)}). Confira antes de aplicar.`);
  }
  const quem = garantirUsuario(db, ctx, d.usuario);
  const metodo = { dinheiro: 'dinheiro', credito: 'cartão de crédito', debito: 'cartão de débito', pix: 'Pix' }[l.metodo] || l.metodo || '';
  db.prepare('INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, motivo, operador_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(l.id, clienteId, 'pagamento', reais(Math.abs(l.valor_centavos)), `Recebido no celular${metodo ? ` (${metodo})` : ''}`, quem, dataDesktop(l.criado_em));
  return { status: 'aplicado' };
}

function aplicarCliente(db, ctx, d) {
  const c = d.cliente;
  if (!c?.id) throw new ErroTerminal('Evento de cliente incompleto.');
  const existente = clienteExistente(db, ctx, c);
  if (!existente) { resolverCliente(db, ctx, c); return { status: 'aplicado', clienteId: c.id }; }
  // Atualiza o cadastro (nunca o saldo: fiado só anda pelos lançamentos).
  const doc = soDigitos(c.documento);
  db.prepare(
    `UPDATE customers SET nome = ?, telefone = COALESCE(?, telefone),
       cpf = CASE WHEN ? = 11 THEN ? ELSE cpf END, cnpj = CASE WHEN ? = 14 THEN ? ELSE cnpj END WHERE id = ?`,
  ).run(c.nome, c.telefone || null, doc.length, doc, doc.length, doc, existente);
  return { status: 'aplicado', clienteId: existente };
}

/** Entrada/contagem feita no celular entre a migração e virar terminal. */
function aplicarEstoque(db, ctx, d) {
  const mv = d.movimento;
  if (!mv?.id) throw new ErroTerminal('Evento de estoque incompleto.');
  if (db.prepare('SELECT 1 FROM stock_movements WHERE id = ?').get(mv.id)) return { status: 'ignorado', motivo: 'Movimento já estava no computador.' };
  const snap = d.produto || { id: mv.produto_id };
  const productId = resolverProduto(db, ctx, snap, (snap.estoque_mil ?? 0) - mv.qtd_mil);
  const quem = garantirUsuario(db, ctx, d.usuario);
  const inseriu = inserirMovimentoEstoque(db, ctx, {
    mv, productId, saleId: null, tipo: migr.TIPO_MOV_ESTOQUE[mv.tipo] || 'ajuste', motivo: `${mv.motivo || 'Estoque'} (celular)`, operadorId: quem,
  });
  return inseriu ? { status: 'aplicado' } : { status: 'ignorado', motivo: 'Produto sem controle de estoque neste computador.' };
}

const APLICADORES = {
  venda: aplicarVenda, venda_cancelada: aplicarCancelamento, fiado_pagamento: aplicarFiadoPagamento, cliente: aplicarCliente, estoque: aplicarEstoque,
};

function registrar(db, ev, installId, r) {
  db.prepare(
    `INSERT INTO pdv_terminal_eventos (evento_id, install_id, tipo, ref_id, criado_em_ms, status, erro, aplicado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('aplicado', 'ignorado') THEN NOW_SYNCED() END)
     ON CONFLICT(evento_id) DO UPDATE SET status = excluded.status, erro = excluded.erro, aplicado_em = excluded.aplicado_em`,
  ).run(ev.id, installId, String(ev.tipo || '?'), ev.refId || null, Number(ev.criadoEmMs) || 0, r.status, r.erro || r.motivo || r.aviso || null, r.status);
}

/**
 * Aplica um evento do celular. Nunca lança: devolve { status, erro?, ... }.
 * status: 'aplicado' | 'ignorado' (já estava aqui) | 'erro' | 'aguardando'
 * (depende de outro evento que ainda não chegou -- tenta de novo depois).
 */
function aplicarEvento(installId, ev, { forcarRevisado = false } = {}) {
  const db = getDb();
  const anterior = db.prepare('SELECT status, erro FROM pdv_terminal_eventos WHERE evento_id = ?').get(ev?.id || '');
  if (anterior && (anterior.status === 'aplicado' || anterior.status === 'ignorado')) {
    // Reenvio (o recibo não chegou no celular): responde de novo, sem reaplicar.
    return { status: anterior.status, motivo: anterior.erro || null, repetido: true, saleId: ev.tipo === 'venda' || ev.tipo === 'venda_cancelada' ? ev.refId : undefined };
  }
  let r;
  try {
    if (!ev?.id || !TIPOS.has(ev.tipo)) throw new ErroTerminal(`Tipo de evento desconhecido (${ev?.tipo}).`);
    if (Number(ev.versao) > VERSAO_EVENTO_MAX) throw new ErroTerminal('O app do celular é mais novo que o GerenciaAI deste computador -- atualize o computador.');
    let dados;
    try { dados = typeof ev.dadosJson === 'string' ? JSON.parse(ev.dadosJson) : ev.dados; } catch { throw new ErroTerminal('Evento corrompido (dados ilegíveis).'); }
    if (!dados) throw new ErroTerminal('Evento sem dados.');
    r = db.transaction(() => {
      const ctx = { ...contexto(db, installId), forcarRevisado };
      const res = APLICADORES[ev.tipo](db, ctx, dados);
      registrar(db, ev, installId, res);
      return res;
    })();
  } catch (err) {
    if (!(err instanceof ErroTerminal)) console.error('[pdvMobileTerminal] erro inesperado ao aplicar evento', ev?.id, err);
    r = err instanceof ErroTerminal && err.aguardar
      ? { status: 'aguardando', erro: err.message }
      : { status: 'erro', erro: err instanceof ErroTerminal ? err.message : `Erro inesperado no computador: ${err.message}` };
    try { registrar(db, ev || { id: 'sem-id' }, installId, r); } catch (e) { console.error('[pdvMobileTerminal] não consegui registrar o evento', e); }
  }
  return r;
}

/** Aplica e, se configurado, emite a NFC-e da venda (assíncrono, fora da transação). */
async function processarEvento(installId, ev, { agoraMs = Date.now(), forcarRevisado = false } = {}) {
  const r = aplicarEvento(installId, ev, { forcarRevisado });
  if (r.status !== 'aplicado' || ev.tipo !== 'venda' || r.repetido) return r;
  const cfg = getConfig();
  if (!cfg.emitirNfce) return r;
  const atrasoMin = (agoraMs - Number(ev.criadoEmMs)) / 60000;
  let nfce;
  if (atrasoMin > cfg.janelaNfceMin) {
    nfce = { status: 'nao_emitida', mensagem: `A venda chegou ${Math.round(atrasoMin)} min depois (limite: ${cfg.janelaNfceMin} min). Se precisar, emita pelo computador em Vendas.` };
  } else {
    try {
      const fiscal = require('./fiscalService');
      const res = await fiscal.emitirNFCe(r.saleId, { dataEmissao: new Date(agoraMs) });
      nfce = res.ok
        ? { status: res.contingencia ? 'contingencia' : res.autorizada ? 'autorizada' : res.transmitido ? 'rejeitada' : 'pendente', numero: res.numero, chave: res.chaveAcesso, url: res.qrCodeUrl || null, mensagem: res.motivo || res.aviso || null }
        : { status: 'erro', mensagem: res.error };
    } catch (err) {
      nfce = { status: 'erro', mensagem: err.message };
    }
  }
  getDb().prepare('UPDATE pdv_terminal_eventos SET nfce_status = ?, nfce_mensagem = ? WHERE evento_id = ?').run(nfce.status, nfce.mensagem || null, ev.id);
  return { ...r, nfce };
}

// ---------------------------------------------------------------------------
// Catálogo publicado pro celular

/** Produtos, estoque e clientes daqui, no formato do celular (centavos, milésimos). Inclui os ids "antigos" do celular ligados a cada um. */
function montarCatalogo(installId) {
  const db = getDb();
  const location = db.prepare('SELECT id FROM locations ORDER BY criado_em LIMIT 1').get();
  const estoque = new Map();
  if (location) {
    for (const l of db.prepare('SELECT product_id, SUM(quantidade) AS q FROM stock_movements WHERE location_id = ? GROUP BY product_id').all(location.id)) estoque.set(l.product_id, l.q);
  }
  const apelidos = { produto: new Map(), cliente: new Map() };
  for (const m of db.prepare('SELECT tipo, id_mobile, id_local FROM pdv_terminal_mapa WHERE install_id = ?').all(installId)) {
    const mapa = apelidos[m.tipo];
    if (!mapa.has(m.id_local)) mapa.set(m.id_local, []);
    mapa.get(m.id_local).push(m.id_mobile);
  }
  const centavos = (v) => Math.round((Number(v) || 0) * 100);
  const mil = (v) => Math.round((Number(v) || 0) * 1000);
  // Preço que vale hoje: o promocional, enquanto a promoção não venceu (mesma regra do balcão).
  const hoje = require('./timeService').hojeLocalISO();
  const produtos = db.prepare(
    `SELECT id, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, tipo, preco_promocional, promocao_valida_ate
     FROM products WHERE ativo = 1 ORDER BY id`,
  ).all().map((p) => {
    const promo = p.preco_promocional != null && p.promocao_valida_ate && p.promocao_valida_ate >= hoje;
    return {
      id: p.id, nome: p.nome, codigo_barras: p.codigo_barras || null, categoria: p.categoria || null,
      unidade: String(p.unidade || '').toLowerCase() === 'kg' ? 'kg' : 'un',
      preco_centavos: centavos(promo ? p.preco_promocional : p.preco), custo_centavos: centavos(p.custo),
      estoque_mil: p.tipo === 'servico' ? 0 : mil(estoque.get(p.id)), estoque_minimo_mil: mil(p.estoque_minimo),
      controla_estoque: p.tipo === 'servico' ? 0 : 1,
      apelidos: apelidos.produto.get(p.id) || undefined,
    };
  });
  const saldos = new Map(db.prepare(`SELECT customer_id, SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END) AS s FROM customer_credit_movements GROUP BY customer_id`).all().map((r) => [r.customer_id, r.s]));
  const clientes = db.prepare('SELECT id, nome, telefone, cpf, cnpj, ativo FROM customers WHERE ativo = 1 ORDER BY id').all().map((c) => ({
    id: c.id, nome: c.nome, telefone: c.telefone || null, documento: soDigitos(c.cpf) || soDigitos(c.cnpj) || null,
    saldo_fiado_centavos: centavos(saldos.get(c.id)), apelidos: apelidos.cliente.get(c.id) || undefined,
  }));
  // Eventos deste celular já aplicados aqui (últimas 24 h): o estoque/fiado
  // acima JÁ inclui o efeito deles. O celular para de descontar esses
  // como "pendentes" mesmo que o recibo ainda não tenha chegado lá --
  // senão a mesma venda seria descontada duas vezes até o próximo catálogo.
  const eventosAplicados = db.prepare(
    `SELECT evento_id FROM pdv_terminal_eventos WHERE install_id = ? AND status IN ('aplicado', 'ignorado') AND aplicado_em >= datetime('now', '-1 day')
     ORDER BY aplicado_em DESC LIMIT 2000`,
  ).all(installId).map((r) => r.evento_id).sort();
  return { produtos, clientes, eventosAplicados };
}

function partirCatalogo({ produtos, clientes }) {
  const partes = {};
  const fatiar = (lista, tam, prefixo) => {
    const n = Math.ceil(lista.length / tam);
    for (let i = 0; i < n; i++) partes[`${prefixo}${i}`] = lista.slice(i * tam, (i + 1) * tam);
    return n;
  };
  return { partes, partesProdutos: fatiar(produtos, ITENS_POR_PARTE_PRODUTOS, 'p'), partesClientes: fatiar(clientes, ITENS_POR_PARTE_CLIENTES, 'c') };
}

const versaoDoCatalogo = (cat) => createHash('sha1').update(JSON.stringify(cat)).digest('hex').slice(0, 20);

// ---------------------------------------------------------------------------
// Rede

const terminais = new Map(); // installId -> { nome, pararEventos, catalogoVersao, ultimaMudancaDb, emFila:Set, ultimoErro }
let pararEscutaTerminais = null;
let intervaloCatalogo = null;
let intervaloLimpeza = null;
let fila = Promise.resolve();

function enfileirar(tarefa) {
  const p = fila.then(tarefa);
  fila = p.catch((err) => console.error('[pdvMobileTerminal] tarefa falhou:', err));
  return p;
}

function fsCtx() {
  const fs = require('firebase/firestore');
  const licenseService = require('./licenseService');
  return { fs, db: licenseService.getLicenseFirestore(), meuId: require('./pdvRegistryService').getOrCreateDeviceUid() };
}

async function enviarRecibo(installId, eventoId, r) {
  const { fs, db } = fsCtx();
  const lote = fs.writeBatch(db);
  const resultado = {};
  if (r.saleId) resultado.saleId = r.saleId;
  if (r.nfce) resultado.nfce = r.nfce;
  if (r.aviso) resultado.aviso = r.aviso;
  if (r.motivo) resultado.motivo = r.motivo;
  lote.set(fs.doc(db, 'installations', installId, 'terminal_acks', eventoId), {
    status: r.status, erro: r.erro || null, resultadoJson: Object.keys(resultado).length ? JSON.stringify(resultado) : null, em: fs.serverTimestamp(),
  });
  lote.set(fs.doc(db, 'installations', installId, 'terminal_eventos', eventoId), {
    status: r.status, erro: r.erro || null, processadoEm: fs.serverTimestamp(),
  }, { merge: true });
  await lote.commit();
}

async function tratarEventos(installId, docs) {
  const t = terminais.get(installId);
  if (!t) return;
  const ordenados = docs.sort((a, b) => (Number(a.criadoEmMs) || 0) - (Number(b.criadoEmMs) || 0));
  let aplicouAlgo = false;
  for (const ev of ordenados) {
    if (t.emFila.has(ev.id)) continue;
    t.emFila.add(ev.id);
    await enfileirar(async () => {
      try {
        const r = await processarEvento(installId, ev);
        if (r.status === 'aguardando') return; // fica 'novo' na nuvem; tenta de novo na próxima passada
        if (r.status === 'aplicado') aplicouAlgo = true;
        await enviarRecibo(installId, ev.id, r);
      } catch (err) {
        t.ultimoErro = err.message;
        console.error('[pdvMobileTerminal] recibo não enviado (tenta de novo):', err.message);
      } finally {
        t.emFila.delete(ev.id);
      }
    });
  }
  // Depois de aplicar, o estoque/fiado daqui mudou: atualiza o catálogo do celular já.
  if (aplicouAlgo) publicarCatalogo(installId).catch(() => {});
  // Algum ficou esperando outro evento? Agora que a fila andou, tenta de novo.
  const aguardando = ordenados.filter((ev) => getDb().prepare(`SELECT 1 FROM pdv_terminal_eventos WHERE evento_id = ? AND status = 'aguardando'`).get(ev.id));
  if (aplicouAlgo && aguardando.length) await tratarEventos(installId, aguardando);
}

function ligarTerminal(installId, dados) {
  const existente = terminais.get(installId);
  if (existente) {
    const virouTerminal = existente.modo !== 'terminal' && dados.modoOperacao === 'terminal';
    existente.nome = dados.nomeNegocio || existente.nome;
    existente.modo = dados.modoOperacao;
    existente.pendentesNoCelular = Number(dados.terminalPendentes) || 0;
    if (virouTerminal) publicarCatalogo(installId, { forcar: true }).catch(() => {});
    return;
  }
  const { fs, db } = fsCtx();
  const t = {
    nome: dados.nomeNegocio || 'PDV mobile', modo: dados.modoOperacao, pendentesNoCelular: Number(dados.terminalPendentes) || 0,
    pararEventos: null, catalogoVersao: null, ultimaMudancaDb: null, emFila: new Set(), ultimoErro: null,
  };
  terminais.set(installId, t);
  t.pararEventos = fs.onSnapshot(
    fs.query(fs.collection(db, 'installations', installId, 'terminal_eventos'), fs.where('status', '==', 'novo')),
    (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (docs.length) tratarEventos(installId, docs).catch((err) => console.error('[pdvMobileTerminal]', err));
    },
    (err) => { t.ultimoErro = err.message; console.error('[pdvMobileTerminal] escuta dos eventos falhou:', err.message); },
  );
  publicarCatalogo(installId, { forcar: true }).catch((err) => console.error('[pdvMobileTerminal] catálogo:', err.message));
}

function desligarTerminal(installId) {
  const t = terminais.get(installId);
  if (!t) return;
  try { t.pararEventos?.(); } catch { /* já parada */ }
  terminais.delete(installId);
}

/**
 * Publica o catálogo pro celular -- só se algo mudou aqui (total_changes)
 * e o conteúdo for diferente do último publicado. Uma publicação por vez
 * por celular: uma mais velha nunca grava a meta por cima de uma mais nova.
 */
function publicarCatalogo(installId, opcoes = {}) {
  const t = terminais.get(installId);
  if (!t) return Promise.resolve({ publicado: false });
  const proxima = (t.publicando || Promise.resolve()).catch(() => {}).then(() => publicarCatalogoAgora(installId, opcoes));
  t.publicando = proxima;
  return proxima;
}

async function publicarCatalogoAgora(installId, { forcar = false } = {}) {
  const t = terminais.get(installId);
  // Voltou a autônomo na Central: só termina de receber o que ficou na
  // fila do celular; catálogo não (produtos voltam a ser dele).
  if (!t || t.modo !== 'terminal') return { publicado: false };
  const mudancas = getDb().prepare('SELECT total_changes() AS n').get().n;
  if (!forcar && t.ultimaMudancaDb === mudancas) return { publicado: false };
  const cat = montarCatalogo(installId);
  const versao = versaoDoCatalogo(cat);
  t.ultimaMudancaDb = mudancas;
  if (!forcar && versao === t.catalogoVersao) return { publicado: false };
  const { fs, db } = fsCtx();
  if (forcar) {
    // Primeira publicação desde que o app abriu: se a nuvem já tem esta
    // mesma versão, não reescreve nada.
    const meta = await fs.getDoc(fs.doc(db, 'installations', installId, 'terminal_catalogo', 'meta')).catch(() => null);
    if (meta?.exists() && meta.data().versao === versao) { t.catalogoVersao = versao; return { publicado: false }; }
  }
  const { partes, partesProdutos, partesClientes } = partirCatalogo(cat);
  if (terminais.get(installId) !== t) return { publicado: false }; // desligado no meio
  // Partes primeiro, meta por último: o celular só lê quando a meta muda,
  // e confere a versão de cada parte (se pegar no meio, espera a próxima).
  const nomes = Object.keys(partes);
  for (let i = 0; i < nomes.length; i += 10) {
    const lote = fs.writeBatch(db);
    for (const nome of nomes.slice(i, i + 10)) {
      lote.set(fs.doc(db, 'installations', installId, 'terminal_catalogo', nome), { versao, itensJson: JSON.stringify(partes[nome]) });
    }
    await lote.commit();
  }
  const { nomeNegocio } = await migr.meuClienteId().catch(() => ({}));
  await fs.setDoc(fs.doc(db, 'installations', installId, 'terminal_catalogo', 'meta'), {
    versao, partesProdutos, partesClientes, servidorNome: nomeNegocio || 'computador', geradoEmMs: Date.now(),
    eventosAplicadosJson: JSON.stringify(cat.eventosAplicados),
  });
  t.catalogoVersao = versao;
  return { publicado: true, versao, produtos: cat.produtos.length, clientes: cat.clientes.length };
}

/** Apaga da nuvem eventos já aplicados há mais de 30 dias (aqui eles continuam registrados). */
async function limparEventosAntigos() {
  const { fs, db } = fsCtx();
  const antigos = getDb().prepare(
    `SELECT evento_id, install_id FROM pdv_terminal_eventos
     WHERE status IN ('aplicado', 'ignorado') AND limpo_nuvem = 0 AND aplicado_em < datetime('now', ?)
     LIMIT 300`,
  ).all(`-${DIAS_GUARDAR_EVENTOS_NA_NUVEM} days`);
  for (let i = 0; i < antigos.length; i += 100) {
    const lote = fs.writeBatch(db);
    for (const e of antigos.slice(i, i + 100)) lote.delete(fs.doc(db, 'installations', e.install_id, 'terminal_eventos', e.evento_id));
    await lote.commit();
    const marcar = getDb().prepare('UPDATE pdv_terminal_eventos SET limpo_nuvem = 1 WHERE evento_id = ?');
    for (const e of antigos.slice(i, i + 100)) marcar.run(e.evento_id);
  }
}

/** Liga a escuta dos celulares que a Central marcou como terminal DESTE computador. Chamado no boot (main.js). */
function iniciarTerminais() {
  try {
    if (pararEscutaTerminais) return;
    const { fs, db, meuId } = fsCtx();
    pararEscutaTerminais = fs.onSnapshot(
      fs.query(fs.collection(db, 'installations'), fs.where('servidorInstallId', '==', meuId)),
      (snap) => {
        const vistos = new Set();
        for (const d of snap.docs) {
          const x = d.data();
          // Só confia em celular cujos dados vieram pra cá (migração feita
          // neste computador) -- o vínculo na Central sozinho não basta.
          // "Voltar a autônomo" na Central mantém servidorInstallId: o que
          // ficou na fila do celular ainda chega aqui (ver ligarTerminal).
          if (x.tipo !== migr.TIPO_INSTALACAO_MOBILE || !migracaoDoCelular(getDb(), d.id)) continue;
          vistos.add(d.id);
          ligarTerminal(d.id, x);
        }
        for (const id of [...terminais.keys()]) if (!vistos.has(id)) desligarTerminal(id);
      },
      (err) => console.error('[pdvMobileTerminal] escuta dos terminais falhou:', err.message),
    );
    intervaloCatalogo = setInterval(() => {
      for (const id of terminais.keys()) publicarCatalogo(id).catch((err) => console.error('[pdvMobileTerminal] catálogo:', err.message));
    }, INTERVALO_CATALOGO_MS);
    intervaloLimpeza = setInterval(() => { limparEventosAntigos().catch(() => {}); }, 24 * 60 * 60 * 1000);
    setTimeout(() => { limparEventosAntigos().catch(() => {}); }, 10 * 60 * 1000);
  } catch (err) {
    console.error('[pdvMobileTerminal] não foi possível iniciar:', err);
  }
}

function pararTerminais() {
  if (pararEscutaTerminais) { pararEscutaTerminais(); pararEscutaTerminais = null; }
  for (const id of [...terminais.keys()]) desligarTerminal(id);
  clearInterval(intervaloCatalogo);
  clearInterval(intervaloLimpeza);
}

// ---------------------------------------------------------------------------
// Tela (Configurações → Migrar PDV mobile → Terminais)

function listarTerminais() {
  const db = getDb();
  migr.garantirTabela(db);
  const celulares = db.prepare(
    `SELECT install_id_mobile AS installId, MAX(nome_mobile) AS nome, MAX(importado_em) AS importadoEm FROM pdv_mobile_migracoes GROUP BY install_id_mobile`,
  ).all();
  return celulares.map((c) => {
    const cont = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM pdv_terminal_eventos WHERE install_id = ? GROUP BY status').all(c.installId).map((r) => [r.status, r.n]));
    const ultimo = db.prepare(`SELECT MAX(aplicado_em) AS u FROM pdv_terminal_eventos WHERE install_id = ? AND status = 'aplicado'`).get(c.installId).u;
    const t = terminais.get(c.installId);
    return {
      ...c, ativo: !!t, modo: t?.modo || null, pendentesNoCelular: t?.pendentesNoCelular || 0, nomeAtual: t?.nome || c.nome, ultimoErroRede: t?.ultimoErro || null, catalogoVersao: t?.catalogoVersao || null,
      aplicados: cont.aplicado || 0, ignorados: cont.ignorado || 0, erros: cont.erro || 0, aguardando: cont.aguardando || 0, ultimoAplicadoEm: ultimo,
    };
  });
}

function listarEventos({ installId = null, soProblemas = false, limit = 50 } = {}) {
  const filtros = [];
  const params = [];
  if (installId) { filtros.push('e.install_id = ?'); params.push(installId); }
  if (soProblemas) filtros.push(`(e.status IN ('erro', 'aguardando') OR e.nfce_status IN ('erro', 'rejeitada'))`);
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 300));
  return getDb().prepare(
    `SELECT e.*, s.total - s.desconto - s.desconto_gerente AS total_venda,
       (SELECT json_extract(p.detalhes, '$.numeroPdvMobile') FROM payments p WHERE p.sale_id = s.id AND json_valid(p.detalhes) LIMIT 1) AS numero_celular
     FROM pdv_terminal_eventos e LEFT JOIN sales s ON s.id = e.ref_id AND e.tipo IN ('venda', 'venda_cancelada')
     ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
     ORDER BY e.recebido_em DESC, e.criado_em_ms DESC LIMIT ?`,
  ).all(...params);
}

/** Tenta de novo um evento que deu erro (depois de corrigir a causa aqui -- ex.: loja sem admin). */
async function reprocessar(eventoId) {
  const row = getDb().prepare('SELECT * FROM pdv_terminal_eventos WHERE evento_id = ?').get(eventoId);
  if (!row) return { ok: false, error: 'Evento não encontrado.' };
  if (row.status === 'aplicado' || row.status === 'ignorado') return { ok: false, error: 'Esse evento já foi aplicado.' };
  const { fs, db } = fsCtx();
  const snap = await fs.getDoc(fs.doc(db, 'installations', row.install_id, 'terminal_eventos', eventoId));
  if (!snap.exists()) return { ok: false, error: 'O evento não está mais na nuvem -- peça pro celular reenviar (Ajustes → Computador → Tentar de novo).' };
  // "Tentar de novo" é uma pessoa (gerente/admin) conferindo: libera as
  // travas de plausibilidade (ex.: recebimento de fiado maior que a dívida).
  const r = await enfileirar(() => processarEvento(row.install_id, { id: snap.id, ...snap.data() }, { forcarRevisado: true }));
  if (r.status !== 'aguardando') await enviarRecibo(row.install_id, eventoId, r).catch(() => {});
  if (r.status === 'aplicado') publicarCatalogo(row.install_id).catch(() => {});
  return r.status === 'aplicado' || r.status === 'ignorado' ? { ok: true, resultado: r } : { ok: false, error: r.erro };
}

module.exports = {
  iniciarTerminais, pararTerminais, listarTerminais, listarEventos, reprocessar, getConfig, salvarConfig,
  // Parte local, exportada pra teste.
  aplicarEvento, processarEvento, montarCatalogo, partirCatalogo, versaoDoCatalogo, ErroTerminal, ORIGEM,
};
